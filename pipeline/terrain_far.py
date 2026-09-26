"""Far terrain around the detailed region (terrain pipeline stage 4).

Covers a 368.64 km square centred on the origin (+-184 km): the Greater Caucasus with Elbrus
(~150 km SSE), the Stavropol upland, the Kuban valley and the steppe.

Sources
  * heights: AWS Terrain Tiles (terrarium PNG, zoom 10, ~110 m; SRTM/GMTED based, public domain /
    attribution: Mapzen / AWS open data "Terrain Tiles")
  * colour : Sentinel-2 L2A 120 m cloudless mosaic (Sinergise, CC-BY 4.0, "Contains modified
    Copernicus data 2020 processed by Sentinel Hub"), July 2020 periods, median
  * inside the detailed region: our bare-earth heights and ortho, so the seam matches

Outputs (public/data/terrain/)
  far.json            {size, n, res, tiles:[{x0,z0,size,nv,ni,offV,offI}], hScale, hMin, ...}
  far_mesh.bin.gz     per tile: uint16 x,z (tile-local, 0..65535 over the tile), uint16 h
                      ((h - hMin) / hScale), then uint16 triangle indices; tiles concatenated
                      in far.json order (vertices of all tiles first, then indices of all tiles)
  far_color.jpg       2048x2048 sRGB albedo (row 0 = north edge of the far square)
  far_normal.jpg      2048x2048 RG world normal x/z (0..255 -> -1..1), B = built-up fraction^0.7
                      (ESA WorldCover 2021 overview, CC-BY 4.0) used for night lights
The mesh is a right-triangulated irregular network (RTIN, "Martini") built from a 2049^2 grid at
180 m with a screen-space error tolerance that grows with the distance from the detailed region,
so peaks and ridges (Elbrus' double summit) are kept while flat steppe stays coarse.
"""
import concurrent.futures as cf
import gzip
import io
import json
import math
import os
import time

import numpy as np
import rasterio
import requests
try:
    from numba import njit                 # pip install numba (makes the RTIN step ~100x faster)
except ImportError:                          # pragma: no cover - slow pure-Python fallback
    print("[far] numba not installed: RTIN meshing runs in pure Python (several minutes)")

    def njit(*a, **k):
        if a and callable(a[0]):
            return a[0]
        return lambda f: f
from PIL import Image
from rasterio.warp import reproject, Resampling
from rasterio.windows import from_bounds
from scipy import ndimage

from config import *
from terrain_lib import srgb_encode, srgb_decode

FAR_N = 2049                 # grid samples per side (2^11 + 1)
FAR_RES = 180.0
FAR_HALF = (FAR_N - 1) * FAR_RES / 2      # 184320 m
ZOOM = 10
TILE_CACHE = os.path.join(PROC, "far_tiles")
OUT = os.path.join(WEB_DATA, "terrain")
os.makedirs(TILE_CACHE, exist_ok=True)
t0 = time.time()


def log(*a):
    print(f"[far {time.time()-t0:6.1f}s]", *a, flush=True)


# ------------------------------------------------------------------------------ grid geometry
xs = -FAR_HALF + FAR_RES * np.arange(FAR_N)            # east
ys = FAR_HALF - FAR_RES * np.arange(FAR_N)             # north (row 0 = north)
X, Y = np.meshgrid(xs, ys)
inv = to_lonlat()
lon, lat = inv.transform(X, Y)
log("grid lon", lon.min(), lon.max(), "lat", lat.min(), lat.max())


# ------------------------------------------------------------------------------ terrarium heights
def tile_xy(lo, la, z):
    n = 2 ** z
    x = (lo + 180) / 360 * n
    y = (1 - np.log(np.tan(np.radians(la)) + 1 / np.cos(np.radians(la))) / np.pi) / 2 * n
    return x, y


px, py = tile_xy(lon, lat, ZOOM)
tx0, tx1 = int(np.floor(px.min())), int(np.floor(px.max()))
ty0, ty1 = int(np.floor(py.min())), int(np.floor(py.max()))
log(f"terrarium z{ZOOM} tiles x {tx0}..{tx1} y {ty0}..{ty1} ({(tx1-tx0+1)*(ty1-ty0+1)} tiles)")
sess = requests.Session()


