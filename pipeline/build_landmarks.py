"""Landmarks: placement data for the hand-modelled landmarks (module "landmarks").

  python3 pipeline/build_landmarks.py            (about 1-2 min; --no-shadows skips the S2 shadow refinement)

Everything is derived from the local open data (Overture buildings / land use / infrastructure /
places / transportation, Copernicus DSM, Sentinel-2) plus published facts (see docs/modules/landmarks.md).
The runtime (src/modules/landmarks) builds the geometry procedurally from these parameters.

Tall structures (chimneys / towers) are located and measured from their shadows in five low-sun
winter Sentinel-2 scenes (sun elevation 22-32 deg): for a candidate base point and height H the
shadow is a dark line of length H / tan(elevation) along the anti-sun azimuth. Scenes with different
elevations break the base/height ambiguity; the score is the mean darkness along the far part of the
predicted shadow minus darkness just beyond its tip, required to be consistent across all scenes.

Output: public/data/landmarks/landmarks.json   (world frame: x east, z south, metres; angles in radians,
  "rot" = rotation about +Y applied to a model whose local +X is the long axis of the footprint)
  {
    version, generated,
    gres:   { stacks:[{x,z,h,r0,r1,bands}], main:{x,z,len,wid,rot,ring}, tec:{...}, boilers:[...],
              tanks:[{x,z,r,h}], hide:[ids] },
    azot:   { stacks:[...], prill:[...], columns:[...], ammonia:[{x,z,r,h}], tanks:[...],
              cells:[[x,z,seed],...], racks:[[x0,z0,x1,z1,...],...], hide:[ids], poly:[x,z,...] },
    churches: [{name,x,z,len,wid,rot,kind,domes,dome,walls,bell,h,hide:[ids],ring}],
    memorial: {x,z,rot, ...}, station:{...}, stadium:{...},
    turbines: [[x,z],...], masts: [[x,z,h],...], weir:{line,up,down,canal}, ges4:{...}, signs:[...]
  }
"""
import json
import math
import os
import pickle
import sys
import time

import numpy as np
import pyarrow.parquet as pq
import shapely
import shapely.ops
from shapely import affinity
from scipy.ndimage import map_coordinates, label

from config import RAW, PROC, WEB_DATA, REGION_HALF, to_local

OUT_DIR = os.path.join(WEB_DATA, "landmarks")
os.makedirs(OUT_DIR, exist_ok=True)
# procedural texture used by the runtime material (generated once, committed)
if not os.path.exists(os.path.join(os.path.dirname(WEB_DATA), "textures", "landmarks", "noise.png")):
    import landmarks_textures
    landmarks_textures.main()
T0 = time.time()
tr = to_local()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


def W(g):
    """lon/lat geometry -> world x/z geometry (z = -north)."""
    g = shapely.ops.transform(lambda X, Y: tr.transform(X, Y), g)
    return affinity.scale(g, 1, -1, origin=(0, 0))


def ring_of(g, simplify=0.3):
    if g.geom_type == "MultiPolygon":
        g = max(g.geoms, key=lambda p: p.area)
    g = g.simplify(simplify)
    xs, zs = g.exterior.coords.xy
    out = []
    for x, z in list(zip(xs, zs))[:-1]:
        out += [round(x, 2), round(z, 2)]
    return out


def mrr(g):
    """Minimum rotated rectangle -> centre, length (long side), width, rot (radians; local +X = long axis)."""
    r = g.minimum_rotated_rectangle
    xs, zs = r.exterior.coords.xy
    e0 = (xs[1] - xs[0], zs[1] - zs[0])
    e1 = (xs[2] - xs[1], zs[2] - zs[1])
    l0, l1 = math.hypot(*e0), math.hypot(*e1)
    e = e0 if l0 >= l1 else e1
    # three.js rotation.y = a maps local +X to (cos a, -sin a) in (x, z)
    rot = math.atan2(-e[1], e[0])
    c = r.centroid
    return dict(x=round(c.x, 2), z=round(c.y, 2), len=round(max(l0, l1), 2), wid=round(min(l0, l1), 2), rot=round(rot, 4))


