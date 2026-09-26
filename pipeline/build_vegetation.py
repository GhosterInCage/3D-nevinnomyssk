"""Vegetation placement for the Nevinnomyssk 3D city (module "vegetation").

Inputs
  data/processed: worldcover.npy, s2_ndvi.npy, s2_rgb.npy, dsm_excess.npy, dem_ground.npy (10 m grids)
  data/raw: Overture buildings, transportation segments, water, land, land_use

Outputs (public/data/vegetation/), all little-endian:

  trees.bin.gz   every tree / shrub / hedge instance, bucketed in 64 m cells
      header (40 bytes):
        char[4] magic 'VEG1'; u32 version (1); u32 count N; u32 cells C (320 per side);
        f32 cellSize (64); f32 origin (-10240, world x and z of the north-west corner);
        f32 posQuant (0.25 m); f32 heightQuant (0.15 m); f32 crownQuant (0.1 m); u32 reserved
      u16 counts[C*C]           instances per cell, row-major, row 0 = north (world z = -10240)
      u8  qx[N], qz[N]          position inside the cell: x = x0 + (q + 0.5) * posQuant
                                (x0 = origin + col*cellSize, z0 = origin + row*cellSize; z = world z (south+))
      u8  species[N]            ids of pipeline/vegetation_species.py
      u8  height[N]             * heightQuant (m)
      u8  crown[N]              crown width * crownQuant (m); for hedges: hedge length
      u8  rot[N]                hedges: direction of the hedge line (2*pi/256 units); 0 for everything else
                                (tree/shrub yaw is hashed from the instance index at runtime)
      Instances are grouped by cell (cell order = counts order) and shuffled inside a cell.

  cover.jpg      2048x2048 RGB, row 0 = north, 10 m texels (same grid as terrain/landcover.png):
      R = grass / ground-cover density (0..255)
      G = dryness 0 (lush green) .. 255 (straw)
      B = relative height factor (0..255 -> 0.4..1.6)
  covertype.png  2048x2048 8-bit: 0 lawn, 1 meadow/steppe (tall), 2 reeds, 3 ripe cereal,
                 4 green crop (sunflower/maize), 5 stubble / harvested field

  nogrow.bin.gz  10240x10240 bit mask at 2 m (np.packbits, row-major, row 0 = north, MSB first):
      1 = no grass / no shrubs (buildings, carriageways + sidewalks, footways, rail beds, water)

  stats.json     counts per species / zone (documentation only)
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
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import GRID_N, GRID_RES, PROC, RAW, REGION_HALF, WEB_DATA, to_local  # noqa: E402
from vegetation_species import MIX, NAME_TO_ID, SHRUB_MIX, SPECIES  # noqa: E402

T0 = time.time()
# foliage / bark textures (public/textures/vegetation) are produced by vegetation_textures.py
if "--textures" in sys.argv or not os.path.exists(os.path.join(os.path.dirname(WEB_DATA), "textures", "vegetation", "leaves.webp")):
    import vegetation_textures
    vegetation_textures.main()
OUT = os.path.join(WEB_DATA, "vegetation")
os.makedirs(OUT, exist_ok=True)
H = REGION_HALF
FR = 2.0                      # fine raster resolution (m)
NF = int(2 * H / FR)          # 10240
CELL = 64.0                   # instance bucket size (m)
NC = int(2 * H / CELL)        # 320
RNG = np.random.default_rng(20260715)


def log(*a):
    print(f"[veg {time.time() - T0:6.1f}s]", *a, flush=True)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- rasters (10 m)
wc = np.load(f"{PROC}/worldcover.npy")
ndvi = np.nan_to_num(np.load(f"{PROC}/s2_ndvi.npy").astype(np.float32), nan=0.0)
rgb = np.load(f"{PROC}/s2_rgb.npy").astype(np.float32)
ex_v = np.load(f"{PROC}/dsm_excess.npy").astype(np.float32)
dem_v = np.load(f"{PROC}/dem_ground.npy").astype(np.float32)
# vertex-centred (2049) -> cell-centred (2048)
excess = 0.25 * (ex_v[:-1, :-1] + ex_v[1:, :-1] + ex_v[:-1, 1:] + ex_v[1:, 1:])
dem = 0.25 * (dem_v[:-1, :-1] + dem_v[1:, :-1] + dem_v[:-1, 1:] + dem_v[1:, 1:])
N10 = GRID_N
log("rasters", wc.shape, ndvi.shape, rgb.shape)


def bilinear(grid, x, y, res=GRID_RES):
    """Sample a cell-centred north-up grid at pipeline coords (x east, y north)."""
    n = grid.shape[0]
    gx = (x + H) / res - 0.5
    gy = (H - y) / res - 0.5
    gx = np.clip(gx, 0, n - 1.001)
    gy = np.clip(gy, 0, n - 1.001)
    i = np.floor(gx).astype(np.int32)
    j = np.floor(gy).astype(np.int32)
    fx = (gx - i).astype(np.float32)
    fy = (gy - j).astype(np.float32)
    a = grid[j, i]; b = grid[j, i + 1]; c = grid[j + 1, i]; d = grid[j + 1, i + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def nearest10(grid, x, y):
    i = np.clip(((x + H) / GRID_RES).astype(np.int32), 0, N10 - 1)
    j = np.clip(((H - y) / GRID_RES).astype(np.int32), 0, N10 - 1)
    return grid[j, i]


def fine_idx(x, y):
    i = np.clip(((x + H) / FR).astype(np.int32), 0, NF - 1)
    j = np.clip(((H - y) / FR).astype(np.int32), 0, NF - 1)
    return j, i


# ----------------------------------------------------------------------------- vectors
TR = to_local()


def tolocal(g):
    return shapely.transform(g, lambda c: np.column_stack(TR.transform(c[:, 0], c[:, 1])))


def read(name, cols=None):
    t = pq.read_table(f"{RAW}/{name}.parquet", columns=cols)
    return t.to_pylist()


REG = shapely.box(-H - 200, -H - 200, H + 200, H + 200)


def load_geoms(name, keep=lambda r: True, cols=None):
    out = []
    for r in read(name, cols):
        if not keep(r):
            continue
        bb = r.get("bbox")
        g = tolocal(shapely.from_wkb(r["geometry"]))
        if not g.intersects(REG):
            continue
        out.append((r, g))
    return out


def px_coords(coords):
    c = np.asarray(coords)[:, :2]
    return list(zip(((c[:, 0] + H) / FR).tolist(), ((H - c[:, 1]) / FR).tolist()))


def draw_poly(draw, g, fill=1):
    if g.geom_type == "Polygon":
        if len(g.exterior.coords) >= 3:
            draw.polygon(px_coords(g.exterior.coords), fill=fill)
            for hole in g.interiors:
                if len(hole.coords) >= 3:
                    draw.polygon(px_coords(hole.coords), fill=0)
    elif g.geom_type in ("MultiPolygon", "GeometryCollection"):
        for p in g.geoms:
            draw_poly(draw, p, fill)


def draw_line(draw, g, width_m, fill=1):
    if g.geom_type == "LineString":
        pts = px_coords(g.coords)
        if len(pts) >= 2:
            w = max(1, int(round(width_m / FR)))
            draw.line(pts, fill=fill, width=w, joint="curve")
            if w > 2:  # round caps
                r = w / 2
                for (px, py) in (pts[0], pts[-1]):
                    draw.ellipse([px - r, py - r, px + r, py + r], fill=fill)
    elif g.geom_type in ("MultiLineString", "GeometryCollection"):
        for p in g.geoms:
            draw_line(draw, p, width_m, fill)


def new_mask():
    return Image.new("L", (NF, NF), 0)


CACHE = f"{PROC}/veg_cache.npz"
USE_CACHE = "--cache" in sys.argv and os.path.exists(CACHE)
# --- buildings
log("buildings…")
bld = load_geoms("buildings_building", keep=lambda r: not r.get("is_underground"),
                 cols=["geometry", "is_underground", "num_floors", "height", "class", "bbox"])
im_b = new_mask(); d_b = ImageDraw.Draw(im_b)
b_cent = []
for r, g in bld:
    draw_poly(d_b, g)
    c = g.centroid
    floors = r.get("num_floors") or 0
    hgt = r.get("height") or 0
    b_cent.append((c.x, c.y, g.area, max(floors, hgt / 3.0)))
M_bld = np.asarray(im_b, dtype=np.uint8) > 0
del im_b, d_b
b_cent = np.array(b_cent, dtype=np.float64)
log("buildings", len(bld))

# --- roads / rail
CARR = {"motorway": 20, "trunk": 16, "primary": 14, "secondary": 12, "tertiary": 9, "residential": 7,
        "unclassified": 6, "living_street": 6, "service": 4.5, "track": 3.5, "pedestrian": 6,
        "footway": 2.2, "path": 2.2, "cycleway": 2.2, "steps": 2.2, "bridleway": 2.2}
SIDEWALK = {"motorway": 1.0, "trunk": 2.5, "primary": 2.5, "secondary": 2.5, "tertiary": 2.0,
            "residential": 0.8, "living_street": 0.5, "unclassified": 0.3, "service": 0.2, "pedestrian": 0.3}
PATHS = {"footway", "path", "cycleway", "steps", "bridleway"}
log("roads…")
roads = load_geoms("transportation_segment",
                   cols=["geometry", "subtype", "class", "subclass", "width_rules", "road_flags", "level_rules", "bbox"])
im_c = new_mask(); d_c = ImageDraw.Draw(im_c)      # carriageways
im_s = new_mask(); d_s = ImageDraw.Draw(im_s)      # carriageway + sidewalks (grass exclusion)
im_p = new_mask(); d_p = ImageDraw.Draw(im_p)      # footways / paths
im_r = new_mask(); d_r = ImageDraw.Draw(im_r)      # rail corridors
road_list = []
for r, g in roads:
    st, cl = r.get("subtype"), r.get("class")
    if st == "rail":
        draw_line(d_r, g, 5.0 + 6.0)       # bed + cleared margin (tree exclusion)
        draw_line(d_s, g, 5.0)
        continue
    if cl not in CARR:
        continue
    w = CARR[cl]
    if cl == "service" and r.get("subclass") in ("driveway", "parking_aisle"):
        w = 3.5
    wr = r.get("width_rules")
    if wr:
        try:
            vals = [x["value"] for x in wr if x.get("value")]
            if vals:
                w = float(np.clip(np.median(vals), 2.0, 30.0))
        except Exception:
            pass
    if cl in PATHS:
        draw_line(d_p, g, w)
        continue
    draw_line(d_c, g, w)
    draw_line(d_s, g, w + 2 * SIDEWALK.get(cl, 0.0))
    road_list.append((cl, w, g, r))
M_carr = np.asarray(im_c) > 0
M_side = np.asarray(im_s) > 0
M_path = np.asarray(im_p) > 0
M_rail = np.asarray(im_r) > 0
del im_c, im_s, im_p, im_r, d_c, d_s, d_p, d_r
log("roads", len(road_list))

# --- water
log("water…")
water = load_geoms("base_water", cols=["geometry", "subtype", "class", "bbox"])
im_w = new_mask(); d_w = ImageDraw.Draw(im_w)
im_riv = Image.new("L", (N10, N10), 0); d_riv = ImageDraw.Draw(im_riv)


def px10(coords):
    c = np.asarray(coords)[:, :2]
    return list(zip(((c[:, 0] + H) / GRID_RES).tolist(), ((H - c[:, 1]) / GRID_RES).tolist()))


for r, g in water:
    cl = r.get("class")
    if cl == "swimming_pool":
        continue
    if g.geom_type in ("LineString", "MultiLineString"):
        wm = 4.0 if cl in ("stream", "canal", "river") else 2.0
        draw_line(d_w, g, wm)
        if cl in ("river", "canal", "stream"):
            for ls in (g.geoms if hasattr(g, "geoms") else [g]):
                if len(ls.coords) >= 2:
                    d_riv.line(px10(ls.coords), fill=1, width=2)
    else:
        draw_poly(d_w, g)
        if cl in ("river", "canal", "water", "stream", "reservoir"):
            for p in (g.geoms if hasattr(g, "geoms") else [g]):
                if p.geom_type == "Polygon" and p.area > 20000 and len(p.exterior.coords) >= 3:
                    d_riv.polygon(px10(p.exterior.coords), fill=1)
M_water = np.asarray(im_w) > 0
RIVER10 = np.asarray(im_riv) > 0
del im_w, d_w
log("water", len(water), "river cells", int(RIVER10.sum()))

# worldcover water also excludes (10 m -> 2 m)
wc_water_fine = np.repeat(np.repeat(wc == 80, 5, axis=0), 5, axis=1)
M_water_all = M_water | (wc_water_fine & ~(M_bld | M_carr))
del wc_water_fine

# --- land / land use (10 m rasters)
log("land use…")
lu = load_geoms("base_land_use", cols=["geometry", "subtype", "class", "bbox"])
land = load_geoms("base_land", cols=["geometry", "subtype", "class", "bbox"])


def raster10(feats, pred, width_m=None):
    im = Image.new("L", (N10, N10), 0); d = ImageDraw.Draw(im)
    for r, g in feats:
        if not pred(r):
            continue
        for p in (g.geoms if hasattr(g, "geoms") else [g]):
            if p.geom_type == "Polygon" and len(p.exterior.coords) >= 3:
                d.polygon(px10(p.exterior.coords), fill=1)
                for hole in p.interiors:
                    if len(hole.coords) >= 3:
                        d.polygon(px10(hole.coords), fill=0)
            elif p.geom_type == "LineString" and width_m:
                d.line(px10(p.coords), fill=1, width=max(1, int(width_m / GRID_RES)))
    return np.asarray(im) > 0


Z_park = raster10(lu, lambda r: r["class"] in ("park", "garden", "religious", "theme_park", "natural_monument"))
Z_grass_lu = raster10(lu, lambda r: r["class"] in ("grass",))
Z_cem = raster10(lu, lambda r: r["class"] == "cemetery")
Z_allot = raster10(lu, lambda r: r["class"] in ("allotments", "plant_nursery", "orchard", "vineyard"))
Z_ind = raster10(lu, lambda r: r["class"] in ("industrial", "works", "landfill", "military", "garages",
                                              "construction", "quarry", "railway"))
Z_res = raster10(lu, lambda r: r["class"] in ("residential",))
Z_sport = raster10(lu, lambda r: r["class"] in ("pitch", "stadium", "track", "playground"))
Z_farm = raster10(lu, lambda r: r["class"] in ("farmland", "farmyard"))
Z_forest = raster10(land, lambda r: r["class"] in ("forest", "wood"))
Z_scrub = raster10(land, lambda r: r["class"] in ("scrub", "heath"))
Z_treerow = raster10(land, lambda r: r["class"] in ("tree_row",), width_m=15)
Z_wet = raster10(land, lambda r: r["class"] in ("wetland", "marsh", "reedbed"))
log("land use rasters done")

# ----------------------------------------------------------------------------- zones (10 m)
tree10 = (wc == 10).astype(np.float32)
built10 = (wc == 50).astype(np.float32)
built_frac = ndimage.uniform_filter(built10, 25)            # 250 m window
# building size classes -> densities (per 10 m cell, smoothed)
bx = np.clip(((b_cent[:, 0] + H) / GRID_RES).astype(int), 0, N10 - 1)
by = np.clip(((H - b_cent[:, 1]) / GRID_RES).astype(int), 0, N10 - 1)
small = (b_cent[:, 2] < 260) & (b_cent[:, 3] < 3)
large = (b_cent[:, 2] >= 500) | (b_cent[:, 3] >= 4)
cnt_small = np.zeros((N10, N10), np.float32); np.add.at(cnt_small, (by[small], bx[small]), 1)
cnt_large = np.zeros((N10, N10), np.float32); np.add.at(cnt_large, (by[large], bx[large]), 1)
dens_small = ndimage.uniform_filter(cnt_small, 13) * 169       # houses within ~130 m window
dens_large = ndimage.uniform_filter(cnt_large, 13) * 169
urban = (built_frac > 0.10) | Z_res | Z_ind
urban = ndimage.binary_closing(urban, iterations=3)
private = urban & (dens_small > 12) & (dens_large < 0.35 * dens_small) & ~Z_ind
apartment = urban & ~private
# riparian: near big river water and not much higher than it
dist_riv, (ri, rj) = ndimage.distance_transform_edt(~RIVER10, return_indices=True)
dist_riv = dist_riv * GRID_RES
riv_h = dem[ri, rj]
dh = dem - riv_h
riparian = (dist_riv < 450) & (dh < 9.0)
tree_frac70 = ndimage.uniform_filter(tree10, 7)
big_patch = ndimage.uniform_filter(tree10, 15) > 0.55

ZONES = ["shelterbelt", "forest", "riparian", "urban", "park", "cemetery", "private", "allotments", "industrial"]
Z = {n: i for i, n in enumerate(ZONES)}
zone = np.full((N10, N10), Z["shelterbelt"], np.uint8)
zone[big_patch | Z_forest] = Z["forest"]
zone[urban] = Z["urban"]
zone[urban & Z_ind] = Z["industrial"]
zone[private] = Z["private"]
zone[riparian & ((tree10 > 0) | Z_forest)] = Z["riparian"]
zone[Z_park | Z_grass_lu] = Z["park"]
zone[Z_allot] = Z["allotments"]
zone[Z_cem] = Z["cemetery"]
zone_names = {i: n for n, i in Z.items()}
log("zones", {n: int((zone == i).sum()) for n, i in Z.items()})

# ----------------------------------------------------------------------------- canopy fraction (10 m)
t_nd = smoothstep(0.32, 0.68, ndvi)
CF = tree10 * (0.35 + 0.65 * t_nd)
green_extra = smoothstep(0.42, 0.75, ndvi) * (1 - tree10)
green_extra_priv = smoothstep(0.28, 0.62, ndvi) * (1 - tree10)
extra_w = np.zeros_like(CF)
extra_w[zone == Z["private"]] = 0.34
extra_w[zone == Z["allotments"]] = 0.45
extra_w[zone == Z["urban"]] = 0.16
extra_w[zone == Z["park"]] = 0.30
extra_w[zone == Z["cemetery"]] = 0.40
extra_w[zone == Z["industrial"]] = 0.08
CF += np.where(zone == Z["private"], green_extra_priv, green_extra) * extra_w
forest_like = Z_forest | Z_treerow
CF = np.where(forest_like, np.maximum(CF, 0.75 * smoothstep(0.30, 0.6, ndvi)), CF)
CF[(wc == 80) | (wc == 60)] *= 0.2
CF = np.clip(CF, 0, 1).astype(np.float32)
# excess canopy height (smoothed) for tree heights
excess_s = ndimage.gaussian_filter(np.clip(excess, 0, 40), 1.5)

CROWN = {"shelterbelt": 9.0, "forest": 11.0, "riparian": 13.0, "urban": 9.0, "park": 9.0, "cemetery": 6.0,
         "private": 6.5, "allotments": 5.5, "industrial": 9.5}
CLOSURE = {"shelterbelt": 0.85, "forest": 0.85, "riparian": 0.85, "urban": 0.8, "park": 0.9, "cemetery": 0.9,
           "private": 0.75, "allotments": 0.36, "industrial": 0.7}
dens_by_zone = np.array([CLOSURE[n] / (math.pi * (CROWN[n] / 2) ** 2) for n in ZONES], np.float32)
DENS = CF * dens_by_zone[zone]
log("expected trees", int(DENS.sum() * 100))

# ----------------------------------------------------------------------------- distance fields (2 m)
if USE_CACHE:
    _c = np.load(CACHE)
    dist_bld, dist_hard = _c["dist_bld"], _c["dist_hard"]
    log("EDT from cache")
else:
    log("EDT buildings…")
    dist_bld = (ndimage.distance_transform_edt(~M_bld) * FR).astype(np.float16)
    log("EDT hard…")
    hard = M_carr | M_rail | M_water_all
    dist_hard = (ndimage.distance_transform_edt(~hard) * FR).astype(np.float16)
    del hard
    np.savez(CACHE, dist_bld=dist_bld, dist_hard=dist_hard)
    log("EDT done")

# ----------------------------------------------------------------------------- blue-noise ranked pattern


def ranked_pattern(n, seed, k=24):
    """Mitchell's best-candidate on a torus: every prefix is a blue-noise set."""
    rng = np.random.default_rng(seed)
    pts = np.zeros((n, 2), np.float64)
    pts[0] = rng.random(2)
    for i in range(1, n):
        cand = rng.random((k, 2))
        d = np.abs(cand[:, None, :] - pts[None, :i, :])
        d = np.minimum(d, 1 - d)
        dd = (d ** 2).sum(-1).min(1)
        pts[i] = cand[np.argmax(dd)]
    return pts


