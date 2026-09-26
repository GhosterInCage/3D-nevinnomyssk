"""Stage 2 of build_buildings.py: per-building feature table used for
typology classification and the level (storey count) model.

Features: shape (area, MRR length/width, elongation, compactness, rectangularity,
vertex count), Copernicus DSM relief (several local statistics), Sentinel-2 shadow
contrast (dark band on the anti-sun side of the footprint), neighbourhood density,
Overture land use / land cover, WorldCover, distance to centre and to roads.
"""
import math
import os

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely import from_wkb, STRtree
from scipy import ndimage
from scipy.spatial import cKDTree
from rasterio import features as rfeatures
from affine import Affine

from config import RAW, PROC, REGION_HALF, to_local
from buildings_geom import mrr_dims

CENTRE = (182.0, -64.0)  # Eternal Flame, pipeline coords (x east, y north)

LANDUSE_KEYS = ["residential", "industrial", "works", "garages", "allotments", "school", "kindergarten",
                "university", "hospital", "farmyard", "farmland", "cemetery", "military", "religious",
                "construction", "stadium", "park", "greenhouse_horticulture", "landfill", "quarry"]


def _local(g, tr):
    return shapely.transform(g, lambda c: np.column_stack(tr.transform(c[:, 0], c[:, 1])))


def load_landuse():
    tr = to_local()
    t = pq.read_table(os.path.join(RAW, "base_land_use.parquet")).to_pylist()
    geoms, cls = [], []
    for r in t:
        g = _local(from_wkb(r["geometry"]), tr)
        if g.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        geoms.append(g)
        cls.append(r["class"])
    return np.array(geoms, dtype=object), np.array(cls)


def load_roads():
    tr = to_local()
    t = pq.read_table(os.path.join(RAW, "transportation_segment.parquet"),
                      columns=["subtype", "class", "geometry"]).to_pylist()
    major, minor, rail = [], [], []
    for r in t:
        g = _local(from_wkb(r["geometry"]), tr)
        if r["subtype"] == "rail":
            rail.append(g)
        elif r["class"] in ("trunk", "primary", "secondary", "tertiary"):
            major.append(g)
        elif r["class"] in ("residential", "service", "unclassified", "living_street"):
            minor.append(g)
    return (np.array(major, dtype=object), np.array(minor, dtype=object), np.array(rail, dtype=object))


def _bilinear(img, x, y, x0, y0, res):
    """Sample a north-up raster whose sample (i,j) centre is at (x0 + i*res, y0 - j*res)."""
    fx = (x - x0) / res
    fy = (y0 - y) / res
    h, w = img.shape[:2]
    fx = np.clip(fx, 0, w - 1.001)
    fy = np.clip(fy, 0, h - 1.001)
    i = np.floor(fx).astype(int)
    j = np.floor(fy).astype(int)
    ax = fx - i
    ay = fy - j
    a = img[j, i]
    b = img[j, i + 1]
    c = img[j + 1, i]
    d = img[j + 1, i + 1]
    if img.ndim == 3:
        ax = ax[:, None]
        ay = ay[:, None]
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay


def compute(recs, verbose=True):
    n = len(recs)
    geoms = np.array([r["geom"] for r in recs], dtype=object)
    area = shapely.area(geoms)
    perim = shapely.length(geoms)
    cen = shapely.centroid(geoms)
    cx = shapely.get_x(cen)
    cy = shapely.get_y(cen)
    F = {}
    F["area"] = area
    F["log_area"] = np.log(area)
    L = np.zeros(n)
    W = np.zeros(n)
    ang = np.zeros(n)
    for k, g in enumerate(geoms):
        L[k], W[k], ang[k], _ = mrr_dims(g)
    F["length"] = L
    F["width"] = W
    F["elong"] = L / np.maximum(W, 0.5)
    F["compact"] = 4 * math.pi * area / np.maximum(perim, 1e-3) ** 2
    F["rectness"] = area / np.maximum(L * W, 1e-3)
    F["nverts"] = np.array([len(g.exterior.coords) - 1 for g in geoms], float)
    F["osm"] = np.array([r["osm"] for r in recs], float)
    F["dist_centre"] = np.hypot(cx - CENTRE[0], cy - CENTRE[1])

    # ------------------------------------------------ DSM relief
    raw = np.load(os.path.join(PROC, "dem_raw.npy"))
    exc = np.load(os.path.join(PROC, "dsm_excess.npy"))
    x0, y0, res = -REGION_HALF, REGION_HALF, 10.0  # vertex-centred 2049 grid
    lo11 = ndimage.percentile_filter(raw, 15, size=11)
    lo5 = ndimage.percentile_filter(raw, 20, size=5)
    mx3 = ndimage.maximum_filter(raw, size=3)
    F["dsm_sig"] = _bilinear(mx3 - lo11, cx, cy, x0, y0, res)
    F["dsm_sig5"] = _bilinear(raw - lo5, cx, cy, x0, y0, res)
    F["dsm_exc"] = _bilinear(exc, cx, cy, x0, y0, res)
    # footprint-wide max/mean via label raster (only buildings covering pixel centres)
    tf = Affine(res, 0, x0 - res / 2, 0, -res, y0 + res / 2)
    shapes = ((g, k + 1) for k, g in enumerate(geoms) if area[k] > 60)
    lab = rfeatures.rasterize(shapes, out_shape=raw.shape, transform=tf, fill=0, dtype="int32")
    idx = np.arange(1, n + 1)
    sig = raw - lo11
    has = np.bincount(lab.ravel(), minlength=n + 1)[1:] > 0
    mxl = np.array(ndimage.maximum(sig, lab, idx))
    mnl = np.array(ndimage.mean(sig, lab, idx))
    F["dsm_fmax"] = np.where(has, mxl, F["dsm_sig"])
    F["dsm_fmean"] = np.where(has, mnl, F["dsm_sig5"])
    F["dsm_npx"] = np.bincount(lab.ravel(), minlength=n + 1)[1:].astype(float)

    # ------------------------------------------------ Sentinel-2 shadow contrast
    rgb = np.load(os.path.join(PROC, "s2_rgb.npy"))
    bri = rgb.mean(axis=2).astype(np.float32)
    ndvi = np.load(os.path.join(PROC, "s2_ndvi.npy")).astype(np.float32)
    sx0, sy0 = -REGION_HALF + 5, REGION_HALF - 5  # pixel-centred 2048 grid
    # shadow direction (S2 overpass ~11:00 solar time, summer): sun az ~150 deg -> shadow to az ~330
    saz = math.radians(330.0)
    sdx, sdy = math.sin(saz), math.cos(saz)
    shadow_near = np.full(n, np.nan)
    shadow_far = np.full(n, np.nan)
    sun_side = np.full(n, np.nan)
    ndvi_ring = np.zeros(n)
    rng = np.random.default_rng(1)
    for k, g in enumerate(geoms):
        if area[k] < 120:
            continue
        # sample points in the footprint translated by d along the shadow direction, excluding the footprint
        vals = []
        for d in (7.0, 16.0, -9.0):
            sh = shapely.affinity.translate(g, d * sdx, d * sdy)
            reg = sh.difference(g.buffer(1.5))
            if reg.is_empty or reg.area < 5:
                vals.append(np.nan)
                continue
            b = reg.bounds
            m = max(8, min(60, int(reg.area / 4)))
            px = rng.uniform(b[0], b[2], m * 3)
            py = rng.uniform(b[1], b[3], m * 3)
            ins = shapely.contains_xy(reg, px, py)
            if ins.sum() < 3:
                vals.append(np.nan)
                continue
            vals.append(float(_bilinear(bri, px[ins], py[ins], sx0, sy0, 10.0).mean()))
        shadow_near[k], shadow_far[k], sun_side[k] = vals
    ref = np.where(np.isfinite(sun_side), sun_side, np.nan)
    F["shadow_near"] = np.nan_to_num(shadow_near / np.maximum(ref, 1e-3), nan=1.0)
    F["shadow_far"] = np.nan_to_num(shadow_far / np.maximum(ref, 1e-3), nan=1.0)
    F["ndvi_c"] = _bilinear(ndvi, cx, cy, sx0, sy0, 10.0)
    ndvi_s = ndimage.uniform_filter(ndvi, 7)
    F["ndvi_70"] = _bilinear(ndvi_s, cx, cy, sx0, sy0, 10.0)
    wc = np.load(os.path.join(PROC, "worldcover.npy"))
    built = ndimage.uniform_filter((wc == 50).astype(np.float32), 11)
    F["built_110"] = _bilinear(built, cx, cy, sx0, sy0, 10.0)

    # ------------------------------------------------ neighbourhood
    pts = np.column_stack([cx, cy])
    kd = cKDTree(pts)
    for r in (60.0, 150.0, 300.0):
        cnt = np.array([len(x) - 1 for x in kd.query_ball_point(pts, r)], float)
        F[f"n_{int(r)}"] = cnt
    nb = kd.query_ball_point(pts, 150.0)
    big = area > 400
    F["nb_big_frac"] = np.array([big[x].mean() if len(x) else 0 for x in nb])
    F["nb_med_area"] = np.array([np.median(area[x]) if len(x) else 0 for x in nb])
    F["nb_max_area"] = np.array([area[[j for j in x if j != k]].max() if len(x) > 1 else 0 for k, x in enumerate(nb)])
    dd, _ = kd.query(pts, k=2)
    F["nn_dist"] = dd[:, 1]
    # similar-shape neighbours (apartment micro-districts: long blocks of similar width)
    blk = (W > 9) & (W < 18) & (L > 25)
    F["nb_blocks"] = np.array([blk[x].sum() for x in nb], float)

    # ------------------------------------------------ land use
    lu_g, lu_c = load_landuse()
    tree = STRtree(lu_g)
    bi, li = tree.query(cen, predicate="within")
    lu = np.array([""] * n, dtype=object)
    lu_area = np.full(n, np.inf)
    lu_areas = shapely.area(lu_g)
    for b, l in zip(bi, li):
        if lu_areas[l] < lu_area[b]:
            lu_area[b] = lu_areas[l]
            lu[b] = lu_c[l]
    F["landuse"] = lu
    for k in LANDUSE_KEYS:
        F["lu_" + k] = (lu == k).astype(float)

    # ------------------------------------------------ roads
    major, minor, rail = load_roads()
    for name, arr in (("d_major", major), ("d_minor", minor), ("d_rail", rail)):
        t = STRtree(arr)
        near = t.query_nearest(geoms, return_distance=True, max_distance=2000)
        dist = np.full(n, 2000.0)
        dist[near[0][0]] = near[1]
        F[name] = dist
    F["cx"] = cx
    F["cy"] = cy
    F["angle"] = ang
    if verbose:
        print(f"[features] {n} buildings, {len(F)} features")
    return F


