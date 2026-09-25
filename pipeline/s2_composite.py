"""Cloud-free Sentinel-2 L2A summer composite over the region, reprojected to the
local 10 m grid (2048x2048).  Outputs data/processed/s2_{rgb,nir,ndvi}.npy and a
preview PNG.  Scenes: clear, full-coverage acquisitions from tile 37TGK."""
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
import concurrent.futures as cf
from PIL import Image
from config import *

SCENES = [
    "2026/7/S2A_37TGK_20260702_1_L2A",
    "2026/7/S2C_37TGK_20260710_0_L2A",
    "2025/7/S2B_37TGK_20250710_0_L2A",
    "2025/6/S2A_37TGK_20250627_1_L2A",
    "2025/7/S2A_37TGK_20250727_1_L2A",
    "2026/7/S2C_37TGK_20260720_0_L2A",
    "2025/6/S2B_37TGK_20250620_0_L2A",
]
BANDS = ["B02", "B03", "B04", "B08", "SCL"]
BASE = "/vsicurl/https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/37/T/GK/"
n = GRID_N
T = region_transform()


def load(scene, band):
    url = f"{BASE}{scene}/{band}.tif"
    out = np.zeros((n, n), np.float32)
    with rasterio.open(url) as ds:
        reproject(rasterio.band(ds, 1), out, dst_transform=T, dst_crs=LOCAL_PROJ,
                  resampling=Resampling.nearest if band == "SCL" else Resampling.bilinear,
                  src_nodata=0, dst_nodata=0)
    return out


stack = {b: [] for b in BANDS}
with cf.ThreadPoolExecutor(8) as ex:
    futs = {(s, b): ex.submit(load, s, b) for s in SCENES for b in BANDS}
    for s in SCENES:
        for b in BANDS:
            stack[b].append(futs[(s, b)].result())
        print("loaded", s, flush=True)

scl = np.stack(stack["SCL"])
valid = np.isin(scl, [4, 5, 6, 7, 11])  # veg, bare, water, unclassified(low prob cloud), snow
out = {}
for b in ["B02", "B03", "B04", "B08"]:
    a = np.stack(stack[b])
    a = np.where(valid & (a > 0), a, np.nan)
    med = np.nanmedian(a, axis=0)
    # fallback where every scene was masked
    fallback = np.nanmedian(np.where(np.stack(stack[b]) > 0, np.stack(stack[b]), np.nan), axis=0)
    med = np.where(np.isfinite(med), med, fallback)
    # L2A (processing baseline >= 04.00) has +1000 offset
    out[b] = med / 10000.0  # earth-search COGs: BOA offset already applied
print("valid fraction", valid.mean(axis=0).mean())
rgb = np.stack([out["B04"], out["B03"], out["B02"]], -1).clip(0, 1).astype(np.float32)
nir = out["B08"].clip(0, 1).astype(np.float32)
ndvi = (nir - rgb[..., 0]) / (nir + rgb[..., 0] + 1e-6)
np.save(f"{PROC}/s2_rgb.npy", rgb)
np.save(f"{PROC}/s2_nir.npy", nir)
np.save(f"{PROC}/s2_ndvi.npy", ndvi.astype(np.float32))
# quick-look preview (simple gain + gamma)
prev = (np.clip(rgb * 3.2, 0, 1) ** (1 / 1.6) * 255).astype(np.uint8)
Image.fromarray(prev).save(f"{PROC}/s2_preview.png")
print("done", rgb.mean(axis=(0, 1)), ndvi.mean())
