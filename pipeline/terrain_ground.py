"""Ground maps for the terrain shader (terrain pipeline stage 3).

Outputs (public/data/terrain/, all north-up, row 0 = north edge, covering the 20.48 km region):
  ground_class.bin.gz  uint8 4096x4096 (5 m cells). low nibble = ground class (see CLASSES),
                       high nibble = row orientation of fields (0..15 -> angle = k*pi/16 measured
                       from world +X towards +Z) or a random variant for other classes.
  ground_shade.jpg     2048x2048 RGB (10 m cells): R = terrain sky-visibility (ambient occlusion),
                       G = wetness near water, B = vegetation lushness (from summer NDVI).
  ground_albedo.jpg    2048x2048 sRGB: ortho albedo with roofs / tree crowns removed
                       (in-painted from the surrounding ground), used close to the camera.
Also data/processed/terrain_ortho.npy (graded linear-reflectance ortho, exported as ortho.jpg).
"""
import gzip
import json
import os
import time

import numpy as np
from PIL import Image
from scipy import ndimage

from config import *
from terrain_lib import *

CLASSES = ["grass", "crop", "stubble", "ploughed", "bare", "gravel", "forest", "urban",
           "pebbles", "mud", "sand", "rock"]
C = {n: i for i, n in enumerate(CLASSES)}

OUT = os.path.join(WEB_DATA, "terrain")
os.makedirs(OUT, exist_ok=True)
t0 = time.time()
NC = 4096                     # class map cells
CT = cell_transform(NC)
T10 = cell_transform(GRID_N)

h = np.load(f"{PROC}/terrain_final.npy")
rgb = np.load(f"{PROC}/s2_rgb.npy")
ndvi = np.load(f"{PROC}/s2_ndvi.npy")
wc = np.load(f"{PROC}/worldcover.npy")


def up2(a, order=0):
    if order == 0:
        return np.repeat(np.repeat(a, 2, 0), 2, 1)
    return ndimage.zoom(a, 2, order=1, mode="nearest", grid_mode=True)


# ---------------------------------------------------------------- vector layers @5 m
bld = read_layer("buildings_building", ["geometry"])
bmask5 = rasterize([(r["geom"], 1) for r in bld], (NC, NC), CT).astype(bool)
bmask10 = rasterize([(r["geom"], 1) for r in bld], (GRID_N, GRID_N), T10, all_touched=True).astype(bool)

lu = read_layer("base_land_use", ["geometry", "subtype", "class"])
land = read_layer("base_land", ["geometry", "subtype", "class"])
seg = read_layer("transportation_segment", ["geometry", "subtype", "class", "road_surface"])
print("vectors loaded", f"{time.time()-t0:.1f}s")

LU_CODES = {  # 1 industrial ground, 2 bare/construction, 3 lawn/sport, 4 garden plots, 5 farmland, 6 cemetery/park
    "industrial": 1, "works": 1, "garages": 1, "landfill": 2, "quarry": 2, "construction": 2,
    "pitch": 3, "stadium": 3, "playground": 3, "park": 6, "cemetery": 6, "grass": 3,
    "allotments": 4, "garden": 4, "plant_nursery": 4, "greenhouse_horticulture": 4, "orchard": 4,
    "farmland": 5, "farmyard": 1,
}
lu_r = rasterize([(r["geom"], LU_CODES[r["class"]]) for r in lu if r["class"] in LU_CODES
                  and r["geom"].geom_type in ("Polygon", "MultiPolygon")], (NC, NC), CT)
land_r = rasterize([(r["geom"], {"sand": 1, "scree": 2, "rock": 2, "wetland": 3}[r["class"]]) for r in land
                    if r["class"] in ("sand", "scree", "rock", "wetland")], (NC, NC), CT)

road_shapes, rail_shapes, track_shapes = [], [], []
ROAD_W = {"trunk": 12, "primary": 11, "secondary": 9, "tertiary": 8, "residential": 6.5,
          "unclassified": 6, "service": 4.5, "living_street": 5, "pedestrian": 5}
