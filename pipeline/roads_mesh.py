"""Geometry helpers for build_roads.py: polylines, grid-subdivided triangulation, binary packing.

All coordinates here are WORLD x/z (x = east, z = south = -north), metres.
"""
import gzip
import json
import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, MultiPolygon, box

HALF = 10240.0
TILE = 1024.0
NT = int(2 * HALF / TILE)  # 20 tiles per side
CELL = 10.0                # draping subdivision (matches the 10 m height grid)
QS = 32.0                  # vertex quantisation: 1/32 m, uint16 relative to tile min corner


# ----------------------------------------------------------------- projection
_TR = None


def to_world(geom_wkb):
    """Overture WKB (lon/lat) -> shapely geometry in world x/z (z = -north)."""
    global _TR
    if _TR is None:
        from config import to_local
        _TR = to_local()
    g = shapely.from_wkb(geom_wkb)

    def f(coords):
        x, y = _TR.transform(coords[:, 0], coords[:, 1])
        return np.c_[x, -np.asarray(y)]

    return shapely.transform(g, f)


# ----------------------------------------------------------------- polylines
def cumlen(p):
    d = np.hypot(np.diff(p[:, 0]), np.diff(p[:, 1]))
    return np.concatenate([[0.0], np.cumsum(d)])


def interp(p, c, s):
    s = np.clip(s, 0, c[-1])
    i = np.clip(np.searchsorted(c, s, side="right") - 1, 0, len(c) - 2)
    seg = c[i + 1] - c[i]
    t = np.where(seg > 1e-9, (s - c[i]) / np.where(seg > 1e-9, seg, 1), 0)
    t = np.asarray(t)
    return p[i] + (p[i + 1] - p[i]) * t[..., None]


def tangent(p, c, s, h=1.0):
    a = interp(p, c, np.asarray(s) - h)
    b = interp(p, c, np.asarray(s) + h)
    d = b - a
    n = np.linalg.norm(d, axis=-1, keepdims=True)
    return d / np.maximum(n, 1e-9)


def substring(p, c, a, b):
    """Sub-polyline between arc lengths a < b."""
    a = max(0.0, a)
    b = min(c[-1], b)
    if b - a < 1e-6:
        return None
    inner = (c > a) & (c < b)
    pts = [interp(p, c, a)] + list(p[inner]) + [interp(p, c, b)]
    return np.array(pts)


def resample(p, step):
    c = cumlen(p)
    n = max(1, int(np.ceil(c[-1] / step)))
    s = np.linspace(0, c[-1], n + 1)
    # keep original corners too for accuracy
    s = np.unique(np.concatenate([s, c]))
    return interp(p, c, s)


def offset_polyline(p, d):
    """Offset a polyline to the right (+d) with mitred joins (clamped). Right = (-tz, tx)."""
    n = len(p)
    if n < 2:
        return p.copy()
    t = np.diff(p, axis=0)
    t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-9)
    nrm = np.stack([-t[:, 1], t[:, 0]], 1)
    vn = np.zeros((n, 2))
    vn[0] = nrm[0]
    vn[-1] = nrm[-1]
    if n > 2:
        m = nrm[:-1] + nrm[1:]
        ml = np.linalg.norm(m, axis=1, keepdims=True)
        m = m / np.maximum(ml, 1e-9)
        cosh = np.sum(m * nrm[:-1], axis=1, keepdims=True)
        vn[1:-1] = m / np.maximum(cosh, 0.35)
    return p + vn * d


def simplify_pts(p, tol=0.05):
    ls = LineString(p).simplify(tol)
    return np.array(ls.coords)


def lines_of(geom):
    """All LineStrings contained in a (multi)line geometry."""
    if geom is None or geom.is_empty:
        return []
    t = geom.geom_type
    if t == "LineString":
        return [geom]
    if t in ("MultiLineString", "GeometryCollection"):
        out = []
        for g in geom.geoms:
            out += lines_of(g)
        return out
    return []


def polys_of(geom):
    if geom is None or geom.is_empty:
        return []
    t = geom.geom_type
    if t == "Polygon":
        return [geom]
    if t in ("MultiPolygon", "GeometryCollection"):
        out = []
        for g in geom.geoms:
            out += polys_of(g)
        return out
    return []


def merge_lines(geom):
    """Line merge of a boundary/intersection result into long polylines."""
    ls = lines_of(geom)
    if not ls:
        return []
    m = shapely.line_merge(shapely.MultiLineString(ls))
    return lines_of(m)


# ----------------------------------------------------------------- tiling
def tile_of(x, z):
    i = int(np.floor((x + HALF) / TILE))
    j = int(np.floor((z + HALF) / TILE))
    return min(max(i, 0), NT - 1), min(max(j, 0), NT - 1)


def tile_box(i, j):
    x0 = -HALF + i * TILE
    z0 = -HALF + j * TILE
    return x0, z0, x0 + TILE, z0 + TILE


def safe_clip(g, x0, z0, x1, z1):
    try:
        return shapely.clip_by_rect(g, x0, z0, x1, z1)
    except shapely.errors.GEOSException:
        return shapely.make_valid(g).buffer(0).intersection(box(x0, z0, x1, z1))


