"""ESA WorldCover 2021 (10 m) -> local grid data/processed/worldcover.npy (uint8 class codes).
Codes: 10 tree, 20 shrub, 30 grass, 40 crop, 50 built, 60 bare, 70 snow, 80 water, 90 wetland, 95 mangrove, 100 moss."""
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from config import *

n = GRID_N
T = region_transform()
out = np.zeros((n, n), np.uint8)
for tile in ["N42E039", "N42E042"]:
    url = f"/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
    tmp = np.zeros((n, n), np.uint8)
    with rasterio.open(url) as ds:
        reproject(rasterio.band(ds, 1), tmp, dst_transform=T, dst_crs=LOCAL_PROJ,
                  resampling=Resampling.mode, src_nodata=0, dst_nodata=0)
    out = np.where(tmp > 0, tmp, out)
np.save(f"{PROC}/worldcover.npy", out)
vals, cnt = np.unique(out, return_counts=True)
print(dict(zip(vals.tolist(), (cnt / out.size).round(3).tolist())))
