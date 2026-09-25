"""Copernicus GLO-30 DSM -> local heightmap (2049x2049 @10m) in data/processed/dem_raw.npy.

Also writes a bare-earth approximation dem_ground.npy (morphological opening +
smoothing removes most building/tree bumps from the radar surface model) and
dsm_excess.npy = dsm - ground (used for building height inference).
"""
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from affine import Affine
from scipy import ndimage
from config import *

TILES = [
    "Copernicus_DSM_COG_10_N44_00_E041_00_DEM",
    "Copernicus_DSM_COG_10_N44_00_E042_00_DEM",
]
half = REGION_HALF
n = HEIGHT_N
res = GRID_RES
# vertex-centred grid: sample i at x = -half + i*res
dst_t = Affine(res, 0, -half - res / 2, 0, -res, half + res / 2)
dst = np.full((n, n), np.nan, np.float32)
for name in TILES:
    url = f"/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif"
    with rasterio.open(url) as ds:
        tmp = np.full((n, n), np.nan, np.float32)
        reproject(rasterio.band(ds, 1), tmp, dst_transform=dst_t, dst_crs=LOCAL_PROJ,
                  resampling=Resampling.cubic, dst_nodata=np.nan)
        m = np.isfinite(tmp)
        dst[m] = tmp[m]
        print(name, m.sum())
assert np.isfinite(dst).all(), "holes in DEM"
np.save(f"{PROC}/dem_raw.npy", dst)
# bare-earth approximation: grey opening with ~90 m structuring element removes blobs
ground = ndimage.grey_opening(dst, size=(9, 9))
ground = ndimage.gaussian_filter(ground, 2.0)
# never raise terrain above raw DSM
ground = np.minimum(ground, ndimage.gaussian_filter(dst, 1.0))
np.save(f"{PROC}/dem_ground.npy", ground.astype(np.float32))
np.save(f"{PROC}/dsm_excess.npy", (dst - ground).astype(np.float32))
print("dem range", dst.min(), dst.max(), "ground", ground.min(), ground.max())
