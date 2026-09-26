"""Procedural textures for the buildings module (CC0, generated here).

public/textures/buildings/noise.bin  512x512 RGBA8 raw (row 0 = top), seamlessly tileable
  (raw instead of PNG: decoded in a worker without canvas premultiplication, 1 MiB)
  R: low-frequency fBm (large stains, colour variation)
  G: mid-frequency fBm (plaster / render unevenness)
  B: high-frequency grain (concrete / brick surface)
  A: vertical streaks (rain-washed dirt below sills, rust runs)
"""
import os

import numpy as np
from PIL import Image

from config import ROOT

OUT = os.path.join(ROOT, "public", "textures", "buildings")


def fbm_periodic(n, beta, seed, lo=1.0, hi=None, aniso=(1.0, 1.0)):
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
    r = (r - r.mean()) / (r.std() + 1e-9)
    return r


def to_u8(a, contrast=0.18):
    return (np.clip(0.5 + a * contrast, 0, 1) * 255 + 0.5).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    n = 512
    R = fbm_periodic(n, 1.6, 1, lo=1.0)
    G = fbm_periodic(n, 1.2, 2, lo=3.0)
    B = fbm_periodic(n, 0.4, 3, lo=24.0)
    # vertical streaks: strongly anisotropic noise (long in y), multiplied by patchy mask
    S = fbm_periodic(n, 1.0, 4, lo=2.0, aniso=(1.0, 14.0))
    M = fbm_periodic(n, 1.5, 5, lo=1.0)
    A = S * 0.7 + np.clip(M, 0, None) * S * 0.6
    img = np.stack([to_u8(R), to_u8(G), to_u8(B, 0.2), to_u8(A / (A.std() + 1e-9))], -1)
    img.astype(np.uint8).tofile(os.path.join(OUT, "noise.bin"))
    old = os.path.join(OUT, "noise.png")
    if os.path.exists(old):
        os.remove(old)
    print("noise.bin", os.path.getsize(os.path.join(OUT, "noise.bin")))


if __name__ == "__main__":
    main()