pat_file = f"{PROC}/veg_patterns.npy"
if os.path.exists(pat_file):
    PATS = np.load(pat_file)
else:
    log("building ranked blue-noise patterns…")
    PATS = np.stack([ranked_pattern(1024, 100 + s) for s in range(6)])
    np.save(pat_file, PATS)
NP = PATS.shape[1]


def sym(p, s):
    x, y = p[:, 0], p[:, 1]
    if s & 1: x = 1 - x
    if s & 2: y = 1 - y
    if s & 4: x, y = y, x
    return np.column_stack([x, y])


def scatter(density10, pat_ids, salt):
    """Blue-noise points with local density (points per m^2) given by a 10 m raster.
    Returns x, y (pipeline coords) and rank fraction."""
    # max density per 64 m tile
    blk = int(CELL / GRID_RES)  # 6.4 -> use maximum filter + sampling at tile centres
    dmax = ndimage.maximum_filter(density10, size=9)
    tc = (np.arange(NC) + 0.5) * CELL
    txx, tyy = np.meshgrid(tc - H, H - tc)          # tile centres (x east, y north), row 0 = north
    tmax = nearest10(dmax, txx.ravel(), tyy.ravel()).reshape(NC, NC)
    need = np.clip(np.ceil(tmax * CELL * CELL * 1.05), 0, NP).astype(np.int32)
    xs, ys, rk = [], [], []
    h = np.random.default_rng(salt)
    var = h.integers(0, len(pat_ids), size=(NC, NC))
    sy = h.integers(0, 8, size=(NC, NC))
    rows, cols = np.nonzero(need)
    for r, c in zip(rows.tolist(), cols.tolist()):
        n = need[r, c]
        p = sym(PATS[pat_ids[var[r, c]], :n], sy[r, c])
        xs.append(-H + (c + p[:, 0]) * CELL)
        ys.append(H - (r + p[:, 1]) * CELL)
        rk.append(np.arange(n, dtype=np.float32))
    x = np.concatenate(xs); y = np.concatenate(ys); rank = np.concatenate(rk)
    d = bilinear(density10, x, y)
    keep = rank < d * CELL * CELL
    return x[keep], y[keep]


