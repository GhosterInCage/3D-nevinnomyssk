"""Bare-earth DTM from the Copernicus GLO-30 DSM (terrain pipeline stage 1).

Method (progressive morphological filter + prior masks + push-pull interpolation):
  1. prior non-ground: Overture building footprints (dilated), ESA WorldCover tree cells
  2. progressive morphological filter (square openings 30..250 m) with context-dependent
     elevation thresholds (aggressive in built-up/tree areas, gentle in open land) flags objects
  3. protected cells (rail / major-road embankments, dams near water) are never flagged by (2)
  4. non-ground cells are filled from ground cells with a push-pull (normalised convolution)
     pyramid; inside tree stands the fill is limited by DSM - local canopy height so forested
     ravines (balki) keep their shape
  5. light, slope-adaptive denoising (flat land smoothed more, escarpments preserved)

Writes data/processed/terrain_bare.npy (float32 2049^2) + masks for debugging.
"""
import os
import time

import numpy as np
import shapely
from scipy import ndimage

from config import *
from terrain_lib import *

t0 = time.time()
N = HEIGHT_N
VT = vertex_transform()
dsm = np.load(f"{PROC}/dem_raw.npy").astype(np.float32)
wc = np.load(f"{PROC}/worldcover.npy")
ndvi = np.load(f"{PROC}/s2_ndvi.npy")

# ------------------------------------------------------------------ context rasters (vertex grid)
wc_v_tree = cells_to_vertices(wc == 10) > 0.24          # any touching cell is tree
wc_v_built = cells_to_vertices(wc == 50) > 0.24
wc_v_water = cells_to_vertices(wc == 80) > 0.74
ndvi_v = cells_to_vertices(ndvi)

bld = read_layer("buildings_building", ["geometry"])
bmask = rasterize([(r["geom"], 1) for r in bld], (N, N), VT, all_touched=True).astype(bool)
print("buildings", len(bld), "cells", bmask.sum(), f"{time.time()-t0:.1f}s")

seg = read_layer("transportation_segment", ["geometry", "subtype", "class"])
prot_shapes = []
for r in seg:
    c = r["class"]
    if r["subtype"] == "rail":
        prot_shapes.append((r["geom"].buffer(14), 1))
    elif c in ("trunk", "primary", "secondary", "tertiary"):
        prot_shapes.append((r["geom"].buffer(12), 1))
protect = rasterize(prot_shapes, (N, N), VT).astype(bool)

water_rows = read_layer("base_water", ["geometry", "subtype", "class"])
wpoly = [(r["geom"], 1) for r in water_rows if r["geom"].geom_type in ("Polygon", "MultiPolygon")]
wline = [(r["geom"].buffer(6), 1) for r in water_rows if r["geom"].geom_type in ("LineString", "MultiLineString")]
water = rasterize(wpoly + wline, (N, N), VT).astype(bool) | wc_v_water
# dams / levees next to water bodies are real terrain
near_water = ndimage.binary_dilation(water, disk(4)) & ~water
protect |= near_water & ~wc_v_tree

# ------------------------------------------------------------------ progressive morphological filter
built_ctx = ndimage.binary_dilation(bmask | wc_v_built, disk(6))
tree_ctx = ndimage.binary_dilation(wc_v_tree, disk(2))
# window sizes (cells) and per-context thresholds (m)
windows = [3, 5, 9, 15, 25]
flag = np.zeros((N, N), bool)
surf = dsm.copy()
prev = 1
for k, w in enumerate(windows):
    op = ndimage.grey_opening(surf, size=(w, w))
    dw = (w - prev) * GRID_RES
    # open land: only small windows, gentle thresholds (keep natural convexities)
    th_open = np.float32(min(3.0, 1.2 + 0.08 * dw)) if w <= 9 else np.float32(1e9)
    th_tree = np.float32(min(2.5, 0.8 + 0.10 * dw)) if w <= 15 else np.float32(1e9)
    th_built = np.float32(min(2.2, 0.5 + 0.12 * dw))
    th = np.where(built_ctx, th_built, np.where(tree_ctx, th_tree, th_open))
    f = (surf - op) > th
    flag |= f
    surf = op
    prev = w
    print(f"pmf w={w} flagged {f.mean()*100:.2f}% total {flag.mean()*100:.2f}%")

nonground = (flag & ~protect) | ndimage.binary_dilation(bmask, disk(1)) | wc_v_tree
nonground &= ~water
# grow slightly: DSM smearing (30 m source resampled with cubic) spreads object bumps
nonground = ndimage.binary_dilation(nonground, disk(1)) & ~water
# isolated tiny ground islands inside object areas are unreliable
lab, nl = ndimage.label(~nonground)
sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, nl + 1))
small = np.zeros(nl + 1, bool)
small[1:] = sizes < 6
nonground |= small[lab]
print("nonground", f"{nonground.mean()*100:.1f}%", f"{time.time()-t0:.1f}s")

