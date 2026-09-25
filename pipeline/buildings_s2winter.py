"""Fetch a few clear, low-sun WINTER Sentinel-2 L2A scenes (tile 37TGK) and
reproject them to the local 10 m grid. Low sun (elevation 21-32 deg) makes
building shadows 1.6-2.6x the building height, which is the strongest open
signal for telling 5-storey from 9-storey blocks at 10 m resolution.

Output: data/processed/s2w_<date>.npz  {bri: float16 (2048^2) brightness
(mean of B03,B04,B08 reflectance, NaN = invalid), sun_el, sun_az}
Usage: python3 pipeline/buildings_s2winter.py
"""
import concurrent.futures as cf
import os

import numpy as np
import rasterio
import requests
from rasterio.warp import reproject, Resampling

from config import PROC, GRID_N, LOCAL_PROJ, region_transform

SCENES = [
    "2025/1/S2B_37TGK_20250111_0_L2A",
    "2025/11/S2B_37TGK_20251127_0_L2A",
    "2023/11/S2B_37TGK_20231108_0_L2A",
    "2025/2/S2C_37TGK_20250215_0_L2A",
    "2026/2/S2C_37TGK_20260220_0_L2A",
    "2025/1/S2B_37TGK_20250108_0_L2A",
    "2023/12/S2A_37TGK_20231230_0_L2A",
]
BASE = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/37/T/GK/"
T = region_transform()
n = GRID_N


def load(scene, band):
    url = f"/vsicurl/{BASE}{scene}/{band}.tif"
    out = np.zeros((n, n), np.float32)
    with rasterio.open(url) as ds:
        reproject(rasterio.band(ds, 1), out, dst_transform=T, dst_crs=LOCAL_PROJ,
                  resampling=Resampling.nearest if band == "SCL" else Resampling.bilinear,
                  src_nodata=0, dst_nodata=0)
    return out


def meta(scene):
    name = scene.split("/")[-1]
    j = requests.get(f"{BASE}{scene}/{name}.json", timeout=60).json()["properties"]
    return j["view:sun_elevation"], j["view:sun_azimuth"]


def fetch(scene):
    name = scene.split("/")[-1]
    out = os.path.join(PROC, f"s2w_{name.split('_')[2]}.npz")
    if os.path.exists(out):
        return out
    el, az = meta(scene)
    with cf.ThreadPoolExecutor(4) as ex:
        b = dict(zip(["B03", "B04", "B08", "SCL"], ex.map(lambda k: load(scene, k), ["B03", "B04", "B08", "SCL"])))
    valid = (b["B04"] > 0) & np.isin(b["SCL"], [2, 4, 5, 6, 7, 11])
    bri = (b["B03"] + b["B04"] + b["B08"]) / 3e4
    bri = np.where(valid, bri, np.nan).astype(np.float16)
    np.savez_compressed(out, bri=bri, sun_el=el, sun_az=az)
    print(name, "valid", round(float(valid.mean()), 3), "sun", round(el, 1), round(az, 1), flush=True)
    return out


def all_scenes():
    res = []
    for s in SCENES:
        try:
            p = fetch(s)
            d = np.load(p)
            if np.isfinite(d["bri"].astype(np.float32)).mean() > 0.6:
                res.append(p)
        except Exception as e:  # network hiccups: keep going with what we have
            print("skip", s, e)
    return res


if __name__ == "__main__":
    print(all_scenes())
