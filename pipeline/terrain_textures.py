"""Tiling ground detail textures for the terrain shader (terrain pipeline stage 5).

Writes public/textures/terrain/albedo_<k>.webp (sRGB albedo) and normal_<k>.webp
(R,G = tangent-space normal x/y where +x = +u (image right, world +X) and +y = +v (image down,
world +Z); B = height 0..1 used for height-based blending) for every layer k, plus
public/textures/terrain/layers.json (name, physical tile size in metres, mean linear albedo,
roughness).

Sources (all redistributable):
  * Grass004, Ground037, Rock023 from ambientCG (CC0 1.0), fetched from public GitHub mirrors
    (RichardEllicott/SimpleInfiniteGodotTerrain, TokisanGames/Terrain3D demo assets)
  * all other layers are generated procedurally here (CC0).
"""
import io
import json
import os
import time

import numpy as np
import requests
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

from config import *
from terrain_lib import srgb_decode, srgb_encode

N = 1024
OUT = os.path.join(ROOT, "public", "textures", "terrain")
CACHE = os.path.join(PROC, "tex_src")
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)
SRC = {
    "Grass004_Color": "https://raw.githubusercontent.com/RichardEllicott/SimpleInfiniteGodotTerrain/HEAD/richards_simple_infinite_terrain_v1/Grass004_1K_Color.png",
    "Grass004_Normal": "https://raw.githubusercontent.com/RichardEllicott/SimpleInfiniteGodotTerrain/HEAD/richards_simple_infinite_terrain_v1/Grass004_1K_NormalGL.png",
    "Ground037_alb_ht": "https://raw.githubusercontent.com/TokisanGames/Terrain3D/main/project/demo/assets/textures/ground037_alb_ht.png",
    "Ground037_nrm_rgh": "https://raw.githubusercontent.com/TokisanGames/Terrain3D/main/project/demo/assets/textures/ground037_nrm_rgh.png",
    "Rock023_alb_ht": "https://raw.githubusercontent.com/TokisanGames/Terrain3D/main/project/demo/assets/textures/rock023_alb_ht.png",
    "Rock023_nrm_rgh": "https://raw.githubusercontent.com/TokisanGames/Terrain3D/main/project/demo/assets/textures/rock023_nrm_rgh.png",
}


