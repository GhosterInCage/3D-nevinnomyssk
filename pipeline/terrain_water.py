"""River / canal / pond bed carving for the terrain pipeline (stage 2).

Input  : bare-earth heights (2049^2), water surface grid (2049^2, NaN = no water, finite =
         water-surface elevation). The water module writes data/processed/water_surface.npy;
         when it is missing a fallback surface is estimated here from Overture water features.
Output : carved heights; the bed lies below the surface with a depth that grows with the
         distance from the shore (river ~2.5 m, canal ~3.5 m with steep lined banks, ponds
         ~2 m); the banks are raised to at least the water line + a small freeboard so that
         the waterline is exactly the polygon outline.
"""
import numpy as np
from scipy import ndimage

from config import *
from terrain_lib import *

# water kinds (vertex raster codes)
K_NONE, K_RIVER, K_CANAL, K_POND, K_STREAM = 0, 1, 2, 3, 4
PROFILE = {
    # kind: (max depth m, bank distance m to reach max depth, min depth at first wet sample)
    K_RIVER: (2.6, 28.0, 0.35),
    K_CANAL: (3.6, 7.0, 0.6),
    K_POND: (2.0, 14.0, 0.3),
    K_STREAM: (0.9, 4.0, 0.25),
}


def water_kinds(shape=(HEIGHT_N, HEIGHT_N)):
    """Rasterise Overture water features into kind codes on the vertex grid."""
    VT = vertex_transform()
    rows = read_layer("base_water", ["geometry", "subtype", "class", "names"])
    shapes = []
    for r in rows:
        g = r["geom"]
        st, cl = r["subtype"], r["class"]
        name = (r.get("names") or {}).get("primary") if r.get("names") else None
        if cl == "swimming_pool":
            continue
        poly = g.geom_type in ("Polygon", "MultiPolygon")
        if st in ("river",):
            kind = K_RIVER
        elif st == "canal" or cl in ("canal", "drain", "ditch"):
            kind = K_CANAL
        elif st == "stream":
            kind = K_STREAM
        else:
            kind = K_POND
        if not poly:
            # line features: buffer by a plausible half width
            if kind == K_CANAL:
                hw = 14.0 if name and "Невинномысский" in name else (9.0 if name else 3.0)
                if cl in ("drain", "ditch"):
                    hw = 2.0
            elif kind == K_RIVER:
                hw = 10.0 if name in ("Кубань", "Большой Зеленчук") else 4.0
            else:
                hw = 2.0
            g = g.buffer(hw)
        shapes.append((g, kind, (0 if poly else 1)))
    # lines first (lower priority), polygons last
    shapes.sort(key=lambda s: -s[2])
    return rasterize([(g, k) for g, k, _ in shapes], shape, VT)


def estimate_surface(h, kinds):
    """Fallback water surface: smoothed low envelope of the bare DEM inside water bodies."""
    # thin line features (ditches, small streams) are not carved by the fallback
    wet = ndimage.binary_opening(kinds > 0, np.ones((3, 3), bool))
    lab, n = ndimage.label(wet)
    surf = np.full(h.shape, np.nan, np.float32)
    low = ndimage.grey_erosion(h, size=(3, 3))
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        m = lab[sl] == i
        area = m.sum()
        if area < 3:
            continue
        vals = low[sl][m]
        span = max(m.shape) * GRID_RES
        if span < 800:
            lvl = np.percentile(vals, 25)
            surf[sl][m] = lvl
        else:
            # long features: level varies along the course -> masked smoothing of low values
            sub = np.where(m, low[sl], 0)
            num = ndimage.gaussian_filter(sub, 12)
            den = ndimage.gaussian_filter(m.astype(np.float32), 12)
            lv = num / np.maximum(den, 1e-6)
            s = surf[sl]
            s[m] = np.minimum(lv[m], ndimage.gaussian_filter(np.where(m, low[sl], 1e4), 3)[m] + 0.5)
    return surf