# ----------------------------------------------------------------------------- sources
log("loading Overture")
BLD = []
for r in pq.read_table(os.path.join(RAW, "buildings_building.parquet"),
                       columns=["id", "geometry", "height", "num_floors", "class", "names", "sources"]).to_pylist():
    g = W(shapely.from_wkb(r["geometry"]))
    c = g.centroid
    if abs(c.x) > REGION_HALF or abs(c.y) > REGION_HALF:
        continue
    BLD.append(dict(id=r["id"], g=g, x=c.x, z=c.y, h=r["height"], cls=r["class"],
                    name=(r["names"] or {}).get("primary"),
                    osm=(r["sources"] or [{}])[0].get("record_id") or ""))
BTREE = shapely.STRtree([b["g"] for b in BLD])
log(len(BLD), "buildings")

LU = {}
for r in pq.read_table(os.path.join(RAW, "base_land_use.parquet")).to_pylist():
    nm = (r["names"] or {}).get("primary")
    if nm:
        LU.setdefault(nm, W(shapely.from_wkb(r["geometry"])))
INFRA = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet")).to_pylist()
SEG = pq.read_table(os.path.join(RAW, "transportation_segment.parquet"),
                    columns=["geometry", "subtype", "class", "names"]).to_pylist()


def bld_by_id(prefix):
    for b in BLD:
        if b["id"].startswith(prefix):
            return b
    raise KeyError(prefix)


def optional(fn, what):
    """Run a builder; a missing footprint (Overture re-release) drops that landmark instead of failing."""
    try:
        return fn()
    except KeyError as e:
        log(f"  {what}: footprint {e} not found - skipped")
        return None


def blds_in(poly, pred=None):
    idx = BTREE.query(poly, predicate="intersects")
    out = []
    for i in idx:
        b = BLD[i]
        if poly.contains(shapely.Point(b["x"], b["z"])) and (pred is None or pred(b)):
            out.append(b)
    return out


def circularity(g):
    return 4 * math.pi * g.area / (g.length ** 2 + 1e-9)


# ----------------------------------------------------------------------------- rasters
EXC = np.load(os.path.join(PROC, "dsm_excess.npy"))
NDVI = np.load(os.path.join(PROC, "s2_ndvi.npy"))


def sample(a, x, z):
    n = a.shape[0]
    if n == 2049:
        return map_coordinates(a, [[(z + 10240) / 10], [(x + 10240) / 10]], order=1)[0]
    return map_coordinates(a, [[(z + 10240) / 10 - 0.5], [(x + 10240) / 10 - 0.5]], order=1)[0]


# ----------------------------------------------------------------------------- shadow refinement
SCENES = []
if "--no-shadows" not in sys.argv:
    for d in ["20250111", "20251127", "20231108", "20250215", "20260220"]:
        p = os.path.join(PROC, f"s2w_{d}.npz")
        if os.path.exists(p):
            w = np.load(p)
            b = w["bri"].astype(np.float32)
            b = np.where(np.isfinite(b), b, np.nanmedian(b))
            SCENES.append((b, float(w["sun_el"]), float(w["sun_az"])))


def _S(b, x, z):
    return map_coordinates(b, [(z + 10240) / 10 - 0.5, (x + 10240) / 10 - 0.5], order=1, mode="nearest")


def shadow_score(H, X, Z):
    tot = []
    for b, el, az in SCENES:
        a = math.radians(az)
        dx, dz = -math.sin(a), math.cos(a)
        px, pz = -dz, dx
        L = H / math.tan(math.radians(el))

        def seg(t0, t1):
            ts = np.arange(t0, t1, 6.0)
            acc = 0
            for t in ts:
                on = _S(b, X + dx * t, Z + dz * t)
                off = 0.5 * (_S(b, X + dx * t + px * 20, Z + dz * t + pz * 20) + _S(b, X + dx * t - px * 20, Z + dz * t - pz * 20))
                acc = acc + (off - on)
            return acc / len(ts)
        tot.append(seg(max(12, L * 0.45), L * 0.97) - np.maximum(seg(L * 1.06, L * 1.06 + 50), 0))
    return np.array(tot)


def refine_stack(x0, z0, h0, dh=30, r=16):
    """Refine a tall structure's base and height from winter shadows. Returns (x, z, h, consistency)."""
    if not SCENES:
        return x0, z0, h0, None
    xs = np.arange(x0 - r, x0 + r + 0.1, 4.0)
    zs = np.arange(z0 - r * 1.5, z0 + r * 1.5 + 0.1, 4.0)
    X, Z = np.meshgrid(xs, zs)
    best = None
    for H in np.arange(max(30, h0 - dh), h0 + dh + 0.1, 5.0):
        t = shadow_score(H, X, Z)
        m = t.mean(0) - 0.5 * t.std(0)
        k = np.unravel_index(np.argmax(m), m.shape)
        if best is None or m[k] > best[3]:
            best = (float(X[k]), float(Z[k]), float(H), float(m[k]), float(t[:, k[0], k[1]].min()))
    return best[0], best[1], best[2], round(best[4], 4)


