"""Geometry helpers for build_buildings.py: footprint cleaning, squaring
(orthogonalisation) and rectangle decomposition for pitched roofs.

All functions work in pipeline coordinates (x = east, y = north, metres).
"""
import math

import numpy as np
import shapely
from shapely.geometry import Polygon, MultiPolygon, GeometryCollection, box
from shapely import affinity


# ----------------------------------------------------------------- basics

def polygons_of(g, min_area=4.0):
    """Explode any geometry into valid polygons (area >= min_area)."""
    if g is None or g.is_empty:
        return []
    if not g.is_valid:
        g = shapely.make_valid(g)
    out = []
    if isinstance(g, Polygon):
        if g.area >= min_area:
            out.append(g)
    elif isinstance(g, (MultiPolygon, GeometryCollection)):
        for p in g.geoms:
            out += polygons_of(p, min_area)
    return out


def mrr_dims(p):
    """(length, width, angle_of_long_side_rad, rect_polygon) of the minimum rotated rectangle."""
    r = p.minimum_rotated_rectangle
    if r.geom_type != 'Polygon':
        return 0.0, 0.0, 0.0, r
    c = np.asarray(r.exterior.coords)
    e0 = c[1] - c[0]
    e1 = c[2] - c[1]
    l0, l1 = math.hypot(*e0), math.hypot(*e1)
    if l0 >= l1:
        return l0, l1, math.atan2(e0[1], e0[0]), r
    return l1, l0, math.atan2(e1[1], e1[0]), r


def dominant_angle(p):
    """Edge-length weighted dominant orientation (mod 90 deg), radians in [-pi/4, pi/4)."""
    c = np.asarray(p.exterior.coords)
    d = np.diff(c, axis=0)
    L = np.hypot(d[:, 0], d[:, 1])
    a = np.arctan2(d[:, 1], d[:, 0])
    s = (L * np.sin(4 * a)).sum()
    k = (L * np.cos(4 * a)).sum()
    return math.atan2(s, k) / 4.0


def orthogonality(p, theta=None):
    """Fraction of perimeter whose edges are within 10 deg of the dominant axes."""
    if theta is None:
        theta = dominant_angle(p)
    tot = 0.0
    ok = 0.0
    for ring in [p.exterior, *p.interiors]:
        c = np.asarray(ring.coords)
        d = np.diff(c, axis=0)
        L = np.hypot(d[:, 0], d[:, 1])
        a = np.arctan2(d[:, 1], d[:, 0]) - theta
        dev = np.abs(((a + math.pi / 4) % (math.pi / 2)) - math.pi / 4)
        tot += L.sum()
        ok += L[dev < math.radians(10)].sum()
    return ok / max(tot, 1e-9)


# ----------------------------------------------------------------- squaring