for r in seg:
    g, cl = r["geom"], r["class"]
    if r["subtype"] == "rail":
        rail_shapes.append((g.buffer(4.5), 1))
    elif cl == "track":
        track_shapes.append((g.buffer(2.2), 1))
    elif cl in ROAD_W:
        road_shapes.append((g.buffer(ROAD_W[cl] / 2 + 2.0), 1))
rail_r = rasterize(rail_shapes, (NC, NC), CT).astype(bool)
track_r = rasterize(track_shapes, (NC, NC), CT).astype(bool)
road_r = rasterize(road_shapes, (NC, NC), CT).astype(bool)
print("rasterised", f"{time.time()-t0:.1f}s")

# ---------------------------------------------------------------- water (water module grids)
ws_path = f"{PROC}/water_surface.npy"
wsurf = np.load(ws_path) if os.path.exists(ws_path) else np.load(f"{PROC}/terrain_water_estimate.npy")
wet_v = np.isfinite(wsurf)
wbody_type = np.zeros((HEIGHT_N, HEIGHT_N), np.uint8)   # 1 river 3 canal 4 stream 5 pond 6 industrial
if os.path.exists(f"{PROC}/water_body.npy") and os.path.exists(f"{PROC}/water_bodies.json"):
    wb = np.load(f"{PROC}/water_body.npy")
    table = json.load(open(f"{PROC}/water_bodies.json"))
    lut = np.zeros(max(len(table), 1) + 1, np.uint8)
    for b in table:
        lut[b["idx"] + 1] = {1: 1, 2: 1, 3: 3, 4: 4, 5: 5, 6: 6, 7: 6}.get(b.get("typeId", 5), 5)
    wbody_type = lut[np.clip(wb.astype(np.int32) + 1, 0, len(lut) - 1)]
    wbody_type[~wet_v] = 0
else:
    wbody_type[wet_v] = 5
wdepth = np.load(f"{PROC}/water_depth.npy") if os.path.exists(f"{PROC}/water_depth.npy") else np.zeros_like(h)


def vert_to_cells(a, n):
    """vertex grid (2049^2) -> n^2 cell grid by bilinear sampling at cell centres."""
    k = (HEIGHT_N - 1) / n
    c = (np.arange(n) + 0.5) * k
    return ndimage.map_coordinates(a, np.meshgrid(c, c, indexing="ij"), order=1, mode="nearest")


def vert_to_cells_nearest(a, n):
    k = (HEIGHT_N - 1) / n
    c = np.clip(np.round((np.arange(n) + 0.5) * k).astype(int), 0, HEIGHT_N - 1)
    return a[np.ix_(c, c)]


wtype5 = vert_to_cells_nearest(wbody_type, NC)
wet5 = wtype5 > 0
bars5 = vert_to_cells_nearest(np.where(wet_v, wdepth, 0) < -0.05, NC) & wet5
d_water5 = ndimage.distance_transform_edt(~wet5) * (2 * HALF / NC)
_, (iy, ix) = ndimage.distance_transform_edt(~wet5, return_indices=True)
near_type5 = wtype5[iy, ix]

