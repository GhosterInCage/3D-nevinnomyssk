"""Shared helpers for the terrain pipeline (build_terrain.py, terrain_far.py, terrain_textures.py).

Grids
  * vertex grid  : HEIGHT_N x HEIGHT_N (2049^2) samples at 10 m, sample (i=col, j=row) at
                   x = -HALF + 10 i, y(north) = HALF - 10 j   (row 0 = north edge)
  * cell grids   : n x n cells covering the region exactly (2048^2 @10 m, 4096^2 @5 m), row 0 = north
"""
import numpy as np
import pyarrow.parquet as pq
import shapely
from affine import Affine
from rasterio import features
from scipy import ndimage

from config import *

HALF = REGION_HALF


def vertex_transform(res=GRID_RES):
    """Affine for the vertex-centred heightmap grid (pixel centre == sample position)."""
    return Affine(res, 0, -HALF - res / 2, 0, -res, HALF + res / 2)


def cell_transform(n):
    res = 2 * HALF / n
    return Affine(res, 0, -HALF, 0, -res, HALF)


_tr = None


def project_geom(g):
    """lon/lat shapely geometry -> local metres (x=east, y=north)."""
    global _tr
    if _tr is None:
        _tr = to_local()
    return shapely.transform(g, lambda c: np.column_stack(_tr.transform(c[:, 0], c[:, 1])))


def read_layer(name, columns=None):
    t = pq.read_table(f"{RAW}/{name}.parquet", columns=columns)
    rows = t.to_pylist()
    for r in rows:
        r["geom"] = project_geom(shapely.from_wkb(r["geometry"]))
    return rows


def rasterize(shapes, shape, transform, all_touched=False, dtype=np.uint8, fill=0):
    shapes = [(g, v) for g, v in shapes if g is not None and not g.is_empty]
    if not shapes:
        return np.full(shape, fill, dtype)
    return features.rasterize(shapes, out_shape=shape, transform=transform, all_touched=all_touched,
                              fill=fill, dtype=dtype)


def disk(r):
    y, x = np.mgrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r + 0.5


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _down(a):
    """2x downsample (sum of 2x2 blocks), pads odd sizes by edge replication."""
    h, w = a.shape
    if h % 2 or w % 2:
        a = np.pad(a, ((0, h % 2), (0, w % 2)), mode="edge")
    return a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2]


def _up(a, shape):
    """Bilinear upsample (x2) to `shape`."""
    zy = shape[0] / a.shape[0]
    zx = shape[1] / a.shape[1]
    out = ndimage.zoom(a, (zy, zx), order=1, mode="nearest", grid_mode=True)
    return out[: shape[0], : shape[1]]


def pushpull_fill(values, weights, blur=1.0):
    """Fill cells with weight 0 from weighted neighbours (Gortler push-pull / normalised
    convolution pyramid). weights in [0,1]; returns a smooth membrane-like fill that equals
    `values` where weights == 1."""
    values = np.where(weights > 0, values, 0).astype(np.float64)
    w = weights.astype(np.float64)
    pyr = []
    v, ww = values * w, w
    while min(v.shape) > 2:
        if blur:
            v = ndimage.gaussian_filter(v, blur)
            ww = ndimage.gaussian_filter(ww, blur)
        pyr.append((v, ww))
        v, ww = _down(v), _down(ww)
    est = v / np.maximum(ww, 1e-9)
    if not np.all(ww > 0):
        est = np.where(ww > 0, est, np.nanmean(np.where(ww > 0, est, np.nan)))
    for v, ww in reversed(pyr):
        up = _up(est, v.shape)
        a = np.clip(ww, 0, 1)
        mean = v / np.maximum(ww, 1e-9)
        est = a * mean + (1 - a) * up
    return np.where(weights >= 1, values, est).astype(np.float32)


def masked_gaussian(a, mask, sigma):
    """Gaussian smoothing that only averages cells inside `mask` (normalised convolution)."""
    m = mask.astype(np.float32)
    num = ndimage.gaussian_filter(np.where(mask, a, 0).astype(np.float32), sigma)
    den = ndimage.gaussian_filter(m, sigma)
    return num / np.maximum(den, 1e-6), den


def hillshade(h, res=10.0, az=315, alt=45, z=2.0):
    gy, gx = np.gradient(h * z, res)
    slope = np.pi / 2 - np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    a = np.radians(az)
    al = np.radians(alt)
    v = np.sin(al) * np.sin(slope) + np.cos(al) * np.cos(slope) * np.cos(a - np.pi / 2 - aspect)
    return np.clip(v, 0, 1)


def srgb_encode(lin):
    lin = np.clip(lin, 0, 1)
    return np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def srgb_decode(s):
    s = np.clip(s, 0, 1)
    return np.where(s <= 0.04045, s / 12.92, np.power((s + 0.055) / 1.055, 2.4))


def cells_to_vertices(cell):
    """2048^2 cell grid -> 2049^2 vertex grid (average of the up to 4 touching cells)."""
    c = cell.astype(np.float32)
    p = np.pad(c, 1, mode="edge")
    return 0.25 * (p[:-1, :-1] + p[1:, :-1] + p[:-1, 1:] + p[1:, 1:])
