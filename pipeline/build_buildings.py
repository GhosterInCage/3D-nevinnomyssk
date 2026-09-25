"""Buildings: Overture footprints -> cleaned, classified, height-inferred binary
for the web app (module "buildings").

  python3 pipeline/build_buildings.py [--refresh]    (--refresh recomputes cached stages)

Stages
  1. buildings_clean.py     load / de-duplicate / fix / square footprints
  2. buildings_features.py  shape, DSM relief, S2 summer + WINTER shadow profiles, context
  3. level model            gradient boosting classifier trained on the OSM-labelled
                            buildings (num_floors), validated with spatial group k-fold
  4. typology rules         Soviet micro-district blocks, private houses, garages, dachas,
                            schools, industrial halls ... -> heights, roofs, materials
  5. writer                 public/data/buildings/buildings.bin.gz (+ ids.bin.gz, meta.json)

Output format (little-endian) - see src/modules/buildings/format.ts for the reader:
  buildings.bin.gz
    header 64 B: 'NBLD', u32 version (2), u32 nBuildings, u32 nVerts, u32 nRings, u32 nParts,
                 f32 tileSize, u32 tilesX, f32 originX, f32 originZ, u32 nTiles, u32 nFences, reserved
    u32 tileStart[nTiles+1]      buildings sorted by tile (tile = tz*tilesX + tx, 512 m tiles)
    record[nBuildings] 52 B      centre (f32 x, f32 z world), vertStart, ringStart, partStart,
                                 u16 vertCount, u8 ringCount, u8 partCount, u16 height dm,
                                 u8 roofHeight dm, u8 levels, u8 typology, u8 roofShape,
                                 u8 wallStyle, u8 roofMat, u8 wallRGB[3], u8 roofRGB[3], u8 seed,
                                 u8 flags, u8 entranceDir, u8 floorH dm, u8 minHeight m,
                                 u8 socle dm, u16 nameIdx, u8 roofPitch deg, u8 overhang cm/2,
                                 u8 streetDir, u8[3] reserved
    i16 verts[2*nVerts]          cm (2 cm if flag Q2) relative to the centre, world x/z (z south)
    u16 ringLen[nRings]          outer ring first (negative signed area in x/z), then holes
    part[nParts] 12 B            roof rectangles: i16 cx, i16 cz (cm), u16 halfLen, u16 halfWid (cm),
                                 i16 angle (1e-4 rad, ridge direction (cos a, sin a) in x/z), u16 0
    u32 fenceTileStart[nTiles+1] plot fences sorted by tile of their midpoint
    fence[nFences] 16 B          i16 x0, z0, x1, z1 (cm rel. tile centre, world x/z), u8 type
                                 (0 sheet, 1 sheet+brick pillars, 2 wood, 3 picket, 4 gate),
                                 u8 height dm, u8 rgb[3], u8 seed, u16 0
  ids.bin.gz   'NBID', u32 n, u32 idHi[n], u32 idLo[n] (first 16 hex digits of the Overture id),
               u32 osmId[n], u8 osmKind[n] (0 none, 1 node, 2 way, 3 relation)
  meta.json    typology names, name table, model validation report, stats
"""
import gzip
import hashlib
import json
import math
import os
import pickle
import struct
import sys
import time

os.environ.setdefault("OMP_NUM_THREADS", "2")

import numpy as np
import shapely
from shapely import affinity

from config import PROC, WEB_DATA, REGION_HALF
from buildings_clean import load_clean
import buildings_features as bf
from buildings_geom import rect_decompose, mrr_dims, square_polygon
import buildings_s2winter as s2w
from buildings_fences import build_fences

OUT = os.path.join(WEB_DATA, "buildings")
TILE = 512.0
REFRESH = "--refresh" in sys.argv

# ------------------------------------------------------------------ enums (keep in sync with format.ts)
T_HOUSE, T_OUTB, T_GARAGE, T_DACHA, T_KHRU, T_PANEL9, T_TOWER, T_STALINKA, T_LOWAPT, T_SCHOOL, \
    T_KINDER, T_PUBLIC, T_COMM, T_MALL, T_IND, T_WARE, T_AGRI, T_GREEN, T_REL, T_MODERN, T_UTIL, T_KIOSK = range(22)
TYP_NAMES = ['house', 'outbuilding', 'garages', 'dacha', 'khrushchevka', 'panel9', 'tower', 'stalinka',
             'lowrise_apartments', 'school', 'kindergarten', 'public', 'commercial', 'mall', 'industrial',
             'warehouse', 'agricultural', 'greenhouse', 'religious', 'modern_apartments', 'utility', 'kiosk']
R_FLAT, R_GABLE, R_HIP, R_PYR, R_SHED = range(5)
W_PLAIN, W_HPLASTER, W_HBRICK, W_PANEL5, W_BRICK5, W_PANEL9, W_STALINKA, W_SCHOOL, W_COMM, W_IND, \
    W_GARAGE, W_WARE, W_GLASS, W_MODERN, W_PUBLIC, W_SIDING = range(16)
M_BITUMEN, M_GRAVEL, M_CORR, M_MTILE, M_SLATE, M_SEAM, M_GLASS, M_TILES = range(8)
F_Q2, F_SHOP, F_BALC, F_ENTR, F_OSM, F_NAMED, F_LABEL, F_STREETSHOP = 1, 2, 4, 8, 16, 32, 64, 128

APT_TYPES = {T_KHRU, T_PANEL9, T_TOWER, T_STALINKA, T_LOWAPT, T_MODERN}

# ------------------------------------------------------------------ palettes (sRGB)
P_PLASTER = [(222, 216, 200), (230, 222, 204), (226, 208, 165), (218, 196, 156), (228, 204, 180),
             (204, 212, 196), (196, 204, 212), (214, 212, 206), (220, 188, 160), (192, 196, 182),
             (232, 228, 218), (210, 178, 146), (205, 195, 175), (224, 214, 186)]