def _square_ring(c, tol_rad, min_edge):
    """Orthogonalise a ring already rotated so its dominant axes are x/y.
    c: (n,2) closed? no - open ring (first != last). Returns open ring or None."""
    n = len(c)
    if n < 4:
        return None
    # classify edges
    types = []
    for i in range(n):
        a, b = c[i], c[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        if L < 1e-6:
            types.append(('X', 0.0, a, b))
            continue
        ang = math.atan2(dy, dx)
        dev = abs(((ang + math.pi / 4) % (math.pi / 2)) - math.pi / 4)
        if dev > tol_rad:
            return None
        types.append(('H' if abs(dx) >= abs(dy) else 'V', L, a, b))
    types = [t for t in types if t[0] != 'X']
    if len(types) < 4:
        return None
    # lines: (type, value, weight)
    lines = []
    for t, L, a, b in types:
        v = (a[1] + b[1]) / 2 if t == 'H' else (a[0] + b[0]) / 2
        lines.append([t, v, L])

    def merge_same(lines):
        changed = True
        while changed and len(lines) >= 2:
            changed = False
            out = []
            i = 0
            while i < len(lines):
                cur = list(lines[i])
                while i + 1 < len(lines) and lines[i + 1][0] == cur[0]:
                    nx = lines[i + 1]
                    w = cur[2] + nx[2]
                    cur[1] = (cur[1] * cur[2] + nx[1] * nx[2]) / max(w, 1e-9)
                    cur[2] = w
                    i += 1
                    changed = True
                out.append(cur)
                i += 1
            if len(out) >= 2 and out[0][0] == out[-1][0]:
                a, b = out[0], out[-1]
                w = a[2] + b[2]
                a[1] = (a[1] * a[2] + b[1] * b[2]) / max(w, 1e-9)
                a[2] = w
                out.pop()
                changed = True
            lines = out
        return lines

    lines = merge_same(lines)
    # iteratively remove tiny edges: an edge is the segment on line i between
    # its intersections with lines i-1 and i+1
    for _ in range(64):
        m = len(lines)
        if m < 4 or m % 2:
            return None
        lens = []
        for i in range(m):
            p, q = lines[i - 1], lines[(i + 1) % m]
            lens.append(abs(q[1] - p[1]))
        j = int(np.argmin(lens))
        if lens[j] >= min_edge:
            break
        # drop line j: its neighbours (same type) merge
        del lines[j]
        lines = merge_same(lines)
    m = len(lines)
    if m < 4 or m % 2:
        return None
    pts = []
    for i in range(m):
        a, b = lines[i], lines[(i + 1) % m]
        if a[0] == 'H':
            pts.append((b[1], a[1]))
        else:
            pts.append((a[1], b[1]))
    return np.asarray(pts)


def square_polygon(p, tol_deg=12.0, min_edge=0.6):
    """Snap near-orthogonal footprints to exact right angles. Returns (polygon, theta)
    or (None, theta) if the shape is not near-orthogonal."""
    theta = dominant_angle(p)
    cx, cy = p.centroid.x, p.centroid.y
    ca, sa = math.cos(-theta), math.sin(-theta)

    def rot(c, ca, sa):
        x = c[:, 0] - cx
        y = c[:, 1] - cy
        return np.column_stack([x * ca - y * sa, x * sa + y * ca])

    rings = []
    for k, ring in enumerate([p.exterior, *p.interiors]):
        c = np.asarray(ring.coords)[:-1]
        r = _square_ring(rot(c, ca, sa), math.radians(tol_deg), min_edge)
        if r is None:
            if k == 0:
                return None, theta
            continue  # drop an irregular hole
        rings.append(r)
    ca2, sa2 = math.cos(theta), math.sin(theta)
    back = []
    for r in rings:
        x = r[:, 0] * ca2 - r[:, 1] * sa2 + cx
        y = r[:, 0] * sa2 + r[:, 1] * ca2 + cy
        back.append(np.column_stack([x, y]))
    try:
        q = Polygon(back[0], back[1:])
    except Exception:
        return None, theta
    if not q.is_valid or q.is_empty:
        return None, theta
    return q, theta


# ----------------------------------------------------------------- roof rectangles

def rect_decompose(p, theta, max_rects=4, cover=0.96):
    """Cover an orthogonal polygon (dominant angle theta) with a few, possibly
    overlapping, maximal rectangles (greedy set cover). Returns list of
    (cx, cy, half_len, half_wid, angle) with angle = direction of the long side,
    or [] if decomposition fails."""
    if len(p.interiors):
        return []
    cx0, cy0 = p.centroid.x, p.centroid.y
    q = affinity.rotate(p, -theta, origin=(cx0, cy0), use_radians=True)
    c = np.asarray(q.exterior.coords)[:-1]
    xs = np.unique(np.round(c[:, 0], 2))
    ys = np.unique(np.round(c[:, 1], 2))
    if len(xs) > 14 or len(ys) > 14 or len(xs) < 2 or len(ys) < 2:
        return []
    nx, ny = len(xs) - 1, len(ys) - 1
    inside = np.zeros((ny, nx), bool)
    for j in range(ny):
        for i in range(nx):
            pt = shapely.Point((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2)
            inside[j, i] = q.contains(pt)
    cell_area = np.outer(np.diff(ys), np.diff(xs))
    total = (cell_area * inside).sum()
    if total <= 0:
        return []
    # prefix sums of "outside" count
    out = (~inside).astype(np.int32)
    P = np.zeros((ny + 1, nx + 1), np.int32)
    P[1:, 1:] = out.cumsum(0).cumsum(1)

    def full(i0, i1, j0, j1):  # cells [i0,i1) x [j0,j1)
        return P[j1, i1] - P[j0, i1] - P[j1, i0] + P[j0, i0] == 0

    rects = []
    for i0 in range(nx):
        for i1 in range(i0 + 1, nx + 1):
            for j0 in range(ny):
                for j1 in range(j0 + 1, ny + 1):
                    if not full(i0, i1, j0, j1):
                        break
                    # maximal? (cannot extend in any direction)
                    if i0 > 0 and full(i0 - 1, i1, j0, j1):
                        continue
                    if i1 < nx and full(i0, i1 + 1, j0, j1):
                        continue
                    if j0 > 0 and full(i0, i1, j0 - 1, j1):
                        continue
                    if j1 < ny and full(i0, i1, j0, j1 + 1):
                        continue
                    rects.append((i0, i1, j0, j1))
    if not rects:
        return []
    covered = np.zeros_like(inside)
    chosen = []
    while len(chosen) < max_rects:
        best, bestv = None, 0.0
        for r in rects:
            i0, i1, j0, j1 = r
            gain = (cell_area[j0:j1, i0:i1] * (~covered[j0:j1, i0:i1])).sum()
            if gain > bestv + 1e-6:
                best, bestv = r, gain
        if best is None or bestv < 0.02 * total:
            break
        i0, i1, j0, j1 = best
        covered[j0:j1, i0:i1] = True
        chosen.append(best)
        if (cell_area * covered).sum() >= cover * total:
            break
    if (cell_area * covered).sum() < 0.85 * total:
        return []
    res = []
    ct, st = math.cos(theta), math.sin(theta)
    for i0, i1, j0, j1 in chosen:
        x0, x1, y0, y1 = xs[i0], xs[i1], ys[j0], ys[j1]
        mx, my = (x0 + x1) / 2 - cx0, (y0 + y1) / 2 - cy0
        wx, wy = (x1 - x0) / 2, (y1 - y0) / 2
        gx = mx * ct - my * st + cx0
        gy = mx * st + my * ct + cy0
        if wx >= wy:
            res.append((gx, gy, wx, wy, theta))
        else:
            res.append((gx, gy, wy, wx, theta + math.pi / 2))
    return res
