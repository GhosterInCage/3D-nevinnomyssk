"""Procedural, tileable PBR surface textures for the roads module (CC0, generated here).

Writes public/textures/roads/:
  surf_albedo.jpg  1024 x (1024*L)  sRGB albedo, layers stacked vertically (layer 0 at top)
  surf_nrm.jpg     1024 x (1024*L)  R,G = tangent-space normal xy (0.5+0.5*n), B = roughness
Layers (index = texture array layer, world size in metres covered by one tile):
  0 asphalt        1.5 m   dense bitumen with 2-12 mm aggregate
  1 concrete       4.0 m   poured concrete / slab surface, pores, stains
  2 gravel         3.0 m   compacted gravel road
  3 dirt           4.0 m   packed soil with pebbles
  4 paving         2.0 m   grey concrete pavers 200x100 mm, running bond, some red
  5 ballast        2.0 m   crushed granite ballast 30-60 mm
  6 platform       4.0 m   500x500 mm concrete slabs
  7 curb           2.0 m   weathered concrete / granite curb stone

Everything is generated with numpy (FFT noise is periodic, Voronoi uses wrapped points),
so every layer tiles seamlessly.
"""
import os
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree
from scipy import ndimage

N = 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "textures", "roads")
rng = np.random.default_rng(1234)


def fft_noise(n, beta=2.0, seed=None, lo=1.0, hi=None):
    """Periodic 1/f^beta noise normalised to zero mean, unit std."""
    r = np.random.default_rng(seed)
    w = r.standard_normal((n, n))
    F = np.fft.fft2(w)
    fx = np.fft.fftfreq(n) * n
    f = np.sqrt(fx[None, :] ** 2 + fx[:, None] ** 2)
    f[0, 0] = 1
    amp = 1.0 / f ** (beta / 2)
    amp[f < lo] = 0
    if hi is not None:
        amp *= np.exp(-(f / hi) ** 2)
    out = np.real(np.fft.ifft2(F * amp))
    out -= out.mean()
    out /= out.std() + 1e-9
    return out


def voronoi(n, count, seed, jitter=1.0):
    """Wrapped Voronoi: returns (cell id, F1 distance, F2-F1 edge distance) in pixels."""
    r = np.random.default_rng(seed)
    pts = r.random((count, 2)) * n
    offs = np.array([(dx, dy) for dx in (-n, 0, n) for dy in (-n, 0, n)])
    allp = (pts[None, :, :] + offs[:, None, :]).reshape(-1, 2)
    ids = np.tile(np.arange(count), 9)
    tree = cKDTree(allp)
    yy, xx = np.mgrid[0:n, 0:n]
    q = np.c_[xx.ravel() + 0.5, yy.ravel() + 0.5]
    d, i = tree.query(q, k=2)
    cell = ids[i[:, 0]].reshape(n, n)
    f1 = d[:, 0].reshape(n, n)
    f2 = d[:, 1].reshape(n, n)
    return cell, f1, f2 - f1


def normals_from_height(h, strength):
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * strength
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * strength
    nz = 1.0 / np.sqrt(gx * gx + gy * gy + 1)
    nx = -gx * nz
    ny = gy * nz  # image rows go down; flip so +y is "up" in texture space
    return nx, ny