def get_tile(tx, ty):
    p = os.path.join(TILE_CACHE, f"{ZOOM}_{tx}_{ty}.png")
    if not os.path.exists(p):
        for attempt in range(4):
            try:
                r = sess.get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{ZOOM}/{tx}/{ty}.png", timeout=60)
                r.raise_for_status()
                open(p, "wb").write(r.content)
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2)
    a = np.asarray(Image.open(p).convert("RGB")).astype(np.float32)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


W = (tx1 - tx0 + 1) * 256
H = (ty1 - ty0 + 1) * 256
mosaic = np.zeros((H, W), np.float32)
with cf.ThreadPoolExecutor(16) as ex:
    futs = {(tx, ty): ex.submit(get_tile, tx, ty) for tx in range(tx0, tx1 + 1) for ty in range(ty0, ty1 + 1)}
    for (tx, ty), f in futs.items():
        mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = f.result()
log("terrarium mosaic", mosaic.shape, float(mosaic.min()), float(mosaic.max()))
# sample (pixel centres at +0.5)
hfar = ndimage.map_coordinates(mosaic, [(py - ty0) * 256 - 0.5, (px - tx0) * 256 - 0.5], order=1, mode="nearest")
hfar = np.maximum(hfar.astype(np.float32), -1.0)       # no bathymetry: the Black Sea is at 0 m
log("far heights", float(hfar.min()), float(hfar.max()))

# ------------------------------------------------------------------------------ merge detailed region
h_near = np.load(f"{PROC}/terrain_final.npy")
k = int(FAR_RES / GRID_RES)                              # 18 near samples per far cell
reg = REGION_HALF
in_x = np.abs(X) <= reg
in_y = np.abs(Y) <= reg
inside = in_x & in_y
# near heights sampled at far grid points (area minimum so the far surface stays below)
hn_min = ndimage.minimum_filter(h_near, size=k + 1)
ci = np.clip(((X + reg) / GRID_RES).round().astype(int), 0, HEIGHT_N - 1)
cj = np.clip(((reg - Y) / GRID_RES).round().astype(int), 0, HEIGHT_N - 1)
near_at = h_near[cj, ci]
near_min_at = hn_min[cj, ci]
# bias of the far source against our DEM (edge band), then blend across a 6 km band
dist_out = np.maximum(np.maximum(np.abs(X) - reg, np.abs(Y) - reg), 0)
edge_band = (~inside) & (dist_out < 3 * FAR_RES)
ring = inside & ((np.abs(X) > reg - 2000) | (np.abs(Y) > reg - 2000))
bias = float(np.median((hfar - near_at)[ring]))
log("far-vs-near bias (m)", round(bias, 2))
hfar_adj = hfar - bias * np.exp(-dist_out / 20000.0)
h_out = np.where(inside, near_min_at - 4.0, hfar_adj).astype(np.float32)
# at the region edge the far surface continues our DEM exactly
edge_vals = np.where(inside, near_at, np.nan)
blend = np.clip(dist_out / 4000.0, 0, 1)
# extrapolate the edge heights outward (nearest edge sample) for the blend band
_, (iy, ix) = ndimage.distance_transform_edt(~inside, return_indices=True)
edge_ext = near_at[iy, ix]
h_out = np.where(inside, h_out, edge_ext * (1 - blend) + hfar_adj * blend).astype(np.float32)
log("merged heights", float(h_out.min()), float(h_out.max()))

# ------------------------------------------------------------------------------ colour (S2 120 m mosaic)
S2M = "https://sentinel-s2-l2a-mosaic-120.s3.amazonaws.com"
DATES = ["2020/7/12", "2020/7/22", "2020/7/2"]
from rasterio.transform import Affine
far_T = Affine(FAR_RES, 0, -FAR_HALF - FAR_RES / 2, 0, -FAR_RES, FAR_HALF + FAR_RES / 2)


