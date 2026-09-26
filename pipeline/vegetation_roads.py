"""Rasterise the roads module's rendered ground surfaces for vegetation placement.

Reads public/data/roads/{meta.json, ground.bin.gz} (written by pipeline/build_roads.py; format in its
header): per 1 km tile, a triangle mesh whose vertices carry the surface id (gatt[0]) - carriageways,
sidewalks, pedestrian paving, parking lots, rail ballast and platforms exactly as they are drawn.
Bridge decks (bpos/bidx) are skipped: the ground under a bridge may carry vegetation.

rasterise(fr, nf, half) -> dict of boolean masks at `fr` metres (nf x nf, row 0 = north = world z -half):
  carriage  asphalt / old asphalt / concrete / gravel / dirt / paved roads
  walk      sidewalks (asphalt)
  paving    pedestrian paving (centre sidewalks, squares)
  parking   parking lots
  rail      ballast + platforms
Returns None when the roads data is missing.
"""
import gzip
import json
import os

import numpy as np
from PIL import Image, ImageDraw

from config import WEB_DATA

CARRIAGE = ("asphalt", "asphalt_old", "concrete", "gravel", "dirt", "paving_road")
GROUPS = {"carriage": CARRIAGE, "walk": ("sidewalk",), "paving": ("paving",), "parking": ("parking",),
          "rail": ("ballast", "platform")}


def _arr(buf, rec):
    dt, off, n = rec
    np_dt = {"u16": "<u2", "i16": "<i2", "u32": "<u4", "i32": "<i4", "f32": "<f4", "u8": "u1", "i8": "i1"}[dt]
    return np.frombuffer(buf, dtype=np_dt, count=n, offset=off)


def source_mtime():
    p = os.path.join(WEB_DATA, "roads", "ground.bin.gz")
    return os.path.getmtime(p) if os.path.exists(p) else None


def rasterise(fr, nf, half):
    meta_p = os.path.join(WEB_DATA, "roads", "meta.json")
    bin_p = os.path.join(WEB_DATA, "roads", "ground.bin.gz")
    if not (os.path.exists(meta_p) and os.path.exists(bin_p)):
        return None
    meta = json.load(open(meta_p))
    with gzip.open(bin_p, "rb") as f:
        buf = f.read()
    A = meta["arrays"]
    gpos = _arr(buf, A["gpos"]).reshape(-1, 2).astype(np.float64) / float(meta["qs"])
    gatt = _arr(buf, A["gatt"]).reshape(-1, 4)
    gidx = _arr(buf, A["gidx"]).astype(np.int64)
    names = meta["surfaces"]
    sid_group = np.full(256, -1, np.int16)
    gnames = list(GROUPS)
    for gi, g in enumerate(gnames):
        for n in GROUPS[g]:
            if n in names:
                sid_group[names.index(n)] = gi
    ims = [Image.new("L", (nf, nf), 0) for _ in gnames]
    draws = [ImageDraw.Draw(im) for im in ims]
    T = float(meta["tile"])
    for t in meta["tiles"]:
        v0, nv, i0, ni = t["v0"], t["nv"], t["i0"], t["ni"]
        if ni == 0:
            continue
        x0 = -half + t["i"] * T
        z0 = -half + t["j"] * T
        P = gpos[v0:v0 + nv]
        px = (P[:, 0] + x0 + half) / fr          # column
        py = (P[:, 1] + z0 + half) / fr          # row (z south = row down)
        tri = gidx[i0:i0 + ni].reshape(-1, 3)
        grp = sid_group[gatt[v0:v0 + nv, 0][tri[:, 0]]]
        for a, b, c, g in zip(tri[:, 0].tolist(), tri[:, 1].tolist(), tri[:, 2].tolist(), grp.tolist()):
            if g < 0:
                continue
            draws[g].polygon([(px[a], py[a]), (px[b], py[b]), (px[c], py[c])], fill=1, outline=1)
    return {g: np.asarray(im) > 0 for g, im in zip(gnames, ims)}


if __name__ == "__main__":
    import time
    from config import REGION_HALF
    t0 = time.time()
    m = rasterise(2.0, 10240, REGION_HALF)
    print({k: int(v.sum()) * 4 for k, v in m.items()}, "m2", round(time.time() - t0, 1), "s")
