"""Procedural textures for the landmarks module (CC0, generated here, no downloads).

public/textures/landmarks/noise.png   512x512 RGBA, seamlessly tileable, linear data (not colour)
  R: fine grain (concrete / render / paint micro relief)
  G: mid-frequency fBm (patchy weathering, repairs, colour variation)
  B: low-frequency fBm (large stains, soot fields)
  A: vertical streaks (rain-washed dirt and rust runs below ledges)

Usage: python3 pipeline/landmarks_textures.py
"""
import os

import numpy as np
from PIL import Image

from config import ROOT

OUT = os.path.join(ROOT, "public", "textures", "landmarks")


def fbm_periodic(n, beta, seed, lo=1.0, hi=None, aniso=(1.0, 1.0)):
    """Tileable fractal noise by spectral synthesis (power-law filtered white noise)."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((n, n))
    F = np.fft.fft2(w)
    fy = np.fft.fftfreq(n)[:, None] * n * aniso[1]
    fx = np.fft.fftfreq(n)[None, :] * n * aniso[0]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    filt = 1.0 / f ** beta
    filt[f < lo] = 0.0
    if hi is not None:
        filt *= np.exp(-(f / hi) ** 2)
    filt[0, 0] = 0.0
    r = np.real(np.fft.ifft2(F * filt))
    return (r - r.mean()) / (r.std() + 1e-9)


def to_u8(a, contrast):
    return (np.clip(0.5 + a * contrast, 0, 1) * 255 + 0.5).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    n = 512
    R = fbm_periodic(n, 0.5, 11, lo=20.0)
    G = fbm_periodic(n, 1.3, 12, lo=2.0)
    B = fbm_periodic(n, 1.8, 13, lo=1.0)
    S = fbm_periodic(n, 1.0, 14, lo=2.0, aniso=(1.0, 16.0))
    M = fbm_periodic(n, 1.5, 15, lo=1.0)
    A = S * 0.7 + np.clip(M, 0, None) * S * 0.6
    A = (A - A.mean()) / (A.std() + 1e-9)
    img = np.stack([to_u8(R, 0.2), to_u8(G, 0.2), to_u8(B, 0.2), to_u8(A, 0.2)], -1)
    Image.fromarray(img, "RGBA").save(os.path.join(OUT, "noise.png"), optimize=True)
    print("wrote", os.path.join(OUT, "noise.png"))


if __name__ == "__main__":
    main()