def read_band(date, zone, band):
    url = f"/vsicurl/{S2M}/{date}/{zone}/{band}.tif"
    out = np.zeros((FAR_N, FAR_N), np.float32)
    with rasterio.open(url) as ds:
        # window in source CRS covering our lon/lat extent
        from pyproj import Transformer
        tr = Transformer.from_crs("EPSG:4326", ds.crs, always_xy=True)
        ex, ey = tr.transform([lon.min(), lon.max(), lon.min(), lon.max()], [lat.min(), lat.min(), lat.max(), lat.max()])
        win = from_bounds(min(ex) - 5000, min(ey) - 5000, max(ex) + 5000, max(ey) + 5000, ds.transform)
        win = win.intersection(rasterio.windows.Window(0, 0, ds.width, ds.height))
        arr = ds.read(1, window=win).astype(np.float32)
        wt = ds.window_transform(win)
        reproject(arr, out, src_transform=wt, src_crs=ds.crs, dst_transform=far_T, dst_crs=LOCAL_PROJ,
                  resampling=Resampling.bilinear, src_nodata=0, dst_nodata=0)
    return out


def fetch_rgb():
    cache = f"{PROC}/far_s2.npy"
    if os.path.exists(cache):
        return np.load(cache)
    stack = []
    for date in DATES:
        chans = []
        for band in ("B04", "B03", "B02"):
            acc = np.zeros((FAR_N, FAR_N), np.float32)
            for zone in ("37T", "38T"):
                try:
                    a = read_band(date, zone, band)
                except Exception as e:
                    log("  s2 read failed", date, zone, band, e)
                    continue
                acc = np.where(a > 0, a, acc)
            chans.append(acc)
        rgb = np.stack(chans, -1)
        log("  s2", date, "valid", float((rgb[..., 0] > 0).mean()))
        stack.append(np.where(rgb > 0, rgb, np.nan))
    med = np.nanmedian(np.stack(stack), axis=0) / 10000.0
    med = np.nan_to_num(med, nan=0.0).astype(np.float32)
    np.save(cache, med)
    return med


s2 = fetch_rgb()
log("s2 mean", s2.reshape(-1, 3).mean(0))
# colour-match to our ortho albedo inside the region (per-channel linear fit, robust)
ortho = np.load(f"{PROC}/terrain_ortho.npy") if os.path.exists(f"{PROC}/terrain_ortho.npy") else np.load(f"{PROC}/s2_rgb.npy")
o_small = np.stack([ndimage.uniform_filter(ortho[..., c], 18) for c in range(3)], -1)
oi = np.clip(((X + reg) / GRID_RES).astype(int), 0, GRID_N - 1)
oj = np.clip(((reg - Y) / GRID_RES).astype(int), 0, GRID_N - 1)
o_at = o_small[oj, oi]
m = inside & (s2[..., 0] > 0)
col = s2.copy()
for c in range(3):
    a, b = s2[..., c][m], o_at[..., c][m]
    A = np.vstack([a, np.ones_like(a)]).T
    g, off = np.linalg.lstsq(A, b, rcond=None)[0]
    g = float(np.clip(g, 0.6, 1.6))
    log(f"  colour fit ch{c}: gain {g:.3f} offset {off:.4f}")
    fit = s2[..., c] * g + off
    # keep bright snow / glaciers / clouds-free rock at their measured reflectance (soft knee)
    kb = np.clip((s2[..., c] - 0.22) / 0.3, 0, 1)
    col[..., c] = np.clip(fit * (1 - kb) + s2[..., c] * kb, 0, 1)
col = np.where(inside[..., None], o_at, col)
# feather the region edge
fe = np.clip(dist_out / 3000.0, 0, 1)[..., None]
col = np.where(inside[..., None], col, o_at * (1 - fe) + col * fe)
# fill no-data with a neutral steppe colour
nod = s2[..., 0] <= 0
col[nod & ~inside] = [0.09, 0.085, 0.06]
Image.fromarray((srgb_encode(col) * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, "far_color.jpg"), quality=88)
log("far colour written")

# ------------------------------------------------------------------------------ built-up fraction (night lights)
def fetch_built():
    cache = f"{PROC}/far_built.npy"
    if os.path.exists(cache):
        return np.load(cache)
    acc = np.zeros((FAR_N, FAR_N), np.float32)
    for t in ["N42E039", "N42E042", "N45E039", "N45E042"]:
        url = f"/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{t}_Map.tif"
        try:
            with rasterio.open(url, overview_level=2) as ds:      # 1/8 -> ~80 m
                a = (ds.read(1) == 50).astype(np.float32)
                tmp = np.zeros((FAR_N, FAR_N), np.float32)
                reproject(a, tmp, src_transform=ds.transform, src_crs=ds.crs, dst_transform=far_T,
                          dst_crs=LOCAL_PROJ, resampling=Resampling.average, src_nodata=None, dst_nodata=0)
                acc = np.maximum(acc, tmp)
        except Exception as e:
            log("  worldcover overview failed", t, e)
    np.save(cache, acc)
    return acc


