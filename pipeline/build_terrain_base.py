"""Foundation terrain assets for the web app (the terrain module may replace these
with richer versions, keeping the same file contracts - see docs/DATA.md):

  public/data/manifest.json          origin / projection / region description
  public/data/terrain/height.bin.gz  uint16 LE heightmap, HEIGHT_N x HEIGHT_N, row 0 = north edge
                                     height_m = hMin + value * hScale
  public/data/terrain/ortho.jpg      2048x2048 Sentinel-2 summer composite, sRGB-encoded linear
                                     surface reflectance * orthoGain (row 0 = north edge)
  public/data/terrain/landcover.png  2048x2048 8-bit ESA WorldCover class codes (row 0 = north)
"""
import gzip, json, os
import numpy as np
from PIL import Image
from config import *

out_dir = os.path.join(WEB_DATA, "terrain")
os.makedirs(out_dir, exist_ok=True)

h = np.load(f"{PROC}/dem_ground.npy")
# optional carved terrain produced by later pipeline stages
carved = f"{PROC}/terrain_final.npy"
if os.path.exists(carved):
    h = np.load(carved)
H_MIN, H_SCALE = 200.0, 0.02
q = np.clip(np.round((h - H_MIN) / H_SCALE), 0, 65535).astype("<u2")
with gzip.open(os.path.join(out_dir, "height.bin.gz"), "wb", compresslevel=9) as f:
    f.write(q.tobytes())

ORTHO_GAIN = 1.0
rgb = np.load(f"{PROC}/s2_rgb.npy") * ORTHO_GAIN
srgb = np.where(rgb <= 0.0031308, 12.92 * rgb, 1.055 * np.power(np.clip(rgb, 0, 1), 1 / 2.4) - 0.055)
Image.fromarray((np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8)).save(
    os.path.join(out_dir, "ortho.jpg"), quality=90, subsampling=0)
wc = np.load(f"{PROC}/worldcover.npy")
Image.fromarray(wc).save(os.path.join(out_dir, "landcover.png"), optimize=True)

manifest = {
    "name": "Nevinnomyssk",
    "origin": {"lon": LON0, "lat": LAT0},
    "proj": LOCAL_PROJ,
    "frame": "three.js world: X=east, Y=up (m above sea level), Z=-north; pipeline (x=east,y=north)",
    "region": {"half": REGION_HALF, "res": GRID_RES, "n": GRID_N},
    "terrain": {
        "height": "terrain/height.bin.gz", "n": HEIGHT_N, "size": 2 * REGION_HALF,
        "hMin": H_MIN, "hScale": H_SCALE, "format": "u16le", "rowOrder": "north-to-south",
        "ortho": "terrain/ortho.jpg", "orthoGain": ORTHO_GAIN,
        "landcover": "terrain/landcover.png",
        "minHeight": float(h.min()), "maxHeight": float(h.max()),
    },
}
json.dump(manifest, open(os.path.join(WEB_DATA, "manifest.json"), "w"), indent=2, ensure_ascii=False)
print("ok", os.listdir(out_dir))
