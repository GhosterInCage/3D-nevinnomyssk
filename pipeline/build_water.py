#!/usr/bin/env python3
"""Water bodies of Nevinnomyssk: water-surface elevations + tiled surface meshes.

Inputs: data/raw/base_water.parquet (Overture), data/raw/base_infrastructure.parquet (weir/dam),
        data/processed/{dem_raw,dem_ground,s2_rgb,s2_nir}.npy

Outputs (pipeline frame: x = east, y = north; world z = -y)
-------------------------------------------------------------------------------------------
data/processed/water_surface.npy  float32 [2049,2049] water-surface elevation (m ASL) sampled at the
                                  heightmap vertices (i,j) -> x = -10240 + 10 i, north = 10240 - 10 j.
                                  NaN = no water. Rivers/canals/streams slope monotonically downstream,
                                  still water is flat.
data/processed/water_body.npy     int16 [2049,2049] body index (-1 = none) into water_bodies.json
data/processed/water_depth.npy    float32 [2049,2049] SUGGESTED bed depth below the surface (m), a hint
                                  for terrain carving (bed = surface - depth). Negative values mark
                                  emergent gravel bars / islands inside river polygons (the bed should
                                  stand above the water there). NaN = no water.
data/processed/water_sdf.npy      float32 [2049,2049] signed distance (m) to the mapped shoreline, + inside water,
                                  - outside (band down to -60 m), NaN elsewhere. Carving banks as
                                  terrain = level - k*sdf near the shore puts the waterline exactly on the
                                  polygon outline (no 10 m staircase).
data/processed/water_level_ext.npy float32 [2049,2049] water level extended (nearest) into the -60 m band
data/processed/water_bodies.json  body table (same as "bodies" in public/data/water/water.json)

public/data/water/water.json      metadata: body table + tile directory + binary layout
public/data/water/water.bin.gz    all tiles, little-endian, concatenated sections (see "layout" in the
                                  json). Per tile (1024 m squares, origin = tile centre cx, cz in world
                                  metres):
                                    pos    int16  x3  (x - cx, z - cz in decimetres; level in cm above 200 m
                                                       stored as uint16 bits)
                                    flow   int8   x2  world-space flow velocity (vx, vz) in 0.05 m/s
                                    attr   uint8  x4  [shore distance (d+8)*4 m clamp 0..255,
                                                       foam/turbulence 0..255, bar proximity 0..255, 0]
                                    body   uint16 x1  body index
                                    index  uint16 x3  triangles (local to tile)
Body types: 1 river_fast (Kuban), 2 river (Bolshoy Zelenchuk / others), 3 canal, 4 stream/ditch,
            5 pond/lake/reservoir, 6 industrial settling / storage pond, 7 swimming pool.
"""
import gzip
import json
import math
import os
import sys
import time

import numpy as np
import pyarrow.parquet as pq
import shapely
from affine import Affine
from rasterio import features
from scipy import ndimage

from config import *
from water_hydro import RiverGrid, ndwi_water_polygons

T0 = time.time()
STAGE = sys.argv[1] if len(sys.argv) > 1 else "all"   # "raster" = stop after the rasters


def log(*a):
    print(f"[water {time.time() - T0:6.1f}s]", *a, flush=True)


H = REGION_HALF
N = HEIGHT_N
RES = GRID_RES
VT = Affine(RES, 0, -H - RES / 2, 0, -RES, H + RES / 2)       # vertex-centred raster (2049^2)
REGION = shapely.box(-H, -H, H, H)
TYPE_ID = {"river_fast": 1, "river": 2, "canal": 3, "stream": 4, "pond": 5, "industrial": 6, "pool": 7}

# Defaults per type: scatter albedo (linear), extinction 1/m, max speed m/s, roughness, wind exposure
TYPE_DEFAULTS = {
    "river_fast": dict(albedo=[0.085, 0.090, 0.075], ext=4.5, speed=2.4, rough=0.06, wind=0.3),
    "river":      dict(albedo=[0.070, 0.078, 0.062], ext=3.0, speed=1.6, rough=0.05, wind=0.4),
    "canal":      dict(albedo=[0.058, 0.072, 0.058], ext=2.4, speed=1.1, rough=0.04, wind=0.6),
    "stream":     dict(albedo=[0.040, 0.045, 0.030], ext=2.0, speed=0.5, rough=0.05, wind=0.2),
    "pond":       dict(albedo=[0.025, 0.040, 0.030], ext=1.2, speed=0.0, rough=0.03, wind=1.0),
    "industrial": dict(albedo=[0.20, 0.23, 0.21],    ext=6.0, speed=0.0, rough=0.03, wind=1.0),
    "pool":       dict(albedo=[0.02, 0.10, 0.14],    ext=0.08, speed=0.0, rough=0.02, wind=0.15),
}


# ------------------------------------------------------------------------------------ helpers
def proj_fn():
    tr = to_local()
    return lambda g: shapely.transform(g, lambda c: np.stack(tr.transform(c[:, 0], c[:, 1]), 1))


def vsample(a, x, y, order=1):
    """Sample a vertex-centred 2049^2 grid at pipeline coords."""
    from scipy.ndimage import map_coordinates
    c = (np.asarray(x) + H) / RES
    r = (H - np.asarray(y)) / RES
    return map_coordinates(a, [r, c], order=order, mode="nearest")


def csample(a, x, y, order=1):
    """Sample a cell-centred 2048^2 grid at pipeline coords."""
    from scipy.ndimage import map_coordinates
    c = (np.asarray(x) + H) / RES - 0.5
    r = (H - np.asarray(y)) / RES - 0.5
    return map_coordinates(a, [r, c], order=order, mode="nearest")


def raster_window(geom, all_touched=False, pad=2):
    """Rasterise geom on the vertex grid inside its bbox window. Returns (r0, c0, mask)."""
    minx, miny, maxx, maxy = geom.bounds
    c0 = max(0, int(math.floor((minx + H) / RES)) - pad)
    c1 = min(N, int(math.ceil((maxx + H) / RES)) + pad + 1)
    r0 = max(0, int(math.floor((H - maxy) / RES)) - pad)
    r1 = min(N, int(math.ceil((H - miny) / RES)) + pad + 1)
    if c1 <= c0 or r1 <= r0:
        return 0, 0, np.zeros((0, 0), bool)
    t = VT * Affine.translation(c0, r0)
    m = features.rasterize([(geom, 1)], out_shape=(r1 - r0, c1 - c0), transform=t,
                           all_touched=all_touched, dtype=np.uint8).astype(bool)
    return r0, c0, m


def win_coords(r0, c0, m):
    rr, cc = np.nonzero(m)
    rr = rr + r0
    cc = cc + c0
    return rr, cc, -H + cc * RES, H - rr * RES


