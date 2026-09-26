"""Procedural foliage textures for the vegetation module.

  public/textures/vegetation/leaves.webp   2048x2048 RGBA atlas, 4x4 cells of 512 px, one leaf-cluster
                                           sprite (twig + leaves, straight alpha) per cell; the twig
                                           attaches at the bottom centre of the cell.
  public/textures/vegetation/bark_*.jpg    512x512 bark colour + normal maps, downsized from the MIT
                                           licensed @dgreenheck/ez-tree assets (oak/willow/pine/birch;
                                           originals from polyhaven.com (CC0) and texturecan.com (CC0)).

Cell index (row-major, row 0 = top of the image):
  0 poplar (deltoid)      1 white poplar       2 willow           3 robinia (pinnate)
  4 horse chestnut        5 linden (cordate)   6 maple (palmate)  7 elm
  8 walnut (pinnate)      9 fruit tree         10 oak (lobed)     11 birch
  12 pine (needles)       13 spruce            14 thuja           15 shrub (small oval / lilac)

Run:  python3 pipeline/vegetation_textures.py
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import ROOT  # noqa: E402

OUT = os.path.join(ROOT, "public", "textures", "vegetation")
os.makedirs(OUT, exist_ok=True)
CELL = 512
SS = 2
S = CELL * SS


def srgb(c):
    return np.array(c, np.float32) / 255.0


class Canvas:
    def __init__(self):
        self.rgb = np.zeros((S, S, 3), np.float32)
        self.a = np.zeros((S, S), np.float32)

    def over(self, x0, y0, rgb, a):
        h, w = a.shape
        x1, y1 = x0 + w, y0 + h
        cx0, cy0, cx1, cy1 = max(x0, 0), max(y0, 0), min(x1, S), min(y1, S)
        if cx1 <= cx0 or cy1 <= cy0:
            return
        sa = a[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
        sr = rgb[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
        da = self.a[cy0:cy1, cx0:cx1]
        dr = self.rgb[cy0:cy1, cx0:cx1]
        oa = sa + da * (1 - sa)
        orgb = (sr * sa[..., None] + dr * (da * (1 - sa))[..., None]) / np.maximum(oa, 1e-6)[..., None]
        self.a[cy0:cy1, cx0:cx1] = oa
        self.rgb[cy0:cy1, cx0:cx1] = orgb

    def line(self, pts, width, color, alpha=1.0):
        """Anti-aliased (via supersampling) polyline in canvas pixel coords."""
        pts = np.asarray(pts, np.float32)
        x0, y0 = np.floor(pts.min(0) - width - 2).astype(int)
        x1, y1 = np.ceil(pts.max(0) + width + 2).astype(int)
        w, h = x1 - x0, y1 - y0
        if w <= 0 or h <= 0:
            return
        m = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(m)
        p = [(float(x - x0), float(y - y0)) for x, y in pts]
        d.line(p, fill=255, width=max(1, int(round(width))), joint="curve")
        a = np.asarray(m, np.float32) / 255.0 * alpha
        rgb = np.broadcast_to(np.asarray(color, np.float32), (h, w, 3)).copy()
        self.over(x0, y0, rgb, a)

    def image(self):
        rgb, a = self.rgb, self.a
        # bleed colours into transparent areas (avoids dark fringes in mips)
        acc = rgb * a[..., None]
        wsum = a.copy()
        img_rgb = rgb.copy()
        k = acc; kw = wsum
        for r in (2, 4, 8, 16, 32):
            kb = np.stack([ndimage.uniform_filter(k[..., i], 2 * r + 1) for i in range(3)], -1)
            kwb = ndimage.uniform_filter(kw, 2 * r + 1)
            fill = (a < 0.02) & (kwb > 1e-4)
            img_rgb[fill] = (kb[fill] / kwb[fill][..., None])
        out = np.concatenate([np.clip(img_rgb, 0, 1), np.clip(a, 0, 1)[..., None]], -1)
        im = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")
        return im.resize((CELL, CELL), Image.LANCZOS)


# ------------------------------------------------------------------ leaf shapes (half width 0..1 over u in 0..1)
def f_ovate(u):
    return np.sin(np.pi * u) ** 0.75 * (1 - 0.28 * u)


def f_elliptic(u):
    return np.sin(np.pi * u) ** 0.85


def f_lance(u):
    return np.sin(np.pi * u) ** 0.6 * (1 - 0.35 * u)


def f_deltoid(u):
    return np.where(u < 0.28, (u / 0.28) ** 0.55, ((1 - u) / 0.72) ** 1.05)


def f_cordate(u):
    return np.sin(np.pi * np.clip(u * 0.92 + 0.08, 0, 1)) ** 0.5 * (1.12 - 0.75 * u) ** 1.2


def f_obovate(u):
    return np.sin(np.pi * u) ** 0.7 * (0.55 + 0.6 * u) * np.where(u > 0.85, ((1 - u) / 0.15) ** 0.5, 1)


def f_oak(u):
    return (np.sin(np.pi * u) ** 0.6 * (0.8 + 0.2 * u)) * (0.62 + 0.38 * np.abs(np.cos(u * 4.5 * np.pi)) ** 0.7)


def f_whitepoplar(u):
    return np.sin(np.pi * u) ** 0.6 * (0.7 + 0.3 * np.abs(np.cos(u * 2.5 * np.pi)))


def serrate(f, n=18, amt=0.07):
    return lambda u: f(u) * (1 - amt * ((u * n) % 1.0))


def leaf(cv, rng, base, ang, length, width, shape, col_top, col_under=None, p_under=0.0,
         vary=0.10, rib=0.18, gloss=0.0, petiole=0.0, pet_col=(0.28, 0.3, 0.12)):
    """Draw one leaf: base (x,y) in canvas px, ang (rad, 0 = up), length/width in px."""
    bx, by = base
    dx, dy = math.sin(ang), -math.cos(ang)
    if petiole > 0:
        ex, ey = bx + dx * petiole, by + dy * petiole
        cv.line([(bx, by), (ex, ey)], max(1.5, width * 0.06), pet_col)
        bx, by = ex, ey
    n = 48
    u = np.linspace(0, 1, n)
    hw = np.maximum(shape(u), 0) * width * 0.5
    # slight curvature of the midrib
    bend = rng.uniform(-0.12, 0.12)
    cxs = u * length
    side = bend * length * (u ** 2)
    px_l = [(bx + dx * cxs[i] + (-dy) * (side[i] - hw[i]), by + dy * cxs[i] + dx * (side[i] - hw[i])) for i in range(n)]
    px_r = [(bx + dx * cxs[i] + (-dy) * (side[i] + hw[i]), by + dy * cxs[i] + dx * (side[i] + hw[i])) for i in range(n)]
    poly = px_l + px_r[::-1]
    arr = np.array(poly, np.float32)
    x0, y0 = np.floor(arr.min(0) - 2).astype(int)
    x1, y1 = np.ceil(arr.max(0) + 2).astype(int)
    w, h = x1 - x0, y1 - y0
    if w <= 1 or h <= 1:
        return
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).polygon([(x - x0, y - y0) for x, y in poly], fill=255)
    a = np.asarray(m, np.float32) / 255.0
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rx, ry = xx + x0 - bx, yy + y0 - by
    uu = np.clip((rx * dx + ry * dy) / max(length, 1), 0, 1)       # along
    vv = (rx * (-dy) + ry * dx)                                    # across (px)
    hw_at = np.interp(uu, u, hw) + 1e-3
    vn = np.clip((vv - np.interp(uu, u, side)) / hw_at, -1.5, 1.5)
    under = col_under is not None and rng.random() < p_under
    base_c = srgb(col_under if under else col_top)
    jit = 1 + rng.uniform(-vary, vary)
    hue = rng.uniform(-vary, vary) * 0.6
    c = base_c * jit * np.array([1 + hue, 1, 1 - hue * 0.8], np.float32)
    shade = (0.78 + 0.34 * uu) * (1 - 0.22 * vn ** 2)
    # one half of the leaf a bit darker (folded along the midrib)
    shade *= np.where(vn > 0, 1.0, 0.88 + rng.uniform(-0.05, 0.08))
    if gloss > 0:
        shade += gloss * np.exp(-((vn - 0.35) ** 2) / 0.05) * (0.4 + 0.6 * uu)
    rgb = c[None, None, :] * shade[..., None]
    if rib > 0:
        ribm = np.exp(-(vn ** 2) / 0.004) * (1 - uu * 0.7)
        rgb = rgb * (1 - rib * ribm[..., None]) + rib * 0.6 * ribm[..., None] * srgb((170, 180, 110))[None, None, :] * 0.5
        # secondary veins
        vein = np.abs(np.sin((uu * 9 - np.abs(vn) * 1.6) * np.pi)) ** 30 * (np.abs(vn) < 0.9)
        rgb *= (1 - 0.08 * vein[..., None])
    # darker edge
    rgb *= (1 - 0.15 * np.clip(np.abs(vn) - 0.8, 0, 1)[..., None] * 3)
    cv.over(x0, y0, np.clip(rgb, 0, 1), a)


def twig_path(rng, start, ang, length, curl=0.15, n=12):
    pts = [start]
    x, y = start
    a = ang
    for i in range(n):
        a += rng.uniform(-curl, curl) / n * 4
        x += math.sin(a) * length / n
        y -= math.cos(a) * length / n
        pts.append((x, y))
    return pts


def broadleaf(rng, n_side=8, leaf_len=110, leaf_w=60, shape=f_ovate, col=(70, 100, 40), under=None, p_under=0,
              petiole=10, spread=0.9, twig_col=(0.30, 0.25, 0.16), gloss=0.0, vary=0.12, droop=0.0, rib=0.18,
              main_len=0.86, leaf_angle=(0.35, 1.1), n_leaves_per=3, fruit=None):
    cv = Canvas()
    sc = SS
    start = (S / 2, S - 4)
    main = twig_path(rng, start, rng.uniform(-0.1, 0.1), S * main_len, curl=0.2)
    cv.line(main, 7 * sc, twig_col)
    leaves = []
    # side twigs
    for i in range(n_side):
        t = 0.18 + 0.8 * (i + rng.random() * 0.5) / n_side
        k = int(t * (len(main) - 1))
        p = main[k]
        side = 1 if i % 2 == 0 else -1
        a = side * rng.uniform(0.45, 0.95) * spread
        L = S * rng.uniform(0.22, 0.36) * (1.15 - t * 0.5)
        tw = twig_path(rng, p, a, L, curl=0.3, n=8)
        cv.line(tw, 4 * sc, twig_col)
        for j in range(n_leaves_per):
            q = tw[min(len(tw) - 1, int((0.35 + 0.65 * (j + 0.5) / n_leaves_per) * (len(tw) - 1)))]
            la = a + side * rng.uniform(*leaf_angle) * (1 if j % 2 == 0 else -0.6) + droop
            leaves.append((q, la))
        leaves.append((tw[-1], a + rng.uniform(-0.2, 0.2)))
    # leaves at the tip of the main twig
    for j in range(4):
        leaves.append((main[-1 - j], rng.uniform(-0.7, 0.7)))
    rng.shuffle(leaves)
    for (q, la) in leaves:
        s = rng.uniform(0.75, 1.15)
        leaf(cv, rng, q, la, leaf_len * sc * s, leaf_w * sc * s, shape, col, under, p_under, vary=vary,
             gloss=gloss, petiole=petiole * sc * s, rib=rib)
    if fruit:
        fc, nfr, rad = fruit
        for _ in range(nfr):
            q = leaves[rng.integers(len(leaves))][0]
            r = rad * sc * rng.uniform(0.8, 1.2)
            m = Image.new("L", (int(r * 2 + 4), int(r * 2 + 4)), 0)
            ImageDraw.Draw(m).ellipse([2, 2, 2 + 2 * r, 2 + 2 * r], fill=255)
            a = np.asarray(m, np.float32) / 255
            yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]].astype(np.float32)
            sh = 1.15 - 0.5 * np.hypot(xx - r * 0.7, yy - r * 0.7) / (r * 1.4)
            rgb = srgb(fc)[None, None, :] * sh[..., None]
            cv.over(int(q[0] - r), int(q[1] + 2), np.clip(rgb, 0, 1), a)
    return cv


def compound(rng, n_leaves=7, pairs=6, leaflet_len=48, leaflet_w=24, shape=f_elliptic, col=(100, 130, 45),
             rachis_len=0.42, twig_col=(0.33, 0.28, 0.17), terminal=True, vary=0.1, rib=0.12, under=None, p_under=0):
    """Pinnate compound leaves (robinia, walnut, ash) arranged along a twig."""
    cv = Canvas()
    sc = SS
    start = (S / 2, S - 4)
    main = twig_path(rng, start, rng.uniform(-0.1, 0.1), S * 0.55, curl=0.2)
    cv.line(main, 6 * sc, twig_col)
    for i in range(n_leaves):
        t = 0.25 + 0.75 * i / max(1, n_leaves - 1)
        p = main[int(t * (len(main) - 1))]
        side = 1 if i % 2 == 0 else -1
        a = side * rng.uniform(0.2, 1.0) if i < n_leaves - 1 else rng.uniform(-0.15, 0.15)
        L = S * rachis_len * rng.uniform(0.8, 1.1)
        rach = twig_path(rng, p, a, L, curl=0.25, n=10)
        cv.line(rach, 2.2 * sc, (0.35, 0.42, 0.18))
        for k in range(pairs):
            tt = 0.15 + 0.8 * k / max(1, pairs - 1)
            q = rach[int(tt * (len(rach) - 1))]
            dirang = a + rng.uniform(-0.1, 0.1)
            for sd in (-1, 1):
                s = rng.uniform(0.85, 1.1) * (0.8 + 0.3 * tt)
                leaf(cv, rng, q, dirang + sd * rng.uniform(1.1, 1.5), leaflet_len * sc * s, leaflet_w * sc * s,
                     shape, col, under, p_under, vary=vary, rib=rib, petiole=2 * sc)
        if terminal:
            leaf(cv, rng, rach[-1], a, leaflet_len * sc * 1.05, leaflet_w * sc, shape, col, under, p_under, vary=vary, rib=rib)
    return cv


def palmate_compound(rng, n=6, col=(55, 85, 35), leaflet_len=150, leaflet_w=62):
    """Horse chestnut: palmately compound leaves on a stout twig."""
    cv = Canvas()
    sc = SS
    start = (S / 2, S - 4)
    main = twig_path(rng, start, 0, S * 0.3, curl=0.1)
    cv.line(main, 9 * sc, (0.32, 0.24, 0.16))
    for i in range(n):
        p = main[-1 - (i % 3)]
        a = (i / (n - 1) - 0.5) * 1.9 + rng.uniform(-0.15, 0.15)
        L = S * rng.uniform(0.12, 0.3)
        pet = twig_path(rng, p, a, L, curl=0.1, n=5)
        cv.line(pet, 3 * sc, (0.4, 0.42, 0.2))
        c = pet[-1]
        nl = 7 if rng.random() < 0.6 else 5
        for k in range(nl):
            la = a + (k / (nl - 1) - 0.5) * 2.6
            s = (1 - abs(k / (nl - 1) - 0.5) * 0.7) * rng.uniform(0.85, 1.05)
            leaf(cv, rng, c, la, leaflet_len * sc * s * 0.8, leaflet_w * sc * s * 0.8, serrate(f_obovate, 24, 0.05),
                 col, vary=0.08, rib=0.2)
    # flower candles are gone by July; a couple of spiky fruits
    return cv


def palmate_lobed(rng, n=14, col=(70, 105, 40), R=70):
    """Maple: palmately lobed simple leaves."""
    cv = Canvas()
    sc = SS
    start = (S / 2, S - 4)
    main = twig_path(rng, start, 0, S * 0.8, curl=0.25)
    cv.line(main, 6 * sc, (0.35, 0.28, 0.18))
    items = []
    for i in range(n):
        t = 0.2 + 0.8 * i / n
        p = main[int(t * (len(main) - 1))]
        side = 1 if i % 2 == 0 else -1
        a = side * rng.uniform(0.4, 1.2)
        L = S * rng.uniform(0.1, 0.2)
        pet = twig_path(rng, p, a, L, curl=0.2, n=4)
        items.append((pet, a))
    rng.shuffle(items)
    for pet, a in items:
        cv.line(pet, 2 * sc, (0.45, 0.35, 0.2))
        c = pet[-1]
        r = R * sc * rng.uniform(0.8, 1.15)
        th = np.linspace(0, 2 * np.pi, 160)
        # lobes: 5 main lobes, pointing away from the petiole direction
        rr = r * (0.42 + 0.58 * np.abs(np.cos(2.5 * th)) ** 1.6) * (1 - 0.06 * ((th * 30 / np.pi) % 1.0))
        rr = np.where(np.abs(np.cos(th / 2)) > 0.93, rr * 0.35, rr)  # notch at the petiole
        rot = a + np.pi
        cx, cy = c[0] + math.sin(a) * r * 0.55, c[1] - math.cos(a) * r * 0.55
        pts = [(cx + math.sin(t + rot) * q, cy - math.cos(t + rot) * q) for t, q in zip(th, rr)]
        arr = np.array(pts)
        x0, y0 = np.floor(arr.min(0) - 2).astype(int)
        x1, y1 = np.ceil(arr.max(0) + 2).astype(int)
        m = Image.new("L", (x1 - x0, y1 - y0), 0)
        ImageDraw.Draw(m).polygon([(x - x0, y - y0) for x, y in pts], fill=255)
        am = np.asarray(m, np.float32) / 255
        yy, xx = np.mgrid[0:am.shape[0], 0:am.shape[1]].astype(np.float32)
        d = np.hypot(xx + x0 - cx, yy + y0 - cy) / r
        ang = np.arctan2(xx + x0 - cx, -(yy + y0 - cy)) - rot
        veins = np.abs(np.cos(2.5 * ang)) ** 60
        base = srgb(col) * (1 + rng.uniform(-0.12, 0.12))
        shade = (0.8 + 0.3 * d) * (1 - 0.18 * veins)
        rgb = base[None, None, :] * shade[..., None]
        cv.over(x0, y0, np.clip(rgb, 0, 1), am)
    return cv


def needles(rng, col=(55, 85, 50), needle_len=90, density=9, twig_col=(0.35, 0.25, 0.15), n_side=5, short=False):
    cv = Canvas()
    sc = SS
    start = (S / 2, S - 4)
    main = twig_path(rng, start, rng.uniform(-0.1, 0.1), S * 0.9, curl=0.2)
    twigs = [(main, 0.0)]
    for i in range(n_side):
        t = 0.2 + 0.7 * (i + 0.5) / n_side
        p = main[int(t * (len(main) - 1))]
        side = 1 if i % 2 == 0 else -1
        a = side * rng.uniform(0.6, 1.0)
        twigs.append((twig_path(rng, p, a, S * rng.uniform(0.25, 0.4) * (1.2 - t * 0.5), curl=0.2, n=8), a))
    for tw, a in twigs:
        cv.line(tw, (5 if tw is main else 3) * sc, twig_col)
    base = srgb(col)
    for tw, a in twigs:
        arr = np.array(tw)
        seg = np.linalg.norm(np.diff(arr, axis=0), axis=1)
        total = seg.sum()
        count = int(total / sc * density / 10)
        for k in range(count):
            t = rng.random()
            idx = min(len(arr) - 2, int(t * (len(arr) - 1)))
            f = t * (len(arr) - 1) - idx
            p = arr[idx] * (1 - f) + arr[idx + 1] * f
            d = arr[idx + 1] - arr[idx]
            ta = math.atan2(d[0], -d[1])
            side = rng.choice([-1, 1])
            na = ta + side * rng.uniform(0.35, 1.2 if short else 0.9)
            L = needle_len * sc * rng.uniform(0.7, 1.1) * (0.6 + 0.4 * (1 - t) if not short else 1)
            e = (p[0] + math.sin(na) * L, p[1] - math.cos(na) * L)
            c = base * rng.uniform(0.75, 1.2) * np.array([1, 1 + rng.uniform(-0.05, 0.05), 1], np.float32)
            cv.line([tuple(p), e], (2.2 if not short else 2.6) * sc, np.clip(c, 0, 1))
    return cv


def thuja(rng, col=(60, 95, 45)):
    """Flat fern-like sprays of scale leaves."""
    cv = Canvas()
    sc = SS
    base = srgb(col)

    def spray(p, a, L, depth):
        pts = twig_path(rng, p, a, L, curl=0.15, n=8)
        w = max(3.0, 11.0 - depth * 2.6) * sc
        for i in range(len(pts) - 1):
            c = base * rng.uniform(0.8, 1.2) * (1.0 + 0.08 * depth)
            cv.line([pts[i], pts[i + 1]], w, np.clip(c, 0, 1))
        if depth < 3:
            for i in range(1, len(pts) - 1):
                for sd in (-1, 1):
                    if rng.random() < 0.85:
                        spray(pts[i], a + sd * rng.uniform(0.5, 0.85), L * rng.uniform(0.38, 0.5) * (1 - i / len(pts) * 0.4),
                              depth + 1)

    for k in range(3):
        spray((S / 2 + rng.uniform(-30, 30), S - 4), rng.uniform(-0.35, 0.35), S * rng.uniform(0.7, 0.85), 0)
    return cv


def main():
    rng = np.random.default_rng(7)
    cells = [
        # 0 black poplar: deltoid, glossy, long petioles
        lambda: broadleaf(rng, n_side=8, leaf_len=88, leaf_w=80, shape=serrate(f_deltoid, 20, 0.05), col=(58, 92, 38),
                          petiole=34, gloss=0.18, vary=0.12, n_leaves_per=3),
        # 1 white poplar: lobed, white undersides
        lambda: broadleaf(rng, n_side=8, leaf_len=92, leaf_w=76, shape=f_whitepoplar, col=(64, 94, 50),
                          under=(126, 138, 118), p_under=0.28, petiole=22, vary=0.08, n_leaves_per=3),
        # 2 willow: long narrow grey-green leaves, drooping
        lambda: broadleaf(rng, n_side=10, leaf_len=130, leaf_w=20, shape=serrate(f_lance, 30, 0.05), col=(104, 126, 82),
                          under=(160, 172, 150), p_under=0.3, petiole=4, vary=0.1, n_leaves_per=6, droop=0.3,
                          leaf_angle=(0.2, 0.7), rib=0.1),
        # 3 robinia
        lambda: compound(rng, n_leaves=6, pairs=6, leaflet_len=42, leaflet_w=26, shape=f_elliptic, col=(100, 132, 46),
                         rachis_len=0.4),
        # 4 horse chestnut
        lambda: palmate_compound(rng, n=9, col=(52, 84, 32), leaflet_len=210, leaflet_w=80),
        # 5 linden
        lambda: broadleaf(rng, n_side=8, leaf_len=92, leaf_w=86, shape=serrate(f_cordate, 26, 0.04), col=(74, 110, 44),
                          petiole=26, vary=0.1, n_leaves_per=3, gloss=0.06),
        # 6 maple
        lambda: palmate_lobed(rng, n=13, col=(68, 104, 38), R=72),
        # 7 elm (small serrate, asymmetric)
        lambda: broadleaf(rng, n_side=11, leaf_len=64, leaf_w=34, shape=serrate(f_ovate, 22, 0.08), col=(62, 94, 38),
                          petiole=5, vary=0.1, n_leaves_per=6, leaf_angle=(0.8, 1.3), rib=0.25),
        # 8 walnut
        lambda: compound(rng, n_leaves=5, pairs=3, leaflet_len=84, leaflet_w=42, shape=f_elliptic, col=(72, 104, 44),
                         rachis_len=0.48, rib=0.2),
        # 9 fruit tree (apple / apricot) with a few fruits
        lambda: broadleaf(rng, n_side=9, leaf_len=78, leaf_w=48, shape=serrate(f_ovate, 20, 0.05), col=(72, 104, 50),
                          petiole=10, vary=0.12, n_leaves_per=4, gloss=0.08, fruit=((200, 120, 40), 5, 13)),
        # 10 oak
        lambda: broadleaf(rng, n_side=8, leaf_len=110, leaf_w=62, shape=f_oak, col=(62, 94, 40), petiole=4, vary=0.1,
                          n_leaves_per=4, rib=0.2),
        # 11 birch: small triangular, light, drooping twigs
        lambda: broadleaf(rng, n_side=10, leaf_len=56, leaf_w=44, shape=serrate(f_deltoid, 16, 0.08), col=(96, 132, 52),
                          petiole=12, vary=0.12, n_leaves_per=5, droop=0.5, spread=1.2),
        # 12 pine
        lambda: needles(rng, col=(58, 88, 52), needle_len=78, density=16, n_side=5),
        # 13 spruce (blue-green, short dense needles)
        lambda: needles(rng, col=(86, 116, 112), needle_len=26, density=34, n_side=7, short=True),
        # 14 thuja
        lambda: thuja(rng, col=(50, 82, 38)),
        # 15 shrub / lilac: cordate-ovate mid green
        lambda: broadleaf(rng, n_side=10, leaf_len=70, leaf_w=52, shape=f_cordate, col=(64, 98, 42), petiole=8,
                          vary=0.12, n_leaves_per=4, gloss=0.05),
    ]
    atlas = Image.new("RGBA", (CELL * 4, CELL * 4), (0, 0, 0, 0))
    for i, fn in enumerate(cells):
        cv = fn()
        im = cv.image()
        atlas.paste(im, ((i % 4) * CELL, (i // 4) * CELL))
        print("cell", i, flush=True)
    atlas.save(os.path.join(OUT, "leaves.webp"), quality=90, method=6)
    atlas.save(os.path.join(ROOT, "data", "processed", "veg_leaves_preview.png"))
    print("leaves.webp", os.path.getsize(os.path.join(OUT, "leaves.webp")) // 1024, "KB")

    # bark textures (downsized from ez-tree assets, MIT)
    src = os.path.join(ROOT, "node_modules", "@dgreenheck", "ez-tree", "src", "lib", "assets", "bark")
    for name in ("oak", "willow", "pine", "birch"):
        for kind in ("color", "normal"):
            p = os.path.join(src, f"{name}_{kind}_1k.jpg")
            if not os.path.exists(p):
                print("missing", p)
                continue
            im = Image.open(p).convert("RGB").resize((512, 512), Image.LANCZOS)
            im.save(os.path.join(OUT, f"bark_{name}_{kind}.jpg"), quality=85)
    print("bark done")


if __name__ == "__main__":
    main()