def pick(mix_name, u, table=MIX):
    names = list(table[mix_name].keys())
    w = np.array(list(table[mix_name].values()), np.float64)
    cw = np.cumsum(w) / w.sum()
    idx = np.searchsorted(cw, u, side="right")
    ids = np.array([NAME_TO_ID[n] for n in names], np.uint8)
    return ids[np.clip(idx, 0, len(ids) - 1)]


def hash2(ix, iy, salt=0):
    h = (ix.astype(np.int64) * 73856093) ^ (iy.astype(np.int64) * 19349663) ^ (salt * 83492791)
    h = (h ^ (h >> 13)) * 1274126177
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float64) / float(0xFFFFFF)


def choose_species(x, y, zone_ids, patch=55.0, dominance=0.55, salt=1):
    """Species with spatial clumping: jittered patches get a dominant species."""
    n = len(x)
    out = np.zeros(n, np.uint8)
    u_rand = RNG.random(n)
    jx = x + 20 * np.sin(y / 37.0); jy = y + 20 * np.sin(x / 41.0)
    pix = np.floor(jx / patch).astype(np.int64); piy = np.floor(jy / patch).astype(np.int64)
    u_patch = hash2(pix, piy, salt)
    dom = hash2(pix, piy, salt + 7) < dominance
    for zi in np.unique(zone_ids):
        m = zone_ids == zi
        name = zone_names[int(zi)]
        u = np.where(dom[m], u_patch[m], u_rand[m])
        out[m] = pick(name, u)
    return out