P_REDBRICK = [(150, 74, 52), (160, 82, 58), (138, 66, 48), (170, 96, 70), (128, 62, 46)]
P_SILICATE = [(214, 212, 204), (205, 203, 196), (222, 219, 210), (196, 194, 188)]
P_YELBRICK = [(212, 184, 130), (200, 170, 118), (222, 196, 146)]
P_PANEL = [(196, 194, 188), (206, 202, 192), (188, 188, 184), (212, 206, 196), (200, 196, 186), (214, 214, 210)]
P_PANEL_PAINT = [(226, 214, 190), (222, 200, 180), (206, 214, 222), (228, 222, 204), (214, 222, 206)]
P_STALINKA = [(226, 206, 150), (232, 214, 170), (226, 196, 176), (238, 230, 214), (214, 214, 192), (230, 200, 150)]
P_SIDING = [(232, 228, 214), (220, 214, 190), (206, 214, 204), (214, 204, 184), (196, 206, 214)]
P_IND = [(170, 170, 166), (186, 186, 182), (160, 158, 152), (204, 204, 200), (150, 152, 150), (176, 170, 160)]
P_WARE = [(200, 202, 204), (180, 186, 190), (214, 214, 212), (150, 170, 186), (196, 190, 180)]
P_COMM = [(214, 214, 212), (226, 222, 212), (190, 196, 200), (230, 226, 210), (200, 186, 170), (176, 60, 50)]
P_GARAGE = [(196, 194, 188), (220, 218, 210), (160, 86, 64), (180, 176, 170)]
P_SCHOOL = [(226, 216, 196), (216, 214, 206), (236, 222, 200), (220, 206, 190)]
P_KINDER = [(240, 226, 196), (236, 214, 200), (222, 232, 214), (232, 222, 236)]

R_METALTILE = [(102, 40, 34), (84, 48, 38), (70, 54, 46), (44, 78, 56), (44, 64, 98), (92, 92, 94), (120, 48, 38)]
W_METALTILE = [3, 3, 2, 2, 0.8, 1, 1]
R_CORR = [(160, 164, 166), (140, 146, 150), (84, 48, 38), (44, 78, 56), (102, 40, 34), (44, 64, 98), (180, 182, 180)]
W_CORR = [4, 2, 2, 1.5, 1, 0.6, 1]
R_SLATE = [(150, 150, 146), (136, 138, 134), (160, 158, 150), (122, 124, 120)]
R_SEAM = [(76, 106, 80), (112, 52, 44), (120, 124, 128), (150, 154, 156), (60, 90, 70)]
R_BITUMEN = [(62, 62, 64), (54, 54, 56), (72, 70, 68), (84, 84, 84)]
R_GRAVEL = [(120, 118, 112), (132, 128, 120)]
R_GLASS = [(200, 214, 220)]


def sseed(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


class Rnd:
    """Deterministic per-building random stream."""

    def __init__(self, key):
        self.r = np.random.default_rng(sseed(key))

    def u(self):
        return float(self.r.random())

    def pick(self, a, w=None):
        if w is None:
            return a[int(self.r.integers(len(a)))]
        w = np.asarray(w, float)
        return a[int(self.r.choice(len(a), p=w / w.sum()))]

    def rng(self, a, b):
        return a + (b - a) * self.u()


def jitter(c, rnd, amt=8):
    return tuple(int(np.clip(v + rnd.rng(-amt, amt), 0, 255)) for v in c)


# ------------------------------------------------------------------ stage 3: level model

BUCKETS = np.array([1, 2, 3, 4, 5, 7, 9, 10, 13])
MODEL_FEATS = ['log_area', 'length', 'width', 'elong', 'compact', 'rectness', 'nverts', 'dist_centre',
               'dsm_sig', 'dsm_sig5', 'dsm_exc', 'dsm_fmax', 'dsm_fmean', 'shadow_near', 'shadow_far',
               'ndvi_70', 'built_110', 'n_60', 'n_150', 'n_300', 'nb_big_frac', 'nb_med_area', 'nb_max_area',
               'nn_dist', 'nb_blocks', 'lu_residential', 'lu_industrial', 'lu_allotments', 'd_major', 'd_minor']


def bucket(y):
    y = np.asarray(y)
    return np.where(y >= 13, 13, np.where(y >= 10, 10, np.where((y >= 6) & (y <= 8), 7, y)))


def train_level_model(F, levels):
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.model_selection import GroupKFold
    feats = MODEL_FEATS + [k for k in F if k.startswith('sh_')]
    X = np.column_stack([F[f] for f in feats]).astype(float)
    m = (levels > 0) & (levels <= 17)
    Xl, yl = X[m], bucket(levels[m])
    groups = (np.floor(F['cx'][m] / 700) * 1000 + np.floor(F['cy'][m] / 700)).astype(int)

    def make():
        return HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_leaf_nodes=15,
                                              min_samples_leaf=6, l2_regularization=1.0,
                                              class_weight='balanced', random_state=0)
    pred = np.zeros(len(yl))
    for tr, te in GroupKFold(n_splits=5).split(Xl, yl, groups):
        c = make().fit(Xl[tr], yl[tr])
        pred[te] = c.predict(Xl[te])
    rep = {
        "n_labelled": int(m.sum()),
        "cv": "5-fold spatial GroupKFold (700 m blocks)",
        "bucket_accuracy": round(float((pred == yl).mean()), 3),
        "accuracy_3plus_floors": round(float((pred[yl >= 3] == yl[yl >= 3]).mean()), 3),
        "within_one_bucket": round(float((np.abs(np.searchsorted(BUCKETS, pred) - np.searchsorted(BUCKETS, yl)) <= 1).mean()), 3),
        "per_class": {},
    }
    for b in BUCKETS:
        mm = yl == b
        if mm.sum():
            rep["per_class"][int(b)] = {"n": int(mm.sum()), "recall": round(float((pred[mm] == b).mean()), 3)}
    clf = make().fit(Xl, yl)
    proba = clf.predict_proba(X)
    classes = clf.classes_
    print(f"[model] {rep}")
    return classes, proba, rep


# ------------------------------------------------------------------ stage 4: typology

def name_typology(name):
    if not name:
        return None
    s = name.lower()
    if any(k in s for k in ('школ', 'сош', 'гимназ', 'лицей', 'колледж', 'техникум', 'нэт', 'училищ', 'институт', 'университет')):
        return T_SCHOOL
    if any(k in s for k in ('детский сад', 'доу', 'д/с', 'детсад', 'ясли')):
        return T_KINDER
    if any(k in s for k in ('больниц', 'поликлин', 'роддом', 'госпиталь', 'санатор', 'гбуз', 'медицин')):
        return T_PUBLIC
    if any(k in s for k in ('храм', 'церк', 'собор', 'часовн', 'мечет', 'молитв')):
        return T_REL
    if any(k in s for k in ('тц', 'т.ц', 'торгов', 'рынок', 'магнит', 'пятёрочка', 'пятерочка', 'wildberries', 'гипермаркет', 'супермаркет')):
        return T_COMM
    if any(k in s for k in ('гэс', 'грэс', 'компрессор', 'водозабор', 'водоканал', 'котельн', 'подстанц')):
        return T_IND
    return T_PUBLIC