# ============================================================================ GRES
log("GRES")
gres_poly = LU["Невинномысская ГРЭС"]
gres = dict(stacks=[], tanks=[], hide=[])
# Main chimney: 250 m (published), base at the Overture place "Невинномысская ГРЭС" and confirmed by
# its ~600 m winter shadow (refined base (-850, -2167), best height 240-250 m).
x, z, h, cons = refine_stack(-848.0, -2164.0, 250, dh=10, r=8)
gres["stacks"].append(dict(name="Main chimney (250 m)", x=round(x, 1), z=round(z, 1), h=250.0, r0=10.6, r1=4.6,
                           style="redwhite", shadowH=h, consistency=cons))
# Second chimney of the 1960 TEC part: consistent 120 m shadow in all five scenes.
x, z, h, cons = refine_stack(-755.0, -1922.0, 120, dh=20, r=10)
gres["stacks"].append(dict(name="TEC chimney", x=round(x, 1), z=round(z, 1), h=round(h), r0=6.4, r1=3.2,
                           style="concrete_top", shadowH=h, consistency=cons))
log("  stacks", gres["stacks"])

main = bld_by_id("ffd12a5f")      # 249 x 70 m main building of the 150 MW blocks
tec = bld_by_id("7958db14")       # 183 x 71 m main building of the 1960 TEC part
for key, b in (("main", main), ("tec", tec)):
    m = mrr(b["g"])
    m["ring"] = ring_of(b["g"])
    m["id"] = b["id"]
    gres[key] = m
    gres["hide"].append(b["id"])
# Chimney side: the boilers of the open-configuration 150 MW blocks stand between the turbine hall and
# the chimney, i.e. on the building side facing the main chimney.
mx, mz = gres["main"]["x"], gres["main"]["z"]
sx, sz = gres["stacks"][0]["x"], gres["stacks"][0]["z"]
rot = gres["main"]["rot"]
# local +Z of the building frame in world: (sin rot, cos rot)
side = (sx - mx) * math.sin(rot) + (sz - mz) * math.cos(rot)
gres["main"]["boilerSide"] = 1 if side > 0 else -1
tx, tz = gres["tec"]["x"], gres["tec"]["z"]
s2x, s2z = gres["stacks"][1]["x"], gres["stacks"][1]["z"]
rot2 = gres["tec"]["rot"]
gres["tec"]["boilerSide"] = 1 if ((s2x - tx) * math.sin(rot2) + (s2z - tz) * math.cos(rot2)) > 0 else -1

# round footprints = tanks (fuel oil / water); circularity > 0.8
for b in blds_in(gres_poly):
    g = b["g"]
    nv = len(g.exterior.coords) if g.geom_type == "Polygon" else 0
    mm = mrr(g)
    roundish = circularity(g) > 0.8 or (nv >= 12 and circularity(g) > 0.55 and mm["len"] < 1.25 * mm["wid"])
    if g.area > 120 and roundish:
        r = math.sqrt(g.area / math.pi) if circularity(g) > 0.8 else 0.47 * mm["wid"]
        c = g.centroid
        if abs(c.x + 786) < 3 and abs(c.y + 1918) < 3:
            kind = "water"   # 27 m round structure next to the TEC chimney: water tank
        else:
            kind = "oil" if r > 15 else "water"
        gres["tanks"].append(dict(x=round(c.x, 1), z=round(c.y, 1), r=round(r, 1),
                                  h=round(min(18.0, 6 + r * 0.45), 1), kind=kind, id=b["id"]))
        gres["hide"].append(b["id"])
log("  tanks", len(gres["tanks"]))

