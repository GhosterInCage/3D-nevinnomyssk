#!/usr/bin/env python3
"""Procedural, tileable water textures for the water module (no third-party assets; CC0 by construction).

public/textures/water/
  ripple_n.png  512^2 RGB  small-scale capillary / turbulent ripples (isotropic FFT spectrum) as a
                           world-space normal map: R = nx, G = nz, B = ny (up), all *0.5+0.5.
                           Image row index increases towards +z (texture flipY = false).
  wave_n.png    512^2 RGB  wind-driven gravity waves (Phillips spectrum, wind along +x) same encoding
  foam.png      512^2 L    foam / white-water pattern (Worley cells + fbm), tileable
  noise.png     256^2 RGBA R,G smooth tileable value noise (low / mid frequency), B white noise,
                           A cellular noise
"""
import os

import numpy as np
from PIL import Image

from config import ROOT

OUT = os.path.join(ROOT, "public", "textures", "water")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(1234)


def spectrum_height(n, amp_fn):
    kx = np.fft.fftfreq(n) * n            # cycles per tile
    ky = np.fft.fftfreq(n) * n
    KX, KY = np.meshgrid(kx, ky)          # KX along columns (x), KY along rows (z)
    A = amp_fn(KX, KY)
    A[0, 0] = 0
    ph = rng.standard_normal((n, n)) + 1j * rng.standard_normal((n, n))
    h = np.real(np.fft.ifft2(A * ph))
    # analytic derivatives in Fourier space (exact, tileable)
    F = np.fft.fft2(h)
    dhdx = np.real(np.fft.ifft2(F * (2j * np.pi * KX / n)))
    dhdz = np.real(np.fft.ifft2(F * (2j * np.pi * KY / n)))
    return h, dhdx, dhdz


def save_normal(dhdx, dhdz, name, rms_slope):
    s = np.sqrt(np.mean(dhdx ** 2 + dhdz ** 2))
    k = rms_slope / s
    nx, nz, ny = -dhdx * k, -dhdz * k, np.ones_like(dhdx)
    L = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    rgb = np.stack([nx / L, nz / L, ny / L], -1) * 0.5 + 0.5
    Image.fromarray(np.clip(rgb * 255 + 0.5, 0, 255).astype(np.uint8)).save(os.path.join(OUT, name), optimize=True)


n = 512
# ---- ripples: broad isotropic band, k^-3 slope spectrum with soft low/high cut-offs
def ripple_amp(KX, KY):
    k = np.hypot(KX, KY) + 1e-6
    return k ** -1.9 * np.exp(-(6.0 / k) ** 2) * np.exp(-(k / 150.0) ** 2)


_, dx, dz = spectrum_height(n, ripple_amp)
save_normal(dx, dz, "ripple_n.png", 0.32)


# ---- wind waves: Phillips spectrum, wind along +x, directional spreading cos^4
def wave_amp(KX, KY):
    k = np.hypot(KX, KY) + 1e-6
    kp = 7.0                              # spectral peak (cycles per tile)
    ph = np.exp(-(kp / k) ** 2) / k ** 3.6
    cosang = KX / k
    spread = np.clip(cosang, 0, 1) ** 4 + 0.08 * np.abs(cosang) ** 2 + 0.02
    return np.sqrt(ph * spread) * np.exp(-(k / 110.0) ** 2)


_, dx, dz = spectrum_height(n, wave_amp)
save_normal(dx, dz, "wave_n.png", 0.28)


# ---- tileable value noise helpers
def tile_noise(n, cells, seed):
    r = np.random.default_rng(seed)
    g = r.random((cells, cells))
    x = np.arange(n) * cells / n
    i0 = np.floor(x).astype(int)
    f = x - i0
    f = f * f * (3 - 2 * f)
    i1 = (i0 + 1) % cells
    a = g[np.ix_(i0, i0)]; b = g[np.ix_(i0, i1)]; c = g[np.ix_(i1, i0)]; d = g[np.ix_(i1, i1)]
    fx = f[None, :]; fy = f[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(n, base, octaves, seed, gain=0.5):
    out = np.zeros((n, n)); amp = 1.0; tot = 0
    for o in range(octaves):
        out += amp * tile_noise(n, base * 2 ** o, seed + o)
        tot += amp; amp *= gain
    return out / tot


def worley(n, cells, seed):
    """Tileable F1/F2 Worley distances (in cell units)."""
    r = np.random.default_rng(seed)
    pts = r.random((cells, cells, 2))
    yy, xx = np.mgrid[0:n, 0:n] * (cells / n)
    ci = np.floor(xx).astype(int); cj = np.floor(yy).astype(int)
    f1 = np.full((n, n), 9.0); f2 = np.full((n, n), 9.0)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            ii = ci + di; jj = cj + dj
            p = pts[jj % cells, ii % cells]
            px = ii + p[..., 0]; py = jj + p[..., 1]
            d = np.hypot(xx - px, yy - py)
            f2 = np.where(d < f1, f1, np.minimum(f2, d))
            f1 = np.minimum(f1, d)
    return f1, f2


# ---- foam: bubbly cell borders (F2-F1 small) modulated by fbm clumps
f1a, f2a = worley(n, 24, 7)
f1b, f2b = worley(n, 55, 8)
edges = np.exp(-((f2a - f1a) / 0.12) ** 2) * 0.65 + np.exp(-((f2b - f1b) / 0.14) ** 2) * 0.45
clump = fbm(n, 4, 5, 21)
foam = edges * (0.35 + 0.9 * clump) + 0.55 * np.clip((clump - 0.45) * 2.2, 0, 1) * fbm(n, 16, 3, 33)
foam = (foam - foam.min()) / (foam.max() - foam.min())
foam = np.clip(foam ** 0.9, 0, 1)
Image.fromarray((foam * 255 + 0.5).astype(np.uint8), "L").save(os.path.join(OUT, "foam.png"), optimize=True)

# ---- noise
m = 256
R = fbm(m, 4, 4, 51)
G = fbm(m, 16, 3, 61)
B = rng.random((m, m))
f1c, _ = worley(m, 16, 71)
A = np.clip(f1c / 0.9, 0, 1)
rgba = np.stack([R, G, B, A], -1)
rgba = (rgba - rgba.min((0, 1))) / (rgba.max((0, 1)) - rgba.min((0, 1)) + 1e-9)
Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), "RGBA").save(os.path.join(OUT, "noise.png"), optimize=True)
print("textures ->", OUT, sorted(os.listdir(OUT)))