CLS_MAP = {
    'house': T_HOUSE, 'detached': T_HOUSE, 'bungalow': T_HOUSE, 'semidetached_house': T_HOUSE,
    'terrace': T_LOWAPT, 'apartments': -1, 'residential': -2, 'dormitory': -1,
    'garages': T_GARAGE, 'garage': T_GARAGE, 'carport': T_OUTB, 'shed': T_OUTB, 'hut': T_OUTB,
    'retail': T_COMM, 'commercial': T_COMM, 'kiosk': T_KIOSK, 'supermarket': T_COMM, 'office': T_PUBLIC,
    'kindergarten': T_KINDER, 'school': T_SCHOOL, 'college': T_SCHOOL, 'university': T_SCHOOL,
    'hospital': T_PUBLIC, 'public': T_PUBLIC, 'civic': T_PUBLIC, 'government': T_PUBLIC, 'post_office': T_PUBLIC,
    'fire_station': T_PUBLIC, 'train_station': T_PUBLIC, 'transportation': T_PUBLIC, 'hotel': T_PUBLIC,
    'sports_hall': T_PUBLIC, 'parking': T_IND, 'service': T_UTIL,
    'industrial': T_IND, 'warehouse': T_WARE, 'farm': T_AGRI, 'farm_auxiliary': T_AGRI, 'barn': T_AGRI,
    'cowshed': T_AGRI, 'greenhouse': T_GREEN, 'church': T_REL, 'chapel': T_REL, 'cathedral': T_REL,
    'religious': T_REL, 'roof': -3,
}
SUB_MAP = {'education': T_SCHOOL, 'medical': T_PUBLIC, 'agricultural': T_AGRI, 'industrial': T_IND,
           'commercial': T_COMM, 'outbuilding': T_OUTB, 'religious': T_REL, 'civic': T_PUBLIC,
           'transportation': T_PUBLIC, 'entertainment': T_PUBLIC, 'service': T_UTIL, 'residential': -2}


def shadow_height(F, k):
    """Height (m) where the winter shadow profile recovers (0 if no shadow)."""
    keys = [f"sh_{int(h)}" for h in bf.H_BINS[:-1]]
    vals = [F[q][k] for q in keys]
    edges = bf.H_BINS[1:]
    dark = [v < 0.8 for v in vals]
    if not any(dark[:3]):
        return 0.0
    h = 0.0
    for i, v in enumerate(vals):
        if v < 0.86:
            h = edges[i]
        elif i > 1 and all(x >= 0.86 for x in vals[i:i + 2]):
            break
    return float(h)


def classify(recs, F, classes, proba):
    n = len(recs)
    area, L, W = F['area'], F['length'], F['width']
    elong = F['elong']
    lu = F['landuse']
    dc = F['dist_centre']
    # expected level per bucket probabilities
    pb = {int(c): proba[:, i] for i, c in enumerate(classes)}
    p_tall = sum(pb.get(b, 0) for b in (9, 10, 13))
    p_mid = sum(pb.get(b, 0) for b in (4, 5, 7))
    p_low = sum(pb.get(b, 0) for b in (1, 2, 3))
    best = classes[np.argmax(proba, axis=1)]
    # garage-row neighbourhoods: many narrow elongated similar buildings close together
    from scipy.spatial import cKDTree
    pts = np.column_stack([F['cx'], F['cy']])
    kd = cKDTree(pts)
    garage_like = (W >= 3.5) & (W <= 8.5) & (elong >= 2.0) & (area < 1500)
    nb30 = kd.query_ball_point(pts, 40.0)
    garage_nb = np.array([garage_like[x].sum() - garage_like[k] for k, x in enumerate(nb30)])
    # for outbuilding detection: largest neighbour within 25 m
    nb25 = kd.query_ball_point(pts, 25.0)
    big_nb = np.array([max([area[j] for j in x if j != k], default=0) for k, x in enumerate(nb25)])
    typ = np.zeros(n, int)
    lev = np.zeros(n, int)
    labelled = np.zeros(n, bool)
    height_override = np.full(n, np.nan)
    min_h = np.zeros(n)
    for k, r in enumerate(recs):
        a = area[k]
        t = None
        cls = r['cls']
        lv = r['levels'] if r['levels'] and 0 < r['levels'] <= 17 else None
        if lv:
            labelled[k] = True
        if r['height'] and r['height'] > 2:
            height_override[k] = r['height']
        if r['min_height'] and r['min_height'] > 0:
            min_h[k] = r['min_height']
        nt = name_typology(r['name']) if r['name'] else None
        if cls in CLS_MAP:
            t = CLS_MAP[cls]
        elif r['subtype'] in SUB_MAP:
            t = SUB_MAP[r['subtype']]
        if t is None and nt is not None:
            t = nt
        if t == -3:  # roof-only structure (fuel station canopy, market roof)
            t = T_UTIL
            min_h[k] = 4.5
            height_override[k] = 5.3
        # --- apartment-ish or unknown: decide with geometry + model
        mlev = int(best[k])
        if t in (-1, -2):
            # labelled 'apartments'/'residential' but may lack levels
            if lv is None:
                if t == -2 and a < 250:
                    t = T_HOUSE
                    lv = 1 if mlev < 2 else 2
                else:
                    lv = mlev if mlev >= 2 else (2 if a < 400 else 5)
            t = None  # resolved by level below
            apt = True
        else:
            apt = False
        if t is None:
            if lu[k] == 'garages' and a < 4000 and (lv or 1) <= 2:
                t = T_GARAGE if (elong[k] >= 1.8 or a < 80) else T_GARAGE
            elif lu[k] == 'allotments' and a < 220 and (lv or 1) <= 2:
                t = T_OUTB if a < 18 else T_DACHA
            elif lu[k] in ('industrial', 'works', 'military', 'landfill', 'quarry') and not apt and (lv or 1) <= 3:
                t = T_UTIL if a < 60 else (T_IND if a > 300 else T_WARE)
            elif lu[k] in ('farmyard', 'farmland') and not apt:
                t = T_AGRI if a > 150 else T_OUTB
            elif lu[k] == 'cemetery' and not apt:
                t = T_OUTB if a < 60 else T_UTIL
            elif lu[k] == 'greenhouse_horticulture' and a > 80 and not apt:
                t = T_GREEN
            elif lu[k] in ('school', 'university') and a > 400 and not apt:
                t = T_SCHOOL
            elif lu[k] == 'kindergarten' and a > 300 and not apt:
                t = T_KINDER
            elif lu[k] == 'hospital' and a > 300 and not apt:
                t = T_PUBLIC
        if t is None and not apt and lv is None:
            if garage_like[k] and garage_nb[k] >= 2 and mlev <= 1 and a >= 25:
                t = T_GARAGE
        if t is None:
            # levels: label > model (gated by shape)
            if lv is None:
                lv = mlev
                apt_shape = a >= 200 and W[k] >= 9.0 and L[k] >= 16
                if lv >= 4 and not apt_shape:
                    lv = 2 if a >= 120 else 1
                if lv >= 9 and p_tall[k] < 0.45:
                    lv = 5 if p_mid[k] > p_low[k] else 3
                if lv >= 4 and p_low[k] > 0.6:
                    lv = 2
                if a < 60 and lv > 1:
                    lv = 1
            if lv >= 9:
                t = T_TOWER if (elong[k] < 1.6 and a < 1100) else T_PANEL9
            elif lv >= 4:
                t = T_KHRU if (W[k] < 16.5 and not (dc[k] < 1200 and elong[k] < 2.2 and lv <= 4)) else (T_STALINKA if dc[k] < 2500 and lv <= 4 else T_KHRU)
                if lv >= 6:
                    t = T_MODERN if not labelled[k] else T_PANEL9 if lv >= 8 else T_MODERN
            elif lv == 3 or (lv == 2 and a >= 300):
                if a < 180:
                    t = T_HOUSE
                elif lu[k] == 'residential' or apt or lu[k] == '':
                    if dc[k] < 2800 and W[k] < 16 and elong[k] >= 1.4:
                        t = T_STALINKA if lv <= 4 else T_LOWAPT
                    elif a > 1500 and not apt:
                        t = T_PUBLIC
                    else:
                        t = T_LOWAPT
                else:
                    t = T_PUBLIC
            else:
                # 1-2 storeys
                if a < 25 or (a < 50 and big_nb[k] > 1.6 * a):
                    t = T_OUTB
                elif a < 350:
                    t = T_HOUSE
                elif a < 1200:
                    t = T_COMM if (dc[k] < 3500 or F['d_major'][k] < 60) else T_WARE
                else:
                    t = T_WARE if a < 4000 else T_IND
        if lv is None:
            lv = None
        typ[k] = t
        lev[k] = lv if lv else 0
    return typ, lev, labelled, height_override, min_h, shadow_height


