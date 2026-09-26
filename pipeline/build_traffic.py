"""Build the data for the `traffic` module (cars, buses, trains, pedestrians, parked cars).

Inputs : data/raw/transportation_segment.parquet, base_infrastructure.parquet, buildings_building.parquet,
         base_land_use.parquet, base_water.parquet, places_place.parquet
Outputs: public/data/traffic/
  meta.json        { version, graph: {<array directory>, classes, count}, density: {...}, parked: {...},
                     rail: {...}, stops: [[x, z], ...] (bus stops, Overture base_infrastructure) }
  graph.bin.gz     FALLBACK road network (used only when the roads module is not loaded; the runtime prefers
                   the roads service graph). Little-endian arrays, same layout as roads/graph.bin.gz:
                     nodes f32 (x,z) | ea,eb i32 | ecls u8 (index into meta.graph.classes) | ewidth u16 (dm)
                     elanes u8 | eflags u8 (1 oneway a->b, 2 oneway b->a, 4 link) | espeed u8 (km/h, 0 = none)
                     eoff u32 (point offsets, count+1) | epts f32 (x,z)
  rail.json.gz     { routes: [{name, kind, el, p:[x,z,...] (travel order), br:[[s0,s1],...] bridge ranges,
                               stops:[[s, name], ...]}],
                     sidings: [{p:[x,z,...], cars:[[s, type], ...]}] }   (s = metres along p)
                   route kinds: 'main' (Armavir <-> Mineralnye Vody, 25 kV), 'branch' (Cherkessk line)
                   siding car types: 0 tank, 1 hopper, 2 gondola, 3 box car, 4 flat/container
  parked.bin.gz    parked cars: count * [x f32, z f32, heading u8 (deg*256/360, cw from north), kind u8]
                   kind: 0 courtyard/service road, 1 street kerb (apartment district), 2 private sector verge,
                         3 parking lot, 4 industrial lot
  density.png      1024x1024 RGB, 20 m texels, row 0 = north edge (z = -10240):
                     R pedestrian activity (0..255), G apartment-block district, B private-house district

World frame: x = east, z = south (= -north), metres (see docs/ARCHITECTURE.md).
Run: python3 pipeline/build_traffic.py   (~1 min)
"""
import gzip
import json
import math
import os
import sys
import time
from collections import defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import LineString, Point, box
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import RAW, WEB_DATA, REGION_HALF, to_local  # noqa: E402

OUT = os.path.join(WEB_DATA, "traffic")
HALF = REGION_HALF
T0 = time.time()
RNG = np.random.default_rng(20260925)


def log(*a):
    print(f"[traffic {time.time() - T0:6.1f}s]", *a, flush=True)


_TR = None


def to_world(wkb):
    global _TR
    if _TR is None:
        _TR = to_local()
    g = shapely.from_wkb(wkb)

    def f(c):
        x, y = _TR.transform(c[:, 0], c[:, 1])
        return np.c_[x, -np.asarray(y)]

    return shapely.transform(g, f)


def cumlen(p):
    return np.r_[0.0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]


def substring(p, c, a, b):
    """Polyline piece between arc lengths a..b."""
    a, b = max(0.0, a), min(c[-1], b)
    if b - a < 1e-6:
        return None
    i0 = np.searchsorted(c, a, side="right")
    i1 = np.searchsorted(c, b, side="left")
    pa = np.array([np.interp(a, c, p[:, 0]), np.interp(a, c, p[:, 1])])
    pb = np.array([np.interp(b, c, p[:, 0]), np.interp(b, c, p[:, 1])])
    mid = p[i0:i1]
    return np.vstack([pa, mid, pb]) if len(mid) else np.vstack([pa, pb])


def interp(p, c, s):
    return np.array([np.interp(s, c, p[:, 0]), np.interp(s, c, p[:, 1])])


def ranges_with(rules, key):
    out = []
    for e in rules or []:
        if key in (e.get("values") or []):
            b = e.get("between") or [0.0, 1.0]
            out.append((float(b[0]), float(b[1])))
    return out


class Packer:
    def __init__(self):
        self.parts = []
        self.off = 0

    def add(self, arr):
        arr = np.ascontiguousarray(arr)
        dt = {np.dtype("<f4"): "f32", np.dtype("<i4"): "i32", np.dtype("<u4"): "u32", np.dtype("<u2"): "u16",
              np.dtype("<i2"): "i16", np.dtype("u1"): "u8", np.dtype("i1"): "i8"}[arr.dtype]
        pad = (-self.off) % 4
        if pad:
            self.parts.append(b"\0" * pad)
            self.off += pad
        rec = [dt, self.off, int(arr.size)]
        b = arr.tobytes()
        self.parts.append(b)
        self.off += len(b)
        return rec

    def write(self, path):
        data = b"".join(self.parts)
        with gzip.open(path, "wb", compresslevel=9) as f:
            f.write(data)
        return os.path.getsize(path)