# ---------------------------------------------------------------- base classes
# field state is decided on median-filtered spectra (fields are homogeneous; speckle is noise)
ndvi_m = ndimage.median_filter(ndvi, size=5)
br_m = ndimage.median_filter(rgb.sum(-1), size=5)
wc5 = up2(wc)
nd5 = up2(ndvi, 1)
ndm5 = up2(ndvi_m, 1)
brm5 = up2(br_m, 1)
rgb5 = np.stack([up2(rgb[..., k], 1) for k in range(3)], -1)
br5 = rgb5.sum(-1)
rng = np.random.default_rng(42)
cls = np.full((NC, NC), C["grass"], np.uint8)
cls[wc5 == 10] = C["forest"]
crop = (wc5 == 40) | (lu_r == 5)
fcls = np.where(ndm5 >= 0.42, C["crop"], np.where(brm5 >= 0.27, C["stubble"], C["ploughed"])).astype(np.uint8)
# mode filter (45 m) among field classes removes blobs inside fields
votes = np.stack([ndimage.uniform_filter((fcls == k).astype(np.float32), 9) for k in (C["crop"], C["stubble"], C["ploughed"])])
fcls = np.array([C["crop"], C["stubble"], C["ploughed"]], np.uint8)[np.argmax(votes, 0)]
cls[crop] = fcls[crop]
cls[(wc5 == 50) & (nd5 < 0.42)] = C["urban"]
cls[wc5 == 60] = C["bare"]
cls[(wc5 == 90)] = C["mud"]
# land use overrides
cls[(lu_r == 1) & (nd5 < 0.4)] = C["gravel"]
cls[(lu_r == 2) & (nd5 < 0.45)] = C["bare"]
cls[(lu_r == 3) & (nd5 >= 0.3)] = C["grass"]
cls[(lu_r == 3) & (nd5 < 0.3)] = C["urban"]
cls[(lu_r == 4) & (nd5 < 0.35)] = C["ploughed"]      # vegetable plots
cls[(lu_r == 6) & (cls != C["forest"])] = C["grass"]
cls[land_r == 1] = C["sand"]
cls[land_r == 2] = C["rock"]
cls[(land_r == 3)] = C["mud"]
# linear features
cls[road_r] = C["urban"]
cls[track_r] = C["bare"]
cls[rail_r] = C["gravel"]
cls[ndimage.binary_dilation(bmask5, disk(1))] = C["urban"]
# water beds and shores
river_like = near_type5 == 1                       # Kuban / Zelenchuk: gravel-bed mountain rivers
stream = near_type5 == 4                           # steppe streams and ditches: muddy, grassy banks
still = (near_type5 == 5) | (near_type5 == 6)
canal = near_type5 == 3
shore = (~wet5) & (d_water5 < 9)
cls[shore & river_like & (d_water5 < 6)] = C["pebbles"]
cls[shore & river_like & (d_water5 >= 6) & (nd5 < 0.45)] = C["sand"]
cls[shore & still & (d_water5 < 4)] = C["mud"]
cls[shore & stream & (d_water5 < 2.5)] = C["mud"]
cls[shore & canal & (d_water5 < 3)] = C["gravel"]
cls[wet5 & river_like] = C["pebbles"]
cls[wet5 & (still | canal | stream)] = C["mud"]
cls[bars5] = C["pebbles"]
print("classes", {n: round(float((cls == i).mean()) * 100, 2) for n, i in C.items()}, f"{time.time()-t0:.1f}s")

# ---------------------------------------------------------------- field row orientation
lum = rgb.mean(-1) * 3 + ndvi * 0.3
gx = ndimage.sobel(lum, axis=1)   # along +x (columns)
gz = ndimage.sobel(lum, axis=0)   # along +z (rows, southwards)


def orient(sigma):
    jxx = ndimage.gaussian_filter(gx * gx, sigma)
    jzz = ndimage.gaussian_filter(gz * gz, sigma)
    jxz = ndimage.gaussian_filter(gx * gz, sigma)
    th = 0.5 * np.arctan2(2 * jxz, jxx - jzz)                 # dominant gradient direction
    coh = np.sqrt((jxx - jzz) ** 2 + 4 * jxz ** 2) / (jxx + jzz + 1e-12)
    return th, coh