def carve(h, surface, kinds, depth_hint=None, sdf=None, level_ext=None):
    """Carve beds below `surface` (NaN = dry). `depth_hint` (optional, the water module's
    water_depth.npy) overrides the profile depth where finite; negative hints are emergent
    gravel bars / islands (bed above the water line). `sdf` / `level_ext` (optional, the water
    module's signed distance to the mapped shoreline, + inside, and the level extended into the
    band) make the terrain cross the water level exactly on the polygon outline instead of the
    10 m staircase of the binary mask. Returns (carved heights, depth grid)."""
    h = h.astype(np.float32).copy()
    wet = np.isfinite(surface)
    if not wet.any():
        return h, np.zeros_like(h)
    S = np.where(wet, surface, 0).astype(np.float32)
    # unknown kinds inside the water mask -> guess by width
    edt = ndimage.distance_transform_edt(wet) * GRID_RES          # 10 m at the first wet sample
    d = np.maximum(edt - 0.5 * GRID_RES, 0)                       # ~distance from the shore line
    k = np.where(wet, kinds, 0)
    if (wet & (k == 0)).any():
        # widths: local max of the distance field
        halfw = ndimage.grey_dilation(edt, size=(9, 9))
        guess = np.where(halfw > 30, K_RIVER, np.where(halfw > 12, K_POND, K_STREAM))
        # propagate the nearest known kind for the unknown cells when close
        k = np.where(wet & (k == 0), guess, k)
    halfw = ndimage.grey_dilation(np.where(wet, d, 0), size=(7, 7))
    depth = np.zeros_like(h)
    for kind, (dmax, L, dmin) in PROFILE.items():
        m = wet & (k == kind)
        if not m.any():
            continue
        # narrow channels get shallower beds (depth limited by half width * bank slope)
        dm = np.minimum(dmax, np.maximum(dmin, halfw[m] * (dmax / L)))
        Lm = np.minimum(L, np.maximum(halfw[m], GRID_RES))
        t = smoothstep(0, 1, d[m] / Lm)
        depth[m] = dmin + (dm - dmin) * t
    # gentle thalweg variation for rivers (pools / riffles)
    rng = np.random.default_rng(7)
    nz = ndimage.gaussian_filter(rng.standard_normal(h.shape).astype(np.float32), 8) * 8
    depth = np.where(wet & (k == K_RIVER), depth * (1 + 0.25 * np.clip(nz, -1, 1)), depth)
    bars = np.zeros(h.shape, bool)
    if depth_hint is not None:
        hint = np.where(wet & np.isfinite(depth_hint), depth_hint, np.nan).astype(np.float32)
        has = np.isfinite(hint)
        bars = has & (hint < 0)
        # first wet sample next to the shore: keep at least a shallow margin under the surface
        shore1 = wet & (edt <= 1.5 * GRID_RES) & ~bars
        hint = np.where(shore1 & has, np.maximum(hint, 0.2), hint)
        depth = np.where(has, hint, depth)
        depth = np.where(wet & ~bars, np.maximum(depth, 0.15), depth)
    bed = S - depth
    h = np.where(wet & ~bars, np.minimum(h, bed), h)
    h = np.where(bars, bed, h)   # gravel bars / islands stand above the water line

    # banks: dry cells near water rise to at least the water line + freeboard
    dist_out, (iy, ix) = ndimage.distance_transform_edt(~wet, return_indices=True)
    dist_out = dist_out * GRID_RES
    lvl_near = S[iy, ix]
    near = (~wet) & (dist_out < 25)
    freeboard = 0.2 + np.minimum(0.5, 0.025 * np.maximum(dist_out - GRID_RES, 0))
    need = lvl_near + freeboard
    h = np.where(near & (h < need), need, h)
    # smooth the shore band slightly and re-impose constraints
    band = ndimage.binary_dilation(wet, disk(2)) & ~ndimage.binary_erosion(wet, disk(2))
    hs = ndimage.gaussian_filter(h, 0.8)
    h = np.where(band, hs, h)
    h = np.where(wet & ~bars, np.minimum(h, S - np.maximum(depth * 0.9, 0.15)), h)
    h = np.where(bars, np.maximum(h, S - depth * 0.9), h)
    h = np.where(near & (h < lvl_near + 0.2), lvl_near + 0.2, h)
    if sdf is not None and level_ext is not None:
        h = shore_from_sdf(h, S, wet, depth, bars, sdf, level_ext)
    return h.astype(np.float32), np.where(wet, np.maximum(S - h, 0), 0).astype(np.float32)


K_IN = 0.12      # bed slope just inside the shoreline (m per m)
K_OUT = 0.10     # minimum bank slope just outside (m per m)
MAX_OUT = 0.7    # the minimum-bank ramp stops rising here (m above water)


def shore_from_sdf(h, S, wet, depth, bars, sdf, lv):
    """Re-shape the samples in the shore band as a function of the exact signed distance."""
    band = np.isfinite(sdf) & np.isfinite(lv)
    inside = band & (sdf > 0) & ~bars
    outside = band & (sdf <= 0)
    d_in = np.where(inside, sdf, 0)
    # near the shore the bed depth grows linearly from 0 at the outline, then follows the profile
    t = smoothstep(0.0, 12.0, d_in)
    prof = np.where(wet, depth, K_IN * d_in)
    dep = K_IN * d_in * (1 - t) + np.maximum(prof, K_IN * np.minimum(d_in, 12.0)) * t
    level_in = np.where(wet, S, lv)
    bed = level_in - dep
    # below the water inside the outline (never raise existing deeper beds except at the outline)
    h = np.where(inside, np.minimum(np.where(d_in < 3.0, bed, h), bed), h)
    # outside: at least a gentle bank above the water, starting exactly at the outline
    need = lv + np.minimum(MAX_OUT, K_OUT * np.maximum(-sdf, 0.0))
    h = np.where(outside & (h < need), need, h)
    # samples that the binary mask called wet but lie outside the outline become bank
    return h
