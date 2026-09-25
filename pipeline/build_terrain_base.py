"""Foundation terrain assets + manifest (export step of the terrain pipeline).

  public/data/manifest.json          origin / projection / region description
  public/data/terrain/height.bin.gz  uint16 LE heightmap, HEIGHT_N x HEIGHT_N, row 0 = north edge
                                     height_m = hMin + value * hScale   (4 cm steps)
  public/data/terrain/ortho.jpg      2048x2048 Sentinel-2 summer composite, sRGB-encoded linear
                                     surface reflectance * orthoGain (row 0 = north edge)
  public/data/terrain/landcover.png  2048x2048 8-bit ESA WorldCover class codes (row 0 = north)

Heights come from data/processed/terrain_final.npy (bare earth + carved water beds, written by
build_terrain.py) and fall back to dem_ground.npy. The ortho comes from
data/processed/terrain_ortho.npy (graded albedo, build_terrain.py) and falls back to s2_rgb.npy.
Running this script alone is safe at any time; it only re-exports.
"""
import gzip
import json
import os

import numpy as np
from PIL import Image

from config import *

OUT = os.path.join(WEB_DATA, "terrain")
H_MIN, H_SCALE = 200.0, 0.04
ORTHO_GAIN = 1.0


def srgb8(lin):
    lin = np.clip(lin, 0, 1)
    s = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    return (np.clip(s, 0, 1) * 255 + 0.5).astype(np.uint8)


def export_height(h):
    os.makedirs(OUT, exist_ok=True)
    q = np.clip(np.round((h - H_MIN) / H_SCALE), 0, 65535).astype("<u2")
    with gzip.open(os.path.join(OUT, "height.bin.gz"), "wb", compresslevel=9) as f:
        f.write(q.tobytes())


def export_ortho(rgb_lin):
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray(srgb8(rgb_lin * ORTHO_GAIN)).save(os.path.join(OUT, "ortho.jpg"), quality=90, subsampling=0)


def export_landcover():
    wc = np.load(f"{PROC}/worldcover.npy")
    Image.fromarray(wc).save(os.path.join(OUT, "landcover.png"), optimize=True)


def write_manifest(h):
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
    path = os.path.join(WEB_DATA, "manifest.json")
    # keep any extra top-level keys other modules may have added
    try:
        old = json.load(open(path))
        for k, v in old.items():
            manifest.setdefault(k, v)
        for k, v in old.get("terrain", {}).items():
            manifest["terrain"].setdefault(k, v)
    except Exception:
        pass
    json.dump(manifest, open(path, "w"), indent=2, ensure_ascii=False)


def main():
    final = f"{PROC}/terrain_final.npy"
    h = np.load(final) if os.path.exists(final) else np.load(f"{PROC}/dem_ground.npy")
    export_height(h)
    ortho = f"{PROC}/terrain_ortho.npy"
    export_ortho(np.load(ortho) if os.path.exists(ortho) else np.load(f"{PROC}/s2_rgb.npy"))
    export_landcover()
    write_manifest(h)
    print("terrain base ok", sorted(os.listdir(OUT)))


if __name__ == "__main__":
    main()