# ------------------------------------------------------------------ stage 4b: per-building parameters

def params_for(k, r, t, lv, labelled, F, rnd, hovr, minh):
    """Return dict with levels, floorH, height, socle, roof shape/pitch/overhang, styles, colours, flags."""
    a = F['area'][k]
    W = F['width'][k]
    L = F['length'][k]
    elong = F['elong'][k]
    dc = F['dist_centre'][k]
    sh = shadow_height(F, k)
    p = dict(levels=lv or 1, floorH=3.0, socle=0.5, roof=R_FLAT, pitch=0, overhang=0.0,
             wall=W_HPLASTER, wcol=(230, 225, 210), rmat=M_BITUMEN, rcol=(70, 70, 70), balc=False, extra=0.0)
    if t == T_HOUSE:
        if not lv:
            p['levels'] = 1
        p['levels'] = min(p['levels'], 3)
        p['floorH'] = rnd.rng(2.9, 3.2)
        p['socle'] = rnd.rng(0.35, 0.8)
        small_sq = elong < 1.25 and a < 140
        p['roof'] = rnd.pick([R_HIP, R_GABLE, R_PYR], [0.5, 0.4, 0.1]) if not small_sq else rnd.pick([R_PYR, R_HIP, R_GABLE], [0.45, 0.35, 0.2])
        p['pitch'] = rnd.rng(20, 30) if p['roof'] != R_GABLE else rnd.rng(24, 36)
        p['overhang'] = rnd.rng(0.35, 0.6)
        p['wall'] = rnd.pick([W_HPLASTER, W_HBRICK, W_SIDING], [0.45, 0.4, 0.15])
        if p['wall'] == W_HPLASTER:
            p['wcol'] = jitter(rnd.pick(P_PLASTER), rnd)
        elif p['wall'] == W_HBRICK:
            p['wcol'] = jitter(rnd.pick([rnd.pick(P_REDBRICK), rnd.pick(P_SILICATE), rnd.pick(P_YELBRICK)], [0.5, 0.25, 0.25]), rnd, 6)
        else:
            p['wcol'] = jitter(rnd.pick(P_SIDING), rnd, 5)
        p['rmat'] = rnd.pick([M_MTILE, M_CORR, M_SLATE], [0.4, 0.3, 0.3])
    elif t == T_OUTB:
        p['levels'] = 1
        p['floorH'] = rnd.rng(2.3, 2.8)
        p['socle'] = 0.1
        p['roof'] = rnd.pick([R_SHED, R_GABLE, R_FLAT], [0.5, 0.35, 0.15]) if a > 8 else R_FLAT
        p['pitch'] = rnd.rng(6, 12) if p['roof'] == R_SHED else rnd.rng(18, 30)
        p['overhang'] = rnd.rng(0.15, 0.35)
        p['wall'] = rnd.pick([W_HPLASTER, W_HBRICK, W_WARE, W_SIDING], [0.4, 0.25, 0.25, 0.1])
        p['wcol'] = jitter(rnd.pick(P_PLASTER + P_REDBRICK + P_SILICATE) if p['wall'] != W_WARE else rnd.pick(P_WARE), rnd)
        p['rmat'] = rnd.pick([M_SLATE, M_CORR, M_BITUMEN], [0.4, 0.5, 0.1])
    elif t == T_GARAGE:
        p['levels'] = 1
        p['floorH'] = rnd.rng(2.6, 3.0)
        p['socle'] = 0.05
        p['roof'] = R_FLAT
        p['wall'] = W_GARAGE
        p['wcol'] = jitter(rnd.pick(P_GARAGE), rnd, 5)
        p['rmat'] = M_BITUMEN
    elif t == T_DACHA:
        p['levels'] = 2 if (lv or 0) >= 2 or (a > 50 and rnd.u() < 0.25) else 1
        p['floorH'] = rnd.rng(2.5, 2.8)
        p['socle'] = rnd.rng(0.2, 0.5)
        p['roof'] = rnd.pick([R_GABLE, R_HIP, R_SHED], [0.7, 0.2, 0.1])
        p['pitch'] = rnd.rng(28, 40) if p['roof'] == R_GABLE else rnd.rng(20, 28)
        p['overhang'] = rnd.rng(0.3, 0.5)
        p['wall'] = rnd.pick([W_SIDING, W_HPLASTER, W_HBRICK, W_WARE], [0.3, 0.3, 0.3, 0.1])
        p['wcol'] = jitter(rnd.pick(P_SIDING + P_PLASTER + P_REDBRICK), rnd)
        p['rmat'] = rnd.pick([M_CORR, M_MTILE, M_SLATE], [0.4, 0.3, 0.3])
    elif t in (T_KHRU, T_LOWAPT, T_STALINKA, T_MODERN):
        p['levels'] = lv or (5 if t == T_KHRU else 3)
        if t == T_KHRU:
            panel = rnd.u() < 0.45
            p['floorH'] = 2.8
            p['socle'] = rnd.rng(0.8, 1.3)
            p['wall'] = W_PANEL5 if panel else W_BRICK5
            if panel:
                p['wcol'] = jitter(rnd.pick(P_PANEL) if rnd.u() < 0.7 else rnd.pick(P_PANEL_PAINT), rnd, 5)
            else:
                p['wcol'] = jitter(rnd.pick(P_SILICATE) if rnd.u() < 0.7 else rnd.pick(P_REDBRICK), rnd, 5)
            pitched = (not panel and rnd.u() < 0.55) or (panel and rnd.u() < 0.15)
            p['roof'] = rnd.pick([R_GABLE, R_HIP], [0.6, 0.4]) if pitched else R_FLAT
            p['pitch'] = rnd.rng(14, 22)
            p['overhang'] = 0.45
            p['rmat'] = rnd.pick([M_SLATE, M_CORR], [0.6, 0.4]) if pitched else M_BITUMEN
            p['balc'] = rnd.u() < 0.9
            p['extra'] = 0.35
        elif t == T_STALINKA:
            p['floorH'] = rnd.rng(3.2, 3.5)
            p['socle'] = rnd.rng(0.8, 1.2)
            p['wall'] = W_STALINKA
            p['wcol'] = jitter(rnd.pick(P_STALINKA), rnd, 6)
            p['roof'] = R_HIP if rnd.u() < 0.75 else R_GABLE
            p['pitch'] = rnd.rng(24, 32)
            p['overhang'] = 0.6
            p['rmat'] = rnd.pick([M_SEAM, M_SLATE, M_CORR], [0.5, 0.3, 0.2])
            p['balc'] = rnd.u() < 0.5
            p['extra'] = 0.7
        elif t == T_MODERN:
            p['floorH'] = 3.0
            p['socle'] = 1.0
            p['wall'] = W_MODERN
            p['wcol'] = jitter(rnd.pick([(222, 196, 160), (196, 120, 90), (230, 222, 206), (206, 170, 140)]), rnd, 6)
            p['roof'] = R_FLAT if rnd.u() < 0.6 else R_HIP
            p['pitch'] = 18
            p['overhang'] = 0.5
            p['rmat'] = M_BITUMEN if p['roof'] == R_FLAT else M_MTILE
            p['balc'] = True
            p['extra'] = 0.5
        else:
            p['floorH'] = 3.0
            p['socle'] = rnd.rng(0.6, 1.0)
            p['wall'] = rnd.pick([W_BRICK5, W_STALINKA, W_PANEL5], [0.45, 0.35, 0.2])
            p['wcol'] = jitter(rnd.pick(P_SILICATE + P_REDBRICK) if p['wall'] == W_BRICK5 else rnd.pick(P_STALINKA if p['wall'] == W_STALINKA else P_PANEL), rnd, 5)
            pitched = rnd.u() < 0.6
            p['roof'] = rnd.pick([R_HIP, R_GABLE]) if pitched else R_FLAT
            p['pitch'] = rnd.rng(18, 28)
            p['overhang'] = 0.5
            p['rmat'] = rnd.pick([M_SLATE, M_CORR, M_SEAM]) if pitched else M_BITUMEN
            p['balc'] = rnd.u() < 0.5
            p['extra'] = 0.4
        if p['roof'] != R_FLAT:
            p['rcol'] = None
    elif t in (T_PANEL9, T_TOWER):
        p['levels'] = lv or (9 if t == T_PANEL9 else 12)
        p['floorH'] = 2.8
        p['socle'] = rnd.rng(1.0, 1.5)
        p['wall'] = W_PANEL9 if rnd.u() < 0.8 else W_BRICK5
        p['wcol'] = jitter(rnd.pick(P_PANEL + P_PANEL_PAINT) if p['wall'] == W_PANEL9 else rnd.pick(P_SILICATE), rnd, 5)
        p['roof'] = R_FLAT
        p['rmat'] = M_BITUMEN
        p['balc'] = True
        p['extra'] = 0.6
    elif t in (T_SCHOOL, T_KINDER, T_PUBLIC):
        p['levels'] = lv or (3 if t == T_SCHOOL else 2 if t == T_KINDER else max(2, min(5, int(round(max(sh, 7) / 3.6)))))
        p['floorH'] = 3.6 if t != T_KINDER else 3.3
        p['socle'] = rnd.rng(0.6, 1.0)
        p['wall'] = W_SCHOOL if t != T_PUBLIC else rnd.pick([W_PUBLIC, W_BRICK5, W_STALINKA])
        pal = P_SCHOOL if t == T_SCHOOL else P_KINDER if t == T_KINDER else P_PLASTER + P_SILICATE
        p['wcol'] = jitter(rnd.pick(pal), rnd, 6)
        pitched = rnd.u() < (0.25 if t != T_KINDER else 0.35)
        p['roof'] = rnd.pick([R_HIP, R_GABLE]) if pitched else R_FLAT
        p['pitch'] = rnd.rng(15, 25)
        p['overhang'] = 0.5
        p['rmat'] = rnd.pick([M_CORR, M_MTILE, M_SEAM]) if pitched else M_BITUMEN
        p['extra'] = 0.5
    elif t in (T_COMM, T_MALL, T_KIOSK):
        if t == T_KIOSK:
            p['levels'] = 1
            p['floorH'] = 2.8
            p['socle'] = 0.1
        else:
            p['levels'] = lv or (1 if a < 600 or rnd.u() < 0.6 else 2)
            if t == T_MALL:
                p['levels'] = max(p['levels'], 2)
            p['floorH'] = rnd.rng(3.6, 4.4)
            p['socle'] = rnd.rng(0.2, 0.5)
        p['wall'] = W_COMM
        p['wcol'] = jitter(rnd.pick(P_COMM), rnd, 5)
        p['roof'] = R_FLAT if rnd.u() < 0.85 else R_GABLE
        p['pitch'] = rnd.rng(10, 20)
        p['overhang'] = 0.3
        p['rmat'] = M_BITUMEN if p['roof'] == R_FLAT else M_CORR
        p['extra'] = 0.6
    elif t in (T_IND, T_WARE, T_UTIL):
        if t == T_IND:
            h = sh if sh > 0 else 10.0
            # DSM sees big halls: blend in its footprint max for large footprints
            if a > 3000 and F['dsm_fmax'][k] > 4:
                h = max(h, 0.8 * F['dsm_fmax'][k])
            h = float(np.clip(h * rnd.rng(0.85, 1.1), 6.0, 32.0))
            p['levels'] = max(1, int(round(h / 5.0)))
            p['floorH'] = h / p['levels']
            p['wall'] = rnd.pick([W_IND, W_WARE, W_BRICK5], [0.55, 0.25, 0.2])
        elif t == T_WARE:
            h = float(np.clip(sh if sh > 0 else 7.0, 4.5, 12.0))
            p['levels'] = 1
            p['floorH'] = h
            p['wall'] = rnd.pick([W_WARE, W_IND, W_GARAGE], [0.6, 0.25, 0.15])
        else:
            p['levels'] = 1
            p['floorH'] = rnd.rng(2.8, 3.5)
            p['wall'] = rnd.pick([W_HBRICK, W_HPLASTER, W_WARE])
        p['socle'] = 0.2
        p['wcol'] = jitter(rnd.pick(P_IND if p['wall'] != W_WARE else P_WARE) if p['wall'] != W_BRICK5 else rnd.pick(P_SILICATE + P_REDBRICK), rnd, 6)
        pitched = rnd.u() < (0.3 if t == T_IND else 0.55 if t == T_WARE else 0.3) and W < 60
        p['roof'] = R_GABLE if pitched else R_FLAT
        p['pitch'] = rnd.rng(8, 15)
        p['overhang'] = 0.3
        p['rmat'] = M_CORR if pitched else rnd.pick([M_BITUMEN, M_GRAVEL], [0.7, 0.3])
        p['extra'] = 0.4 if t != T_UTIL else 0.15
    elif t == T_AGRI:
        p['levels'] = 1
        p['floorH'] = rnd.rng(3.5, 5.0)
        p['socle'] = 0.3
        p['wall'] = rnd.pick([W_WARE, W_HPLASTER, W_HBRICK], [0.4, 0.4, 0.2])
        p['wcol'] = jitter(rnd.pick([(226, 224, 216), (206, 204, 196), (190, 186, 176)] + P_REDBRICK[:1]), rnd, 6)
        p['roof'] = R_GABLE
        p['pitch'] = rnd.rng(15, 22)
        p['overhang'] = 0.4
        p['rmat'] = rnd.pick([M_SLATE, M_CORR], [0.6, 0.4])
    elif t == T_GREEN:
        p['levels'] = 1
        p['floorH'] = 2.4
        p['socle'] = 0.2
        p['wall'] = W_GLASS
        p['wcol'] = (220, 230, 232)
        p['roof'] = R_GABLE
        p['pitch'] = 28
        p['overhang'] = 0.05
        p['rmat'] = M_GLASS
    elif t == T_REL:
        p['levels'] = 1
        p['floorH'] = rnd.rng(6.0, 9.0)
        p['socle'] = 0.8
        p['wall'] = W_STALINKA
        p['wcol'] = (240, 238, 230)
        p['roof'] = R_GABLE
        p['pitch'] = 35
        p['overhang'] = 0.5
        p['rmat'] = M_SEAM
        p['rcol'] = (60, 90, 70)
    if p['wcol'] is None:
        p['wcol'] = (220, 220, 215)
    if p.get('rcol') is None or p['rmat'] in (M_BITUMEN, M_GRAVEL, M_SLATE, M_GLASS) or t not in (T_REL,):
        pal = {M_BITUMEN: R_BITUMEN, M_GRAVEL: R_GRAVEL, M_CORR: R_CORR, M_MTILE: R_METALTILE,
               M_SLATE: R_SLATE, M_SEAM: R_SEAM, M_GLASS: R_GLASS, M_TILES: R_METALTILE}[p['rmat']]
        w = W_CORR if p['rmat'] == M_CORR else W_METALTILE if p['rmat'] in (M_MTILE, M_TILES) else None
        if not (t == T_REL and p.get('rcol')):
            p['rcol'] = jitter(rnd.pick(pal, w), rnd, 5)
    # height
    if labelled and lv:
        p['levels'] = lv
    height = p['levels'] * p['floorH'] + p['extra']
    if not np.isnan(hovr):
        height = max(2.5, hovr - (p['socle'] if minh == 0 else 0))
    p['height'] = height
    p['minh'] = minh
    # tiny/odd footprints: no pitched roofs on slivers
    if p['roof'] != R_FLAT and W < 3.0:
        p['roof'] = R_SHED if W > 2.2 else R_FLAT
    return p