def pava_nonincreasing(y, w=None):
    """Isotonic regression (pool adjacent violators), non-increasing fit."""
    y = np.asarray(y, float)
    w = np.ones_like(y) if w is None else np.asarray(w, float)
    # fit non-decreasing on -y
    v = list(-y)
    ww = list(w)
    blocks = []   # [value, weight, count]
    for vi, wi in zip(v, ww):
        blocks.append([vi, wi, 1])
        while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
            a = blocks.pop()
            b = blocks.pop()
            wt = a[1] + b[1]
            blocks.append([(a[0] * a[1] + b[0] * b[1]) / wt, wt, a[2] + b[2]])
    out = []
    for val, _, cnt in blocks:
        out += [val] * cnt
    return -np.array(out)


def smooth_monotone(y, sigma):
    if sigma <= 0 or len(y) < 3:
        return y
    ys = ndimage.gaussian_filter1d(y, sigma, mode="nearest")
    return pava_nonincreasing(ys)   # guard numerical drift


def profile_from_samples(s, z, length, step, pct=25, win=2, sigma=5, w_min=3):
    """Robust non-increasing level profile along a centreline from (chainage, elevation) samples."""
    ns = int(length // step) + 1
    st = np.arange(ns) * step
    k = np.clip((s // step).astype(int), 0, ns - 1)
    order = np.argsort(k)
    ks, zs = k[order], z[order]
    bounds = np.searchsorted(ks, np.arange(ns + 1))
    val = np.full(ns, np.nan)
    cnt = np.zeros(ns)
    for i in range(ns):
        a = bounds[max(0, i - win)]
        b = bounds[min(ns, i + win + 1)]
        if b - a >= w_min:
            val[i] = np.percentile(zs[a:b], pct)
            cnt[i] = b - a
    ok = np.isfinite(val)
    if ok.sum() == 0:
        return st, None
    val = np.interp(st, st[ok], val[ok])
    cnt[~ok] = 0.5
    fit = pava_nonincreasing(val, np.sqrt(cnt))
    return st, smooth_monotone(fit, sigma)


def line_merge(geoms):
    g = shapely.line_merge(shapely.union_all(geoms))
    if g.geom_type == "MultiLineString":
        # keep the longest connected piece chain: stitch by nearest endpoints in list order
        parts = sorted(g.geoms, key=lambda q: -q.length)
        return parts[0], parts[1:]
    return g, []


def as_polys(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    if g.geom_type in ("MultiPolygon", "GeometryCollection"):
        out = []
        for p in g.geoms:
            out += as_polys(p)
        return out
    return []


def clean(g):
    g = shapely.make_valid(g)
    ps = [p for p in as_polys(g) if p.area > 1.0]
    if not ps:
        return None
    return shapely.union_all(ps)


# ------------------------------------------------------------------------------------ load
log("loading")
P = proj_fn()
rows = pq.read_table(os.path.join(RAW, "base_water.parquet")).to_pylist()
feats = []
for r in rows:
    g = P(shapely.from_wkb(r["geometry"]))
    feats.append(dict(id=r["id"], sub=r["subtype"], cls=r["class"], name=(r["names"] or {}).get("primary"),
                      g=g, tags=dict(r["source_tags"] or {}), inter=bool(r["is_intermittent"])))
infra = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet")).to_pylist()
weirs = []
for r in infra:
    if r["class"] in ("weir", "dam"):
        weirs.append(dict(cls=r["class"], g=P(shapely.from_wkb(r["geometry"]))))
bridges = []
for r in infra:
    if r["class"] == "bridge":
        g = P(shapely.from_wkb(r["geometry"]))
        if g.geom_type == "LineString":
            bridges.append(dict(g=g, tags=dict(r["source_tags"] or {})))

dem_raw = np.load(os.path.join(PROC, "dem_raw.npy")).astype(np.float32)
dem_g = np.load(os.path.join(PROC, "dem_ground.npy")).astype(np.float32)
s2 = np.load(os.path.join(PROC, "s2_rgb.npy")).astype(np.float32)
nir = np.load(os.path.join(PROC, "s2_nir.npy")).astype(np.float32)
ndwi = (s2[..., 1] - nir) / (s2[..., 1] + nir + 1e-6)
bright = s2.mean(-1)
log("loaded", len(feats), "water features")

# ------------------------------------------------------------------------------------ centrelines
def named_lines(name):
    return [f["g"] for f in feats if f["name"] == name and f["g"].geom_type == "LineString"]


kuban_line, _ = line_merge(named_lines("Кубань"))
zel_line, _ = line_merge(named_lines("Большой Зеленчук"))
canal_line, _ = line_merge(named_lines("Невинномысский канал"))
# orient downstream (OSM waterways are drawn along the flow; enforce sanity for the Kuban: flows north)
if kuban_line.coords[0][1] > kuban_line.coords[-1][1]:
    kuban_line = shapely.reverse(kuban_line)
log("kuban", int(kuban_line.length), "zelenchuk", int(zel_line.length), "canal", int(canal_line.length))

# junction of the Zelenchuk with the Kuban
zel_end = shapely.Point(zel_line.coords[-1])
s_junction = kuban_line.project(zel_end)
# weir (headworks of the Nevinnomyssk canal)
weir_pt = None
for w in weirs:
    if w["cls"] == "weir":
        c = w["g"].centroid
        if kuban_line.distance(c) < 300:
            weir_pt = c
s_weir = kuban_line.project(weir_pt) if weir_pt is not None else None
log("junction s=%.0f" % s_junction, "weir s=%s" % (None if s_weir is None else int(s_weir)))

# ------------------------------------------------------------------------------------ classify polygons
river_polys = [f["g"] for f in feats if f["sub"] == "river" and f["g"].geom_type in ("Polygon", "MultiPolygon")]
osm_river = clean(shapely.union_all(river_polys).intersection(REGION))
still_src = []
for f in feats:
    g = f["g"]
    if g.geom_type not in ("Polygon", "MultiPolygon") or f["sub"] == "river":
        continue
    g = clean(g.intersection(REGION))
    if g is not None:
        still_src.append((f, g))
still_union = shapely.union_all([g for _, g in still_src]) if still_src else None

# Reaches of the Kuban / Zelenchuk without a mapped riverbank polygon: take the channel from Sentinel-2
cor = clean(shapely.union_all([kuban_line.buffer(260), zel_line.buffer(200)]).intersection(REGION.buffer(-2)))
free = cor.difference(osm_river.buffer(60))
nd = ndwi_water_polygons(ndwi, H, cor, exclude=None if still_union is None else still_union.buffer(4))
added = []
if nd is not None:
    for p in as_polys(nd.difference(osm_river)):
        if p.area < 1500:
            continue
        if p.intersection(free).area > 0.5 * p.area:
            added.append(p)
river_union = clean(shapely.union_all([osm_river] + added))
# wooded islands / canopy inside mapped riverbank polygons are land (Sentinel-2: NIR >> red)
ndvi_s2 = (nir - s2[..., 0]) / (nir + s2[..., 0] + 1e-6)
veg_c = (nir > 0.22) & (ndvi_s2 > 0.45)
lab_, nl_ = ndimage.label(veg_c)
sz_ = ndimage.sum(veg_c, lab_, np.arange(1, nl_ + 1))
veg_c = np.isin(lab_, np.nonzero(sz_ >= 12)[0] + 1)
veg_polys = [shapely.geometry.shape(gj) for gj, v in features.shapes(veg_c.astype(np.uint8), mask=veg_c,
             transform=region_transform(), connectivity=4) if v == 1]
if veg_polys:
    vu = shapely.union_all(veg_polys).intersection(river_union)
    # only thick blobs (>= ~24 m across): thin canopy strips over narrow channels stay water
    vu = vu.buffer(-12, join_style="round").buffer(10, join_style="round")
    islands = [p for p in as_polys(vu) if p.area >= 1500]
    if islands:
        before = river_union.area
        river_union = clean(river_union.difference(shapely.union_all(islands)))
        log("wooded islands removed from river polygons: %.2f km2" % ((before - river_union.area) / 1e6))
log("river polygons: OSM %.2f km2 + Sentinel-2 channel %.2f km2" % (osm_river.area / 1e6, sum(p.area for p in added) / 1e6))


def heal_network(union, corridor, max_gap=260.0, width=14.0):
    """Connect channel fragments (gaps under bridges / canopy / mapping holes) with short strips along a
    minimum spanning tree so the river network is continuous for the flow and level solvers."""
    comps = [p for p in as_polys(union) if p.intersects(corridor) and p.area > 600]
    edges = []
    for i in range(len(comps)):
        for j in range(i + 1, len(comps)):
            d = comps[i].distance(comps[j])
            if d < max_gap:
                edges.append((d, i, j))
    edges.sort()
    parent = list(range(len(comps)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    links = []
    for d, i, j in edges:
        a, b = find(i), find(j)
        if a == b:
            continue
        parent[a] = b
        if d > 0.01:
            links.append(shapely.shortest_line(comps[i], comps[j]).buffer(width / 2, cap_style="round"))
    if links:
        log("healed %d river gaps (max %.0f m)" % (len(links), max(l.length for l in links)))
        union = clean(shapely.union_all([union] + links))
    return union


river_union = heal_network(river_union, cor)
river_union = clean(river_union.buffer(0.4, join_style="mitre").buffer(-0.4, join_style="mitre")) or river_union
river_buf = river_union.buffer(6)

bodies = []   # dicts


def new_body(kind, name, geom, **kw):
    if geom is not None:
        # dissolve slivers between adjacent parts of multipolygons (internal boundaries)
        geom = clean(geom.buffer(0.4, join_style="mitre").buffer(-0.4, join_style="mitre")) or geom
    b = dict(idx=len(bodies), type=kind, name=name, geom=geom, **kw)
    bodies.append(b)
    return b


still = []
merged_into_river = []
for f, g in still_src:
    if f["cls"] == "swimming_pool":
        still.append(("pool", f, g))
        continue
    ov = g.intersection(river_buf).area / max(g.area, 1)
    if ov > 0.3:
        merged_into_river.append(g)
        continue
    still.append(("still", f, g))
if merged_into_river:
    river_union = clean(shapely.union_all([river_union] + merged_into_river))
log("river area %.2f km2" % (river_union.area / 1e6), "merged", len(merged_into_river), "still", len(still))

# ------------------------------------------------------------------------------------ river hydrology
RG = RiverGrid(river_union, res=5.0)
log("river grid %dx%d, %d wet nodes" % (RG.w, RG.h, RG.n))


def entry_exit(line):
    pts_ = shapely.get_parts(line.intersection(REGION.boundary))
    pts_ = [p for p in pts_ if p.geom_type == "Point"]
    if not pts_:
        return shapely.Point(line.coords[0]), shapely.Point(line.coords[-1])
    s_ = [line.project(p) for p in pts_]
    return pts_[int(np.argmin(s_))], pts_[int(np.argmax(s_))]


def near_edge(px, py):
    return (np.abs(px) > H - 40) | (np.abs(py) > H - 40)


k_in, k_out = entry_exit(kuban_line)
z_in, _ = entry_exit(zel_line)
def end_nodes(p, spread=60.0):
    d = np.hypot(nx_ - p.x, ny_ - p.y)
    return np.nonzero(d < d.min() + spread)[0]


nx_, ny_ = RG.xy(RG.rr, RG.cc)
src_k = end_nodes(k_in)
src_z = end_nodes(z_in)
sink = end_nodes(k_out)
log("inflow nodes kuban %d zelenchuk %d, outflow %d" % (len(src_k), len(src_z), len(sink)))
gK = RG.geodesic(src_k)
gZ = RG.geodesic(src_z)
nx_, ny_ = RG.xy(RG.rr, RG.cc)
# unreachable fragments: fall back to centreline chainage
s_in_k = kuban_line.project(k_in)
s_in_z = zel_line.project(z_in)
npts = shapely.points(nx_, ny_)
fbk = shapely.line_locate_point(kuban_line, npts) - s_in_k
fbz = shapely.line_locate_point(zel_line, npts) - s_in_z
gK = np.where(np.isfinite(gK), gK, fbk)
gZ = np.where(np.isfinite(gZ), gZ, fbz)
conf_node = RG.pixels_near(zel_end.x, zel_end.y, 1e9)
cd = np.hypot(nx_ - zel_end.x, ny_ - zel_end.y)
conf_node = int(np.argmin(cd))
gZ_C, gK_C = float(gZ[conf_node]), float(gK[conf_node])
zel_branch = (gZ < gZ_C) & (np.hypot(nx_ - zel_end.x, ny_ - zel_end.y) > 0)
# nodes much closer (geodesically) to the Kuban source than their Zelenchuk distance suggests are Kuban
zel_branch &= ~((gK < gK_C) & (gK - gK_C < gZ - gZ_C))
log("confluence gK=%.0f gZ=%.0f, zelenchuk-branch nodes %d" % (gK_C, gZ_C, int(zel_branch.sum())))
phi = RG.laplace(np.concatenate([src_k, src_z]), sink)
fu, fv, fmag = RG.flow_field(phi, smooth_px=1.5)
med_mag = float(np.nanmedian(fmag[RG.mask]))
zr = np.minimum(vsample(dem_raw, nx_, ny_), vsample(dem_g, nx_, ny_))

wn = None
s_weir = None
if weir_pt is not None:
    wn = int(np.argmin(np.hypot(nx_ - weir_pt.x, ny_ - weir_pt.y)))
    s_weir = float(gK[wn])


def fit_kuban():
    sel = ~zel_branch
    s, z = gK[sel], zr[sel]
    L = float(np.nanmax(s)) + 50
    if s_weir is None:
        return profile_from_samples(s, z, L, 50, pct=20, w_min=12)
    up = s < s_weir
    st1, p1 = profile_from_samples(s[up], z[up], s_weir, 50, pct=20, w_min=12)
    st2, p2 = profile_from_samples(s[~up] - s_weir, z[~up], L - s_weir, 50, pct=20, w_min=12)
    st1 = np.append(st1, s_weir - 1.0)
    p1 = np.append(p1, p1[-1])
    st = np.concatenate([st1, st2 + s_weir + 1.0])
    drop = max(1.5, p1[-1] - p2[0])
    p1 = np.maximum(p1, p2[0] + drop)
    return st, pava_nonincreasing(np.concatenate([p1, p2]))


k_st, k_pr = fit_kuban()
k_pr = k_pr - 0.3                      # DSM over rivers is biased towards the banks: sit slightly lower
L_junction = float(np.interp(gK_C, k_st, k_pr))
z_st, z_pr = profile_from_samples(gZ[zel_branch], zr[zel_branch], gZ_C + 50, 50, pct=20, w_min=12)
z_pr = z_pr - 0.3
z_pr = np.maximum(z_pr, L_junction)
tail = z_st > gZ_C - 600
z_pr[tail] = z_pr[tail] + (L_junction - np.interp(gZ_C, z_st, z_pr)) * np.clip((z_st[tail] - (gZ_C - 600)) / 600, 0, 1)
z_pr = pava_nonincreasing(z_pr)
L_pool = float(np.interp(s_weir - 20, k_st, k_pr)) if s_weir is not None else None
log("kuban level %.1f -> %.1f  junction %.1f  pool %s  zelenchuk %.1f -> %.1f" % (
    np.interp(0, k_st, k_pr), np.interp(np.nanmax(gK), k_st, k_pr), L_junction, L_pool, z_pr[0], np.interp(gZ_C, z_st, z_pr)))

gK_r = RG.filled(gK)
gZ_r = RG.filled(gZ)
zb_r = RG.filled(zel_branch.astype(float))
fu_r = np.where(RG.mask, fu, np.nan); fu_r = RG.filled(fu_r[RG.rr, RG.cc])
fv_r = np.where(RG.mask, fv, np.nan); fv_r = RG.filled(fv_r[RG.rr, RG.cc])
fm_r = RG.filled(fmag[RG.rr, RG.cc] / max(med_mag, 1e-12))


def river_level(x, y):
    gk = RG.sample(gK_r, x, y)
    gz = RG.sample(gZ_r, x, y)
    oz = RG.sample(zb_r, x, y, order=0) > 0.5
    lv = np.where(oz, np.interp(gz, z_st, z_pr), np.interp(gk, k_st, k_pr))
    return lv, oz, gk, gz


def river_flow(x, y):
    u = RG.sample(fu_r, x, y)
    v = RG.sample(fv_r, x, y)
    m = np.hypot(u, v) + 1e-9
    rel = np.clip(RG.sample(fm_r, x, y), 0.0, 2.0)
    return u / m, v / m, rel


# ------------------------------------------------------------------------------------ linear waterways
def measure_width(line):
    """Median water width (m) from Sentinel-2 NDWI unmixing across the line."""
    wf = WF
    ws = []
    L = line.length
    for d in np.arange(25, max(26, L - 25), 60):
        p = line.interpolate(d)
        p2 = line.interpolate(min(L, d + 5))
        tx, ty = p2.x - p.x, p2.y - p.y
        ln = math.hypot(tx, ty) + 1e-9
        nx, ny = -ty / ln, tx / ln
        off = np.arange(-60, 61, 2.0)
        v = csample(wf, p.x + nx * off, p.y + ny * off)
        base = np.percentile(v, 20)
        ws.append(np.sum(np.clip(v - base, 0, 1)) * 2.0)
    return float(np.median(ws)) if ws else 0.0


WF = np.clip((ndwi + 0.55) / 0.8, 0, 1)

linear = []   # (kind, name, line, width, feature)
for f in feats:
    g = f["g"]
    if g.geom_type not in ("LineString", "MultiLineString"):
        continue
    if f["tags"].get("tunnel") in ("yes", "culvert") or f["inter"] or f["tags"].get("intermittent") == "yes":
        continue
    gi = g.intersection(REGION.buffer(-1))
    if gi.is_empty or gi.length < 30:
        continue
    lines = [gi] if gi.geom_type == "LineString" else [q for q in getattr(gi, "geoms", []) if q.geom_type == "LineString"]
    for ln in lines:
        if ln.length < 30:
            continue
        # waterway lines already covered by the river polygons are not needed
        cover = ln.intersection(river_union.buffer(15)).length / ln.length
        if cover > 0.8:
            continue
        wm = measure_width(ln)
        name = f["name"]
        if name == "Невинномысский канал":
            kind, w = "canal", 30.0
        elif f["cls"] in ("canal",):
            if wm < 1.5:
                kind, w = "canal", 4.0
            else:
                kind, w = "canal", float(np.clip(wm * 1.3, 6, 24))
        elif f["cls"] in ("drain", "ditch"):
            if wm < 1.0:
                continue
            kind, w = "stream", float(np.clip(wm, 3, 8))
        elif f["cls"] == "river":
            kind, w = "stream", float(np.clip(wm, 4, 10))
            if wm > 18 and name is None:
                kind, w = "river", float(min(wm, 25))
        else:   # stream
            kind, w = "stream", float(np.clip(wm, 2.5, 6))
        linear.append(dict(kind=kind, name=name, line=ln, width=w, wm=wm, fid=f["id"]))
log("linear waterways", len(linear))


def line_profile(line, width, freeboard, start_cap=None):
    """Monotone non-increasing level profile along a (downstream-oriented) line from the ground DEM."""
    L = line.length
    step = 10.0
    st = np.arange(0, L + step, step)
    st[-1] = min(st[-1], L)
    p = shapely.line_interpolate_point(line, st)
    x, y = shapely.get_x(p), shapely.get_y(p)
    # lowest ground across the channel (banks + channel) = best guess of the incised channel floor
    nxt = shapely.line_interpolate_point(line, np.minimum(st + 2, L))
    prv = shapely.line_interpolate_point(line, np.maximum(st - 2, 0))
    tx = shapely.get_x(nxt) - shapely.get_x(prv)
    ty = shapely.get_y(nxt) - shapely.get_y(prv)
    ln = np.hypot(tx, ty) + 1e-9
    nx, ny = -ty / ln, tx / ln
    zs = []
    for o in (-0.5, 0.0, 0.5):
        zs.append(vsample(dem_g, x + nx * width * o, y + ny * width * o))
    z = np.min(zs, 0)
    z = ndimage.minimum_filter1d(z, 5, mode="nearest")
    fit = pava_nonincreasing(z)
    fit = smooth_monotone(fit, 8) - freeboard
    if start_cap is not None:
        fit = np.minimum(fit, start_cap)
    return st, fit


for w in linear:
    fb = {"canal": 1.2, "stream": 0.8, "river": 0.6}[w["kind"]]
    cap = None
    if w["name"] == "Невинномысский канал" and L_pool is not None:
        cap = L_pool - 0.3
    w["st"], w["pr"] = line_profile(w["line"], w["width"], fb, cap)

# ------------------------------------------------------------------------------------ bodies
# 1. Kuban system (one body per river so colours/speeds differ)
kub = new_body("river_fast", "Кубань", None, flowing=True)
zel = new_body("river", "Большой Зеленчук", None, flowing=True)
# split river union by nearest centreline (Voronoi-ish) using raster assignment -> geometry split via
# half-planes is overkill; instead keep one geometry for both and pick the body per vertex.
kub["geom"] = river_union
zel["geom"] = None

# 2. linear waterways -> buffered polygons
for w in linear:
    g = clean(w["line"].buffer(w["width"] / 2, cap_style="flat", join_style="round").intersection(REGION))
    if g is None:
        continue
    b = new_body(w["kind"], w["name"], g, flowing=True, line=w["line"], st=w["st"], pr=w["pr"], width=w["width"])
    w["body"] = b

# 3. still water
for kind, f, g in still:
    b = new_body("pool" if kind == "pool" else "pond", f["name"], g, flowing=False, cls=f["cls"])

# ------------------------------------------------------------------------------------ still-water levels
for b in bodies:
    if b["flowing"] or b["geom"] is None:
        continue
    g = b["geom"]
    r0_, c0_, m = raster_window(g, all_touched=False)
    inner = ndimage.binary_erosion(m, iterations=1) if m.sum() > 30 else m
    rr_, cc_, _, _ = win_coords(r0_, c0_, inner)
    zin = dem_raw[rr_, cc_] if len(rr_) else np.array([])
    ring = g.buffer(15).exterior if g.geom_type == "Polygon" else shapely.union_all([p.buffer(15).exterior for p in g.geoms])
    rp = shapely.line_interpolate_point(ring, np.arange(0, ring.length, 8.0)) if ring.geom_type in ("LineString", "LinearRing") else \
        np.concatenate([shapely.line_interpolate_point(q, np.arange(0, q.length, 8.0)) for q in ring.geoms])
    zring = vsample(dem_g, shapely.get_x(rp), shapely.get_y(rp))
    ring20 = float(np.percentile(zring, 20)) if len(zring) else np.inf
    if b["type"] == "pool":
        lvl = float(np.median(vsample(dem_g, *np.array(g.representative_point().coords[0])[:, None]))) - 0.15
    elif len(zin) >= 20:
        lvl = float(np.percentile(zin, 30)) - 0.1
        lvl = min(lvl, max(ring20 + 1.5, float(np.percentile(zin, 5))))   # embanked ponds may sit above the plain
    elif len(zin) >= 3:
        lvl = min(float(np.percentile(zin, 30)), ring20 - 0.3)
    else:
        lvl = ring20 - 0.4
    b["level"] = lvl
    b["npx"] = int(m.sum())

# ------------------------------------------------------------------------------------ colours
def body_color(b, geom):
    """Median Sentinel-2 reflectance of the open-water interior (proxy for the water body's volume
    scattering albedo). Returns None when the body is too small to measure."""
    if geom is None:
        return None
    inner = geom.buffer(-15)
    if inner.is_empty or inner.area < 800:
        return None
    minx, miny, maxx, maxy = inner.bounds
    c0_ = max(0, int((minx + H) / RES)); c1_ = min(2048, int((maxx + H) / RES) + 1)
    r0_ = max(0, int((H - maxy) / RES)); r1_ = min(2048, int((H - miny) / RES) + 1)
    if c1_ <= c0_ or r1_ <= r0_:
        return None
    t = region_transform() * Affine.translation(c0_, r0_)
    m = features.rasterize([(inner, 1)], out_shape=(r1_ - r0_, c1_ - c0_), transform=t).astype(bool)
    w = ndwi[r0_:r1_, c0_:c1_]
    sel = m & (w > 0.0)
    if sel.sum() < 8:
        return None
    rgb = np.median(s2[r0_:r1_, c0_:c1_][sel], 0)
    return [float(v) for v in rgb], int(sel.sum())


for b in bodies:
    if b is zel:
        continue
    res = body_color(b, b["geom"])
    b["s2"] = res[0] if res else None
    # industrial settling / storage ponds: bright milky water
    if b["type"] == "pond" and res and np.mean(res[0]) > 0.085 and res[1] > 30:
        b["type"] = "industrial"
if kub["s2"] is not None:
    zel["s2"] = kub["s2"]
log("bodies", len(bodies), {k: sum(1 for b in bodies if b["type"] == k) for k in TYPE_ID})

# ------------------------------------------------------------------------------------ rasters
surf = np.full((N, N), np.nan, np.float32)
body_ix = np.full((N, N), -1, np.int16)


def paint(b, r0_, c0_, m, lv):
    rr_, cc_ = np.nonzero(m)
    surf[rr_ + r0_, cc_ + c0_] = lv
    body_ix[rr_ + r0_, cc_ + c0_] = b["idx"]


# precedence (later wins): streams -> canals -> rivers -> still water -> pools
order = [b for b in bodies if b["type"] == "stream"] + [b for b in bodies if b["type"] in ("canal", "river") and b is not zel] + \
        [kub] + [b for b in bodies if b["type"] in ("pond", "industrial")] + [b for b in bodies if b["type"] == "pool"]
for b in order:
    g = b["geom"]
    if g is None:
        continue
    narrow = b["type"] in ("stream", "canal", "pool") or g.area < 3000
    r0_, c0_, m = raster_window(g, all_touched=narrow)
    if not m.any():
        continue
    rr_, cc_, x_, y_ = win_coords(r0_, c0_, m)
    if b is kub:
        lv, oz, _, _ = river_level(x_, y_)
        surf[rr_, cc_] = lv
        body_ix[rr_, cc_] = np.where(oz, zel["idx"], kub["idx"])
        continue
    if b["flowing"]:
        s = shapely.line_locate_point(b["line"], shapely.points(x_, y_))
        lv = np.interp(s, b["st"], b["pr"])
    else:
        lv = np.full(len(x_), b["level"])
    surf[rr_, cc_] = lv
    body_ix[rr_, cc_] = b["idx"]

wet = np.isfinite(surf)
log("water samples", int(wet.sum()))

# suggested depth (terrain carving hint)
dist = ndimage.distance_transform_edt(wet) * RES          # distance to the nearest dry sample (m)
btype = np.zeros((N, N), np.uint8)
for b in bodies:
    pass
type_lut = np.zeros(len(bodies) + 1, np.uint8)
for b in bodies:
    type_lut[b["idx"]] = TYPE_ID[b["type"]]
tmap = np.where(body_ix >= 0, type_lut[np.maximum(body_ix, 0)], 0)
depth = np.full((N, N), np.nan, np.float32)
dd = dist
depth = np.where(tmap == 1, np.clip(0.3 + 0.10 * dd, 0.3, 2.6), depth)
depth = np.where(tmap == 2, np.clip(0.3 + 0.09 * dd, 0.3, 1.8), depth)
depth = np.where(tmap == 3, np.clip(0.5 + 0.45 * dd, 0.5, 3.6), depth)
depth = np.where(tmap == 4, np.clip(0.4 + 0.10 * dd, 0.4, 0.9), depth)
depth = np.where(tmap == 5, np.clip(0.3 + 0.06 * dd, 0.3, 3.5), depth)
depth = np.where(tmap == 6, np.clip(0.8 + 0.25 * dd, 0.8, 3.0), depth)
depth = np.where(tmap == 7, 1.8, depth)

# emergent gravel bars / vegetated islands inside the river polygons (Sentinel-2)
ratio_nr = nir / (s2[..., 0] + 1e-4)
dry_c = (ratio_nr > 0.95) & (ratio_nr < 1.7) & (bright > 0.085)
dry_c = ndimage.binary_opening(dry_c, structure=np.ones((2, 2)))
# cell grid (2048) -> vertex grid (2049): a vertex is "dry" if the majority of its 4 cells are
dpad = np.pad(dry_c.astype(np.float32), 1, mode="edge")
dv = (dpad[:-1, :-1] + dpad[1:, :-1] + dpad[:-1, 1:] + dpad[1:, 1:]) / 4.0
bar_v = (dv >= 0.5) & ((tmap == 1) | (tmap == 2))
# distance from the bars into the channel: shallow riffles around bars
d_bar = ndimage.distance_transform_edt(~bar_v) * RES
river_v = (tmap == 1) | (tmap == 2)
depth = np.where(river_v, np.minimum(depth, 0.25 + 0.12 * d_bar), depth)
depth = np.where(bar_v, -0.4, depth)
log("bars: %d samples (%.0f%% of river)" % (bar_v.sum(), 100 * bar_v.sum() / max(1, river_v.sum())))

# signed distance to the mapped shoreline (m, + inside water) in a +-60 m band, and the water level
# extended into that band: lets the terrain carve banks whose zero crossing follows the exact
# polygon outline instead of the 10 m staircase of the binary mask
wet_geoms = [b["geom"] for b in bodies if b["geom"] is not None]
wet_union = shapely.union_all(wet_geoms)
segs = []
for p_ in as_polys(wet_union):
    for ring in [p_.exterior] + list(p_.interiors):
        c_ = np.asarray(ring.coords)
        if len(c_) >= 2:
            segs.append(np.stack([c_[:-1], c_[1:]], 1))
segs = shapely.linestrings(np.concatenate(segs)) if segs else []
band = ndimage.binary_dilation(wet, iterations=7) | wet
br_, bc_ = np.nonzero(band)
bx, by = -H + bc_ * RES, H - br_ * RES
sdf = np.full((N, N), np.nan, np.float32)
if len(segs):
    tree = shapely.STRtree(segs)
    (qi, ti), dist_ = tree.query_nearest(shapely.points(bx, by), max_distance=400.0, return_distance=True)
    dmin = np.full(len(bx), np.inf)
    np.minimum.at(dmin, qi, dist_)
    shapely.prepare(wet_union)
    inside = shapely.contains_xy(wet_union, bx, by)
    val = np.where(inside, dmin, -dmin)
    ok = np.isfinite(val) & (val >= -60)
    sdf[br_[ok], bc_[ok]] = val[ok]
_, (ir_, ic_) = ndimage.distance_transform_edt(~wet, return_indices=True)
level_ext = np.where(np.isfinite(sdf), surf[ir_, ic_], np.nan).astype(np.float32)
level_ext = np.where(wet, surf, level_ext)
np.save(os.path.join(PROC, "water_sdf.npy"), sdf)
np.save(os.path.join(PROC, "water_level_ext.npy"), level_ext)
log("shore SDF band samples: %d" % int(np.isfinite(sdf).sum()))

np.save(os.path.join(PROC, "water_surface.npy"), surf)
np.save(os.path.join(PROC, "water_body.npy"), body_ix)
np.save(os.path.join(PROC, "water_depth.npy"), depth.astype(np.float32))

# bank check: water level vs ground just outside the water
ring = ndimage.binary_dilation(wet, iterations=1) & ~wet
near = ndimage.grey_dilation(np.where(wet, surf, -1e9), size=3)
spill = ring & (dem_g < near - 0.05)
log("bank samples below adjacent water level (need carving/levees): %d of %d" % (spill.sum(), ring.sum()))


def body_meta(b):
    d = TYPE_DEFAULTS[b["type"]]
    alb = list(d["albedo"])
    if b.get("s2"):
        c = np.array(b["s2"])
        # measured reflectance includes ~2% specular skylight residual; clamp into a plausible range per type
        c = np.clip(c - 0.008, 0.004, 0.5)
        lo = {"river_fast": 0.04, "river": 0.03, "canal": 0.02, "stream": 0.015, "pond": 0.01, "industrial": 0.08, "pool": 0.01}[b["type"]]
        hi = {"river_fast": 0.16, "river": 0.14, "canal": 0.10, "stream": 0.08, "pond": 0.09, "industrial": 0.45, "pool": 0.2}[b["type"]]
        m = np.clip(c.mean(), lo, hi) / max(c.mean(), 1e-4)
        alb = [float(v) for v in np.clip(c * m, 0.004, 0.6)]
        # blend 30% towards the type default hue to suppress S2 noise on small bodies
        alb = [0.7 * a + 0.3 * t for a, t in zip(alb, d["albedo"])]
    out = dict(idx=b["idx"], type=b["type"], typeId=TYPE_ID[b["type"]], name=b["name"],
               albedo=[round(a, 4) for a in alb], ext=d["ext"], speed=d["speed"], rough=d["rough"], wind=d["wind"])
    if not b["flowing"]:
        out["level"] = round(float(b["level"]), 2)
    if b.get("s2"):
        out["s2"] = [round(v, 4) for v in b["s2"]]
    if b.get("width"):
        out["width"] = round(b["width"], 1)
    if b["geom"] is not None:
        out["area"] = round(b["geom"].area)
    return out


meta_bodies = [body_meta(b) for b in bodies]
json.dump(meta_bodies, open(os.path.join(PROC, "water_bodies.json"), "w"), ensure_ascii=False, indent=1)
log("rasters written")
if STAGE == "raster":
    sys.exit(0)

# ====================================================================================== meshes
import triangle as tr_lib

MARGIN = 6.0         # mesh extends beyond the mapped shoreline; the terrain hides what is under the banks
TILE = 1024.0
flow_speed_max = {b["idx"]: TYPE_DEFAULTS[b["type"]]["speed"] for b in bodies}

# final (non-overlapping) mesh polygons per body following the same precedence as the raster
final_geoms = {}
taken = None
for b in reversed(order):
    g = b["geom"]
    if g is None:
        continue
    gb = clean(g.buffer(MARGIN if b["type"] != "pool" else 0.3, join_style="round").intersection(REGION))
    if gb is None:
        continue
    if taken is not None:
        gb = clean(gb.difference(taken))
        if gb is None:
            continue
    final_geoms[b["idx"]] = gb
    taken = g if taken is None else shapely.union_all([taken, g])
log("mesh polygons", len(final_geoms))

# bar raster on the vertex grid as float for per-vertex sampling (1 = bar/island)
bar_f = ndimage.gaussian_filter(bar_v.astype(np.float32), 1.0)


def triangulate(poly, max_area, seg_len):
    poly = shapely.segmentize(shapely.simplify(poly, 0.4), seg_len)
    verts = []
    segs = []
    holes = []
    rings = [poly.exterior] + list(poly.interiors)
    for k, ring in enumerate(rings):
        c = np.asarray(ring.coords)[:-1]
        if len(c) < 3:
            continue
        n0 = len(verts)
        verts.extend(c.tolist())
        n = len(c)
        segs.extend([[n0 + i, n0 + (i + 1) % n] for i in range(n)])
        if k > 0:
            hp = shapely.Polygon(ring).representative_point()
            holes.append([hp.x, hp.y])
    if len(verts) < 3:
        return None, None
    d = dict(vertices=np.array(verts, float), segments=np.array(segs, np.int32))
    if holes:
        d["holes"] = np.array(holes, float)
    try:
        t = tr_lib.triangulate(d, f"pq26a{max_area:.1f}")
    except Exception as e:  # noqa
        log("triangulate failed", e)
        return None, None
    if "triangles" not in t:
        return None, None
    return t["vertices"], t["triangles"]


all_v = []    # arrays per piece
all_t = []
all_b = []
nv = 0
for bidx, g in final_geoms.items():
    b = bodies[bidx]
    kind = b["type"]
    max_area = {"river_fast": 60, "river": 60, "canal": 40, "stream": 20, "pond": 250, "industrial": 400, "pool": 50}[kind]
    seg = {"river_fast": 8, "river": 8, "canal": 8, "stream": 5, "pond": 10, "industrial": 14, "pool": 3}[kind]
    if g.area > 4e5 and kind in ("pond", "industrial"):
        max_area *= 2
    for p in as_polys(g):
        V, Tt = triangulate(p, max_area, seg)
        if V is None or len(Tt) == 0:
            continue
        all_v.append(V)
        all_t.append(Tt + nv)
        all_b.append(np.full(len(V), bidx, np.int32))
        nv += len(V)
V = np.concatenate(all_v)
T = np.concatenate(all_t)
B = np.concatenate(all_b)
log("triangulated: %d vertices %d triangles" % (len(V), len(T)))

# --- per-vertex attributes
x, y = V[:, 0], V[:, 1]
lev = np.zeros(len(V))
fx = np.zeros(len(V))
fy = np.zeros(len(V))
shore = np.zeros(len(V))
foam = np.zeros(len(V))
barp = np.clip(vsample(bar_f, x, y) * 1.6, 0, 1)

orig_geom = {b["idx"]: b["geom"] for b in bodies if b["geom"] is not None}


def tangent(line, s):
    L = line.length
    a = shapely.line_interpolate_point(line, np.clip(s - 15, 0, L))
    c = shapely.line_interpolate_point(line, np.clip(s + 15, 0, L))
    tx = shapely.get_x(c) - shapely.get_x(a)
    ty = shapely.get_y(c) - shapely.get_y(a)
    ln = np.hypot(tx, ty) + 1e-9
    return tx / ln, ty / ln


for bidx in np.unique(B):
    sel = B == bidx
    b = bodies[bidx]
    px, py = x[sel], y[sel]
    pts_ = shapely.points(px, py)
    g0 = orig_geom[bidx]
    bd = shapely.distance(g0.boundary, pts_)
    inside = shapely.contains_xy(g0, px, py)
    sd = np.where(inside, bd, -bd)
    if b is kub:
        lv, oz, sk, sz = river_level(px, py)
        tx_, ty_, rel = river_flow(px, py)
        vmax = np.where(oz, TYPE_DEFAULTS["river"]["speed"], TYPE_DEFAULTS["river_fast"]["speed"])
        # potential-flow speed-up in narrows / slow-down in wide pools and dead-end backwaters
        vmax = vmax * np.clip(0.35 + 0.65 * rel, 0.05, 1.5)
        # slower in the weir pool, very fast over the weir, turbulent below it
        f_extra = np.zeros(len(px))
        if s_weir is not None:
            ds = sk - s_weir
            wd = np.hypot(px - weir_pt.x, py - weir_pt.y)
            pool = (~oz) & (ds < 0) & (ds > -900) & (wd < 1200)
            vmax = np.where(pool, vmax * (0.35 + 0.65 * np.clip(-ds / 900, 0, 1)), vmax)
            below = (~oz) & (ds >= -6) & (ds < 160) & (wd < 400)
            vmax = np.where(below, vmax * (1.0 + 0.9 * np.exp(-np.maximum(ds, 0) / 60)), vmax)
            f_extra = np.where(below, np.exp(-np.maximum(ds, 0) / 50), 0)
        # channel velocity profile: slow at banks, fast mid-stream
        prof = np.clip(np.maximum(sd, 0) / 16.0, 0, 1) ** 0.5
        spd = vmax * (0.12 + 0.88 * prof) * (1 - 0.5 * barp[sel])
        # local slope of the profile -> riffles
        slope_k = -np.gradient(k_pr, k_st)
        slope_z = -np.gradient(z_pr, z_st)
        sl = np.where(oz, np.interp(sz, z_st, slope_z), np.interp(sk, k_st, slope_k))
        rif = np.clip((sl - 0.0018) / 0.004, 0, 1) * np.clip(rel, 0, 1)
        foam[sel] = np.clip(0.3 * rif + 0.5 * barp[sel] + f_extra, 0, 1)
        fx[sel] = tx_ * spd
        fy[sel] = ty_ * spd
        lev[sel] = lv
    elif b["flowing"]:
        s = shapely.line_locate_point(b["line"], pts_)
        lev[sel] = np.interp(s, b["st"], b["pr"])
        tx_, ty_ = tangent(b["line"], s)
        hw = max(1.0, b["width"] / 2)
        prof = np.clip(np.maximum(sd, 0) / (hw * 0.6), 0, 1) ** 0.5
        spd = TYPE_DEFAULTS[b["type"]]["speed"] * (0.2 + 0.8 * prof)
        fx[sel] = tx_ * spd
        fy[sel] = ty_ * spd
    else:
        lev[sel] = b["level"]
    shore[sel] = sd
log("attributes done")

# --- tiles
cx = (x[T].mean(1))
cy = (y[T].mean(1))
ti = np.clip(((cx + H) // TILE).astype(int), 0, int(2 * H / TILE) - 1)
tj = np.clip(((H - cy) // TILE).astype(int), 0, int(2 * H / TILE) - 1)
tkey = tj * 100 + ti
sections = {k: [] for k in ("pos", "flow", "attr", "body", "index")}
tiles = []
off = {k: 0 for k in sections}
for key in np.unique(tkey):
    tris = T[tkey == key]
    uv, inv = np.unique(tris.ravel(), return_inverse=True)
    if len(uv) >= 65535:
        raise RuntimeError("tile too large")
    idx = inv.reshape(-1, 3).astype(np.uint16)
    j, i = divmod(int(key), 100)
    tcx = -H + (i + 0.5) * TILE          # world x of tile centre
    tcz = -(H - (j + 0.5) * TILE)        # world z of tile centre (z = -north)
    vx = x[uv]
    vz = -y[uv]
    pos = np.zeros((len(uv), 3), np.int16)
    pos[:, 0] = np.round((vx - tcx) * 10).astype(np.int16)
    pos[:, 1] = np.round((vz - tcz) * 10).astype(np.int16)
    pos[:, 2] = np.clip(np.round((lev[uv] - 200.0) * 100), 0, 65535).astype(np.uint16).view(np.int16)
    fl = np.zeros((len(uv), 2), np.int8)
    fl[:, 0] = np.clip(np.round(fx[uv] / 0.05), -127, 127)
    fl[:, 1] = np.clip(np.round(-fy[uv] / 0.05), -127, 127)       # world z = -north
    at = np.zeros((len(uv), 4), np.uint8)
    at[:, 0] = np.clip(np.round((shore[uv] + 8) * 4), 0, 255)
    at[:, 1] = np.clip(np.round(foam[uv] * 255), 0, 255)
    at[:, 2] = np.clip(np.round(barp[uv] * 255), 0, 255)
    bo = B[uv].astype(np.uint16)
    rec = dict(i=int(i), j=int(j), cx=tcx, cz=tcz, nv=int(len(uv)), nt=int(len(idx)),
               yMin=round(float(lev[uv].min()), 2), yMax=round(float(lev[uv].max()), 2),
               bbox=[round(float(vx.min()), 1), round(float(vz.min()), 1), round(float(vx.max()), 1), round(float(vz.max()), 1)],
               bodies=sorted(set(int(q) for q in np.unique(bo))))
    for k, arr in (("pos", pos), ("flow", fl), ("attr", at), ("body", bo), ("index", idx)):
        buf = np.ascontiguousarray(arr).tobytes()
        pad = (-len(buf)) % 4
        rec[k] = off[k]
        sections[k].append(buf + b"\0" * pad)
        off[k] += len(buf) + pad
    tiles.append(rec)

blob = b""
layout = {}
for k in ("pos", "flow", "attr", "body", "index"):
    data = b"".join(sections[k])
    layout[k] = dict(offset=len(blob), bytes=len(data))
    blob += data
out_dir = os.path.join(WEB_DATA, "water")
os.makedirs(out_dir, exist_ok=True)
with gzip.open(os.path.join(out_dir, "water.bin.gz"), "wb", compresslevel=9) as fh:
    fh.write(blob)

weir_world = None
if weir_pt is not None:
    # weir crest as a line across the river (the bridge/barrage through the weir point)
    best = None
    for br in bridges:
        dd_ = br["g"].distance(weir_pt)
        if dd_ < 30 and (best is None or dd_ < best[0]):
            best = (dd_, br["g"])
    if best is not None:
        crest = best[1].intersection(river_union.buffer(5))
        cl = [list(c) for c in (crest.coords if crest.geom_type == "LineString" else max(crest.geoms, key=lambda q: q.length).coords)]
        weir_world = dict(line=[[round(a, 1), round(-b_, 1)] for a, b_ in cl], up=round(float(np.interp(s_weir - 20, k_st, k_pr)), 2),
                          down=round(float(np.interp(s_weir + 20, k_st, k_pr)), 2))

meta = dict(
    version=1,
    tile=TILE,
    frame="world: x east, z = -north; positions int16 dm relative to tile centre; level uint16 cm above 200 m",
    layout=layout,
    tiles=tiles,
    bodies=meta_bodies,
    types=TYPE_ID,
    weir=weir_world,
    kubanProfile=dict(s=[round(float(v), 1) for v in k_st[::4]], level=[round(float(v), 2) for v in k_pr[::4]]),
    stats=dict(vertices=int(len(V)), triangles=int(len(T)), samples=int(wet.sum())),
)
json.dump(meta, open(os.path.join(out_dir, "water.json"), "w"), ensure_ascii=False, separators=(",", ":"))
log("written public/data/water: %.2f MB gz, %d tiles" % (os.path.getsize(os.path.join(out_dir, "water.bin.gz")) / 1e6, len(tiles)))

# procedural textures (public/textures/water) - regenerate when missing
_tex_dir = os.path.join(ROOT, "public", "textures", "water")
if not all(os.path.exists(os.path.join(_tex_dir, f)) for f in ("ripple_n.png", "wave_n.png", "foam.png", "noise.png")):
    import runpy
    runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "water_textures.py"), run_name="__main__")