def species_dims(sp, zone_ids, u1, u2, cf):
    h = np.zeros(len(sp), np.float32); w = np.zeros(len(sp), np.float32)
    for s in np.unique(sp):
        m = sp == s
        (hl, hh), (rl, rh) = SPECIES[int(s)][2], SPECIES[int(s)][3]
        h[m] = hl + (hh - hl) * (u1[m] ** 0.85)
        w[m] = h[m] * (rl + (rh - rl) * u2[m])
    zm = np.ones(len(sp), np.float32)
    zm[zone_ids == Z["shelterbelt"]] = 0.88
    zm[zone_ids == Z["allotments"]] = 0.9
    zm[zone_ids == Z["riparian"]] = 1.06
    zm *= (0.8 + 0.2 * np.clip(cf * 1.4, 0, 1))      # edge / sparse trees a bit smaller
    h *= zm; w *= (0.9 + 0.1 * zm)
    return h, w


# ----------------------------------------------------------------------------- general trees
log("scatter trees…")
tx, ty = scatter(DENS, [0, 1, 2, 3], salt=11)
log("tree candidates", len(tx))
tz = nearest10(zone, tx, ty)
tcf = bilinear(CF, tx, ty)
tsp = choose_species(tx, ty, tz)
th, tw = species_dims(tsp, tz, RNG.random(len(tx)), RNG.random(len(tx)), tcf)
# taller where the DSM sees canopy
exs = bilinear(excess_s, tx, ty)
th *= np.clip(0.92 + exs * 0.025, 0.9, 1.18)
jb, ib = fine_idx(tx, ty)
db = dist_bld[jb, ib].astype(np.float32)
dhd = dist_hard[jb, ib].astype(np.float32)
onpath = M_path[jb, ib]
ok = (dhd >= 1.6) & (db >= np.clip(0.26 * tw, 1.8, 4.0)) & ~onpath & ~M_rail[jb, ib]
# trees very close to buildings are smaller / narrower
tw = np.where(db < 0.5 * tw, np.maximum(db * 1.8, tw * 0.6), tw)
tx, ty, tz, tsp, th, tw = tx[ok], ty[ok], tz[ok], tsp[ok], th[ok], tw[ok]
trot = RNG.random(len(tx)) * 2 * np.pi
log("trees after exclusion", len(tx), {n: int((tz == i).sum()) for n, i in Z.items()})