# ============================================================================ AZOT
log("Azot")
az_poly = LU["Невинномысский Азот"]
# process core of the plant (dense process units, racks); the south and south-east of the land-use
# polygon are warehouses, workshops and other enterprises
az_core = az_poly.intersection(shapely.box(-450, -3650, 1480, -1440))
azot = dict(stacks=[], prill=[], columns=[], ammonia=[], tanks=[], cells=[], racks=[], hide=[])
# tall structures from the shadow scan of the plant (see header); heights refined here
TALL = [
    # x, z, first-guess height, kind
    (207.0, -3050.0, 160, "stack"),     # strongest shadow in the plant: ~160-180 m flue-gas / tail-gas stack
    (600.0, -2038.0, 80, "prill"),      # ~80 m: prilling tower (ammonium nitrate / urea)
    (1811.0, -3024.0, 60, "column"),
    (1620.0, -1740.0, 50, "column"),
]
for x0, z0, h0, kind in TALL:
    x, z, h, cons = refine_stack(x0, z0, h0, dh=20, r=10)
    e = dict(x=round(x, 1), z=round(z, 1), h=round(h), consistency=cons)
    if kind == "stack":
        e.update(r0=7.0, r1=3.6, style="concrete_top")
        azot["stacks"].append(e)
    elif kind == "prill":
        e.update(r=9.0)
        azot["prill"].append(e)
    else:
        e.update(r=2.2)
        azot["columns"].append(e)
log("  tall", azot["stacks"], azot["prill"], azot["columns"])

# the four isothermal ammonia tanks (Overture height 30 m, 45 m diameter)
for b in blds_in(az_poly.buffer(300)):
    g = b["g"]
    if circularity(g) > 0.8 and g.area > 60 and az_poly.buffer(300).contains(g.centroid):
        r = math.sqrt(g.area / math.pi)
        c = g.centroid
        if b["h"] and b["h"] >= 25 and r > 18:
            azot["ammonia"].append(dict(x=round(c.x, 1), z=round(c.y, 1), r=round(r, 1), h=float(b["h"]), id=b["id"]))
        else:
            h = 1.6 * r + 2 if r < 5 else min(16.0, 5 + 0.55 * r)
            azot["tanks"].append(dict(x=round(c.x, 1), z=round(c.y, 1), r=round(r, 1), h=round(h, 1), id=b["id"]))
        azot["hide"].append(b["id"])
log("  ammonia tanks", len(azot["ammonia"]), "tanks", len(azot["tanks"]))