def triangulate_grid(geom, bx, cell=CELL, sub=80.0):
    """Clip geom to the rect bx=(x0,z0,x1,z1), subdivide on a `cell` grid aligned to the
    world height grid, triangulate. Returns (verts (n,2) float64, tris (m,3) int) or None."""
    x0, z0, x1, z1 = bx
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
    g = safe_clip(geom, x0, z0, x1, z1)
    if g.is_empty:
        return None
    pieces = []
    nsx = int(np.ceil((x1 - x0) / sub))
    nsz = int(np.ceil((z1 - z0) / sub))
    shapely.prepare(g)
    for a in range(nsx):
        for b in range(nsz):
            sx0, sz0 = x0 + a * sub, z0 + b * sub
            sb = box(sx0, sz0, sx0 + sub, sz0 + sub)
            if not g.intersects(sb):
                continue
            gs = safe_clip(g, sx0, sz0, sx0 + sub, sz0 + sub)
            if not gs.is_valid:
                gs = shapely.make_valid(gs)
            if gs.is_empty:
                continue
            if gs.area < 1e-3:
                continue
            nc = int(round(sub / cell))
            # cells in this sub-block
            cx = sx0 + np.arange(nc) * cell
            cz = sz0 + np.arange(nc) * cell
            CX, CZ = np.meshgrid(cx, cz)
            cells = shapely.box(CX.ravel(), CZ.ravel(), CX.ravel() + cell, CZ.ravel() + cell)
            shapely.prepare(gs)
            hit = shapely.intersects(gs, cells)
            if not hit.any():
                continue
            cl = cells[hit]
            # fully-contained cells don't need clipping
            inside = shapely.contains_properly(gs, cl)
            parts = list(cl[inside])
            rest = cl[~inside]
            if len(rest):
                bnds = shapely.bounds(rest)
                for k in range(len(rest)):
                    pc = safe_clip(gs, *bnds[k])
                    if not pc.is_empty:
                        parts += [p for p in polys_of(pc) if p.area > 1e-4]
            pieces += parts
    if not pieces:
        return None
    pieces = np.array(pieces, dtype=object)
    pieces = shapely.make_valid(pieces)
    tri = shapely.constrained_delaunay_triangles(pieces)
    tris = shapely.get_parts(shapely.get_parts(tri))
    tris = tris[shapely.get_type_id(tris) == 3]
    if len(tris) == 0:
        return None
    areas = shapely.area(tris)
    tris = tris[areas > 1e-5]
    coords = shapely.get_coordinates(tris).reshape(-1, 4, 2)[:, :3, :]
    flat = coords.reshape(-1, 2)
    q = np.round((flat - np.array([x0, z0])) * QS).astype(np.int64)
    key = q[:, 0] * 1000003 + q[:, 1]
    uk, inv = np.unique(key, return_inverse=True)
    first = np.zeros(len(uk), dtype=np.int64)
    first[inv[::-1]] = np.arange(len(inv))[::-1]
    verts = q[first].astype(np.float64) / QS + np.array([x0, z0])
    idx = inv.reshape(-1, 3)
    # consistent winding: counter-clockwise when viewed from +y (world x right, z down => cw in xz)
    a, b, c = verts[idx[:, 0]], verts[idx[:, 1]], verts[idx[:, 2]]
    cross = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    flip = cross > 0
    idx[flip] = idx[flip][:, [0, 2, 1]]
    # drop degenerate triangles produced by quantisation
    ok = (idx[:, 0] != idx[:, 1]) & (idx[:, 1] != idx[:, 2]) & (idx[:, 0] != idx[:, 2])
    return verts, idx[ok]


# ----------------------------------------------------------------- binary packing
class Packer:
    """Concatenate little-endian typed arrays (4-byte aligned) into one gzipped blob."""

    def __init__(self):
        self.parts = []
        self.off = 0

    def add(self, arr):
        arr = np.ascontiguousarray(arr)
        dt = {np.dtype("<f4"): "f32", np.dtype("<u2"): "u16", np.dtype("<i2"): "i16", np.dtype("<u4"): "u32",
              np.dtype("<i4"): "i32", np.dtype("u1"): "u8", np.dtype("i1"): "i8"}[arr.dtype.newbyteorder("<") if arr.dtype.itemsize > 1 else arr.dtype]
        b = arr.astype(arr.dtype.newbyteorder("<")).tobytes()
        rec = [dt, self.off, int(arr.size)]
        self.parts.append(b)
        self.off += len(b)
        pad = (-self.off) % 4
        if pad:
            self.parts.append(b"\0" * pad)
            self.off += pad
        return rec

    def write(self, path):
        with gzip.open(path, "wb", compresslevel=9) as f:
            for p in self.parts:
                f.write(p)
        return self.off


def write_json_gz(path, obj):
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def r1(a, d=2):
    """Round floats for compact JSON."""
    return [round(float(v), d) for v in np.asarray(a).ravel()]