# ------------------------------------------------------------------ stage 4c: roofs and orientation

def roof_parts(r, p):
    g = r['geom']
    if p['roof'] == R_FLAT:
        return []
    if r.get('ortho'):
        theta = r.get('theta', 0.0)
        # recompute theta on the squared polygon (exact)
        q, th = square_polygon(g, tol_deg=2.0)
        theta = th
        parts = rect_decompose(g, theta)
        if parts:
            return parts
    Lm, Wm, ang, rect = mrr_dims(g)
    if rect.geom_type == 'Polygon':
        iou = g.intersection(rect).area / max(g.union(rect).area, 1e-9)
        if iou > 0.85:
            c = rect.centroid
            return [(c.x, c.y, Lm / 2, Wm / 2, ang)]
    return []


def angle_byte(nx, ny):
    """World-frame direction byte for a pipeline-frame outward normal (nx east, ny north)."""
    # world x = nx, world z = -ny ; angle a: (sin a, cos a) = (x, z)
    a = math.atan2(nx, -ny)
    return int(round((a % (2 * math.pi)) / (2 * math.pi) * 256)) % 256


def side_normals(g):
    """Outward normals (pipeline frame) of the two long sides of the MRR + their midpoints."""
    Lm, Wm, ang, rect = mrr_dims(g)
    d = np.array([math.cos(ang), math.sin(ang)])
    nrm = np.array([-d[1], d[0]])
    c = np.array([g.centroid.x, g.centroid.y])
    return [(nrm, c + nrm * Wm / 2), (-nrm, c - nrm * Wm / 2)], Wm