WIDTH = {"motorway": 20, "trunk": 16, "primary": 14, "secondary": 12, "tertiary": 9, "residential": 7,
         "unclassified": 6, "living_street": 6, "service": 4.5, "track": 3.5, "pedestrian": 6,
         "footway": 2.2, "path": 2.2, "cycleway": 2.2, "steps": 2.2, "bridleway": 2.2, "unknown": 5}
CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street",
           "service", "track", "pedestrian", "footway", "path", "cycleway", "steps", "bridleway", "unknown"]
CLS_ID = {c: i for i, c in enumerate(CLASSES)}
DRIVE = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street",
         "service", "track", "unknown"}
FOOT = {"footway", "path", "cycleway", "steps", "pedestrian", "bridleway"}
REGION = box(-HALF + 1, -HALF + 1, HALF - 1, HALF - 1)


# ============================================================================ segments
def load_segments():
    tbl = pq.read_table(os.path.join(RAW, "transportation_segment.parquet")).to_pylist()
    segs = []
    for r in tbl:
        g = to_world(r["geometry"])
        if g.geom_type != "LineString":
            continue
        p = np.array(g.coords)
        c = cumlen(p)
        if c[-1] < 0.5:
            continue
        cls = r["class"] or "unknown"
        rf = r["road_flags"] or []
        railf = r["rail_flags"] or []
        width = None
        for w in r["width_rules"] or []:
            if w["value"] and w["between"] is None:
                width = float(w["value"])
        oneway = 0
        for a in r["access_restrictions"] or []:
            w = a["when"] or {}
            if a["access_type"] == "denied" and not (w.get("mode") or w.get("using") or w.get("vehicle")):
                if w.get("heading") == "backward":
                    oneway = 1
                elif w.get("heading") == "forward":
                    oneway = -1
        speed = 0
        for s in r["speed_limits"] or []:
            if s["max_speed"] and s["max_speed"].get("value"):
                speed = int(s["max_speed"]["value"])
        segs.append(dict(
            id=r["id"], kind=r["subtype"], cls=cls, sub=r["subclass"], p=p, c=c, L=c[-1],
            name=(r["names"] or {}).get("primary"), width=width, oneway=oneway, speed=speed,
            bridges=ranges_with(rf, "is_bridge") + ranges_with(railf, "is_bridge"),
            tunnels=ranges_with(rf, "is_tunnel"),
            disused=ranges_with(railf, "is_disused") + ranges_with(railf, "is_abandoned"),
            conns=sorted([(cc["connector_id"], float(cc["at"])) for cc in (r["connectors"] or [])], key=lambda t: t[1]),
            line=g))
    log(f"segments: {len(segs)}")
    return segs


def seg_width(s):
    w = WIDTH.get(s["cls"], 5.0)
    if s["sub"] == "link":
        w = 6.0
    if s["cls"] == "service" and s["sub"] in ("driveway", "parking_aisle"):
        w = 3.5
    if s["width"] and s["width"] >= 1.5 and (s["cls"] in FOOT or w * 0.5 <= s["width"] <= w * 2.5):
        w = s["width"]
    return w


def seg_lanes(s, w):
    cls = s["cls"]
    if cls in FOOT:
        return 0
    if s["sub"] == "link":
        return 1
    if s["oneway"]:
        return 2 if w >= 7 else 1
    if cls in ("trunk", "motorway", "primary") and w >= 13:
        return 4
    if cls == "secondary" and w >= 11.5:
        return 4
    if cls in ("service", "track") or w < 5.5:
        return 1
    return 2