# ----------------------------------------------------------------------------- street trees
log("street trees…")
STREET_CLS = {"trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street",
              "pedestrian"}
stx, sty, stsp, sth, stw, strot = [], [], [], [], [], []
hx, hy, hl, hh, hrot = [], [], [], [], []
srng = np.random.default_rng(777)
for cl, w, g, r in road_list:
    if cl not in STREET_CLS:
        continue
    lines = list(g.geoms) if hasattr(g, "geoms") else [g]
    for ls in lines:
        L = ls.length
        if L < 12:
            continue
        mid = ls.interpolate(0.5, normalized=True)
        zc = int(nearest10(zone, np.array([mid.x]), np.array([mid.y]))[0])
        zn = zone_names[zc]
        is_private = zn in ("private", "allotments")
        is_city = zn in ("urban", "park", "industrial", "cemetery")
        if not (is_private or is_city):
            continue
        for side in (-1, 1):
            u = srng.random()
            if is_private:
                spacing = srng.uniform(6, 12); off = w / 2 + srng.uniform(1.5, 4.0)
                jit = 2.5; mixn = "street_private"; p_base = 0.42
            else:
                spacing = srng.uniform(5.5, 9.0); off = w / 2 + srng.uniform(1.8, 4.5)
                jit = 0.5; mixn = "street_city"; p_base = 0.85 if zn != "industrial" else 0.5
            # species runs of ~150-350 m along the street
            run_len = srng.uniform(150, 350)
            n = int(L / spacing)
            if n < 1:
                continue
            ds = (np.arange(n) + 0.5) * spacing + srng.uniform(-jit, jit, n)
            ds = np.clip(ds, 0.5, L - 0.5)
            pts = np.array([ls.interpolate(d).coords[0][:2] for d in ds])
            pts2 = np.array([ls.interpolate(min(L, d + 1.0)).coords[0][:2] for d in ds])
            pts1 = np.array([ls.interpolate(max(0.0, d - 1.0)).coords[0][:2] for d in ds])
            t = pts2 - pts1
            t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-6)
            nrm = np.column_stack([-t[:, 1], t[:, 0]]) * side
            o = off + (srng.uniform(-1.0, 1.0, n) if is_private else srng.uniform(-0.25, 0.25, n))
            p = pts + nrm * o[:, None]
            ev = np.maximum(bilinear(tree10, p[:, 0], p[:, 1]), smoothstep(0.33, 0.6, bilinear(ndvi, p[:, 0], p[:, 1])))
            acc = srng.random(n) < p_base * ev ** 0.8
            runs = (ds / run_len).astype(int)
            sp = np.zeros(n, np.uint8)
            for ru in np.unique(runs):
                mm = runs == ru
                s0 = pick(mixn, np.array([srng.random()]))[0]
                sp[mm] = s0
                if is_private:  # private streets are mixed
                    sp[mm] = pick(mixn, srng.random(mm.sum()))
            u1 = np.full(n, srng.random()) * 0.6 + srng.random(n) * 0.4
            hs, ws = species_dims(sp, np.full(n, zc), u1, srng.random(n), np.ones(n))
            jb, ib = fine_idx(p[:, 0], p[:, 1])
            db = dist_bld[jb, ib].astype(np.float32)
            dhd = dist_hard[jb, ib].astype(np.float32)
            ok = acc & (dhd >= 1.3) & (db >= np.clip(0.3 * ws, 2.0, 4.5)) & ~M_path[jb, ib] & ~M_rail[jb, ib]
            if ok.any():
                stx.append(p[ok, 0]); sty.append(p[ok, 1]); stsp.append(sp[ok])
                sth.append(hs[ok]); stw.append(ws[ok])
                strot.append(srng.random(ok.sum()) * 2 * np.pi)
            # clipped hedges along city streets (between carriageway and sidewalk / sidewalk and lawn)
            if is_city and zn != "industrial" and cl in ("secondary", "tertiary", "residential", "primary", "trunk") \
                    and srng.random() < 0.38:
                hoff = w / 2 + (srng.uniform(0.9, 1.4) if srng.random() < 0.5 else srng.uniform(3.8, 5.0))
                d = srng.uniform(0, 6)
                seg_h = srng.uniform(0.8, 1.3)
                while d < L - 4:
                    seg_l = srng.uniform(5, 14)
                    if d + seg_l > L:
                        break
                    a = np.array(ls.interpolate(d).coords[0][:2]); b = np.array(ls.interpolate(d + seg_l).coords[0][:2])
                    tt = b - a; ln = np.linalg.norm(tt)
                    if ln > 2:
                        tt /= ln
                        nn = np.array([-tt[1], tt[0]]) * side
                        c = (a + b) / 2 + nn * hoff
                        samp = np.array([c, a + nn * hoff, b + nn * hoff])
                        jb2, ib2 = fine_idx(samp[:3, 0], samp[:3, 1])
                        nd = bilinear(ndvi, np.array([c[0]]), np.array([c[1]]))[0]
                        if nd > 0.3 and (dist_hard[jb2, ib2].astype(np.float32) >= 0.8).all() \
                                and (dist_bld[jb2, ib2].astype(np.float32) >= 1.5).all() and not M_path[jb2, ib2].any():
                            hx.append(c[0]); hy.append(c[1]); hl.append(ln); hh.append(seg_h)
                            hrot.append(math.atan2(tt[1], tt[0]))
                    d += seg_l + srng.uniform(1.5, 12)