# ---------------------------------------------------------------------------
# Winter Sentinel-2 shadow profiles (see buildings_s2winter.py)

H_BINS = np.array([0, 4, 8, 12, 16, 20, 25, 30, 36, 44, 56, 70], float)


def _ring_uv(c, s, p):
    return c @ p, c @ s


def _far_near(u_s, U, V):
    """For each u in u_s: max and min v of the polygon boundary crossing u."""
    u0, u1 = U[:-1], U[1:]
    v0, v1 = V[:-1], V[1:]
    lo = np.minimum(u0, u1)
    hi = np.maximum(u0, u1)
    du = np.where(np.abs(u1 - u0) < 1e-9, 1e-9, u1 - u0)
    far = np.full(len(u_s), -np.inf)
    near = np.full(len(u_s), np.inf)
    for k in range(len(u0)):
        m = (u_s >= lo[k]) & (u_s <= hi[k])
        if not m.any():
            continue
        t = (u_s[m] - u0[k]) / du[k]
        v = v0[k] + t * (v1[k] - v0[k])
        far[m] = np.maximum(far[m], v)
        near[m] = np.minimum(near[m], v)
    return far, near


def shadow_features(geoms, scene_files, min_area=25.0, verbose=True):
    """Per building: mean normalised brightness in height-equivalent bins behind the
    anti-sun edge (averaged over scenes) + integrated darkness 'shadow height'."""
    n = len(geoms)
    nb = len(H_BINS) - 1
    acc = np.zeros((n, nb))
    cnt = np.zeros((n, nb))
    hint = [[] for _ in range(n)]
    hrec = [[] for _ in range(n)]
    hmin = [[] for _ in range(n)]
    x0, y0 = -REGION_HALF + 5, REGION_HALF - 5
    areas = shapely.area(geoms)
    for f in scene_files:
        d = np.load(f)
        bri = d["bri"].astype(np.float32)
        if np.isfinite(bri).mean() < 0.6:
            continue
        el = float(d["sun_el"])
        az = float(d["sun_az"])
        tel = math.tan(math.radians(el))
        a = math.radians(az + 180.0)
        s = np.array([math.sin(a), math.cos(a)])
        p = np.array([s[1], -s[0]])
        dmax = H_BINS[-1] / tel
        ds = np.arange(1.25, dmax + 30.0, 2.5)
        hs = ds * tel
        bidx = np.clip(np.searchsorted(H_BINS, hs, side="right") - 1, 0, nb - 1)
        inb = hs < H_BINS[-1]
        farm = hs >= H_BINS[-1]
        dref = np.arange(6.0, 30.0, 3.0)
        # nan-aware bilinear: fill NaN with local mean for sampling, mask separately
        valid = np.isfinite(bri)
        bri_f = np.where(valid, bri, np.nanmean(bri))
        for k in range(n):
            if areas[k] < min_area:
                continue
            c = np.asarray(geoms[k].exterior.coords)
            U, V = _ring_uv(c, s, p)
            umin, umax = U.min(), U.max()
            w = umax - umin
            m = max(3, min(24, int(w / 2.5)))
            u_s = np.linspace(umin + 0.12 * w, umax - 0.12 * w, m)
            far, near = _far_near(u_s, U, V)
            ok = np.isfinite(far) & np.isfinite(near)
            if ok.sum() < 2:
                continue
            u_s, far, near = u_s[ok], far[ok], near[ok]
            # shadow side samples
            qu = np.repeat(u_s, len(ds))
            qv = (far[:, None] + ds[None, :]).ravel()
            qx = qu * p[0] + qv * s[0]
            qy = qu * p[1] + qv * s[1]
            B = _bilinear(bri_f, qx, qy, x0, y0, 10.0).reshape(len(u_s), len(ds)).mean(0)
            # sun side reference
            ru = np.repeat(u_s, len(dref))
            rv = (near[:, None] - dref[None, :]).ravel()
            rx = ru * p[0] + rv * s[0]
            ry = ru * p[1] + rv * s[1]
            ref_sun = np.median(_bilinear(bri_f, rx, ry, x0, y0, 10.0))
            ref_far = np.median(B[farm]) if farm.any() else ref_sun
            ref = max(0.5 * (ref_sun + ref_far), 1e-3)
            r = B / ref
            np.add.at(acc[k], bidx[inb], r[inb])
            np.add.at(cnt[k], bidx[inb], 1)
            dark = np.clip(1.0 - r[inb], 0, None)
            hint[k].append(float(np.trapezoid(dark, hs[inb])))
            # recovery height: first height after the darkest point where the profile is back
            # above halfway between its minimum and 1
            ri = r[inb]
            j0 = int(np.argmin(ri[: max(1, int(len(ri) * 0.8))]))
            rmin = float(ri[j0])
            rec = 0.0
            if rmin < 0.85:
                thr = 0.5 * (1.0 + rmin)
                after = np.nonzero(ri[j0:] > thr)[0]
                rec = float(hs[inb][j0 + after[0]]) if len(after) else float(hs[inb][-1])
            hrec[k].append(rec)
            hmin[k].append(rmin)
        if verbose:
            print(f"[shadow] {os.path.basename(f)} el={el:.1f} az={az:.1f}", flush=True)
    prof = np.where(cnt > 0, acc / np.maximum(cnt, 1), 1.0)
    h_int = np.array([np.median(h) if h else 0.0 for h in hint])
    h_int_max = np.array([np.max(h) if h else 0.0 for h in hint])
    out = {f"sh_{int(H_BINS[i])}": prof[:, i] for i in range(nb)}
    out["sh_int"] = h_int
    out["sh_int_max"] = h_int_max
    out["sh_int_min"] = np.array([np.min(h) if h else 0.0 for h in hint])
    out["sh_rec"] = np.array([np.median(h) if h else 0.0 for h in hrec])
    out["sh_rec_hi"] = np.array([np.percentile(h, 75) if h else 0.0 for h in hrec])
    out["sh_min"] = np.array([np.median(h) if h else 1.0 for h in hmin])
    return out