def to_srgb(lin):
    lin = np.clip(lin, 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def aggregate(n, count, seed, rmin=0.35, rmax=0.8, shape_noise=None):
    """Stones as rounded Voronoi cells shrunk by a random factor -> (stone mask height, cell id)."""
    cell, f1, edge = voronoi(n, count, seed)
    r = np.random.default_rng(seed + 1)
    size = r.uniform(rmin, rmax, count)
    cellsz = np.sqrt(n * n / count)
    e = edge / (cellsz * 0.5)
    if shape_noise is not None:
        e = e + shape_noise * 0.25
    t = np.clip((e - (1 - size[cell])) / 0.25, 0, 1)
    h = np.sqrt(t)  # rounded stone profile
    return h, cell, r


def layer_asphalt():
    # 1.5 m tile at 1024 px -> 1.5 mm/px; aggregate 5-15 mm
    fine, cell, r = aggregate(N, 16000, 11, 0.3, 0.8, fft_noise(N, 1.0, 1, lo=60))
    big, cell2, r2 = aggregate(N, 2600, 12, 0.25, 0.7, fft_noise(N, 1.0, 2, lo=30))
    sand = fft_noise(N, 0.2, 3)  # nearly white noise -> sand/fines
    macro = fft_noise(N, 2.2, 4, lo=1)
    stone_tone = r.uniform(0.5, 1.0, 16000)[cell]
    stone_tone2 = r2.uniform(0.5, 1.0, 2600)[cell2]
    bitumen = 0.045 + 0.008 * sand + 0.005 * macro
    alb = bitumen.copy()
    alb = alb * (1 - fine) + fine * (0.075 + 0.07 * stone_tone)
    alb = alb * (1 - big) + big * (0.08 + 0.085 * stone_tone2)
    tint = np.stack([alb * 1.00, alb * 0.99, alb * 0.97], -1)
    h = 0.6 * fine + 1.0 * big + 0.1 * sand
    nx, ny = normals_from_height(h, 2.0)
    rough = np.clip(0.93 - 0.22 * np.maximum(fine, big) + 0.03 * sand, 0.5, 1)
    return tint, nx, ny, rough


def layer_concrete():
    pores_cell, pf1, pedge = voronoi(N, 9000, 21)
    pores = np.random.default_rng(22).random(9000)[pores_cell] > 0.82
    pore_mask = (pf1 < 1.6) & pores
    macro = fft_noise(N, 2.4, 23, lo=1)
    mid = fft_noise(N, 1.6, 24, lo=4)
    fine = fft_noise(N, 0.4, 25)
    alb = 0.30 + 0.03 * macro + 0.018 * mid + 0.012 * fine
    stain = np.clip(fft_noise(N, 2.8, 26, lo=1) - 0.9, 0, 2) * 0.05
    alb = alb - stain
    alb = np.where(pore_mask, alb * 0.55, alb)
    tint = np.stack([alb * 1.0, alb * 0.985, alb * 0.955], -1)
    h = 0.15 * mid + 0.1 * fine - 0.8 * pore_mask
    nx, ny = normals_from_height(ndimage.gaussian_filter(h, 0.7, mode="wrap"), 1.5)
    rough = np.clip(0.88 + 0.05 * fine, 0.6, 1)
    return tint, nx, ny, rough


def layer_gravel():
    s1, c1, r1 = aggregate(N, 2600, 31, 0.3, 0.85, fft_noise(N, 1.0, 32, lo=30))
    s2, c2, r2 = aggregate(N, 9000, 33, 0.2, 0.7, fft_noise(N, 1.0, 34, lo=60))
    dust = fft_noise(N, 1.4, 35, lo=2)
    base = 0.20 + 0.03 * dust
    hue = r1.uniform(0, 1, 2600)[c1]
    tone1 = r1.uniform(0.7, 1.25, 2600)[c1]
    tone2 = r2.uniform(0.7, 1.2, 9000)[c2]
    col_dust = np.stack([base * 1.12, base * 1.0, base * 0.82], -1)
    stone1 = np.stack([0.30 * tone1 * (1 + 0.12 * hue), 0.28 * tone1, 0.25 * tone1 * (1 - 0.1 * hue)], -1)
    stone2 = np.stack([0.26 * tone2, 0.245 * tone2, 0.22 * tone2], -1)
    alb = col_dust * (1 - s2[..., None]) + stone2 * s2[..., None]
    alb = alb * (1 - s1[..., None]) + stone1 * s1[..., None]
    shadow = 1 - 0.35 * (1 - np.maximum(s1, s2)) * (np.maximum(s1, s2) > 0)
    alb *= shadow[..., None] * 0.9 + 0.1
    h = 1.0 * s1 + 0.5 * s2 + 0.1 * dust
    nx, ny = normals_from_height(h, 3.0)
    rough = np.clip(0.92 - 0.1 * s1, 0.6, 1)
    return alb, nx, ny, rough


def layer_dirt():
    macro = fft_noise(N, 2.6, 41, lo=1)
    mid = fft_noise(N, 1.8, 42, lo=3)
    fine = fft_noise(N, 0.6, 43)
    peb, pc, pr = aggregate(N, 1400, 44, 0.15, 0.55, fft_noise(N, 1.0, 45, lo=30))
    peb_on = pr.random(1400)[pc] > 0.45
    peb = peb * peb_on
    # dried mud cracks: Voronoi edges
    cc, cf1, cedge = voronoi(N, 90, 46)
    crack = np.clip(1 - cedge / 3.0, 0, 1) * np.clip(fft_noise(N, 2.0, 47, lo=2) + 0.3, 0, 1)
    base = 0.17 + 0.03 * macro + 0.015 * mid + 0.01 * fine
    alb = np.stack([base * 1.25, base * 1.0, base * 0.72], -1)
    pebc = np.stack([0.26 + 0 * peb, 0.24 + 0 * peb, 0.21 + 0 * peb], -1) * pr.uniform(0.7, 1.2, 1400)[pc][..., None]
    alb = alb * (1 - peb[..., None]) + pebc * peb[..., None]
    alb *= (1 - 0.45 * crack)[..., None]
    h = 0.35 * mid + 0.1 * fine + 0.6 * peb - 0.7 * crack
    nx, ny = normals_from_height(ndimage.gaussian_filter(h, 0.8, mode="wrap"), 2.0)
    rough = np.clip(0.95 - 0.05 * peb, 0.7, 1)
    return alb, nx, ny, rough


def layer_paving():
    # 2 m tile -> 512 px/m; pavers 0.2 x 0.1 m = 102.4 x 51.2 px; 10 x 20 per tile
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
    ph = N / 20.0  # paver height (rows) 51.2
    pw = N / 10.0  # paver width 102.4
    row = np.floor(yy / ph).astype(int)
    xo = xx + (row % 2) * pw * 0.5
    col = np.floor(xo / pw).astype(int) % 10
    fy = (yy / ph) - row
    fx = (xo / pw) - np.floor(xo / pw)
    ex = np.minimum(fx, 1 - fx) * pw
    ey = np.minimum(fy, 1 - fy) * ph
    e = np.minimum(ex, ey)
    joint = np.clip(1 - (e - 1.2) / 2.5, 0, 1)
    bevel = np.clip(e / 7.0, 0, 1)
    pid = row * 10 + col
    r = np.random.default_rng(51)
    tone = r.uniform(0.82, 1.12, 400)[pid % 400]
    red = (r.random(400) < 0.10)[pid % 400]
    noise = fft_noise(N, 0.8, 52, lo=6)
    macro = fft_noise(N, 2.4, 53, lo=1)
    g = (0.26 + 0.015 * noise + 0.02 * macro) * tone
    alb = np.stack([g * 1.0, g * 0.99, g * 0.97], -1)
    redc = np.stack([g * 1.35, g * 0.72, g * 0.6], -1)
    alb = np.where(red[..., None], redc, alb)
    sand = np.stack([0.22 + 0 * g, 0.19 + 0 * g, 0.15 + 0 * g], -1) * (0.8 + 0.1 * fft_noise(N, 0.3, 54))[..., None]
    alb = alb * (1 - joint[..., None]) + sand * joint[..., None]
    h = np.sqrt(bevel) + 0.04 * noise
    nx, ny = normals_from_height(h, 2.0)
    rough = np.clip(0.82 + 0.1 * joint + 0.03 * noise, 0.6, 1)
    return alb, nx, ny, rough


def layer_ballast():
    s, c, r = aggregate(N, 1500, 61, 0.55, 0.95, fft_noise(N, 1.0, 62, lo=20) * 1.6)
    s2, c2, r2 = aggregate(N, 5000, 63, 0.3, 0.8, fft_noise(N, 1.0, 64, lo=40))
    tone = r.uniform(0.6, 1.25, 1500)[c]
    pink = r.random(1500)[c]
    rust = np.clip(fft_noise(N, 2.2, 65, lo=1) * 0.5 + 0.2, 0, 1)
    base = np.stack([0.30 * tone * (1 + 0.15 * pink), 0.29 * tone, 0.28 * tone * (1 - 0.05 * pink)], -1)
    base = base * (1 - 0.35 * rust[..., None]) + np.stack([0.22 * rust, 0.13 * rust, 0.08 * rust], -1) * 0.35
    fill = np.stack([0.07 + 0 * s, 0.065 + 0 * s, 0.06 + 0 * s], -1)
    sm = np.maximum(s, s2 * 0.7)
    lower = np.stack([0.20 * r2.uniform(0.6, 1.2, 5000)[c2]] * 3, -1)
    alb = fill * (1 - s2[..., None]) + lower * s2[..., None]
    alb = alb * (1 - s[..., None]) + base * s[..., None]
    h = 1.0 * s + 0.45 * s2
    nx, ny = normals_from_height(h, 4.5)
    rough = np.clip(0.85 - 0.1 * sm, 0.5, 1)
    return alb, nx, ny, rough


def layer_platform():
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
    cs = N / 8.0  # 0.5 m slabs
    fx = (xx / cs) % 1
    fy = (yy / cs) % 1
    e = np.minimum(np.minimum(fx, 1 - fx), np.minimum(fy, 1 - fy)) * cs
    joint = np.clip(1 - (e - 1.0) / 2.0, 0, 1)
    pid = (np.floor(yy / cs) * 8 + np.floor(xx / cs)).astype(int)
    tone = np.random.default_rng(71).uniform(0.88, 1.1, 64)[pid]
    c, a, b, d = layer_concrete()
    alb = c * tone[..., None] * 1.05
    alb = alb * (1 - 0.6 * joint[..., None])
    h = np.clip(e / 5, 0, 1) ** 0.5
    nx, ny = normals_from_height(h, 1.2)
    nx = nx * 0.6 + a * 0.4
    ny = ny * 0.6 + b * 0.4
    rough = np.clip(d + 0.05 * joint, 0, 1)
    return alb, nx, ny, rough


def layer_curb():
    macro = fft_noise(N, 2.2, 81, lo=1)
    fine = fft_noise(N, 0.5, 82)
    grains, gc, gr = aggregate(N, 12000, 83, 0.2, 0.6)
    tone = gr.uniform(0.6, 1.4, 12000)[gc]
    g = 0.34 + 0.025 * macro + 0.015 * fine
    alb = np.stack([g, g * 0.985, g * 0.96], -1)
    alb = alb * (1 - 0.35 * grains[..., None]) + (0.30 * tone)[..., None] * 0.35 * grains[..., None]
    dirt = np.clip(fft_noise(N, 2.6, 84, lo=1) - 0.4, 0, 2) * 0.08
    alb = alb - dirt[..., None] * np.array([0.9, 1.0, 1.1])
    h = 0.2 * fine + 0.2 * grains
    nx, ny = normals_from_height(h, 1.0)
    rough = np.clip(0.8 + 0.05 * fine, 0.5, 1)
    return alb, nx, ny, rough


LAYERS = [layer_asphalt, layer_concrete, layer_gravel, layer_dirt, layer_paving, layer_ballast, layer_platform, layer_curb]


def main():
    os.makedirs(OUT, exist_ok=True)
    albs, nrms = [], []
    for fn in LAYERS:
        alb, nx, ny, rough = fn()
        a8 = (to_srgb(alb) * 255 + 0.5).astype(np.uint8)
        n8 = np.stack([
            np.clip(nx * 0.5 + 0.5, 0, 1),
            np.clip(ny * 0.5 + 0.5, 0, 1),
            np.clip(rough, 0, 1),
        ], -1)
        n8 = (n8 * 255 + 0.5).astype(np.uint8)
        albs.append(a8)
        nrms.append(n8)
        print(fn.__name__, "mean albedo(lin)", np.round(alb.reshape(-1, 3).mean(0), 3), "rough", round(float(rough.mean()), 2))
    Image.fromarray(np.concatenate(albs, 0)).save(os.path.join(OUT, "surf_albedo.jpg"), quality=88, optimize=True)
    Image.fromarray(np.concatenate(nrms, 0)).save(os.path.join(OUT, "surf_nrm.jpg"), quality=84, optimize=True)
    # small preview for humans
    prev = np.concatenate([a[::4, ::4] for a in albs], 1)
    if os.environ.get("PREVIEW"):
        Image.fromarray(prev).save(os.environ["PREVIEW"])


if __name__ == "__main__":
    main()