# ============================================================================ fallback road graph
def build_graph(segs):
    node_id, nodes, edges = {}, [], []
    for s in segs:
        if s["kind"] != "road":
            continue
        conns = list(s["conns"])
        if not conns or conns[0][1] > 1e-6:
            conns.insert(0, (f"s{s['id']}_0", 0.0))
        if conns[-1][1] < 1 - 1e-6:
            conns.append((f"s{s['id']}_1", 1.0))
        w = seg_width(s)
        lanes = seg_lanes(s, w)
        for (c0, a0), (c1, a1) in zip(conns[:-1], conns[1:]):
            sa, sb = a0 * s["L"], a1 * s["L"]
            if sb - sa < 0.05:
                continue
            sub = substring(s["p"], s["c"], sa, sb)
            if sub is None:
                continue
            mid = interp(sub, cumlen(sub), cumlen(sub)[-1] / 2)
            if abs(mid[0]) > HALF - 20 or abs(mid[1]) > HALF - 20:
                continue
            if any(x0 * s["L"] <= (sa + sb) / 2 <= x1 * s["L"] for x0, x1 in s["tunnels"]):
                continue
            ids = []
            for cid, pt in ((c0, sub[0]), (c1, sub[-1])):
                if cid not in node_id:
                    node_id[cid] = len(nodes)
                    nodes.append(pt)
                ids.append(node_id[cid])
            edges.append(dict(a=ids[0], b=ids[1], cls=s["cls"], w=w, lanes=lanes, oneway=s["oneway"],
                              link=s["sub"] == "link", speed=min(255, s["speed"]), pts=sub))
    pk = Packer()
    off = [0]
    for e in edges:
        off.append(off[-1] + len(e["pts"]))
    P = np.concatenate([e["pts"] for e in edges]).astype("<f4")
    flags = np.array([(1 if e["oneway"] == 1 else 0) | (2 if e["oneway"] == -1 else 0) | (4 if e["link"] else 0)
                      for e in edges], "u1")
    meta = dict(
        nodes=pk.add(np.array(nodes, "<f4").ravel()),
        ea=pk.add(np.array([e["a"] for e in edges], "<i4")),
        eb=pk.add(np.array([e["b"] for e in edges], "<i4")),
        ecls=pk.add(np.array([CLS_ID.get(e["cls"], CLS_ID["unknown"]) for e in edges], "u1")),
        ewidth=pk.add(np.array([round(e["w"] * 10) for e in edges], "<u2")),
        elanes=pk.add(np.array([e["lanes"] for e in edges], "u1")),
        eflags=pk.add(flags),
        espeed=pk.add(np.array([e["speed"] for e in edges], "u1")),
        eoff=pk.add(np.array(off, "<u4")),
        epts=pk.add(P.ravel()),
        classes=CLASSES,
        count=[len(nodes), len(edges)],
    )
    size = pk.write(os.path.join(OUT, "graph.bin.gz"))
    log(f"fallback graph: {len(nodes)} nodes, {len(edges)} edges, {size / 1024:.0f} KB")
    return meta, np.array(nodes), edges


# ============================================================================ zones / density raster
def build_density(segs):
    from rasterio import features
    from rasterio.transform import Affine
    from scipy.ndimage import gaussian_filter
    res = 20.0
    n = int(2 * HALF / res)
    tf = Affine(res, 0, -HALF, 0, res, -HALF)  # row index grows with z (south)
    tb = pq.read_table(os.path.join(RAW, "buildings_building.parquet"), columns=["geometry", "class", "subtype"]).to_pylist()
    geoms, areas, cls = [], [], []
    for r in tb:
        g = to_world(r["geometry"])
        if g is None or g.is_empty:
            continue
        geoms.append(g)
        areas.append(g.area)
        cls.append(r["class"] or r["subtype"] or "")
    areas = np.array(areas)
    lu = pq.read_table(os.path.join(RAW, "base_land_use.parquet"), columns=["class", "geometry"]).to_pylist()
    ind = [to_world(r["geometry"]) for r in lu if r["class"] in ("industrial", "works", "garages", "landfill", "quarry", "military")]
    indm = features.rasterize(((g, 1) for g in ind), out_shape=(n, n), transform=tf, dtype=np.uint8) if ind else np.zeros((n, n), np.uint8)
    # building area per texel (fraction), split into apartment-scale and house-scale buildings
    big = [(g, 1) for g, a, c in zip(geoms, areas, cls) if a >= 320 and c not in ("industrial", "warehouse", "garages", "greenhouse", "farm")]
    small = [(g, 1) for g, a in zip(geoms, areas) if 30 <= a < 320]
    bigm = features.rasterize(big, out_shape=(n, n), transform=tf, dtype=np.uint8, all_touched=False).astype(np.float32)
    smallm = features.rasterize(small, out_shape=(n, n), transform=tf, dtype=np.uint8, all_touched=True).astype(np.float32)
    dbig = gaussian_filter(bigm, 3.0)
    dsmall = gaussian_filter(smallm, 2.5)
    apart = np.clip((dbig - 0.04) / 0.10, 0, 1) * (1 - 0.8 * (indm > 0))
    private = np.clip((dsmall - 0.08) / 0.20, 0, 1) * (1 - apart)
    # pedestrian activity: apartment districts, shops / POIs, bus stops, the centre
    poi = np.zeros((n, n), np.float32)
    pl = pq.read_table(os.path.join(RAW, "places_place.parquet"), columns=["geometry"]).to_pylist()
    inf = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet"), columns=["geometry", "class"]).to_pylist()
    pts = [to_world(r["geometry"]) for r in pl]
    pts += [to_world(r["geometry"]) for r in inf if r["class"] in ("bus_stop", "railway_station", "bus_station", "platform")] * 2

    def rc(x, z):
        return int(np.clip((z + HALF) / res, 0, n - 1)), int(np.clip((x + HALF) / res, 0, n - 1))

    for g in pts:
        c = g.centroid
        j, i = rc(c.x, c.y)
        poi[j, i] += 1.0
    poi = gaussian_filter(poi, 4.0) * 60
    yy, xx = np.mgrid[0:n, 0:n]
    wx = -HALF + (xx + 0.5) * res
    wz = -HALF + (yy + 0.5) * res
    centre = np.exp(-((wx - 150) ** 2 + (wz - 250) ** 2) / (2 * 900.0 ** 2))
    ped = np.clip(0.55 * apart + 0.12 * private + np.clip(poi, 0, 1) * 0.6 + 0.45 * centre * (apart + private + 0.3), 0, 1)
    ped *= (1 - 0.85 * (indm > 0))
    img = np.dstack([ped, apart, private])
    img = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
    from PIL import Image
    Image.fromarray(img, "RGB").save(os.path.join(OUT, "density.png"), optimize=True)
    log(f"density raster {n}x{n}: apartment {float((apart > 0.5).sum()) * res * res / 1e6:.1f} km2, "
        f"private {float((private > 0.5).sum()) * res * res / 1e6:.1f} km2")

    def sample(ch, x, z):
        j = np.clip(((np.asarray(z) + HALF) / res).astype(int), 0, n - 1)
        i = np.clip(((np.asarray(x) + HALF) / res).astype(int), 0, n - 1)
        return img[j, i, ch] / 255.0

    return dict(size=n, res=res, file="traffic/density.png"), sample, geoms, indm, tf