built = fetch_built()
log("built-up fraction mean", float(built.mean()))

# ------------------------------------------------------------------------------ normal map
gy_, gx_ = np.gradient(ndimage.gaussian_filter(h_out, 0.6), FAR_RES)
# rows go south: d/dz = +d/drow -> gz = gy_
nx, nz = -gx_, -gy_
ln = np.sqrt(nx * nx + nz * nz + 1)
nrm = np.stack([nx / ln * 0.5 + 0.5, nz / ln * 0.5 + 0.5, np.clip(built, 0, 1) ** 0.7], -1)
Image.fromarray((np.clip(nrm, 0, 1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, "far_normal.jpg"), quality=92)
log("far normal written")


# ------------------------------------------------------------------------------ RTIN (Martini)
@njit(cache=True)
def martini_errors(terrain, tol, size):
    """Bottom-up normalised error pass of Martini (error / local tolerance, propagated)."""
    tile = size - 1
    num_tri = tile * tile * 2 - 2
    num_parent = num_tri - tile * tile
    errors = np.zeros(size * size, np.float32)
    for i in range(num_tri - 1, -1, -1):
        tid = i + 2
        ax = ay = bx = by = cx = cy = 0
        if tid & 1:
            bx = by = cx = tile
        else:
            ax = ay = cy = tile
        tid >>= 1
        while tid > 1:
            mx = (ax + bx) >> 1
            my = (ay + by) >> 1
            if tid & 1:
                bx, by = ax, ay
                ax, ay = cx, cy
            else:
                ax, ay = bx, by
                bx, by = cx, cy
            cx, cy = mx, my
            tid >>= 1
        mx = (ax + bx) >> 1
        my = (ay + by) >> 1
        interp = (terrain[ay * size + ax] + terrain[by * size + bx]) * 0.5
        mid = my * size + mx
        e = abs(interp - terrain[mid]) / tol[mid]
        if e > errors[mid]:
            errors[mid] = e
        if i < num_parent:
            lc = ((ay + cy) >> 1) * size + ((ax + cx) >> 1)
            rc = ((by + cy) >> 1) * size + ((bx + cx) >> 1)
            errors[mid] = max(errors[mid], errors[lc], errors[rc])
    return errors


@njit(cache=True)
def _put(arr, k, a0, a1, a2, a3, a4, a5):
    arr[k, 0] = a0
    arr[k, 1] = a1
    arr[k, 2] = a2
    arr[k, 3] = a3
    arr[k, 4] = a4
    arr[k, 5] = a5


@njit(cache=True)
def martini_extract(errors, size, max_leg):
    """Triangles (grid coords) whose normalised error <= 1 (and leg <= max_leg)."""
    tile = size - 1
    out = np.empty((size * size, 6), np.int32)
    n = 0
    stack = np.empty((256, 6), np.int32)
    for top in range(2):
        if top == 0:
            _put(stack, 0, 0, 0, tile, tile, tile, 0)
        else:
            _put(stack, 0, tile, tile, 0, 0, 0, tile)
        sp = 1
        while sp > 0:
            sp -= 1
            ax = stack[sp, 0]; ay = stack[sp, 1]; bx = stack[sp, 2]
            by = stack[sp, 3]; cx = stack[sp, 4]; cy = stack[sp, 5]
            mx = (ax + bx) >> 1
            my = (ay + by) >> 1
            leg = abs(ax - cx) + abs(ay - cy)
            if leg > 1 and (errors[my * size + mx] > 1.0 or leg > max_leg):
                _put(stack, sp, cx, cy, ax, ay, mx, my)
                _put(stack, sp + 1, bx, by, cx, cy, mx, my)
                sp += 2
            else:
                _put(out, n, ax, ay, bx, by, cx, cy)
                n += 1
    return out[:n]


# tolerance: ~1.3 mrad of the distance to the nearest point of the detailed region (+2 km),
# i.e. about one pixel at 1080p; the hidden interior of the region gets a huge tolerance
d_reg = np.maximum(np.maximum(np.abs(X) - reg, np.abs(Y) - reg), 0)
tol = np.maximum(3.0, 0.0013 * (d_reg + 2500.0)).astype(np.float32)
tol[(np.abs(X) < reg - 1500) & (np.abs(Y) < reg - 1500)] = 1e6
# keep the highest summits crisp: a slightly tighter tolerance on high mountains
tol = np.where(h_out > 3000, tol * 0.6, tol).astype(np.float32)
terr = h_out.astype(np.float32).ravel()
errs = martini_errors(terr, tol.ravel(), FAR_N)
TILES = 8
TCELLS = (FAR_N - 1) // TILES           # 256 cells per tile
tris = martini_extract(errs, FAR_N, TCELLS)
log("RTIN triangles", len(tris))

# split into tiles by triangle centroid; uint16 local indices
cxg = (tris[:, 0] + tris[:, 2] + tris[:, 4]) / 3.0
cyg = (tris[:, 1] + tris[:, 3] + tris[:, 5]) / 3.0
tix = np.clip((cxg // TCELLS).astype(int), 0, TILES - 1)
tiy = np.clip((cyg // TCELLS).astype(int), 0, TILES - 1)
H_MIN, H_SCALE = -100.0, 0.1
tiles_meta, vparts, iparts = [], [], []
offV = offI = 0
for ty in range(TILES):
    for tx in range(TILES):
        sel = tris[(tix == tx) & (tiy == ty)]
        if len(sel) == 0:
            continue
        pts = sel.reshape(-1, 2)                         # (gx, gy) grid coords
        key = pts[:, 1].astype(np.int64) * FAR_N + pts[:, 0]
        uniq, inv_idx = np.unique(key, return_inverse=True)
        gx = (uniq % FAR_N).astype(np.float64)
        gy = (uniq // FAR_N).astype(np.float64)
        lx = (gx - tx * TCELLS) / TCELLS
        ly = (gy - ty * TCELLS) / TCELLS
        hv = h_out.ravel()[uniq]
        v = np.stack([np.round(np.clip(lx, 0, 1) * 65535), np.round(np.clip(ly, 0, 1) * 65535),
                      np.clip(np.round((hv - H_MIN) / H_SCALE), 0, 65535)], -1).astype("<u2")
        idx = inv_idx.reshape(-1, 3).astype("<u2")
        assert len(uniq) < 65536
        vparts.append(v.ravel())
        iparts.append(idx.ravel())
        tsize = TCELLS * FAR_RES
        tiles_meta.append({"x0": -FAR_HALF + tx * tsize, "z0": -FAR_HALF + ty * tsize, "size": tsize,
                           "nv": int(len(uniq)), "ni": int(idx.size), "offV": offV, "offI": offI})
        offV += len(uniq)
        offI += idx.size
blob = np.concatenate([np.concatenate(vparts), np.concatenate(iparts)]).astype("<u2").tobytes()
with gzip.open(os.path.join(OUT, "far_mesh.bin.gz"), "wb", compresslevel=9) as f:
    f.write(blob)
meta = {
    "half": FAR_HALF, "size": 2 * FAR_HALF, "n": FAR_N, "res": FAR_RES, "hMin": H_MIN, "hScale": H_SCALE,
    "regionHalf": REGION_HALF, "maxHeight": float(h_out.max()), "tiles": tiles_meta,
    "vertices": offV, "indices": offI, "color": "terrain/far_color.jpg", "normal": "terrain/far_normal.jpg",
    "mesh": "terrain/far_mesh.bin.gz",
    "sources": "AWS Terrain Tiles (terrarium z10); Sentinel-2 L2A 120 m mosaic 2020 (Sinergise, CC-BY 4.0)",
}
json.dump(meta, open(os.path.join(OUT, "far.json"), "w"), indent=1)
np.save(f"{PROC}/far_height.npy", h_out)
log("far mesh", offV, "vertices", offI // 3, "triangles", os.path.getsize(os.path.join(OUT, "far_mesh.bin.gz")) // 1024, "KB")