stx = np.concatenate(stx); sty = np.concatenate(sty); stsp = np.concatenate(stsp)
sth = np.concatenate(sth); stw = np.concatenate(stw); strot = np.concatenate(strot)
# street trees too close to each other (crossing streets): thin
kd = cKDTree(np.column_stack([stx, sty]))
pairs = kd.query_pairs(3.0, output_type="ndarray")
drop = np.zeros(len(stx), bool); drop[pairs[:, 1]] = True
stx, sty, stsp, sth, stw, strot = (a[~drop] for a in (stx, sty, stsp, sth, stw, strot))
log("street trees", len(stx), "hedges", len(hx))
# remove general trees crowding street trees
kd = cKDTree(np.column_stack([stx, sty]))
dmin, _ = kd.query(np.column_stack([tx, ty]), k=1)
keep = dmin > np.maximum(3.5, 0.45 * tw)
tx, ty, tz, tsp, th, tw, trot = (a[keep] for a in (tx, ty, tz, tsp, th, tw, trot))
log("general trees after street merge", len(tx))

# ----------------------------------------------------------------------------- shrubs
log("shrubs…")
green = smoothstep(0.35, 0.65, ndvi)
SF = np.zeros((N10, N10), np.float32)
nontree = 1 - tree10
edge = smoothstep(0.1, 0.4, tree_frac70) * smoothstep(0.95, 0.6, tree_frac70)
for zn, v in (("urban", 0.022), ("park", 0.045), ("cemetery", 0.06), ("private", 0.025), ("industrial", 0.01)):
    SF[zone == Z[zn]] += v