# ------------------------------------------------------------------ main

def main():
    t0 = time.time()
    recs = load_clean(force=REFRESH)
    fcache = os.path.join(PROC, "buildings_features.pkl")
    scache = os.path.join(PROC, "buildings_shadow.pkl")
    if REFRESH or not os.path.exists(fcache):
        F = bf.compute(recs)
        pickle.dump(F, open(fcache, "wb"))
    else:
        F = pickle.load(open(fcache, "rb"))
    if REFRESH or not os.path.exists(scache):
        scenes = s2w.all_scenes()
        geoms = np.array([r['geom'] for r in recs], dtype=object)
        S = bf.shadow_features(geoms, scenes)
        pickle.dump(S, open(scache, "wb"))
    else:
        S = pickle.load(open(scache, "rb"))
    F.update(S)
    n = len(recs)
    assert len(F['area']) == n, "feature cache out of date: run with --refresh"
    levels = np.array([r['levels'] or 0 for r in recs])
    classes, proba, report = train_level_model(F, levels)
    typ, lev, labelled, hovr, minh, _ = classify(recs, F, classes, proba)

    # roads for entrance / street orientation
    major, minor, _ = bf.load_roads()
    tmaj = shapely.STRtree(major)
    tmin = shapely.STRtree(minor)

    names = []
    name_idx = {}
    out_recs = []
    for k, r in enumerate(recs):
        rnd = Rnd(r['id'] + str(k))
        t = int(typ[k])
        p = params_for(k, r, t, int(lev[k]), bool(labelled[k]), F, rnd, hovr[k], minh[k])
        parts = roof_parts(r, p)
        if p['roof'] != R_FLAT and not parts:
            p['roof'] = R_FLAT
            if p['rmat'] not in (M_BITUMEN, M_GRAVEL):
                p['rmat'] = M_BITUMEN
                p['rcol'] = jitter(R_BITUMEN[0], rnd, 5)
        # roof height from main part
        rh = 0.0
        if parts:
            hw = max(pp[3] for pp in parts)
            if p['roof'] == R_SHED:
                rh = 2 * hw * math.tan(math.radians(p['pitch']))
            else:
                rh = hw * math.tan(math.radians(p['pitch']))
        # entrance / street
        flags = 0
        ent = 0
        street = 0
        g = r['geom']
        if t in APT_TYPES or t in (T_SCHOOL, T_KINDER, T_PUBLIC, T_HOUSE, T_COMM, T_MALL, T_DACHA, T_GARAGE):
            sides, Wm = side_normals(g)
            best = None
            for nrm, mid in sides:
                pt = shapely.Point(mid + nrm * 3.0)
                j = tmin.nearest(pt)
                dmin = pt.distance(minor[j]) if j is not None else 1e9
                if best is None or dmin < best[0]:
                    best = (dmin, nrm)
            ent = angle_byte(*best[1])
            flags |= F_ENTR
            if t in APT_TYPES and F['dist_centre'][k] < 3000 and F['d_major'][k] < 45:
                bests = None
                for nrm, mid in sides:
                    pt = shapely.Point(mid + nrm * 3.0)
                    j = tmaj.nearest(pt)
                    dmj = pt.distance(major[j]) if j is not None else 1e9
                    if bests is None or dmj < bests[0]:
                        bests = (dmj, nrm)
                street = angle_byte(*bests[1])
                if bests[0] < 45 and rnd.u() < 0.75:
                    flags |= F_SHOP
            if t == T_GARAGE:
                street = ent
        if p['balc']:
            flags |= F_BALC
        if r['osm']:
            flags |= F_OSM
        if labelled[k]:
            flags |= F_LABEL
        ni = 0xFFFF
        if r['name']:
            flags |= F_NAMED
            ni = len(names)
            names.append(r['name'])
        out_recs.append((k, t, p, parts, rh, flags, ent, street, ni, rnd))
    print(f"[typology] {dict(zip(*np.unique([TYP_NAMES[x[1]] for x in out_recs], return_counts=True)))}")
    lv_all = np.array([x[2]['levels'] for x in out_recs])
    print("[levels]", {int(a): int(b) for a, b in zip(*np.unique(lv_all, return_counts=True))})

    # ------------------------------------------------------------ plot fences (private houses)
    typ_final = np.array([x[1] for x in out_recs])
    fences = build_fences(recs, typ_final, {T_HOUSE}, lambda key: Rnd(key))

    # ------------------------------------------------------------ write
    os.makedirs(OUT, exist_ok=True)
    half = REGION_HALF
    tiles_x = int(round(2 * half / TILE))
    ntiles = tiles_x * tiles_x
    wx = F['cx']
    wz = -F['cy']
    tx = np.clip(((wx + half) // TILE).astype(int), 0, tiles_x - 1)
    tz = np.clip(((wz + half) // TILE).astype(int), 0, tiles_x - 1)
    tile = tz * tiles_x + tx
    order = np.lexsort((wx, tile))
    tile_start = np.searchsorted(tile[order], np.arange(ntiles + 1)).astype('<u4')
    rec_buf = bytearray()
    verts = []
    ring_len = []
    parts_buf = bytearray()
    ids_hi, ids_lo, osm_ids, osm_kinds = [], [], [], []
    nv = 0
    npart = 0
    stats = {"typology": {}, "levels_labelled": int(labelled.sum())}
    for oi in order:
        k, t, p, parts, rh, flags, ent, street, ni, rnd = out_recs[oi]
        r = recs[k]
        g = shapely.geometry.polygon.orient(r['geom'], 1.0)
        cxw, czw = float(wx[k]), float(wz[k])
        rings = [np.asarray(g.exterior.coords)[:-1]] + [np.asarray(h.coords)[:-1] for h in g.interiors]
        ext = max(float(np.abs(np.asarray(g.exterior.coords) - [cxw, -czw]).max()), 1.0)
        q = 0.01 if ext < 320 else 0.02
        if q == 0.02:
            flags |= F_Q2
        vstart = nv
        rstart = len(ring_len)
        for ring in rings:
            xs = (ring[:, 0] - cxw) / q
            zs = (-ring[:, 1] - czw) / q
            arr = np.column_stack([np.round(xs), np.round(zs)]).astype('<i2')
            verts.append(arr)
            ring_len.append(len(ring))
            nv += len(ring)
        pstart = npart
        for (pcx, pcy, hl, hw, ang) in parts[:255]:
            # pipeline angle -> world: dir (cos t, sin t) in (x,y) -> (cos t, -sin t) in (x,z)
            wa = -ang
            wa = (wa + math.pi) % (2 * math.pi) - math.pi
            parts_buf += struct.pack('<hhHHhH', int(round((pcx - cxw) * 100)), int(round((-pcy - czw) * 100)),
                                     min(65535, int(round(hl * 100))), min(65535, int(round(hw * 100))),
                                     int(round(wa * 1e4)), 0)
            npart += 1
        wr, wg, wb = p['wcol']
        rr, rg, rb = p['rcol']
        rec = struct.pack('<ffIIIHBBHBBBBBB3B3BBBBBBBHBBB3x',
                          cxw, czw, vstart, rstart, pstart, nv - vstart, len(rings), min(255, len(parts)),
                          min(65535, int(round(p['height'] * 10))), min(255, int(round(rh * 10))),
                          min(255, int(p['levels'])), t, p['roof'], p['wall'], p['rmat'],
                          wr, wg, wb, rr, rg, rb, rnd.r.integers(256), flags, ent,
                          min(255, int(round(p['floorH'] * 10))), min(255, int(round(p['minh']))),
                          min(255, int(round(p['socle'] * 10))), ni, int(round(p['pitch'])),
                          min(255, int(round(p['overhang'] * 200))), street)
        assert len(rec) == 52, len(rec)
        rec_buf += rec
        uid = r['id'].replace('-', '')
        ids_hi.append(int(uid[:8], 16))
        ids_lo.append(int(uid[8:16], 16))
        osm_ids.append(r['osm_id'] & 0xFFFFFFFF)
        osm_kinds.append(r['osm_kind'])
        stats["typology"][TYP_NAMES[t]] = stats["typology"].get(TYP_NAMES[t], 0) + 1
    V = np.concatenate(verts).astype('<i2')
    RL = np.array(ring_len, '<u2')
    # fences: sorted by tile of their midpoint, cm relative to the tile centre (world x/z)
    fx = np.array([(f[0] + f[2]) / 2 for f in fences])
    fz = -np.array([(f[1] + f[3]) / 2 for f in fences])
    ftile = np.clip(((fz + half) // TILE).astype(int), 0, tiles_x - 1) * tiles_x + np.clip(((fx + half) // TILE).astype(int), 0, tiles_x - 1)
    forder = np.argsort(ftile, kind='stable')
    fence_start = np.searchsorted(ftile[forder], np.arange(ntiles + 1)).astype('<u4')
    fence_buf = bytearray()
    for fi in forder:
        x0, y0, x1, y1, ft, fh, fc = fences[fi]
        t = ftile[fi]
        tcx = -half + (t % tiles_x + 0.5) * TILE
        tcz = -half + (t // tiles_x + 0.5) * TILE
        fence_buf += struct.pack('<hhhhBB3BBH', int(round((x0 - tcx) * 100)), int(round((-y0 - tcz) * 100)),
                                 int(round((x1 - tcx) * 100)), int(round((-y1 - tcz) * 100)), ft,
                                 min(255, int(round(fh * 10))), *fc, int(fi * 2654435761 % 256), 0)
    header = struct.pack('<4sIIIIIfIffII16x', b'NBLD', 2, n, nv, len(ring_len), npart, TILE, tiles_x,
                         -half, -half, ntiles, len(fences))
    body = bytearray(header)
    body += tile_start.tobytes()
    body += rec_buf
    body += V.tobytes()
    body += RL.tobytes()
    while len(body) % 4:
        body += b'\0'
    body += parts_buf
    body += fence_start.tobytes()
    body += fence_buf
    with gzip.open(os.path.join(OUT, "buildings.bin.gz"), "wb", compresslevel=9) as f:
        f.write(bytes(body))
    idb = struct.pack('<4sI', b'NBID', n) + np.array(ids_hi, '<u4').tobytes() + np.array(ids_lo, '<u4').tobytes() + \
        np.array(osm_ids, '<u4').tobytes() + np.array(osm_kinds, 'u1').tobytes()
    with gzip.open(os.path.join(OUT, "ids.bin.gz"), "wb", compresslevel=9) as f:
        f.write(idb)
    # name table in file order
    order_names = {}
    for fi, oi in enumerate(order):
        ni = out_recs[oi][8]
        if ni != 0xFFFF:
            order_names[ni] = names[ni]
    meta = {
        "version": 1, "count": n, "tileSize": TILE, "tilesX": tiles_x,
        "typologies": TYP_NAMES, "names": names,
        "model": report, "stats": stats,
        "sources": "Overture Maps buildings 2026-09 (OSM + Microsoft ML), Copernicus GLO-30 DSM, "
                   "Sentinel-2 L2A (summer composite + 5 winter low-sun scenes for shadow heights)",
    }
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), ensure_ascii=False, indent=1)
    sz = os.path.getsize(os.path.join(OUT, "buildings.bin.gz"))
    print(f"[write] {n} buildings, {nv} verts, {npart} roof parts, {len(fences)} fence pieces, {sz / 1e6:.2f} MB gz, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