def fetch(name):
    p = os.path.join(CACHE, name + ".png")
    if not os.path.exists(p):
        r = requests.get(SRC[name], timeout=120)
        r.raise_for_status()
        open(p, "wb").write(r.content)
    im = Image.open(p)
    if im.size != (N, N):
        im = im.resize((N, N), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


# ------------------------------------------------------------------------------- noise toolkit
_f = np.fft.fftfreq(N) * N
FX, FY = np.meshgrid(_f, _f)
FR = np.sqrt(FX ** 2 + FY ** 2)
FR[0, 0] = 1e-6


def fbm(size_px, beta=2.0, seed=0, lo=None, aniso=(1.0, 1.0), rot=0.0):
    """Periodic band-limited fractal noise, zero mean / unit std. size_px ~ largest feature."""
    rng = np.random.default_rng(seed)
    w = np.fft.fft2(rng.standard_normal((N, N)))
    c, s = np.cos(rot), np.sin(rot)
    fx = (FX * c + FY * s) * aniso[0]
    fy = (-FX * s + FY * c) * aniso[1]
    fr = np.sqrt(fx ** 2 + fy ** 2) + 1e-6
    f0 = N / size_px
    amp = fr ** (-beta / 2) * (1 - np.exp(-(fr / f0) ** 2))
    if lo:
        amp *= np.exp(-(fr / (N / lo)) ** 2)
    amp[0, 0] = 0
    out = np.real(np.fft.ifft2(w * amp))
    return (out - out.mean()) / (out.std() + 1e-9)


def blur(a, s):
    return ndimage.gaussian_filter(a, s, mode="wrap")


def voronoi(npts, seed=0, jitter=1.0):
    """Periodic Voronoi: returns (F1, F2 distances in px, cell index, nearest point xy)."""
    rng = np.random.default_rng(seed)
    pts = rng.random((npts, 2)) * N
    tiles = np.concatenate([pts + [dx * N, dy * N] for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
    tree = cKDTree(tiles)
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32) + 0.5
    q = np.stack([xx.ravel(), yy.ravel()], -1)
    d, i = tree.query(q, k=2, workers=-1)
    f1 = d[:, 0].reshape(N, N)
    f2 = d[:, 1].reshape(N, N)
    idx = (i[:, 0] % npts).reshape(N, N)
    near = tiles[i[:, 0]].reshape(N, N, 2)
    return f1, f2, idx, near, pts


def stamp(canvas, x, y, patch, mode="max", weight=None):
    """Composite a small patch into a periodic canvas at integer position (x, y) (top-left)."""
    h, w = patch.shape[:2]
    ys = (np.arange(h) + int(y)) % N
    xs = (np.arange(w) + int(x)) % N
    sub = canvas[np.ix_(ys, xs)]
    if mode == "max":
        canvas[np.ix_(ys, xs)] = np.maximum(sub, patch)
    elif mode == "over":
        a = weight[..., None] if canvas.ndim == 3 else weight
        canvas[np.ix_(ys, xs)] = sub * (1 - a) + patch * a
    else:
        canvas[np.ix_(ys, xs)] = sub + patch


def ellipse_patch(rx, ry, ang, soft=1.0, point=0.0):
    """Anti-aliased (optionally pointed) ellipse mask + dome height. Returns (mask, height)."""
    r = int(np.ceil(max(rx, ry))) + 2
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1].astype(np.float32)
    c, s = np.cos(ang), np.sin(ang)
    u = (xx * c + yy * s) / rx
    v = (-xx * s + yy * c) / ry
    if point:
        v = v / np.maximum(1e-3, 1 - point * np.abs(u) ** 1.5)   # leaf-like pointed ends
    d = np.sqrt(u * u + v * v)
    mask = np.clip((1 - d) * max(rx, ry) / soft, 0, 1)
    height = np.sqrt(np.clip(1 - d * d, 0, 1))
    return mask, height


def normal_from_height(h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * strength
    n = np.stack([-dx, -dy, np.ones_like(h)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def cavity(h, r=3.0):
    return h - blur(h, r)


def lin(c):
    return np.asarray(c, np.float32)


def palette_mix(t, cols):
    """Map t in [0,1] through a list of linear colours."""
    cols = np.asarray(cols, np.float32)
    t = np.clip(t, 0, 1) * (len(cols) - 1)
    i = np.clip(np.floor(t).astype(int), 0, len(cols) - 2)
    f = (t - i)[..., None]
    return cols[i] * (1 - f) + cols[i + 1] * f


LAYERS = []


def save(name, albedo_lin, height, normal=None, strength=6.0, tile_m=3.0, rough=0.9):
    """albedo_lin: NxNx3 linear, height: NxN (any range), normal: optional NxNx3 unit vectors."""
    k = len(LAYERS)
    h = (height - height.min()) / (np.ptp(height) + 1e-9)
    if normal is None:
        normal = normal_from_height(h, strength)
    alb8 = (srgb_encode(np.clip(albedo_lin, 0, 1)) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(alb8).save(os.path.join(OUT, f"albedo_{k}.webp"), quality=82, method=6)
    nrm = np.concatenate([normal[..., :2] * 0.5 + 0.5, h[..., None]], -1)
    Image.fromarray((np.clip(nrm, 0, 1) * 255 + 0.5).astype(np.uint8)).save(
        os.path.join(OUT, f"normal_{k}.webp"), quality=74, method=6)
    mean = albedo_lin.reshape(-1, 3).mean(0)
    LAYERS.append({"name": name, "tile": tile_m, "mean": [round(float(x), 4) for x in mean], "rough": rough})
    print(f"  layer {k} {name}: mean {mean.round(3)}", flush=True)


# ------------------------------------------------------------------------------- photo layers
def photo_normal_gl(img):
    n = img[..., :3] * 2 - 1
    n[..., 1] = -n[..., 1]           # OpenGL (+y up in image) -> +v (image down)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def layer_grass_lush():
    c = fetch("Grass004_Color")[..., :3]
    n = photo_normal_gl(fetch("Grass004_Normal"))
    alb = srgb_decode(c)
    # height proxy from luminance (blade tips are brighter)
    hgt = blur(alb.mean(-1), 1.0)
    # the source is quite saturated/bright: tame it towards local summer lawn values
    lum = (alb * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    alb = lum + (alb - lum) * 0.85
    alb *= 0.9
    return alb, hgt, n


def layer_grass_dry(g_alb, g_h, g_n):
    lum = (g_alb * [0.2126, 0.7152, 0.0722]).sum(-1)
    t = np.clip((lum - np.percentile(lum, 2)) / (np.percentile(lum, 98) - np.percentile(lum, 2)), 0, 1)
    straw = palette_mix(t, [[0.045, 0.040, 0.022], [0.14, 0.115, 0.06], [0.30, 0.25, 0.14], [0.45, 0.39, 0.25]])
    green = g_alb * 0.9
    m = np.clip(0.5 + 0.35 * fbm(180, 2.2, seed=11), 0, 1)[..., None]      # patches of still-green grass
    alb = straw * (0.75 + 0.25 * m) + green * 0.25 * m
    # bare soil gaps typical for steppe pasture
    soil_m = np.clip((fbm(90, 2.0, seed=12) - 0.9) * 1.2, 0, 1)
    soil = lin([0.16, 0.12, 0.08]) * (0.8 + 0.2 * fbm(8, 1.0, seed=13)[..., None])
    alb = alb * (1 - soil_m[..., None]) + soil * soil_m[..., None]
    h = g_h * (1 - soil_m) + 0.1 * soil_m
    return alb, h, g_n


def layer_ground_mix():
    a = fetch("Ground037_alb_ht")
    nr = fetch("Ground037_nrm_rgh")
    alb = srgb_decode(a[..., :3])
    n = photo_normal_gl(nr)
    lum = (alb * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    alb = lum + (alb - lum) * 0.8                          # the scan is very saturated
    alb *= 0.12 / float(lum.mean())
    return alb, a[..., 3], n


def layer_rock():
    a = fetch("Rock023_alb_ht")
    nr = fetch("Rock023_nrm_rgh")
    alb = srgb_decode(a[..., :3])
    lum = (alb * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    # recolour grey rock to the buff loess / sandstone of the Stavropol upland escarpments
    tint = lin([1.35, 1.08, 0.78])
    alb = np.clip(lum * tint * 0.8 + (alb - lum) * 0.3, 0, 1)
    return alb, a[..., 3], photo_normal_gl(nr)


# ------------------------------------------------------------------------------- procedural layers
def layer_ploughed(seed=100):
    # tile 4 m -> 256 px/m; furrows every ~0.5 m along u (rows run along u)
    yy = np.mgrid[0:N, 0:N][0].astype(np.float32)
    warp = fbm(300, 2.5, seed) * 6
    furrow = 0.5 + 0.5 * np.cos(2 * np.pi * (yy + warp) / (N / 8))
    furrow = furrow ** 1.5
    f1, f2, idx, _, _ = voronoi(5200, seed + 1)
    rnd = np.random.default_rng(seed + 2).random(idx.max() + 1)
    clod = np.clip(1 - f1 / (f2 + 1e-3), 0, 1) ** 0.6 * (0.6 + 0.4 * rnd[idx])
    f1b, f2b, idxb, _, _ = voronoi(900, seed + 3)
    big = np.clip(1 - f1b / (f2b + 1e-3), 0, 1) ** 0.8 * (0.5 + 0.5 * rnd[idxb % len(rnd)])
    fine = fbm(6, 1.0, seed + 4)
    h = 1.6 * furrow + 0.55 * clod + 0.8 * big + 0.12 * fine
    dry = np.clip(0.5 + 0.6 * fbm(200, 2.0, seed + 5), 0, 1)
    top = np.clip((h - np.percentile(h, 40)) / np.ptp(h), 0, 1)
    base = palette_mix(0.3 + 0.5 * dry * 0.6 + 0.35 * top, [[0.030, 0.023, 0.017], [0.060, 0.045, 0.031],
                                                           [0.105, 0.080, 0.056], [0.15, 0.12, 0.085]])
    cav = cavity(h, 4)
    base *= np.clip(1 + 0.8 * cav, 0.55, 1.25)[..., None]
    # sparse straw remnants
    alb = base.copy()
    rng = np.random.default_rng(seed + 6)
    straw_h = np.zeros((N, N), np.float32)
    for _ in range(260):
        L = rng.uniform(10, 40)
        m, hh = ellipse_patch(L, 1.2, rng.uniform(0, np.pi), soft=0.8)
        col = lin([0.32, 0.26, 0.14]) * rng.uniform(0.6, 1.1)
        x, y = rng.integers(0, N, 2)
        stamp(alb, x, y, np.broadcast_to(col, m.shape + (3,)), "over", m * 0.9)
        stamp(straw_h, x, y, hh * 0.4 * m, "max")
    return alb, h + straw_h, None


def layer_stubble(seed=200):
    # tile 3 m (341 px/m): drill rows every 15 cm along u; stalks 3-5 mm, dense straw litter
    rng = np.random.default_rng(seed)
    soil = palette_mix(0.5 + 0.25 * fbm(120, 2.0, seed), [[0.10, 0.075, 0.05], [0.16, 0.125, 0.085], [0.22, 0.18, 0.125]])
    alb = soil.copy()
    h = 0.15 * fbm(10, 1.2, seed + 1)
    # straw litter: many thin random strokes
    for _ in range(2600):
        L = rng.uniform(12, 60)
        m, hh = ellipse_patch(L, rng.uniform(0.8, 1.6), rng.uniform(0, np.pi), soft=0.7)
        col = lin([0.40, 0.32, 0.17]) * rng.uniform(0.55, 1.15) + lin([0.02, 0.02, 0.0]) * rng.uniform(-1, 1)
        x, y = rng.integers(0, N, 2)
        stamp(alb, x, y, np.broadcast_to(col, m.shape + (3,)), "over", m * rng.uniform(0.6, 0.95))
        stamp(h, x, y, hh * 0.35 * m, "max")
    # stubble rows: short cut stalks (bright rings with dark hollow centres)
    period = N / 20.0
    for r in range(20):
        yrow = r * period + rng.normal(0, 1.2)
        x = 0.0
        while x < N:
            x += rng.uniform(3, 9)
            rr = rng.uniform(1.6, 3.0)
            m, hh = ellipse_patch(rr, rr * rng.uniform(0.8, 1.2), rng.uniform(0, np.pi), soft=0.6)
            col = lin([0.52, 0.43, 0.23]) * rng.uniform(0.75, 1.1)
            stamp(alb, x, yrow + rng.normal(0, 1.5), np.broadcast_to(col, m.shape + (3,)), "over", m)
            stamp(h, x, yrow, hh * 1.0 * m, "max")
    # scattered green weeds
    for _ in range(90):
        rr = rng.uniform(4, 12)
        m, hh = ellipse_patch(rr, rr * 0.7, rng.uniform(0, np.pi), soft=2, point=0.5)
        col = lin([0.05, 0.10, 0.03]) * rng.uniform(0.7, 1.3)
        x, y = rng.integers(0, N, 2)
        stamp(alb, x, y, np.broadcast_to(col, m.shape + (3,)), "over", m * 0.9)
        stamp(h, x, y, hh * 0.6 * m, "max")
    alb *= np.clip(1 + 1.2 * cavity(h, 3), 0.6, 1.2)[..., None]
    return alb, h, None


def leaf_patch(L, W, ang, point=0.65, curl=0.0):
    """Leaf mask, shading (tip lighter, edges darker, midrib highlight) and height."""
    r = int(np.ceil(max(L, W))) + 2
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1].astype(np.float32)
    c, s_ = np.cos(ang), np.sin(ang)
    u = (xx * c + yy * s_) / L                     # along the leaf, -1 (base) .. 1 (tip)
    v = (-xx * s_ + yy * c) / W
    v = v + curl * u * u                            # slight bend
    wprof = np.maximum(1e-3, (1 - np.abs(u) ** 2) * (1 - point * np.clip(u, 0, 1) ** 1.3))
    d = np.abs(v) / wprof
    inside = (np.abs(u) <= 1) & (d <= 1)
    mask = np.clip((1 - d) * W * 0.9, 0, 1) * np.clip((1 - np.abs(u)) * L * 0.5, 0, 1) * inside
    shade = 0.78 + 0.22 * u - 0.28 * d ** 2 + 0.16 * np.exp(-(v / 0.07) ** 2) * (np.abs(u) < 0.9)
    height = np.sqrt(np.clip(1 - d * d, 0, 1)) * (0.6 + 0.4 * (1 - np.abs(u)))
    return mask, shade, height


def layer_crop(seed=300):
    # tile 4 m: rows every 0.7 m along u (sunflower / maize / soy in July), soil between rows
    rng = np.random.default_rng(seed)
    soil = palette_mix(0.45 + 0.25 * fbm(150, 2.0, seed), [[0.045, 0.035, 0.025], [0.085, 0.065, 0.045], [0.13, 0.10, 0.07]])
    alb = soil * np.clip(1 + 0.3 * fbm(5, 1.0, seed + 1), 0.6, 1.4)[..., None]
    h = 0.12 * fbm(8, 1.0, seed + 2)
    # clods between rows
    f1, f2, idx, _, _ = voronoi(2400, seed + 7)
    clod = np.clip(1 - f1 / (f2 + 1e-3), 0, 1) ** 0.7
    h += 0.25 * clod
    alb *= (0.8 + 0.3 * clod)[..., None]
    rows = 6
    period = N / rows
    for r in range(rows):
        yrow = r * period + period * 0.5
        x = rng.uniform(0, 10)
        while x < N:
            x += rng.uniform(40, 70)                  # plants every 16-27 cm
            base_col = lin([0.040, 0.095, 0.024]) * rng.uniform(0.75, 1.3) + lin([0.01, 0.005, -0.004]) * rng.uniform(-1, 1)
            nleaf = rng.integers(6, 10)
            for li in range(nleaf):
                ang = rng.uniform(0, 2 * np.pi)
                L = rng.uniform(30, 58)                # leaves 12-23 cm
                W = L * rng.uniform(0.42, 0.62)
                cx = x + np.cos(ang) * L * 0.75 + rng.normal(0, 3)
                cy = yrow + np.sin(ang) * L * 0.75 * 0.85 + rng.normal(0, 4)
                m, sh, hh = leaf_patch(L, W, ang, point=0.55, curl=rng.uniform(-0.25, 0.25))
                col = base_col[None, None, :] * sh[..., None] * rng.uniform(0.85, 1.15)
                layer_h = 0.8 + 0.15 * li + 0.4 * hh
                ox, oy = cx - m.shape[1] / 2, cy - m.shape[0] / 2
                stamp(alb, ox, oy, col, "over", m * 0.98)
                stamp(h, ox, oy, layer_h * (m > 0.3), "max")
    # a few weeds in the inter-rows
    for _ in range(120):
        L = rng.uniform(5, 12)
        m, sh, hh = leaf_patch(L, L * 0.4, rng.uniform(0, 2 * np.pi), point=0.7)
        col = lin([0.05, 0.09, 0.03])[None, None, :] * sh[..., None] * rng.uniform(0.7, 1.2)
        x, y = rng.integers(0, N, 2)
        stamp(alb, x, y, col, "over", m * 0.9)
        stamp(h, x, y, (0.5 + 0.2 * hh) * (m > 0.3), "max")
    # leaves cast soft shadows on what is below them (baked ambient occlusion)
    alb *= np.clip(1 + 1.1 * cavity(h, 5), 0.45, 1.15)[..., None]
    return alb, h, None


def layer_bare(seed=400):
    # dry loam / clay, tile 3 m: crack network, crust, small stones
    f1, f2, idx, _, _ = voronoi(420, seed)
    crack = np.clip((f2 - f1) / 5.0, 0, 1) ** 0.6
    # only some cracks are open: modulate by noise so the network is broken and irregular
    open_ = np.clip((fbm(160, 2.0, seed + 9) + 0.3) * 1.2, 0, 1)
    crack = 1 - (1 - crack) * open_ * 0.7
    rnd = np.random.default_rng(seed).random(idx.max() + 1)
    plate = 0.1 * rnd[idx] + 0.4 * crack
    n1 = fbm(200, 2.2, seed + 1)
    n2 = fbm(12, 1.5, seed + 2)
    h = plate + 0.25 * n1 + 0.08 * n2
    t = 0.5 + 0.18 * n1 + 0.08 * n2 + 0.2 * (rnd[idx] - 0.5)
    alb = palette_mix(t, [[0.09, 0.068, 0.047], [0.17, 0.13, 0.09], [0.24, 0.19, 0.135], [0.30, 0.25, 0.18]])
    alb *= (0.7 + 0.3 * crack)[..., None]
    rng = np.random.default_rng(seed + 3)
    for _ in range(700):
        rr = rng.uniform(1.5, 6)
        m, hh = ellipse_patch(rr, rr * rng.uniform(0.6, 1), rng.uniform(0, np.pi), soft=0.8)
        col = lin([0.2, 0.19, 0.17]) * rng.uniform(0.5, 1.4)
        x, y = rng.integers(0, N, 2)
        stamp(alb, x, y, np.broadcast_to(col, m.shape + (3,)), "over", m)
        stamp(h, x, y, 0.4 + hh * 0.3 * m, "max")
    return alb, h, None


def stones_layer(seed, npts, cols, sand_col, round_pow=0.5, gap=0.18, tile=2.5, hscale=1.0, flat=1.0, big_frac=0.25):
    """Packed stones from two periodic Voronoi diagrams (small + large stones) with rounded,
    tilted tops, dust in the gaps, ambient occlusion towards the stone edges and mineral
    speckle. Returns (albedo, height)."""
    rng = np.random.default_rng(seed + 1)
    layers = []
    for s_i, (n_i, g_i) in enumerate(((npts, gap), (max(8, int(npts * big_frac * 0.25)), gap * 0.8))):
        f1, f2, idx, near, pts = voronoi(n_i, seed + 17 * s_i)
        nc = idx.max() + 1
        edge = (f2 - f1) / (f2 + f1 + 1e-6)                 # 0 at the cell border .. 1 at the centre
        dome = np.clip((edge - g_i) / (1 - g_i), 0, 1) ** round_pow
        size_r = rng.uniform(0.6, 1.3, nc)
        # random tilt of each stone
        yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
        dx = (xx - near[..., 0]); dy = (yy - near[..., 1])
        tilt = rng.normal(0, 1, (nc, 2)) * 0.012
        h = dome * size_r[idx] * hscale * (1 + (dx * tilt[idx, 0] + dy * tilt[idx, 1]))
        present = rng.random(nc) < (1.0 if s_i == 0 else big_frac)
        h = h * present[idx]
        layers.append((h, idx, dome * present[idx], nc))
    (h0, i0, d0, n0), (h1, i1, d1, n1) = layers
    big = h1 * 1.6 > h0
    h = np.where(big, h1 * 1.6, h0)
    idx = np.where(big, i1 + n0, i0)
    dome = np.where(big, d1, d0)
    ncol = n0 + n1
    cols = np.asarray(cols, np.float32)
    ci = rng.integers(0, len(cols), ncol)
    tone = rng.uniform(0.7, 1.25, ncol)
    base = cols[ci][idx] * tone[idx][..., None]
    # mineral speckle and veins
    speck = 1 + 0.16 * fbm(2.5, 1.0, seed + 2) + 0.08 * fbm(12, 1.5, seed + 5)
    base *= speck[..., None]
    sand = palette_mix(0.5 + 0.3 * fbm(20, 1.5, seed + 3), sand_col)
    m = blur((dome > 0.03).astype(np.float32), 0.8)
    ao = np.clip(0.55 + 0.6 * dome, 0.55, 1.05)          # darker towards the contact line
    alb = base * (m * ao)[..., None] + sand * (1 - m[..., None]) * 0.85
    h = h + 0.04 * fbm(4, 1.0, seed + 4) * (1 - m) * flat
    alb *= np.clip(1 + 0.8 * cavity(h, 6), 0.6, 1.15)[..., None]
    return alb, h


def layer_gravel(seed=500):
    return stones_layer(seed, 2600, [[0.16, 0.155, 0.15], [0.22, 0.21, 0.19], [0.12, 0.115, 0.11], [0.26, 0.24, 0.21]],
                        [[0.10, 0.09, 0.08], [0.16, 0.145, 0.125]], round_pow=0.35, gap=0.1)


def layer_pebbles(seed=600):
    return stones_layer(seed, 900, [[0.24, 0.235, 0.22], [0.30, 0.28, 0.25], [0.17, 0.175, 0.18], [0.34, 0.30, 0.24], [0.20, 0.18, 0.15]],
                        [[0.15, 0.13, 0.10], [0.24, 0.21, 0.16]], round_pow=0.55, gap=0.22)


def layer_forest(seed=700):
    rng = np.random.default_rng(seed)
    soil = palette_mix(0.4 + 0.25 * fbm(120, 2.0, seed), [[0.03, 0.022, 0.015], [0.06, 0.045, 0.03], [0.09, 0.07, 0.045]])
    alb = soil.copy()
    h = 0.1 * fbm(20, 1.5, seed + 1)
    leaf_cols = np.array([[0.16, 0.09, 0.035], [0.22, 0.14, 0.05], [0.11, 0.07, 0.035], [0.26, 0.17, 0.07],
                          [0.08, 0.06, 0.035], [0.14, 0.11, 0.05]], np.float32)
    for _ in range(4200):
        L = rng.uniform(9, 26)
        m, hh = ellipse_patch(L, L * rng.uniform(0.35, 0.6), rng.uniform(0, 2 * np.pi), soft=0.9, point=0.7)
        col = leaf_cols[rng.integers(0, len(leaf_cols))] * rng.uniform(0.7, 1.2)
        x, y = rng.integers(0, N, 2)
        cur = h[np.ix_((np.arange(m.shape[0]) + y) % N, (np.arange(m.shape[1]) + x) % N)]
        stamp(alb, x, y, np.broadcast_to(col, m.shape + (3,)), "over", m * 0.97)
        stamp(h, x, y, (cur.max() + 0.05 + 0.1 * hh) * (m > 0.5), "max")
    for _ in range(160):   # twigs
        L = rng.uniform(25, 120)
        m, hh = ellipse_patch(L, rng.uniform(1.0, 2.2), rng.uniform(0, np.pi), soft=0.6)
        col = lin([0.05, 0.035, 0.022]) * rng.uniform(0.7, 1.3)
        x, y = rng.integers(0, N, 2)
        stamp(alb, x, y, np.broadcast_to(col, m.shape + (3,)), "over", m)
        stamp(h, x, y, (0.6 + 0.3 * hh) * m, "max")
    moss = np.clip((fbm(160, 2.0, seed + 5) - 0.7) * 1.5, 0, 1)[..., None]
    alb = alb * (1 - moss) + lin([0.035, 0.07, 0.02]) * (0.8 + 0.4 * fbm(4, 1.0, seed + 6)[..., None]) * moss
    alb *= np.clip(1 + 1.4 * cavity(h, 3), 0.5, 1.2)[..., None]
    return alb, h, None


def layer_urban(seed=800):
    # compacted dusty yard ground with fine gravel, remnants of old asphalt and a few weeds; tile 4 m
    rng = np.random.default_rng(seed)
    n1 = fbm(220, 2.2, seed)
    t = 0.5 + 0.2 * n1 + 0.08 * fbm(6, 1.0, seed + 1)
    alb = palette_mix(t, [[0.07, 0.065, 0.058], [0.13, 0.12, 0.105], [0.19, 0.175, 0.15], [0.25, 0.23, 0.2]])
    h = 0.2 * n1 + 0.05 * fbm(5, 1.0, seed + 2)
    g_alb, g_h = stones_layer(seed + 3, 9000, [[0.18, 0.17, 0.16], [0.24, 0.23, 0.21], [0.13, 0.125, 0.12]],
                              [[0.12, 0.11, 0.095], [0.17, 0.155, 0.135]], round_pow=0.4, gap=0.3)
    gm = np.clip(0.5 + 0.7 * fbm(120, 2.0, seed + 4), 0, 1)[..., None]
    alb = alb * (1 - 0.6 * gm) + g_alb * 0.6 * gm
    h = h + 0.4 * g_h * gm[..., 0]
    asphalt = np.clip((fbm(260, 2.4, seed + 5) - 0.8) * 3.0, 0, 1)
    f1, f2, _, _, _ = voronoi(160, seed + 6)
    cracks = np.clip((f2 - f1) / 3.0, 0, 1)
    a_col = palette_mix(0.5 + 0.2 * fbm(4, 1.0, seed + 7), [[0.045, 0.045, 0.045], [0.085, 0.082, 0.078]])
    a_col *= (0.5 + 0.5 * cracks)[..., None]
    alb = alb * (1 - asphalt[..., None]) + a_col * asphalt[..., None]
    h = h * (1 - asphalt) + (0.35 + 0.05 * cracks) * asphalt
    weeds = np.clip((fbm(70, 2.0, seed + 8) - 1.1) * 2.0, 0, 1) * (1 - asphalt)
    alb = alb * (1 - weeds[..., None]) + lin([0.05, 0.085, 0.03]) * (0.8 + 0.4 * fbm(3, 1.0, seed + 9)[..., None]) * weeds[..., None]
    alb *= np.clip(1 + 1.0 * cavity(h, 2), 0.6, 1.2)[..., None]
    return alb, h, None


def layer_mud(seed=900):
    n1 = fbm(260, 2.4, seed)
    n2 = fbm(30, 1.8, seed + 1)
    f1, f2, _, _, _ = voronoi(260, seed + 2)
    crack = np.clip((f2 - f1) / 4.0, 0, 1)
    dry = np.clip(0.5 + 0.8 * n1, 0, 1)
    h = 0.4 * n1 + 0.15 * n2 + 0.25 * crack * dry
    t = 0.35 + 0.35 * dry + 0.08 * n2
    alb = palette_mix(t, [[0.028, 0.026, 0.021], [0.05, 0.046, 0.036], [0.085, 0.077, 0.06], [0.12, 0.11, 0.085]])
    alb *= (1 - 0.45 * (1 - crack) * dry)[..., None]
    rng = np.random.default_rng(seed + 3)
    for _ in range(140):      # reed / organic debris
        L = rng.uniform(15, 70)
        m, hh = ellipse_patch(L, rng.uniform(1.0, 2.5), rng.uniform(0, np.pi), soft=0.8)
        col = lin([0.14, 0.12, 0.07]) * rng.uniform(0.6, 1.2)
        x, y = rng.integers(0, N, 2)
        stamp(alb, x, y, np.broadcast_to(col, m.shape + (3,)), "over", m * 0.85)
        stamp(h, x, y, (0.5 + 0.2 * hh) * m, "max")
    return alb, h, None


def layer_sand(seed=1000):
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    warp = fbm(400, 2.6, seed) * 30
    rip = np.sin(2 * np.pi * (yy + warp + 0.3 * xx * 0.0) / (N / 24)) * (0.6 + 0.4 * fbm(300, 2.0, seed + 1))
    h = 0.35 * rip + 0.25 * fbm(250, 2.2, seed + 2) + 0.06 * fbm(2, 1.0, seed + 3)
    t = 0.5 + 0.15 * fbm(200, 2.0, seed + 4) + 0.1 * fbm(2, 1.0, seed + 5)
    alb = palette_mix(t, [[0.17, 0.145, 0.105], [0.25, 0.215, 0.16], [0.33, 0.29, 0.22]])
    rng = np.random.default_rng(seed + 6)
    for _ in range(420):
        rr = rng.uniform(2, 7)
        m, hh = ellipse_patch(rr, rr * rng.uniform(0.6, 1), rng.uniform(0, np.pi), soft=0.8)
        col = lin([0.22, 0.21, 0.2]) * rng.uniform(0.5, 1.4)
        x, y = rng.integers(0, N, 2)
        stamp(alb, x, y, np.broadcast_to(col, m.shape + (3,)), "over", m)
        stamp(h, x, y, (0.6 + 0.4 * hh) * m, "max")
    alb *= np.clip(1 + 0.5 * cavity(h, 3), 0.8, 1.1)[..., None]
    return alb, h, None


def main():
    t0 = time.time()
    print("terrain textures ->", OUT)
    g_alb, g_h, g_n = layer_grass_lush()
    save("grass_lush", g_alb, g_h, g_n, tile_m=2.2, rough=0.95)                          # 0
    a, h, n = layer_grass_dry(g_alb, g_h, g_n)
    save("grass_dry", a, h, n, tile_m=2.2, rough=0.95)                                     # 1
    a, h, n = layer_ground_mix()
    save("ground_mix", a, h, n, tile_m=3.0, rough=0.93)                                    # 2
    a, h, n = layer_crop()
    save("crop_rows", a, h, n, strength=9, tile_m=4.0, rough=0.9)                          # 3
    a, h, n = layer_stubble()
    save("stubble", a, h, n, strength=10, tile_m=3.0, rough=0.93)                          # 4
    a, h, n = layer_ploughed()
    save("ploughed", a, h, n, strength=14, tile_m=4.0, rough=0.97)                         # 5
    a, h, n = layer_bare()
    save("bare_soil", a, h, n, strength=10, tile_m=3.0, rough=0.95)                        # 6
    a, h = layer_gravel()
    save("gravel", a, h, None, strength=18, tile_m=2.0, rough=0.88)                        # 7
    a, h, n = layer_forest()
    save("forest_floor", a, h, n, strength=12, tile_m=3.0, rough=0.9)                      # 8
    a, h, n = layer_urban()
    save("urban_ground", a, h, n, strength=10, tile_m=4.0, rough=0.88)                     # 9
    a, h = layer_pebbles()
    save("pebbles", a, h, None, strength=22, tile_m=2.5, rough=0.7)                        # 10
    a, h, n = layer_mud()
    save("mud", a, h, n, strength=8, tile_m=3.0, rough=0.6)                                # 11
    a, h, n = layer_sand()
    save("sand", a, h, n, strength=8, tile_m=3.0, rough=0.9)                               # 12
    a, h, n = layer_rock()
    save("clay_rock", a, h, n, tile_m=6.0, rough=0.85)                                     # 13
    json.dump({"size": N, "layers": LAYERS,
               "licence": "Grass004/Ground037/Rock023: ambientCG CC0 1.0; others: procedural (CC0)"},
              open(os.path.join(OUT, "layers.json"), "w"), indent=1)
    print(f"textures done in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