SF *= green
near_city = ndimage.distance_transform_edt(~urban) * GRID_RES < 1200
SF += edge * 0.018 * green * near_city
near_water = (dist_riv < 45) & (wc != 80) & near_city
SF[near_water] += 0.06 * green[near_water]
steppe = (wc == 30) & ~urban & near_city
SF[steppe] += 0.0003 * green[steppe]
SF[Z_scrub] += 0.2
SF[(wc == 80) | (wc == 40)] *= 0.1
SDENS = SF / 5.5
log("expected shrubs", int(SDENS.sum() * 100))
sx, sy = scatter(SDENS, [4, 5], salt=23)
log("shrub candidates", len(sx))
sz = nearest10(zone, sx, sy)
szn = np.full(len(sx), "urban", dtype=object)
mixname = np.empty(len(sx), dtype=object)
mixname[:] = "urban"
for zn in ("park", "cemetery"):
    mixname[sz == Z[zn]] = "park"
mixname[(sz == Z["private"]) | (sz == Z["allotments"])] = "private"
mixname[(sz == Z["forest"]) | (sz == Z["shelterbelt"])] = "forest"
nw = nearest10(near_water.astype(np.uint8), sx, sy) > 0
mixname[nw | (sz == Z["riparian"])] = "riparian"
st_mask = nearest10(steppe.astype(np.uint8), sx, sy) > 0
mixname[st_mask] = "steppe"
ssp = np.zeros(len(sx), np.uint8)
us = RNG.random(len(sx))
for mn in np.unique(mixname):
    m = mixname == mn
    ssp[m] = pick(mn, us[m], SHRUB_MIX)
sh, sw = species_dims(ssp, sz, RNG.random(len(sx)), RNG.random(len(sx)), np.ones(len(sx)))
jb, ib = fine_idx(sx, sy)
ok = (dist_hard[jb, ib].astype(np.float32) >= 0.9) & (dist_bld[jb, ib].astype(np.float32) >= 1.2) & \
     ~M_path[jb, ib] & ~M_side[jb, ib] & ~M_rail[jb, ib]
# away from tree trunks
alltrees = np.column_stack([np.concatenate([tx, stx]), np.concatenate([ty, sty])])
kd = cKDTree(alltrees)
dmin, _ = kd.query(np.column_stack([sx, sy]), k=1)
ok &= dmin > 2.2
sx, sy, ssp, sh, sw = sx[ok], sy[ok], ssp[ok], sh[ok], sw[ok]
srot = RNG.random(len(sx)) * 2 * np.pi
log("shrubs", len(sx), {m: int((mixname[ok] == m).sum()) for m in np.unique(mixname)})

# ----------------------------------------------------------------------------- assemble & write trees.bin.gz
X = np.concatenate([tx, stx, sx, np.array(hx)])
Y = np.concatenate([ty, sty, sy, np.array(hy)])
SP = np.concatenate([tsp, stsp, ssp, np.full(len(hx), NAME_TO_ID["hedge"], np.uint8)]).astype(np.uint8)
HT = np.concatenate([th, sth, sh, np.array(hh)])
CW = np.concatenate([tw, stw, sw, np.array(hl)])
RT = np.concatenate([trot, strot, srot, np.array(hrot)])
inside = (np.abs(X) < H - 0.5) & (np.abs(Y) < H - 0.5)
X, Y, SP, HT, CW, RT = (a[inside] for a in (X, Y, SP, HT, CW, RT))
Zw = -Y  # world z
col = np.clip(((X + H) / CELL).astype(np.int64), 0, NC - 1)
row = np.clip(((Zw + H) / CELL).astype(np.int64), 0, NC - 1)
cell = row * NC + col
order = np.lexsort((RNG.random(len(X)), cell))
X, Zw, SP, HT, CW, RT, cell, col, row = (a[order] for a in (X, Zw, SP, HT, CW, RT, cell, col, row))
counts = np.bincount(cell, minlength=NC * NC)
assert counts.max() < 65536
PQ, HQ, CQ = 0.25, 0.15, 0.1
qx = np.clip(np.floor((X - (-H + col * CELL)) / PQ), 0, 255).astype(np.uint8)
qz = np.clip(np.floor((Zw - (-H + row * CELL)) / PQ), 0, 255).astype(np.uint8)
qh = np.clip(np.round(HT / HQ), 1, 255).astype(np.uint8)
qc = np.clip(np.round(CW / CQ), 1, 255).astype(np.uint8)
qr = (np.round((RT % (2 * np.pi)) / (2 * np.pi) * 256) % 256).astype(np.uint8)
qr[SP != NAME_TO_ID["hedge"]] = 0   # yaw of trees/shrubs is hashed at runtime (better compression)
N = len(X)
hdr = np.zeros(10, np.uint32)
hdr_b = bytearray(b"VEG1") + np.array([1, N, NC], "<u4").tobytes() + \
    np.array([CELL, -H, PQ, HQ, CQ], "<f4").tobytes() + np.array([0], "<u4").tobytes()