# process equipment cells: DSM says "something 4+ m tall", Sentinel-2 says "not vegetation",
# footprints say "not a building" -> columns, drums, frames, heat exchangers
import rasterio.features
import affine
x0, z0, x1, z1 = az_poly.bounds
x0 -= 20; z0 -= 20; x1 += 20; z1 += 20
i0, j0 = int((x0 + 10240) // 10), int((z0 + 10240) // 10)
i1, j1 = int((x1 + 10240) // 10) + 1, int((z1 + 10240) // 10) + 1
Tr = affine.Affine(10, 0, -10240 + i0 * 10, 0, 10, -10240 + j0 * 10)
shape = (j1 - j0, i1 - i0)
near = [b["g"] for b in blds_in(az_poly.buffer(50))]
bmask = rasterio.features.rasterize([(g.buffer(5), 1) for g in near], out_shape=shape, transform=Tr)
inside = rasterio.features.rasterize([(az_core.buffer(-15), 1)], out_shape=shape, transform=Tr)
ex = EXC[j0:j1, i0:i1]
nd = NDVI[j0:j1, i0:i1]
cand = (ex > 4.0) & (nd < 0.32) & (bmask == 0) & (inside == 1)
lab, nl = label(cand)
sizes = np.bincount(lab.ravel())
rngc = np.random.default_rng(7)
for k in range(1, nl + 1):
    if sizes[k] > 30:       # large blobs are heaps / dumps, not equipment
        cand[lab == k] = False
for j, i in zip(*np.nonzero(cand)):
    x = -10240 + (i0 + i + 0.5) * 10
    z = -10240 + (j0 + j + 0.5) * 10
    azot["cells"].append([round(x, 1), round(z, 1), int(rngc.integers(0, 1 << 20)), round(float(ex[j, i]), 1)])
log("  process cells", len(azot["cells"]))

# pipe racks: along the internal roads of the plant (the long linear DSM features follow them)
bunion = shapely.union_all([g.buffer(2.5) for g in near])
racks = []
for r in SEG:
    if r["subtype"] != "road":
        continue
    g = W(shapely.from_wkb(r["geometry"]))
    gi = g.intersection(az_core.buffer(-20))
    if gi.is_empty:
        continue
    for part in (gi.geoms if hasattr(gi, "geoms") else [gi]):
        if part.geom_type != "LineString" or part.length < 80:
            continue
        for side in (1, -1):
            off = part.offset_curve(side * 8.5)
            if off.is_empty or off.geom_type != "LineString":
                continue
            free = off.difference(bunion)
            for seg in (free.geoms if hasattr(free, "geoms") else [free]):
                if seg.geom_type != "LineString" or seg.length < 40:
                    continue
                s = seg.simplify(2.5)
                racks.append([round(v, 1) for xy in s.coords for v in xy])
            break   # one side per road
azot["racks"] = racks
log("  pipe racks", len(racks), "total length", round(sum(shapely.LineString(np.array(r).reshape(-1, 2)).length for r in racks)))
azot["poly"] = ring_of(az_poly, 5)

# ============================================================================ churches
log("churches")
churches = []


def church(prefix, **kw):
    b = bld_by_id(prefix)
    m = mrr(b["g"])
    m.update(kw)
    m["ring"] = ring_of(b["g"])
    m["hide"] = [b["id"]]
    # altar (apse) faces east: flip rot so that local +X points east-ish
    if math.cos(m["rot"]) < 0:
        m["rot"] = round(m["rot"] + math.pi if m["rot"] < 0 else m["rot"] - math.pi, 4)
    churches.append(m)
    return m


# Pokrovsky cathedral (1988-1998): white-stone five-domed chetverik with risalits, octagonal
# four-tier bell tower 50 m over the west part, main dome 34 m; gilded domes.
optional(lambda: church("d3be91ae", name="Кафедральный собор Покрова Пресвятой Богородицы", kind="cathedral",
                        domes=5, dome="gold", walls="white", bell=50.0, h=34.0), "cathedral")
# St Seraphim of Sarov (2005-2015, Old Russian style, brick): five drums (Overture building parts:
# central drum 18 m, four 14 m) + west belfry drum.
optional(lambda: church("6702d4d6", name="Храм Преподобного Серафима Саровского", kind="church5",
                        domes=5, dome="gold", walls="brick", bell=26.0, h=27.0), "St Seraphim")
optional(lambda: church("42431ea8", name="Крестильный храм / часовня (Серафимовский приход)", kind="chapel",
                        domes=1, dome="gold", walls="brick", bell=0, h=13.0), "chapel")
# other churches / chapels mapped in OSM (names unknown in the data)
for pref, kw in (("4ddbab1e", dict(kind="church1", domes=1, dome="blue", walls="white", bell=18.0, h=17.0)),
                 ("60d882f5", dict(kind="chapel", domes=1, dome="gold", walls="white", bell=0, h=11.0)),
                 ("4f4f2652", dict(kind="church1", domes=1, dome="green", walls="cream", bell=0, h=16.0)),
                 ("b1e8ef73", dict(kind="chapel", domes=1, dome="gold", walls="cream", bell=0, h=10.0))):
    try:
        church(pref, name="church", **kw)
    except KeyError:
        pass
log("  ", [(c["name"][:30], c["x"], c["z"], c["len"], c["wid"]) for c in churches])

# ============================================================================ memorial / station / stadium
# Eternal Flame + obelisk "Вечная слава" (1967) on bulvar Mira at Gagarina street; the boulevard axis
# here runs at heading ~75 deg (from its Overture centre line).
mem = dict(x=182.0, z=64.0, rot=round(math.atan2(0.27, 1.0), 4), obeliskH=17.0)
def _station():
    st = bld_by_id("db8b04f5")
    station = mrr(st["g"])
    station.update(ring=ring_of(st["g"]), hide=[st["id"]], name="Вокзал станции Невинномысская")
    # entrance faces the town (south, away from the tracks at z ~ 1014-1029): front = sign of local +Z . south
    station["front"] = 1 if math.cos(station["rot"]) >= 0 else -1
    return station


def _stadium():
    stand = bld_by_id("4ffa8295")
    sm = mrr(stand["g"])
    stadium = dict(x=-687.0, z=296.0, rot=round(-math.radians(80), 4), stand=sm, hide=[stand["id"]],
                   name="Стадион «Химик» (НГГТИ)")
    # pitch axis: stadium land-use polygon long axis
    sp = LU.get("Стадион НГГТИ")
    if sp is not None:
        m = mrr(sp)
        stadium.update(x=m["x"], z=m["z"], rot=m["rot"], len=m["len"], wid=m["wid"])
    return stadium


station = optional(_station, "station")
stadium = optional(_stadium, "stadium")

# ============================================================================ turbines / masts / signs
turbines, masts, signs, fountains = [], [], [], []
for r in INFRA:
    st_ = r.get("source_tags") or {}
    g = W(shapely.from_wkb(r["geometry"]))
    c = g.centroid
    if abs(c.x) > REGION_HALF + 3000 or abs(c.y) > REGION_HALF + 3000:
        continue
    if r["class"] == "generator" and dict(st_).get("generator:source") == "wind":
        turbines.append([round(c.x, 1), round(c.y, 1)])
    elif r["class"] == "mobile_phone_tower":
        h = r.get("height") or 0
        masts.append([round(c.x, 1), round(c.y, 1), float(h) if h else 0.0])
    elif r["class"] == "fountain" and abs(c.x) < REGION_HALF and abs(c.y) < REGION_HALF:
        fountains.append([round(c.x, 1), round(c.y, 1)])
    elif r["class"] == "artwork" and (r["names"] or {}).get("primary") in ("ГРЭС", "Еврохим"):
        signs.append(dict(text=(r["names"] or {}).get("primary"), x=round(c.x, 1), z=round(c.y, 1)))
# Kochubeevskaya wind farm: 84 x 2.5 MW NovaWind (Lagerwey L100 design), hub height 100 m (OSM), rotor 100 m
log("turbines", len(turbines), "masts", len(masts), "signs", signs, "fountains", fountains)
# orient the signs towards the nearest road
for s in signs:
    best = None
    p = shapely.Point(s["x"], s["z"])
    for r in SEG:
        if r["subtype"] != "road":
            continue
        g = W(shapely.from_wkb(r["geometry"]))
        d = g.distance(p)
        if d < 80 and (best is None or d < best[0]):
            best = (d, g)
    if best:
        q = best[1].interpolate(best[1].project(p))
        # plane normal (local +Z -> (sin rot, cos rot)) faces the road
        s["rot"] = round(math.atan2(q.x - s["x"], q.y - s["z"]), 4)
    else:
        s["rot"] = 0.0

# ============================================================================ weir (canal headworks)
weir = None
try:
    wj = json.load(open(os.path.join(WEB_DATA, "water", "water.json")))
    if wj.get("weir"):
        weir = dict(line=wj["weir"]["line"], up=wj["weir"]["up"], down=wj["weir"]["down"])
        for r in pq.read_table(os.path.join(RAW, "base_water.parquet")).to_pylist():
            if r["class"] == "canal" and (r["names"] or {}).get("primary") == "Невинномысский канал":
                g = W(shapely.from_wkb(r["geometry"]))
                if g.geom_type == "LineString" and g.distance(shapely.LineString(weir["line"])) < 60:
                    cs = list(g.coords)
                    # canal start = end nearest to the weir
                    wl = shapely.LineString(weir["line"])
                    if shapely.Point(cs[-1]).distance(wl) < shapely.Point(cs[0]).distance(wl):
                        cs = cs[::-1]
                    cl = shapely.LineString(cs)
                    p0 = cl.interpolate(40)
                    p1 = cl.interpolate(55)
                    weir["canal"] = dict(x=round(p0.x, 1), z=round(p0.y, 1),
                                         dir=round(math.atan2(p1.y - p0.y, p1.x - p0.x), 4))
                    break
except Exception as e:  # noqa
    log("weir: water.json not available", e)
log("weir", weir)

# ============================================================================ Kubanskaya GES-4
def _ges4():
    ges = bld_by_id("ee20efc9")
    g4 = mrr(ges["g"])
    g4.update(ring=ring_of(ges["g"]), hide=[ges["id"]], name="Кубанская ГЭС-4")
    return g4


ges4 = optional(_ges4, "GES-4")

# ============================================================================ Ice Palace "Olimpiysky" (2013)
def _arena():
    ice = bld_by_id("26334040")
    a = mrr(ice["g"])
    a.update(ring=ring_of(ice["g"]), hide=[ice["id"]], name="Ледовый дворец «Олимпийский»")
    return a


arena = optional(_arena, "ice arena")

out = dict(version=1, generated=time.strftime("%Y-%m-%d"), gres=gres, azot=azot, churches=churches, memorial=mem,
           station=station, stadium=stadium, turbines=turbines, masts=masts, signs=signs, fountains=fountains,
           weir=weir, ges4=ges4, arena=arena)
p = os.path.join(OUT_DIR, "landmarks.json")
with open(p, "w") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
log("wrote", p, os.path.getsize(p) // 1024, "KB")