# ------------------------------------------------------------------ fill
# (A) trend-guided fill: lower envelope (150 m opening) follows valleys through built-up
#     areas; the residual DSM-trend measured on ground cells is interpolated on top.
trend = ndimage.grey_opening(dsm, size=(15, 15))
trend = np.minimum(ndimage.gaussian_filter(trend, 2.5), dsm)
wts = (~nonground).astype(np.float32)
resid = pushpull_fill(dsm - trend, wts, blur=1.0)
fill_a = trend + np.clip(resid, -1.0, 4.0)

# (B) forests: DSM minus a local canopy-height estimate keeps forested ravines (balki)
#     intact. Canopy height = mean DSM on a band just inside tree stands minus mean DSM on
#     a band just outside (open ground), both averaged over ~0.5 km neighbourhoods.
tree_only = wc_v_tree & ~ndimage.binary_dilation(bmask, disk(3))
dsm_s = ndimage.gaussian_filter(dsm, 1.0)
band_in = tree_only & ~ndimage.binary_erosion(tree_only, disk(4)) & ndimage.binary_erosion(tree_only, disk(1))
band_out = ndimage.binary_dilation(tree_only, disk(4)) & ~ndimage.binary_dilation(tree_only, disk(1)) & ~nonground & ~water
m_in, d_in = masked_gaussian(dsm_s, band_in, 25)
m_out, d_out = masked_gaussian(dsm_s, band_out, 25)
ok = (d_in > 0.005) & (d_out > 0.005)
c_raw = np.where(ok, m_in - m_out, np.nan)
c_med = float(np.nanmedian(c_raw[tree_only])) if np.isfinite(c_raw[tree_only]).any() else 5.0
canopy = np.where(ok, c_raw, c_med)
canopy = np.clip(ndimage.gaussian_filter(np.nan_to_num(canopy, nan=c_med), 10), 1.5, 14.0)
# interior of stands: smooth the canopy texture away before subtracting
depth_in = ndimage.distance_transform_edt(tree_only) * GRID_RES
k_sm = smoothstep(10, 60, depth_in)
fb_s = ndimage.gaussian_filter(dsm, 1.2) * (1 - k_sm) + ndimage.gaussian_filter(dsm, 3.5) * k_sm
fill_b = fb_s - canopy * smoothstep(0, 25, depth_in + 10)
# only wide stands may go below the trend fill (forested ravines); small clumps and shelterbelts
# would otherwise get pits wherever the canopy estimate exceeds their (smeared) DSM bump
allow = 20.0 * smoothstep(25.0, 90.0, depth_in)
allow = ndimage.gaussian_filter(allow, 2.0)
g = np.where(tree_only, np.minimum(fill_a, np.maximum(fill_b, fill_a - allow)), fill_a)
print("canopy est median", c_med, "applied median", float(np.median(canopy[tree_only])),
      "p90", float(np.percentile(canopy[tree_only], 90)))
# built-up areas: residual object bumps -> smooth filled cells a bit more
bs = nonground & built_ctx & ~tree_only
g = np.where(bs, ndimage.gaussian_filter(g, 2.0), g)
ground = np.where(nonground, g, dsm)
# feather the seam between measured and filled cells
fe = ndimage.gaussian_filter(nonground.astype(np.float32), 1.5)
ground = ground * (1 - fe) + ndimage.gaussian_filter(ground, 1.5) * fe
ground = np.minimum(ground, dsm)

# ------------------------------------------------------------------ denoise (slope adaptive)
gy, gx = np.gradient(ndimage.gaussian_filter(ground, 2.0), GRID_RES)
slope = np.hypot(gx, gy)
s_strong = ndimage.gaussian_filter(ground, 2.0)
s_weak = ndimage.gaussian_filter(ground, 0.8)
a = smoothstep(0.03, 0.15, slope)            # 0 flat .. 1 steep (>~8.5 deg)
den = s_strong * (1 - a) + s_weak * a
# never raise the terrain above the (lightly smoothed) raw DSM
den = np.minimum(den, ndimage.gaussian_filter(dsm, 0.8) + 0.05)
ground = den.astype(np.float32)

np.save(f"{PROC}/terrain_bare.npy", ground)
np.save(f"{PROC}/terrain_nonground.npy", nonground)
np.save(f"{PROC}/terrain_water_mask.npy", water)
print("bare-earth done", float(ground.min()), float(ground.max()), f"{time.time()-t0:.1f}s")