assert len(hdr_b) == 40
with gzip.open(os.path.join(OUT, "trees.bin.gz"), "wb", compresslevel=9) as f:
    f.write(bytes(hdr_b))
    f.write(counts.astype("<u2").tobytes())
    for a in (qx, qz, SP, qh, qc, qr):
        f.write(a.tobytes())
log("wrote trees.bin.gz", N, os.path.getsize(os.path.join(OUT, "trees.bin.gz")) // 1024, "KB")

# ----------------------------------------------------------------------------- ground cover (10 m)
log("cover…")
r_, g_, b_ = rgb[..., 0], rgb[..., 1], rgb[..., 2]
bright = (r_ + g_ + b_) / 3
yellow = smoothstep(0.0, 0.05, r_ - b_) * smoothstep(0.02, 0.1, bright)
dens = np.zeros((N10, N10), np.float32)
ctype = np.zeros((N10, N10), np.uint8)
dry = smoothstep(0.72, 0.30, ndvi)
hfac = 0.7 + 0.6 * smoothstep(0.3, 0.8, ndvi)
m = wc == 30
dens[m] = 0.55 + 0.45 * smoothstep(0.25, 0.65, ndvi[m]); ctype[m] = 1
m = wc == 10
dens[m] = 0.42 + 0.43 * smoothstep(0.3, 0.7, ndvi[m]); ctype[m] = 1
m = wc == 50
dens[m] = 0.95 * smoothstep(0.17, 0.42, ndvi[m]); ctype[m] = 0
m = wc == 60
dens[m] = 0.25 * smoothstep(0.15, 0.5, ndvi[m]); ctype[m] = 1
m = wc == 90
dens[m] = 1.0; ctype[m] = 2
m = wc == 40
green_crop = m & (ndvi > 0.62)
cereal = m & (ndvi <= 0.62) & (ndvi > 0.36)
stubble = m & (ndvi <= 0.36)
dens[green_crop] = 1.0; ctype[green_crop] = 4
dens[cereal] = 1.0; ctype[cereal] = 3
dens[stubble] = 0.55; ctype[stubble] = 5
# urban lawns are shorter
lawn = urban & ((wc == 30) | (wc == 10))
ctype[lawn & (ctype == 1)] = 0
ctype[(Z_park | Z_grass_lu | Z_sport) & (ctype == 1)] = 0
# reeds along water edges
reed = (dist_riv < 25) & (wc != 80) & (ndvi > 0.45) & (wc != 10) & ~urban
ctype[reed | Z_wet] = 2; dens[reed | Z_wet] = np.maximum(dens[reed | Z_wet], 0.9)
dens[wc == 80] = 0
cover = np.zeros((N10, N10, 3), np.uint8)
cover[..., 0] = np.clip(dens * 255, 0, 255)
cover[..., 1] = np.clip(dry * 255, 0, 255)
cover[..., 2] = np.clip((hfac - 0.4) / 1.2 * 255, 0, 255)
Image.fromarray(cover, "RGB").save(os.path.join(OUT, "cover.jpg"), quality=82, subsampling=0)
Image.fromarray(ctype, "L").save(os.path.join(OUT, "covertype.png"), optimize=True)
log("cover.jpg", os.path.getsize(os.path.join(OUT, "cover.jpg")) // 1024, "KB", "covertype.png",
    os.path.getsize(os.path.join(OUT, "covertype.png")) // 1024, "KB", {t: int((ctype == t).sum()) for t in range(6)})

# ----------------------------------------------------------------------------- no-grow mask (2 m)
nog = M_bld | M_side | M_path | M_water
jr = M_rail & M_side  # rail beds already in M_side (5 m)
bits = np.packbits(nog, axis=1)
with gzip.open(os.path.join(OUT, "nogrow.bin.gz"), "wb", compresslevel=9) as f:
    f.write(bits.tobytes())
log("nogrow.bin.gz", os.path.getsize(os.path.join(OUT, "nogrow.bin.gz")) // 1024, "KB")

# ----------------------------------------------------------------------------- stats + preview
stats = {"count": int(N), "species": {SPECIES[int(s)][0]: int((SP == s).sum()) for s in np.unique(SP)},
         "street_trees": int(len(stx)), "general_trees": int(len(tx)), "shrubs": int(len(sx)),
         "hedges": int(len(hx)), "zones_cells": {n: int((zone == i).sum()) for n, i in Z.items()}}
json.dump(stats, open(os.path.join(OUT, "stats.json"), "w"), indent=1)
log(json.dumps(stats))

if "--preview" in sys.argv:
    prev = np.zeros((2048, 2048, 3), np.uint8)
    prev[...] = 30
    pi = np.clip(((X + H) / 10).astype(int), 0, 2047); pj = np.clip(((Zw + H) / 10).astype(int), 0, 2047)
    colr = np.array([[(s * 67) % 255, 120 + (s * 31) % 135, (s * 113) % 255] for s in range(64)], np.uint8)
    prev[pj, pi] = colr[SP]
    Image.fromarray(prev).save(os.path.join(PROC, "veg_preview.png"))
    zc = (zone.astype(np.float32) / len(ZONES) * 255).astype(np.uint8)
    Image.fromarray(zc).save(os.path.join(PROC, "veg_zones.png"))
log("done")
