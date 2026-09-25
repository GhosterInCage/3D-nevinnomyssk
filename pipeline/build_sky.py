"""Build the sky module's procedural cloud weather texture.

Output: public/textures/sky/clouds.png  (512x512 RGBA8, seamlessly tileable)

Channels (each histogram-equalised to ~uniform [0,1] so that a threshold of
(1 - coverage) yields approximately `coverage` sky fraction):
  R  cumulus / stratocumulus shape  - Perlin-Worley fbm (billowy cells, ~1.3-2.5 km at a 20 km tile)
  G  cirrus                          - anisotropic streaky fbm
  B  detail / erosion                - high-frequency inverted Worley fbm (sampled at several scales)
  A  large-scale weather variation   - very low frequency fbm (clear gaps vs. cloud banks)

The runtime maps one tile to CLOUD_TILE metres (see src/modules/sky/constants.ts).
Everything is generated with periodic (toroidal) constructions: spectral synthesis
for fbm noise and wrap-around Worley cells, so the texture tiles without seams.

Usage: python3 pipeline/build_sky.py [--seed N]
"""
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import ROOT  # noqa: E402

N = 512
OUT = os.path.join(ROOT, "public", "textures", "sky", "clouds.png")


def spectral_noise(rng, n, beta=2.0, kmin=1.0, kmax=None, aniso=(1.0, 1.0), angle=0.0):
    """Periodic Gaussian noise with power spectrum ~ k^-beta, band-limited."""
    kmax = kmax or n / 2
    fx = np.fft.fftfreq(n) * n
    fy = np.fft.fftfreq(n) * n
    kx, ky = np.meshgrid(fx, fy)
    ca, sa = np.cos(angle), np.sin(angle)
    rx = (kx * ca + ky * sa) * aniso[0]
    ry = (-kx * sa + ky * ca) * aniso[1]
    k = np.sqrt(rx * rx + ry * ry)
    amp = np.zeros_like(k)
    m = (k >= kmin) & (k <= kmax)
    amp[m] = k[m] ** (-beta / 2.0)
    # soft roll-off at the band edges
    amp *= np.exp(-((k / kmax) ** 4))
    ph = rng.normal(size=(n, n)) + 1j * rng.normal(size=(n, n))
    f = np.real(np.fft.ifft2(amp * ph))
    f -= f.mean()
    f /= f.std() + 1e-9
    return f


def worley(rng, n, cells):
    """Periodic Worley F1 distance (0 at feature points, ~1 at cell borders)."""
    pts = rng.random((cells, cells, 2))
    ys, xs = np.mgrid[0:n, 0:n] / n * cells  # cell space coordinates
    cx = np.floor(xs).astype(int)
    cy = np.floor(ys).astype(int)
    best = np.full((n, n), 9.0)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            nx = cx + dx
            ny = cy + dy
            px = pts[ny % cells, nx % cells, 0] + nx
            py = pts[ny % cells, nx % cells, 1] + ny
            d = np.sqrt((px - xs) ** 2 + (py - ys) ** 2)
            best = np.minimum(best, d)
    return np.clip(best / 1.0, 0.0, 1.0)


def worley_fbm(rng, n, base_cells, octaves=3, gain=0.5):
    tot, amp, s = 0.0, 1.0, 0.0
    cells = base_cells
    for _ in range(octaves):
        tot = tot + amp * (1.0 - worley(rng, n, cells))
        s += amp
        amp *= gain
        cells *= 2
    return tot / s


def equalize(f):
    """Rank-based histogram equalisation to uniform [0,1]."""
    flat = f.ravel()
    order = np.argsort(flat, kind="stable")
    ranks = np.empty_like(order)
    ranks[order] = np.arange(flat.size)
    return (ranks / (flat.size - 1)).reshape(f.shape)


def remap(x, a, b, c, d):
    return c + (x - a) / (b - a) * (d - c)


def main():
    seed = 7
    if "--seed" in sys.argv:
        seed = int(sys.argv[sys.argv.index("--seed") + 1])
    rng = np.random.default_rng(seed)

    # --- R: cumulus perlin-worley: clustered billowy cells of ~1-2 km
    perlin = spectral_noise(rng, N, beta=3.0, kmin=1.5, kmax=24)
    perlin = (np.tanh(perlin * 0.9) + 1) * 0.5  # 0..1, low frequency clustering
    w = worley_fbm(rng, N, 12, octaves=3, gain=0.4)
    w = (w - w.min()) / (w.max() - w.min())
    pw = remap(perlin, -(1.0 - w) * 0.9, 1.0, 0.0, 1.0)  # Horizon-ZD style perlin-worley
    pw = np.clip(pw, 0, None)
    r = equalize(pw + 0.04 * spectral_noise(rng, N, beta=1.6, kmin=30, kmax=160))

    # --- G: cirrus streaks (stretched noise, rotated), with finer streak detail
    ci = spectral_noise(rng, N, beta=2.6, kmin=2, kmax=120, aniso=(0.18, 1.0), angle=0.5)
    ci += 0.4 * spectral_noise(rng, N, beta=1.8, kmin=10, kmax=220, aniso=(0.12, 1.0), angle=0.45)
    g = equalize(ci)

    # --- B: detail erosion (high-frequency worley fbm)
    wd = worley_fbm(rng, N, 24, octaves=3, gain=0.55)
    b = equalize(wd + 0.25 * spectral_noise(rng, N, beta=1.2, kmin=40, kmax=250))

    # --- A: large scale weather
    a = equalize(spectral_noise(rng, N, beta=3.0, kmin=1, kmax=6))

    img = np.stack([r, g, b, a], axis=-1)
    img = np.clip(np.round(img * 255), 0, 255).astype(np.uint8)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    Image.fromarray(img, "RGBA").save(OUT, optimize=True)
    print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB")


if __name__ == "__main__":
    main()