# ============================================================================ parked cars
def build_parked(segs, gnodes, gedges, zone, geoms, indm, tf):
    bld_tree = STRtree(geoms)
    drive = [e for e in gedges if e["cls"] in DRIVE]
    lines = [LineString(e["pts"]) for e in drive]
    ltree = STRtree(lines)
    hw = np.array([e["w"] / 2 for e in drive])
    # water + rail exclusion
    wt = pq.read_table(os.path.join(RAW, "base_water.parquet"), columns=["geometry", "class"]).to_pylist()
    water = [to_world(r["geometry"]) for r in wt]
    water = [g.buffer(3) if g.geom_type in ("LineString", "MultiLineString") else g for g in water]
    wtree = STRtree(water)
    rails = [s["line"] for s in segs if s["kind"] == "rail"]
    rtree = STRtree(rails)
    deg = defaultdict(int)
    for e in drive:
        deg[e["a"]] += 1
        deg[e["b"]] += 1
    jn = np.array([gnodes[k] for k, d in deg.items() if d >= 3]) if deg else np.zeros((0, 2))
    jtree = STRtree(shapely.points(jn)) if len(jn) else None

    cars = []  # (x, z, heading_deg, kind, length, width)

    def heading(tx, tz):
        return math.degrees(math.atan2(tx, -tz)) % 360

    def free(x, z, hd, L, W, host=None, margin=0.6):
        """Car rectangle does not hit buildings, other carriageways, water, rails or junctions."""
        if abs(x) > HALF - 30 or abs(z) > HALF - 30:
            return False
        a = math.radians(hd)
        fx, fz = math.sin(a), -math.cos(a)
        rx, rz = -fz, fx
        corners = [(x + fx * L / 2 * sx + rx * W / 2 * sy, z + fz * L / 2 * sx + rz * W / 2 * sy) for sx, sy in ((1, 1), (1, -1), (-1, -1), (-1, 1))]
        poly = shapely.Polygon(corners)
        pb = poly.buffer(margin)
        for k in bld_tree.query(pb, predicate="intersects"):
            return False
        for k in wtree.query(poly, predicate="intersects"):
            return False
        for k in rtree.query(poly.buffer(3.0), predicate="intersects"):
            return False
        for k in ltree.query(poly.buffer(8.0)):
            if host is not None and k == host:
                continue
            if lines[k].distance(poly) < hw[k] + 0.4:
                return False
        if jtree is not None:
            for k in jtree.query(Point(x, z).buffer(11.0)):
                return False
        # industrial land: only on explicit lots
        return True

    placed = STRtree([])  # rebuilt lazily is too slow; use a coarse hash instead
    grid = defaultdict(list)

    def overlaps(x, z, r=2.7):
        i, j = int(x // 8), int(z // 8)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for (px, pz) in grid[(i + di, j + dj)]:
                    if (px - x) ** 2 + (pz - z) ** 2 < r * r:
                        return True
        return False

    def add(x, z, hd, kind):
        cars.append((x, z, hd, kind))
        grid[(int(x // 8), int(z // 8))].append((x, z))

    # ---- 1. parking lots (Overture transit/parking polygons)
    inf = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet"), columns=["geometry", "class"]).to_pylist()
    lots = [to_world(r["geometry"]) for r in inf if r["class"] in ("parking", "parking_space")]
    lots = [g for g in lots if g.geom_type in ("Polygon", "MultiPolygon") and g.area >= 60]
    nlot = 0
    for g in lots:
        g = g.buffer(-0.4)
        if g.is_empty:
            continue
        rect = g.minimum_rotated_rectangle
        rc = np.array(rect.exterior.coords)[:4]
        e0, e1 = rc[1] - rc[0], rc[2] - rc[1]
        ax = e0 if np.hypot(*e0) >= np.hypot(*e1) else e1  # long axis: rows run along it
        ax = ax / (np.hypot(*ax) + 1e-9)
        nx, nz = -ax[1], ax[0]
        cx, cz = g.centroid.x, g.centroid.y
        ext_a = max(abs((rc[:, 0] - cx) * ax[0] + (rc[:, 1] - cz) * ax[1]))
        ext_n = max(abs((rc[:, 0] - cx) * nx + (rc[:, 1] - cz) * nz))
        industrial = False
        try:
            j = int((cz + HALF) / 20)
            i = int((cx + HALF) / 20)
            industrial = indm[min(max(j, 0), indm.shape[0] - 1), min(max(i, 0), indm.shape[1] - 1)] > 0
        except Exception:
            pass
        occ = 0.55 if industrial else 0.72
        # row pattern across the lot: [stall 5.2][stall 5.2][aisle 6]...
        pattern = []
        u = -ext_n + 2.6
        k = 0
        while u < ext_n - 2.5:
            pattern.append((u, k % 2))
            u += 5.2 if k % 2 == 0 else 11.2
            k += 1
        if ext_n < 5.5:  # narrow strip: single row
            pattern = [(0.0, 0)]
        for (u, side) in pattern:
            t = -ext_a + 1.3
            while t < ext_a - 1.2:
                x = cx + ax[0] * t + nx * u
                z = cz + ax[1] * t + nz * u
                t += 2.6
                if RNG.random() > occ:
                    continue
                if not g.contains(Point(x, z)):
                    continue
                hd = heading(nx if side == 0 else -nx, nz if side == 0 else -nz)
                hd += RNG.normal(0, 3)
                if overlaps(x, z, 2.3):
                    continue
                if not free(x, z, hd, 4.4, 1.8, margin=0.3):
                    continue
                add(x, z, hd, 4 if industrial else 3)
                nlot += 1
    log(f"parked: {nlot} cars on {len(lots)} parking lots")

    # ---- 2. along streets / courtyard roads by district
    nstreet = 0
    for k, e in enumerate(drive):
        p = e["pts"]
        c = cumlen(p)
        L = c[-1]
        if L < 12 or e["cls"] in ("track", "motorway", "trunk"):
            continue
        mid = interp(p, c, L / 2)
        ap = zone(1, mid[0], mid[1])
        pr = zone(2, mid[0], mid[1])
        cls = e["cls"]
        if ap > 0.35:
            if cls == "service":
                perp = e["w"] <= 4.6 and RNG.random() < 0.45
                occ, kind = (0.5 if perp else 0.45), 0
            elif cls in ("residential", "living_street", "unclassified"):
                occ, kind, perp = 0.42, 1, False
            elif cls in ("tertiary", "secondary"):
                occ, kind, perp = 0.16, 1, False
            else:
                continue
        elif pr > 0.3:
            if cls in ("residential", "unclassified", "living_street"):
                occ, kind, perp = 0.07, 2, False
            elif cls == "service":
                occ, kind, perp = 0.05, 2, False
            else:
                continue
        else:
            continue
        spacing = 2.7 if perp else 6.0
        for side in (1, -1):
            s = 8.0 + RNG.random() * spacing
            while s < L - 8.0:
                q = interp(p, c, s)
                q2 = interp(p, c, min(L, s + 1.5))
                q1 = interp(p, c, max(0, s - 1.5))
                t = q2 - q1
                tl = np.hypot(*t)
                s += spacing * (1.0 + (0.0 if perp else RNG.random() * 0.35))
                if tl < 1e-6 or RNG.random() > occ:
                    continue
                tx, tz = t / tl
                rx, rz = -tz, tx
                if perp:
                    off = e["w"] / 2 + 2.9
                    x, z = q[0] + rx * off * side, q[1] + rz * off * side
                    fx, fz = (-rx * side, -rz * side) if RNG.random() < 0.8 else (rx * side, rz * side)
                    hd = heading(fx, fz) + RNG.normal(0, 4)
                else:
                    off = e["w"] / 2 + (1.05 if kind != 2 else 1.6 + RNG.random() * 0.8)
                    x, z = q[0] + rx * off * side, q[1] + rz * off * side
                    fwd = side > 0 or RNG.random() < 0.3
                    hd = heading(tx if fwd else -tx, tz if fwd else -tz) + RNG.normal(0, 2)
                if overlaps(x, z, 2.35 if perp else 3.0):
                    continue
                if not free(x, z, hd, 4.5, 1.85, host=k):
                    continue
                add(x, z, hd, kind)
                nstreet += 1
    log(f"parked: {nstreet} cars along streets / courtyards")
    arr = np.zeros(len(cars), dtype=[("x", "<f4"), ("z", "<f4"), ("h", "u1"), ("k", "u1")])
    for i, (x, z, hd, kind) in enumerate(cars):
        arr[i] = (x, z, int(round((hd % 360) * 256 / 360)) % 256, kind)
    # sort into a coarse spatial order (helps runtime chunking)
    order = np.lexsort((arr["x"] // 256, arr["z"] // 256))
    arr = arr[order]
    raw = arr.tobytes()
    with gzip.open(os.path.join(OUT, "parked.bin.gz"), "wb", compresslevel=9) as f:
        f.write(raw)
    log(f"parked cars total {len(arr)} ({os.path.getsize(os.path.join(OUT, 'parked.bin.gz')) / 1024:.0f} KB)")
    return dict(count=int(len(arr)), stride=10, file="traffic/parked.bin.gz")


# ============================================================================ railway routes
def build_rail(segs):
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    rails = [s for s in segs if s["kind"] == "rail"]
    nid, npos = {}, []
    E = []  # (u, v, pts, bridge ranges (arc along pts), disused)
    for s in rails:
        conns = list(s["conns"])
        if not conns or conns[0][1] > 1e-6:
            conns.insert(0, (f"r{s['id']}_0", 0.0))
        if conns[-1][1] < 1 - 1e-6:
            conns.append((f"r{s['id']}_1", 1.0))
        for (c0, a0), (c1, a1) in zip(conns[:-1], conns[1:]):
            sa, sb = a0 * s["L"], a1 * s["L"]
            if sb - sa < 0.01:
                continue
            sub = substring(s["p"], s["c"], sa, sb)
            if sub is None:
                continue
            ids = []
            for cid, pt in ((c0, sub[0]), (c1, sub[-1])):
                if cid not in nid:
                    nid[cid] = len(npos)
                    npos.append(pt)
                ids.append(nid[cid])
            br = []
            for x0, x1 in s["bridges"]:
                b0, b1 = max(sa, x0 * s["L"]), min(sb, x1 * s["L"])
                if b1 > b0:
                    br.append((b0 - sa, b1 - sa))
            dis = any(x0 * s["L"] <= (sa + sb) / 2 <= x1 * s["L"] for x0, x1 in s["disused"]) or s["cls"] == "unknown"
            E.append(dict(u=ids[0], v=ids[1], p=sub, L=cumlen(sub)[-1], br=br, dis=dis))
    npos = np.array(npos)
    N = len(npos)
    log(f"rail graph: {N} nodes, {len(E)} edges")

    def solve(src, dst, penalty=None):
        w = np.array([e["L"] * (6.0 if e["dis"] else 1.0) for e in E])
        if penalty is not None:
            w = w * penalty
        rows = [e["u"] for e in E] + [e["v"] for e in E]
        cols = [e["v"] for e in E] + [e["u"] for e in E]
        # keep the cheapest edge between node pairs (csr sums duplicates otherwise)
        best = {}
        for k, (r, c) in enumerate(zip(rows, cols)):
            ww = w[k % len(E)]
            if (r, c) not in best or ww < best[(r, c)][0]:
                best[(r, c)] = (ww, k % len(E))
        rr = np.array([k[0] for k in best])
        cc = np.array([k[1] for k in best])
        vv = np.array([v[0] for v in best.values()]) + 1e-3
        M = csr_matrix((vv, (rr, cc)), shape=(N, N))
        d, pred = dijkstra(M, indices=src, return_predecessors=True)
        if not np.isfinite(d[dst]):
            return None
        path = [dst]
        while path[-1] != src:
            path.append(pred[path[-1]])
        path = path[::-1]
        out = []
        for a, b in zip(path[:-1], path[1:]):
            out.append(best[(a, b)][1])
        return path, out

    def assemble(path, eids):
        pts, br = [], []
        acc = 0.0
        for (a, b), k in zip(zip(path[:-1], path[1:]), eids):
            e = E[k]
            p = e["p"] if e["u"] == a else e["p"][::-1]
            L = e["L"]
            for b0, b1 in e["br"]:
                if e["u"] == a:
                    br.append((acc + b0, acc + b1))
                else:
                    br.append((acc + L - b1, acc + L - b0))
            if pts:
                p = p[1:]
            pts.extend(p.tolist())
            acc += L
        return np.array(pts), br

    def clip(p, br):
        """Keep the longest run of points inside the region (plus the crossing point)."""
        c = cumlen(p)
        inside = (np.abs(p[:, 0]) < HALF - 40) & (np.abs(p[:, 1]) < HALF - 40)
        best, cur = None, None
        for i, f in enumerate(inside):
            if f:
                cur = [i, i] if cur is None else [cur[0], i]
                if best is None or cur[1] - cur[0] > best[1] - best[0]:
                    best = list(cur)
            else:
                cur = None
        if best is None:
            return None, None
        i0, i1 = max(0, best[0] - 1), min(len(p) - 1, best[1] + 1)
        s0 = c[i0]
        q = p[i0:i1 + 1]
        q = np.clip(q, -HALF + 5, HALF - 5)
        br2 = [(max(0.0, a - s0), b - s0) for a, b in br if b > s0 and a < c[i1]]
        return q, br2

    # endpoints: degree-1 nodes far outside / at the region edge
    deg = np.zeros(N, int)
    for e in E:
        deg[e["u"]] += 1
        deg[e["v"]] += 1
    ends = [i for i in range(N) if deg[i] == 1]
    far = lambda i: max(abs(npos[i][0]), abs(npos[i][1]))  # noqa: E731
    nw = min((i for i in ends if npos[i][0] < -HALF and npos[i][1] < -HALF), key=lambda i: npos[i][0] + npos[i][1], default=None)
    se = max((i for i in ends if npos[i][0] > HALF), key=lambda i: npos[i][0], default=None)
    south = max((i for i in ends if npos[i][1] > HALF and abs(npos[i][0]) < HALF), key=lambda i: npos[i][1], default=None)
    log("rail ends:", {k: (npos[v].round().tolist() if v is not None else None) for k, v in (("nw", nw), ("se", se), ("south", south))})
    # station platforms / halts (for stops)
    inf = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet"), columns=["geometry", "class", "names"]).to_pylist()
    stations = []
    platforms = []
    for r in inf:
        if r["class"] in ("railway_station", "railway_halt"):
            g = to_world(r["geometry"])
            stations.append((g.centroid.x, g.centroid.y, (r["names"] or {}).get("primary") or ""))
        if r["class"] == "platform":
            platforms.append(to_world(r["geometry"]))
    ptree = STRtree(platforms) if platforms else None

    routes = []

    def add_route(name, kind, el, a, b, alt_of=None):
        pen = None
        if alt_of is not None:
            pen = np.ones(len(E))
            for k in alt_of:
                pen[k] = 3.0
        r = solve(a, b, pen)
        if r is None:
            log("no rail path for", name)
            return None
        path, eids = r
        p, br = assemble(path, eids)
        p, br = clip(p, br)
        if p is None or len(p) < 2:
            return None
        c = cumlen(p)
        line = LineString(p)
        stops = []
        for (x, z, nm) in stations:
            d = line.distance(Point(x, z))
            if d > 120:
                continue
            s = line.project(Point(x, z))
            # prefer the platform edge nearest to the station point
            if ptree is not None:
                best = None
                for k in ptree.query(Point(x, z).buffer(400)):
                    pl = platforms[k]
                    if pl.distance(line) < 6:
                        sc = line.project(pl.centroid)
                        dd = abs(sc - s)
                        if best is None or dd < best[0]:
                            best = (dd, sc)
                if best is not None:
                    s = best[1]
            stops.append([round(float(s), 1), nm])
        stops.sort()
        routes.append(dict(name=name, kind=kind, el=el, p=[round(float(v), 2) for v in p.ravel()],
                           br=[[round(a, 1), round(b, 1)] for a, b in br], stops=stops, L=round(float(c[-1]), 1)))
        log(f"route {name}: {c[-1] / 1000:.2f} km, {len(br)} bridges, stops {stops}")
        return eids

    used = set()
    if nw is not None and se is not None:
        e1 = add_route("Armavir -> Mineralnye Vody", "main", 1, nw, se)
        e2 = add_route("Mineralnye Vody -> Armavir", "main", 1, se, nw, alt_of=e1)
        used |= set(e1 or []) | set(e2 or [])
    if south is not None and nw is not None:
        e3 = add_route("Cherkessk -> Armavir", "branch", 0, south, nw)
        used |= set(e3 or [])
    if south is not None and se is not None:
        e4 = add_route("Mineralnye Vody -> Cherkessk", "branch", 0, se, south)
        used |= set(e4 or [])
    # right-hand running: make sure each main route uses the right-hand track of the pair
    mains = [r for r in routes if r["kind"] == "main"]
    if len(mains) == 2:
        p0 = np.array(mains[0]["p"]).reshape(-1, 2)
        l1 = LineString(np.array(mains[1]["p"]).reshape(-1, 2))
        # sample the lateral side of route 1 relative to route 0's direction
        c0 = cumlen(p0)
        side = 0.0
        for s in np.linspace(c0[-1] * 0.1, c0[-1] * 0.9, 40):
            q = interp(p0, c0, s)
            t = interp(p0, c0, min(c0[-1], s + 5)) - interp(p0, c0, max(0, s - 5))
            t /= np.hypot(*t) + 1e-9
            rx, rz = -t[1], t[0]
            n = l1.interpolate(l1.project(Point(*q)))
            d = np.array([n.x, n.y]) - q
            if 2.0 < np.hypot(*d) < 12.0:
                side += np.sign(d[0] * rx + d[1] * rz)
        log(f"main line track side check: {side:+.0f} (positive = reverse route runs on the right of forward)")
        if side > 0:
            # forward route should be on its right: swap the geometries (reverse each)
            a, b = mains
            pa = np.array(a["p"]).reshape(-1, 2)[::-1]
            pb = np.array(b["p"]).reshape(-1, 2)[::-1]
            La, Lb = a["L"], b["L"]
            a["p"], b["p"] = [round(float(v), 2) for v in pb.ravel()], [round(float(v), 2) for v in pa.ravel()]
            a["br"], b["br"] = [[round(Lb - y, 1), round(Lb - x, 1)] for x, y in b["br"]][::-1], [[round(La - y, 1), round(La - x, 1)] for x, y in a["br"]][::-1]
            a["stops"], b["stops"] = [[round(Lb - s, 1), n] for s, n in b["stops"]][::-1], [[round(La - s, 1), n] for s, n in a["stops"]][::-1]
            a["L"], b["L"] = Lb, La
            log("swapped main-line tracks for right-hand running")

    # ---- sidings with parked wagons (station yard + Azot industrial network)
    sidings = []
    ncar = 0
    CAR_LEN = [12.0, 14.7, 13.9, 15.7, 13.6]  # tank, hopper, gondola, box, flat (over couplers)
    for k, e in enumerate(E):
        if k in used or e["dis"] or e["L"] < 70 or e["br"]:
            continue
        p = e["p"]
        mid = interp(p, cumlen(p), e["L"] / 2)
        if abs(mid[0]) > HALF - 100 or abs(mid[1]) > HALF - 100:
            continue
        azot = -300 < mid[0] < 2600 and -4200 < mid[1] < -1000
        yard = 800 < mid[0] < 3400 and 700 < mid[1] < 1400
        other = not azot and not yard
        if RNG.random() > (0.75 if azot else 0.6 if yard else 0.25):
            continue
        if other and e["L"] > 900:
            continue
        # a string of cars of one or two types
        if azot:
            types = [0, 0, 0, 1, 1, 4]
        elif yard:
            types = [0, 1, 2, 2, 3, 4]
        else:
            types = [1, 2, 3]
        t0 = types[RNG.integers(len(types))]
        t1 = types[RNG.integers(len(types))] if RNG.random() < 0.3 else t0
        L = e["L"]
        s = 10 + RNG.random() * 30
        end = L - 10 - RNG.random() * 40
        cars = []
        nmax = RNG.integers(4, 40)
        while s + CAR_LEN[t0] < end and len(cars) < nmax:
            tt = t0 if (len(cars) // 6) % 2 == 0 else t1
            cars.append([round(s + CAR_LEN[tt] / 2, 2), int(tt)])
            s += CAR_LEN[tt]
        if len(cars) >= 2:
            sidings.append(dict(p=[round(float(v), 2) for v in p.ravel()], cars=cars))
            ncar += len(cars)
    log(f"sidings: {len(sidings)} wagon strings, {ncar} wagons")
    data = dict(routes=routes, sidings=sidings)
    with gzip.open(os.path.join(OUT, "rail.json.gz"), "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    log(f"rail.json.gz {os.path.getsize(os.path.join(OUT, 'rail.json.gz')) / 1024:.0f} KB")
    return dict(file="traffic/rail.json.gz", routes=len(routes), sidings=len(sidings))


def main():
    os.makedirs(OUT, exist_ok=True)
    segs = load_segments()
    gmeta, gnodes, gedges = build_graph([s for s in segs if s["line"].intersects(REGION)])
    dmeta, zone, geoms, indm, tf = build_density(segs)
    rmeta = build_rail(segs)
    pmeta = build_parked(segs, gnodes, gedges, zone, geoms, indm, tf)
    inf = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet"), columns=["geometry", "class"]).to_pylist()
    stops = []
    for r in inf:
        if r["class"] == "bus_stop":
            c = to_world(r["geometry"]).centroid
            if abs(c.x) < HALF and abs(c.y) < HALF:
                stops.append([round(c.x, 1), round(c.y, 1)])
    log(f"bus stops: {len(stops)}")
    meta = dict(version=1, graph=gmeta, density=dmeta, parked=pmeta, rail=rmeta, stops=stops)
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    tot = sum(os.path.getsize(os.path.join(OUT, x)) for x in os.listdir(OUT))
    log(f"done: public/data/traffic = {tot / 1024:.0f} KB")


if __name__ == "__main__":
    main()