th1, c1 = orient(10)
th2, c2 = orient(35)
th = np.where(c1 > 0.25, th1, th2)
row_dir = np.mod(th + np.pi / 2, np.pi)                       # rows run along field edges
oq = (np.round(row_dir / np.pi * 16).astype(np.int32) % 16).astype(np.uint8)
oq5 = up2(oq)
field = np.isin(cls, [C["crop"], C["stubble"], C["ploughed"]])
variant = rng.integers(0, 16, (NC // 8, NC // 8), dtype=np.uint8).repeat(8, 0).repeat(8, 1)
hi = np.where(field, oq5, variant)
byte = (cls & 15) | (hi << 4)
with gzip.open(os.path.join(OUT, "ground_class.bin.gz"), "wb", compresslevel=9) as f:
    f.write(byte.astype(np.uint8).tobytes())
print("class map written", os.path.getsize(os.path.join(OUT, "ground_class.bin.gz")) // 1024, "KB", f"{time.time()-t0:.1f}s")

# ---------------------------------------------------------------- shade map: sky visibility, wetness, lushness


def sky_visibility(hh, res=GRID_RES, ndir=16, dists=(10, 20, 30, 45, 65, 90, 130, 180, 250, 350, 500)):
    n = hh.shape[0]
    pad = int(max(dists) / res) + 2
    hp = np.pad(hh, pad, mode="edge")
    acc = np.zeros_like(hh)
    for k in range(ndir):
        a = 2 * np.pi * k / ndir
        tmax = np.zeros_like(hh)
        for d in dists:
            dx = int(round(np.cos(a) * d / res))
            dz = int(round(np.sin(a) * d / res))
            dd = max(np.hypot(dx, dz) * res, 1e-3)
            sh = hp[pad + dz: pad + dz + n, pad + dx: pad + dx + n]
            tmax = np.maximum(tmax, (sh - hh) / dd)
        cos2 = 1.0 / (1.0 + tmax * tmax)    # cos^2 of the horizon elevation
        acc += cos2
    return acc / ndir


svf = sky_visibility(h)
lvl_near = np.where(wet_v, wsurf, np.nan)
d_out, (iy2, ix2) = ndimage.distance_transform_edt(~wet_v, return_indices=True)
lvl = np.where(wet_v, wsurf, wsurf[iy2, ix2]) if wet_v.any() else h
dh = np.where(wet_v, 0, h - np.nan_to_num(lvl, nan=-1e4))
wet = np.clip(1 - (d_out * GRID_RES - 3) / 14, 0, 1) * np.clip(1 - dh / 1.6, 0, 1)
wet = np.where(wet_v, 1.0, wet)
svf_c = vert_to_cells(svf.astype(np.float32), GRID_N)
wet_c = vert_to_cells(wet.astype(np.float32), GRID_N)
lush = np.clip((ndimage.gaussian_filter(ndvi, 0.7) - 0.25) / 0.55, 0, 1)
shade = np.stack([np.clip(svf_c, 0, 1), np.clip(wet_c, 0, 1), lush], -1)
Image.fromarray((shade * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, "ground_shade.jpg"), quality=92)
print("shade written", f"{time.time()-t0:.1f}s")

# ---------------------------------------------------------------- ortho grading + de-roofed ground albedo
lin = rgb.astype(np.float32).copy()
dark = np.percentile(lin.reshape(-1, 3), 0.5, axis=0)
lin = np.clip(lin - 0.5 * dark, 0, 1)                     # remove a little residual path radiance
lum_ = (lin * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
lin = np.clip(lum_ + (lin - lum_) * 1.08, 0, 1)            # gentle saturation
np.save(f"{PROC}/terrain_ortho.npy", lin.astype(np.float32))

tree10 = wc == 10
lum10 = (lin * [0.2126, 0.7152, 0.0722]).sum(-1)
# bright built-up pixels are roofs / tanks / plant structures missing from the footprints
bright = (wc == 50) & (lum10 > 0.17) | (lum10 > 0.3)
occl = ndimage.binary_dilation(bmask10 | bright, disk(1)) | tree10
wts = (~occl).astype(np.float32)
filled = np.stack([pushpull_fill(lin[..., k], wts, blur=1.0) for k in range(3)], -1)
forest_floor = np.array([0.050, 0.047, 0.032], np.float32)
g_alb = np.where(occl[..., None], filled, lin)
g_alb = np.where(tree10[..., None], 0.45 * filled + 0.55 * forest_floor, g_alb)
Image.fromarray((srgb_encode(g_alb) * 255 + 0.5).astype(np.uint8)).save(
    os.path.join(OUT, "ground_albedo.jpg"), quality=90, subsampling=0)
print("ground albedo written", f"{time.time()-t0:.1f}s")
json.dump({"classes": CLASSES, "classMap": {"file": "terrain/ground_class.bin.gz", "n": NC, "format": "u8"},
           "shade": "terrain/ground_shade.jpg", "groundAlbedo": "terrain/ground_albedo.jpg"},
          open(f"{PROC}/terrain_ground_meta.json", "w"), indent=1)
