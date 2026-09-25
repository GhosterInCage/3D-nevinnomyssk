"""Build the roads / rails / bridges / street furniture / power grid data for the web app.

Inputs : data/raw/transportation_segment.parquet, base_infrastructure.parquet, base_water.parquet,
         base_land_use.parquet, buildings_building.parquet, public/data/terrain/height.bin.gz
Outputs: public/data/roads/
  meta.json         index: tiles, binary array directory (name -> [dtype, byteOffset, count]),
                    surface table, polyline kinds, marking styles, street names
  ground.bin.gz     packed arrays (see meta.arrays):
     gpos  u16 (x,z) per vertex, tile-relative, 1/32 m      (all tiles concatenated)
     glat  i16 signed distance from the nearest centre line (cm)
     gatt  u8  [surf, lanes, halfWidth dm, wear 0..255] per vertex
     gdir  i8  [cos 2θ, sin 2θ]*127 of the nearest line direction (undirected)
     gidx  u32 triangle indices, tile-local (per-tile ranges in meta.tiles)
     lpos  u16 polyline pool (x,z), tile-relative 1/32 m
     lrec  i32 polyline records [tile, kind, style, widthCm, group, start, count] (7 ints each)
     bpos/bidx/batt/blat/bdir  bridge-deck ground meshes (world x,z as f32), per group ranges
  graph.bin.gz      road network for traffic: nodes f32 (x,z), edge arrays (see meta.graph)
  objects.json.gz   point features: street lights, pole chains, signals, bus stops, signs,
                    benches, rail masts, level crossings, bridges (groups/profile/piers), power grid

World frame: x = east, z = south (= -north), metres (see docs/ARCHITECTURE.md).
Heights are NOT baked (except bridge clearance analysis); the runtime drapes everything on
ctx.heightfield so all layers sit exactly on the final terrain.
"""
import gzip
import json
import math
import os
import sys
import time
from collections import defaultdict, Counter

import numpy as np
import pyarrow.parquet as pq
import shapely
import shapely.geometry.polygon
from shapely.geometry import LineString, Point, Polygon, MultiPolygon, box
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import RAW, WEB_DATA, to_local  # noqa: E402
from roads_mesh import (HALF, TILE, NT, QS, cumlen, interp, tangent, substring, resample, offset_polyline,  # noqa: E402
                        lines_of, polys_of, merge_lines, tile_of, tile_box, triangulate_grid, Packer,
                        write_json_gz, r1, to_world)

OUT = os.path.join(WEB_DATA, "roads")
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


REGION = box(-HALF + 1, -HALF + 1, HALF - 1, HALF - 1)


# ------------------------------------------------------------------ constants
WIDTH = {"motorway": 20, "trunk": 16, "primary": 14, "secondary": 12, "tertiary": 9, "residential": 7,
         "unclassified": 6, "living_street": 6, "service": 4.5, "track": 3.5, "pedestrian": 6,
         "footway": 2.2, "path": 2.2, "cycleway": 2.2, "steps": 2.2, "bridleway": 2.2, "unknown": 5}
LINK_WIDTH = 6.0
DRIVABLE = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified",
            "living_street", "service", "track", "unknown"}
MAJOR = {"motorway", "trunk", "primary", "secondary", "tertiary"}
FOOT = {"footway", "path", "cycleway", "steps", "pedestrian", "bridleway"}
CLS_ID = {c: i for i, c in enumerate(["motorway", "trunk", "primary", "secondary", "tertiary", "residential",
                                       "unclassified", "living_street", "service", "track", "pedestrian",
                                       "footway", "path", "cycleway", "steps", "bridleway", "unknown"])}

# ground surfaces (id -> runtime material params live in the TS side; keep in sync)
S_ASPH, S_ASPH_OLD, S_CONCRETE, S_GRAVEL, S_DIRT, S_PAVING, S_SIDEWALK, S_BALLAST, S_PLATFORM, S_PARKING, S_PAVING_ROAD = range(11)
SURF_NAMES = ["asphalt", "asphalt_old", "concrete", "gravel", "dirt", "paving", "sidewalk", "ballast", "platform", "parking", "paving_road"]
RAISED = {S_PAVING: 0.18, S_SIDEWALK: 0.18, S_BALLAST: 0.35, S_PLATFORM: 0.9}

# polyline kinds in lrec
K_SKIRT, K_CURB, K_MARK, K_TRACK, K_FENCE, K_WALL, K_PARAPET, K_GUARD = range(8)
KIND_NAMES = ["skirt", "curb", "marking", "track", "fence", "wall", "parapet", "guardrail"]
# marking styles
M_SOLID, M_DASH_URBAN, M_DASH_RURAL, M_EDGE, M_ZEBRA, M_STOP, M_ZEBRA_Y, M_DASH_SHORT = range(8)
MARK_STYLES = [
    {"name": "solid", "dash": 0, "gap": 0, "color": "white"},
    {"name": "dash_urban", "dash": 3, "gap": 6, "color": "white"},
    {"name": "dash_rural", "dash": 3, "gap": 9, "color": "white"},
    {"name": "edge", "dash": 0, "gap": 0, "color": "white"},
    {"name": "zebra", "dash": 0, "gap": 0, "color": "white"},
    {"name": "stop", "dash": 0, "gap": 0, "color": "white"},
    {"name": "zebra_yellow", "dash": 0, "gap": 0, "color": "yellow"},
    {"name": "dash_short", "dash": 1, "gap": 1, "color": "white"},
]
Z_RURAL, Z_PRIVATE, Z_APART, Z_INDUSTRIAL = range(4)
CENTER = np.array([150.0, 150.0])


def h32(s):
    """Deterministic small hash of a string -> [0,1)."""
    v = 2166136261
    for ch in str(s):
        v = ((v ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return (v % 100000) / 100000.0


# ------------------------------------------------------------------ height field (current terrain)
def load_height():
    man = json.load(open(os.path.join(WEB_DATA, "manifest.json")))
    t = man["terrain"]
    raw = gzip.open(os.path.join(WEB_DATA, t["height"])).read()
    n = t["n"]
    H = np.frombuffer(raw, dtype="<u2").reshape(n, n).astype(np.float32) * t["hScale"] + t["hMin"]
    res = t["size"] / (n - 1)
    half = t["size"] / 2

    def sample(x, z):
        x = np.asarray(x, dtype=np.float64)
        z = np.asarray(z, dtype=np.float64)
        gx = np.clip((x + half) / res, 0, n - 1.000001)
        gz = np.clip((z + half) / res, 0, n - 1.000001)
        i = np.floor(gx).astype(int)
        j = np.floor(gz).astype(int)
        fx = gx - i
        fz = gz - j
        a = H[j, i]
        b = H[j, i + 1]
        c = H[j + 1, i]
        d = H[j + 1, i + 1]
        return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz

    return sample


HEIGHT = load_height()


# ------------------------------------------------------------------ zones (building density rasters)
def build_zones():
    from rasterio import features
    from rasterio.transform import Affine
    from scipy.ndimage import gaussian_filter
    res = 5.0
    n = int(2 * HALF / res)
    tf = Affine(res, 0, -HALF, 0, res, -HALF)  # world z grows downward = row index
    tb = pq.read_table(os.path.join(RAW, "buildings_building.parquet"), columns=["geometry"])
    geoms = [to_world(g) for g in tb.column("geometry").to_pylist()]
    geoms = [g for g in geoms if g is not None and not g.is_empty]
    areas = np.array([g.area for g in geoms])
    allm = features.rasterize(((g, 1) for g in geoms), out_shape=(n, n), transform=tf, dtype=np.uint8)
    bigm = features.rasterize(((g, 1) for g, a in zip(geoms, areas) if a >= 320), out_shape=(n, n), transform=tf, dtype=np.uint8)
    lu = pq.read_table(os.path.join(RAW, "base_land_use.parquet"), columns=["class", "geometry"]).to_pylist()
    ind = [to_world(r["geometry"]) for r in lu if r["class"] in ("industrial", "works", "garages", "landfill", "quarry", "military")]
    indm = features.rasterize(((g, 1) for g in ind), out_shape=(n, n), transform=tf, dtype=np.uint8) if ind else np.zeros((n, n), np.uint8)
    dall = gaussian_filter(allm.astype(np.float32), 8)
    dbig = gaussian_filter(bigm.astype(np.float32), 8)
    zone = np.full((n, n), Z_RURAL, np.uint8)
    zone[dall > 0.035] = Z_PRIVATE
    zone[dbig > 0.07] = Z_APART
    zone[(indm > 0) & (dbig > 0.02)] = Z_INDUSTRIAL
    zone[(indm > 0) & (dall < 0.02)] = Z_INDUSTRIAL
    log("zones:", {k: int((zone == k).sum() * 25e-6 * 100) / 100 for k in range(4)}, "km2")

    def at(x, z):
        i = np.clip(((np.asarray(x) + HALF) / res).astype(int), 0, n - 1)
        j = np.clip(((np.asarray(z) + HALF) / res).astype(int), 0, n - 1)
        return zone[j, i]

    bld_tree = STRtree(geoms)
    return at, geoms, bld_tree


# ------------------------------------------------------------------ segments
def ranges_with(rules, key):
    out = []
    for e in rules or []:
        vals = e.get("values") or []
        if key in vals:
            b = e.get("between") or [0.0, 1.0]
            out.append((float(b[0]), float(b[1])))
    return out


def load_segments():
    tbl = pq.read_table(os.path.join(RAW, "transportation_segment.parquet")).to_pylist()
    segs = []
    for r in tbl:
        g = to_world(r["geometry"])
        if g.geom_type != "LineString" or not g.intersects(REGION):
            continue
        p = np.array(g.coords)
        c = cumlen(p)
        if c[-1] < 0.5:
            continue
        kind = r["subtype"]
        cls = r["class"] or "unknown"
        sub = r["subclass"]
        rf = r["road_flags"] or []
        railf = r["rail_flags"] or []
        bridges = ranges_with(rf, "is_bridge") + ranges_with(railf, "is_bridge")
        tunnels = ranges_with(rf, "is_tunnel")
        for lv in r["level_rules"] or []:
            if lv["value"] is not None and lv["value"] < 0:
                b = lv["between"] or [0.0, 1.0]
                tunnels.append((float(b[0]), float(b[1])))
        disused = ranges_with(railf, "is_disused") + ranges_with(railf, "is_abandoned")
        abandoned = ranges_with(railf, "is_abandoned")
        width = None
        for w in r["width_rules"] or []:
            if w["value"] and w["between"] is None:
                width = float(w["value"])
        surf = Counter()
        for s in r["road_surface"] or []:
            b = s["between"] or [0, 1]
            surf[s["value"]] += b[1] - b[0]
        surface = surf.most_common(1)[0][0] if surf else None
        oneway = 0
        for a in r["access_restrictions"] or []:
            w = a["when"] or {}
            if a["access_type"] == "denied" and not (w.get("mode") or w.get("using") or w.get("vehicle")):
                if w.get("heading") == "backward":
                    oneway = 1
                elif w.get("heading") == "forward":
                    oneway = -1
        speed = None
        for s in r["speed_limits"] or []:
            if s["max_speed"] and s["max_speed"].get("value"):
                speed = s["max_speed"]["value"]
        name = (r["names"] or {}).get("primary")
        conns = [(cc["connector_id"], float(cc["at"])) for cc in (r["connectors"] or [])]
        segs.append(dict(id=r["id"], idx=len(segs), kind=kind, cls=cls, sub=sub, p=p, c=c, L=c[-1], name=name,
                         bridges=bridges, tunnels=tunnels, disused=disused, abandoned=abandoned, width=width,
                         surface=surface, oneway=oneway, speed=speed, conns=conns))
    log(f"segments in region: {len(segs)}")
    return segs


def seg_width(s):
    cls = s["cls"]
    if s["kind"] == "rail":
        return 5.0
    w = WIDTH.get(cls, 5.0)
    if s["sub"] == "link":
        w = LINK_WIDTH
    if cls == "service" and s["sub"] in ("driveway", "parking_aisle"):
        w = 3.5
    if s["width"] and s["width"] >= 1.5:
        if cls in FOOT or (s["width"] >= w * 0.5 and s["width"] <= w * 2.5):
            w = s["width"]
    return w


def seg_lanes(s, w):
    cls = s["cls"]
    if cls in FOOT or s["kind"] == "rail":
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


def merge_ranges(rs, gap=0.0):
    rs = sorted((a, b) for a, b in rs if b > a)
    out = []
    for a, b in rs:
        if out and a <= out[-1][1] + gap:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


# ------------------------------------------------------------------ water (auto bridges)
def load_water():
    tbl = pq.read_table(os.path.join(RAW, "base_water.parquet")).to_pylist()
    polys, lines = [], []
    for r in tbl:
        g = to_world(r["geometry"])
        cls = r["class"]
        if cls in ("pond", "reservoir", "lake", "swimming_pool", "basin"):
            continue
        if g.geom_type in ("Polygon", "MultiPolygon"):
            polys.append(g)
        elif g.geom_type in ("LineString", "MultiLineString") and cls in ("river", "canal"):
            lines.append(g.buffer(9.0 if cls == "canal" else 7.0, cap_style="flat"))
    wg = shapely.union_all(polys + lines)
    return wg


def main():
    os.makedirs(OUT, exist_ok=True)
    zone_at, bld_geoms, bld_tree = build_zones()
    segs = load_segments()
    water = load_water()
    shapely.prepare(water)
    log("water loaded")

    # ---------------- per-segment attributes
    for s in segs:
        s["w"] = seg_width(s)
        s["hw"] = s["w"] / 2
        s["lanes"] = seg_lanes(s, s["w"])
        s["line"] = LineString(s["p"])
        # zone: majority along the line
        sp = interp(s["p"], s["c"], np.linspace(0, s["L"], 7))
        zs = Counter(zone_at(sp[:, 0], sp[:, 1]).tolist())
        s["zone"] = zs.most_common(1)[0][0]
        if zs.get(Z_APART, 0) >= 2 and s["zone"] == Z_PRIVATE:
            s["zone"] = Z_APART

    # ---------------- auto bridges over water (roads and rails not flagged as bridges)
    nauto = 0
    for s in segs:
        if s["cls"] in ("steps",) or s["L"] < 5:
            continue
        if not s["line"].intersects(water):
            continue
        inter = s["line"].intersection(water)
        for piece in lines_of(inter):
            if piece.length < 2.5:
                continue
            a = s["line"].project(Point(piece.coords[0]))
            b = s["line"].project(Point(piece.coords[-1]))
            a, b = min(a, b), max(a, b)
            if b - a > 400:
                continue
            fa, fb = max(0, (a - 4) / s["L"]), min(1, (b + 4) / s["L"])
            if any(x0 <= (fa + fb) / 2 <= x1 for x0, x1 in s["bridges"]):
                continue
            covered = any(x0 - 0.02 <= fa and fb <= x1 + 0.02 for x0, x1 in s["bridges"])
            if not covered:
                s["bridges"].append((fa, fb))
                s.setdefault("auto", []).append((fa, fb))
                nauto += 1
    log(f"auto water bridges: {nauto}")
    for s in segs:
        s["bridges"] = merge_ranges([(a * s["L"], b * s["L"]) for a, b in s["bridges"]], 1.0)
        s["tunnels"] = merge_ranges([(a * s["L"], b * s["L"]) for a, b in s["tunnels"]], 1.0)
        s["abandoned"] = merge_ranges([(a * s["L"], b * s["L"]) for a, b in s["abandoned"]])
        s["disused"] = merge_ranges([(a * s["L"], b * s["L"]) for a, b in s["disused"]])

    # ---------------- bridge groups
    groups = build_bridge_groups(segs, water)

    # ---------------- final split into render lines
    rlines = split_render_lines(segs, groups)

    # ---------------- graph (traffic)
    graph, junctions = build_graph(segs, groups)

    # ---------------- surfaces & ground meshes
    polys = build_surfaces(rlines, segs, zone_at, junctions, water)
    tiles, pk, pool = build_ground(polys, rlines, junctions)
    build_bridge_decks(groups, rlines, pk)
    rails = build_rail(rlines, segs, polys, pool)
    marks = build_markings(rlines, polys, junctions, graph, pool)
    furn = build_furniture(rlines, segs, polys, junctions, graph, marks, bld_tree, bld_geoms, water, zone_at, pool, groups)
    power = build_power(bld_tree)

    # ---------------- write
    pool.finish(pk)
    meta = dict(
        version=1,
        tile=TILE, half=HALF, nt=NT, qs=QS,
        surfaces=SURF_NAMES, raised=RAISED, kinds=KIND_NAMES, markStyles=MARK_STYLES,
        tiles=tiles,
        arrays=pk.index,
        names=graph["names"],
        graph=graph["meta"],
        bridges=len(groups),
    )
    size = pk.packer.write(os.path.join(OUT, "ground.bin.gz"))
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    gsize = graph["packer"].write(os.path.join(OUT, "graph.bin.gz"))
    objs = dict(bridges=[g["out"] for g in groups], rail=rails, furniture=furn, power=power)
    write_json_gz(os.path.join(OUT, "objects.json.gz"), objs)
    for f in ("ground.bin.gz", "graph.bin.gz", "objects.json.gz", "meta.json"):
        log(f"  {f}: {os.path.getsize(os.path.join(OUT, f)) / 1e6:.2f} MB")
    log("done")


# ================================================================== bridges
GRADE = 0.05


def build_bridge_groups(segs, water):
    pieces = []
    for s in segs:
        for a, b in s["bridges"]:
            sub = substring(s["p"], s["c"], a, b)
            if sub is None or len(sub) < 2:
                continue
            ls = LineString(sub)
            if not ls.intersects(REGION):
                continue
            pieces.append(dict(seg=s, a=a, b=b, line=ls, hw=s["hw"]))
    # cluster: buffers overlapping and roughly parallel
    n = len(pieces)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    bufs = [pc["line"].buffer(pc["hw"] + 3.0, cap_style="flat") for pc in pieces]
    tree = STRtree(bufs)
    for i, pc in enumerate(pieces):
        for j in tree.query(bufs[i], predicate="intersects"):
            if j <= i:
                continue
            a, b = pieces[i]["line"], pieces[j]["line"]
            # direction compatibility
            da = np.array(a.coords[-1]) - np.array(a.coords[0])
            db = np.array(b.coords[-1]) - np.array(b.coords[0])
            cosang = abs(np.dot(da, db)) / (np.linalg.norm(da) * np.linalg.norm(db) + 1e-9)
            if cosang > 0.8:
                parent[find(i)] = find(j)
    clusters = defaultdict(list)
    for i in range(n):
        clusters[find(i)].append(pieces[i])

    # other lines for clearance analysis
    all_lines = []
    for s in segs:
        if s["cls"] in ("steps",):
            continue
        all_lines.append(s)
    line_tree = STRtree([s["line"] for s in all_lines])

    groups = []
    for mem in clusters.values():
        mem.sort(key=lambda m: -(m["b"] - m["a"]) * (3 if m["seg"]["kind"] == "rail" or m["seg"]["cls"] in DRIVABLE else 1))
        ax = mem[0]
        seg = ax["seg"]
        kind = "rail" if seg["kind"] == "rail" else ("foot" if seg["cls"] in FOOT else "road")
        member_ids = {m["seg"]["idx"] for m in mem}
        axl = ax["line"]
        L = axl.length
        # crossings with other features below
        cross = []
        for j in line_tree.query(axl.buffer(1.0)):
            o = all_lines[j]
            if o["idx"] in member_ids:
                continue
            ip = axl.intersection(o["line"])
            if ip.is_empty:
                continue
            pts = [ip] if ip.geom_type == "Point" else [g for g in getattr(ip, "geoms", []) if g.geom_type == "Point"]
            for pt in pts:
                # is the other feature itself on a bridge at this point?
                so = o["line"].project(pt)
                if any(x0 - 2 <= so <= x1 + 2 for x0, x1 in o["bridges"]):
                    continue
                if any(x0 <= so <= x1 for x0, x1 in o["tunnels"]):
                    continue
                if o["kind"] == "rail":
                    clr = 7.2
                elif o["cls"] in FOOT:
                    clr = 3.6
                elif o["cls"] in DRIVABLE:
                    clr = 6.0
                else:
                    continue
                cross.append((axl.project(pt), clr + (1.2 if kind != "foot" else 0.8), pt.x, pt.y))
        wet = axl.intersects(water)
        wet_s = []
        if wet:
            wi = axl.intersection(water)
            for wl in lines_of(wi):
                wet_s.append((axl.project(Point(wl.coords[0])) + axl.project(Point(wl.coords[-1]))) / 2)
        # static required rise relative to the straight line between (extended) ends
        e0 = e1 = 0.0
        if cross:
            for _ in range(3):
                a0 = max(0.0, ax["a"] - e0)
                b0 = min(seg["L"], ax["b"] + e1)
                pA = interp(seg["p"], seg["c"], a0)
                pB = interp(seg["p"], seg["c"], b0)
                hA, hB = HEIGHT(pA[0], pA[1]), HEIGHT(pB[0], pB[1])
                Lx = b0 - a0
                need0 = need1 = 0.0
                for sc, clr, cx, cz in cross:
                    se = sc + (ax["a"] - a0)  # position along extended axis
                    lerp = hA + (hB - hA) * se / max(Lx, 1)
                    R = HEIGHT(cx, cz) + clr - lerp
                    if R <= 0:
                        continue
                    run = 1.5 * R / GRADE
                    need0 = max(need0, run - se)
                    need1 = max(need1, run - (Lx - se))
                e0 = min(max(0.0, need0), ax["a"])
                e1 = min(max(0.0, need1), seg["L"] - ax["b"])
        groups.append(dict(id=len(groups), mem=mem, ax=ax, kind=kind, cross=cross, wet=wet, wet_s=wet_s, e0=e0, e1=e1))

    # apply extensions to every member (same amount along its own segment)
    for g in groups:
        for m in g["mem"]:
            s = m["seg"]
            m["ea"] = max(0.0, m["a"] - g["e0"]) if g["e0"] > 0 else m["a"]
            m["eb"] = min(s["L"], m["b"] + g["e1"]) if g["e1"] > 0 else m["b"]
            # don't run into another bridge of the same segment
            for x0, x1 in s["bridges"]:
                if x1 <= m["a"] + 1e-6 and x1 > m["ea"]:
                    m["ea"] = x1
                if x0 >= m["b"] - 1e-6 and x0 < m["eb"]:
                    m["eb"] = x0
        ax = g["ax"]
        s = ax["seg"]
        axp = substring(s["p"], s["c"], ax["ea"], ax["eb"])
        g["axis"] = axp
        g["axc"] = cumlen(axp)
        g["bridge_range"] = (ax["a"] - ax["ea"], ax["b"] - ax["ea"])
        g["out"] = None
    log(f"bridge groups: {len(groups)} (with ramps: {sum(1 for g in groups if g['e0'] > 0 or g['e1'] > 0)})")
    return groups


# ================================================================== render lines
def split_render_lines(segs, groups):
    elev = defaultdict(list)  # seg idx -> [(a, b, gid, ramp_a, ramp_b)]
    for g in groups:
        for m in g["mem"]:
            elev[m["seg"]["idx"]].append((m["ea"], m["eb"], g["id"]))
    rlines = []
    for s in segs:
        cuts = [(a, b, ("bridge", gid)) for a, b, gid in elev.get(s["idx"], [])]
        cuts += [(a, b, ("tunnel", -1)) for a, b in s["tunnels"]]
        cuts += [(a, b, ("abandoned", -1)) for a, b in s["abandoned"]] if s["kind"] == "rail" else []
        cuts.sort()
        pos = 0.0
        spans = []
        for a, b, tag in cuts:
            if a > pos + 0.05:
                spans.append((pos, a, None))
            a = max(a, pos)
            if b > a:
                spans.append((a, b, tag))
            pos = max(pos, b)
        if pos < s["L"] - 0.05:
            spans.append((pos, s["L"], None))
        for a, b, tag in spans:
            if tag and tag[0] in ("tunnel", "abandoned"):
                continue
            sub = substring(s["p"], s["c"], a, b)
            if sub is None or len(sub) < 2:
                continue
            ls = LineString(sub)
            if ls.length < 0.3:
                continue
            clipped = ls.intersection(REGION)
            for piece in lines_of(clipped):
                pp = np.array(piece.coords)
                rl = dict(id=len(rlines), seg=s, kind=s["kind"], cls=s["cls"], sub=s["sub"], p=pp, c=cumlen(pp),
                          line=piece, hw=s["hw"], lanes=s["lanes"], oneway=s["oneway"], name=s["name"],
                          zone=s["zone"], group=tag[1] if tag else -1,
                          cut0=a > 0.05, cut1=b < s["L"] - 0.05,
                          disused=any(x0 <= (a + b) / 2 <= x1 for x0, x1 in s["disused"]))
                rlines.append(rl)
    log(f"render lines: {len(rlines)}")
    return rlines


# ================================================================== graph
def build_graph(segs, groups):
    """Road network from Overture connectors. Nodes are connectors, edges run between consecutive
    connectors of a segment."""
    node_id = {}
    nodes = []
    edges = []
    gid_of = defaultdict(list)
    for g in groups:
        for m in g["mem"]:
            gid_of[m["seg"]["idx"]].append((m["ea"], m["eb"], g["id"]))
    for s in segs:
        if s["kind"] != "road":
            continue
        conns = sorted(s["conns"], key=lambda t: t[1])
        if len(conns) < 2:
            conns = [("s%d_0" % s["idx"], 0.0), ("s%d_1" % s["idx"], 1.0)]
        if conns[0][1] > 1e-6:
            conns.insert(0, ("s%d_0" % s["idx"], 0.0))
        if conns[-1][1] < 1 - 1e-6:
            conns.append(("s%d_1" % s["idx"], 1.0))
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
            ids = []
            for cid, pt in ((c0, sub[0]), (c1, sub[-1])):
                if cid not in node_id:
                    node_id[cid] = len(nodes)
                    nodes.append(pt)
                ids.append(node_id[cid])
            if ids[0] == ids[1] and len(sub) < 3:
                continue
            tunnel = any(x0 <= (sa + sb) / 2 <= x1 for x0, x1 in s["tunnels"])
            bridge = -1
            for x0, x1, gid in gid_of.get(s["idx"], []):
                if sb > x0 and sa < x1:
                    bridge = gid
            edges.append(dict(a=ids[0], b=ids[1], cls=s["cls"], w=s["w"], lanes=s["lanes"], oneway=s["oneway"],
                              name=s["name"], pts=sub, link=s["sub"] == "link", tunnel=tunnel, bridge=bridge,
                              speed=s["speed"] or 0, seg=s["idx"]))
    nodes = np.array(nodes)
    deg = np.zeros(len(nodes), int)
    degd = np.zeros(len(nodes), int)  # drivable degree
    for e in edges:
        deg[e["a"]] += 1
        deg[e["b"]] += 1
        if e["cls"] in DRIVABLE:
            degd[e["a"]] += 1
            degd[e["b"]] += 1
    names = sorted({e["name"] for e in edges if e["name"]})
    name_idx = {n: i for i, n in enumerate(names)}
    # junction table: nodes with >= 3 drivable edges -> radius = widest incident half width + 1.5
    jr = np.zeros(len(nodes))
    for e in edges:
        if e["cls"] not in DRIVABLE:
            continue
        for k in (e["a"], e["b"]):
            if degd[k] >= 3:
                jr[k] = max(jr[k], e["w"] / 2 + 1.5)
    junctions = dict(pts=nodes[jr > 0], r=jr[jr > 0], node=np.nonzero(jr > 0)[0])
    # pack
    pk = Packer()
    pts_all = []
    off = [0]
    for e in edges:
        pts_all.append(e["pts"])
        off.append(off[-1] + len(e["pts"]))
    P = np.concatenate(pts_all).astype("<f4") if pts_all else np.zeros((0, 2), "<f4")
    flags = np.array([(1 if e["oneway"] == 1 else 0) | (2 if e["oneway"] == -1 else 0) | (4 if e["link"] else 0)
                      | (8 if e["tunnel"] else 0) | (16 if e["bridge"] >= 0 else 0) for e in edges], "u1")
    meta = dict(
        nodes=pk.add(nodes.astype("<f4").ravel()),
        ea=pk.add(np.array([e["a"] for e in edges], "<i4")),
        eb=pk.add(np.array([e["b"] for e in edges], "<i4")),
        ecls=pk.add(np.array([CLS_ID.get(e["cls"], CLS_ID["unknown"]) for e in edges], "u1")),
        ewidth=pk.add(np.array([round(e["w"] * 10) for e in edges], "<u2")),
        elanes=pk.add(np.array([e["lanes"] for e in edges], "u1")),
        eflags=pk.add(flags),
        espeed=pk.add(np.array([e["speed"] for e in edges], "u1")),
        ename=pk.add(np.array([name_idx.get(e["name"], -1) for e in edges], "<i2")),
        ebridge=pk.add(np.array([e["bridge"] for e in edges], "<i2")),
        eoff=pk.add(np.array(off, "<u4")),
        epts=pk.add(P.ravel()),
        classes=list(CLS_ID.keys()),
        count=[len(nodes), len(edges)],
    )
    log(f"graph: {len(nodes)} nodes, {len(edges)} edges, {len(junctions['r'])} junctions, {len(names)} names")
    return dict(meta=meta, packer=pk, names=names, nodes=nodes, edges=edges, deg=deg, degd=degd, node_id=node_id), junctions


# ================================================================== surfaces
def road_surface(rl):
    s = rl["seg"]
    cls, zone, tag = rl["cls"], rl["zone"], s["surface"]
    key = s["name"] or s["id"]
    if cls in FOOT:
        if cls == "path" and zone == Z_RURAL:
            return S_DIRT
        if tag in ("dirt", "unpaved", "ground", "earth", "grass"):
            return S_DIRT
        if tag == "gravel":
            return S_GRAVEL
        near_c = np.hypot(*(rl["p"].mean(0) - CENTER)) < 1500
        if tag == "paving_stones" or (near_c and zone == Z_APART) or cls == "pedestrian":
            return S_PAVING
        return S_SIDEWALK
    if tag in ("gravel", "fine_gravel", "compacted", "pebblestone"):
        return S_GRAVEL
    if tag in ("dirt", "unpaved", "ground", "earth", "grass", "sand", "mud"):
        return S_DIRT
    if tag == "paving_stones":
        return S_PAVING_ROAD
    if tag == "concrete":
        return S_CONCRETE
    if cls in MAJOR or rl["sub"] == "link":
        return S_ASPH
    if cls == "track":
        return S_GRAVEL if h32(key) < 0.3 else S_DIRT
    if cls == "service":
        if zone == Z_INDUSTRIAL and h32(key) < 0.55:
            return S_CONCRETE
        if zone == Z_RURAL and h32(key) < 0.5:
            return S_GRAVEL
        return S_ASPH_OLD
    if cls in ("residential", "unclassified", "living_street"):
        if zone == Z_PRIVATE and tag is None:
            return S_GRAVEL if h32(key) < 0.22 else S_ASPH_OLD
        if zone == Z_RURAL and cls == "unclassified" and tag is None and h32(key) < 0.3:
            return S_GRAVEL
        return S_ASPH_OLD
    return S_ASPH_OLD


def sidewalk_spec(rl):
    cls, zone = rl["cls"], rl["zone"]
    if rl["kind"] != "road" or cls not in DRIVABLE:
        return None
    if cls in ("trunk", "primary", "secondary", "motorway"):
        if zone == Z_APART:
            return (2.5, 3.0)
        if zone in (Z_PRIVATE, Z_INDUSTRIAL):
            return (1.5, 2.0)
        return None
    if cls == "tertiary":
        if zone == Z_APART:
            return (1.5, 2.25)
        if zone == Z_PRIVATE:
            return (1.0, 1.5)
        return None
    if cls in ("residential", "unclassified", "living_street"):
        if zone == Z_APART:
            return (0.0, 1.75)
        return None
    return None


def flat_buffer(p, d):
    return LineString(p).buffer(d, cap_style="flat", join_style="round", quad_segs=4)


def rl_buffer(rl, d):
    """Carriageway-style buffer: flat caps at bridge/tunnel cuts, round caps elsewhere."""
    g = flat_buffer(rl["p"], d)
    ends = []
    if not rl["cut0"]:
        ends.append(Point(rl["p"][0]).buffer(d, quad_segs=4))
    if not rl["cut1"]:
        ends.append(Point(rl["p"][-1]).buffer(d, quad_segs=4))
    if ends:
        g = shapely.union_all([g] + ends)
    return g


def build_surfaces(rlines, segs, zone_at, junctions, water):
    road = [r for r in rlines if r["kind"] == "road" and r["group"] < 0]
    for r in rlines:
        r["surf"] = road_surface(r) if r["kind"] == "road" else S_BALLAST
        r["sw"] = sidewalk_spec(r)
    by = defaultdict(list)
    for r in road:
        if r["cls"] in FOOT:
            continue
        by[r["surf"]].append(rl_buffer(r, r["hw"]))
    order = [S_ASPH, S_PAVING_ROAD, S_ASPH_OLD, S_CONCRETE, S_GRAVEL, S_DIRT]
    carriage = {}
    acc = None
    for sid in order:
        if not by.get(sid):
            continue
        u = shapely.union_all(by[sid])
        if acc is not None:
            u = u.difference(acc)
        carriage[sid] = u
        acc = u if acc is None else shapely.union_all([acc, u])
    all_carriage = acc
    log("carriageways unioned", {SURF_NAMES[k]: round(v.area / 1e6, 3) for k, v in carriage.items()}, "km2")

    # parking lots
    inf = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet"), columns=["class", "geometry", "subtype"]).to_pylist()
    park = [to_world(r["geometry"]) for r in inf if r["class"] in ("parking",) and r["geometry"] is not None]
    park = [g.buffer(0) for g in park if g.geom_type in ("Polygon", "MultiPolygon")]
    parking = shapely.union_all(park).difference(all_carriage) if park else Polygon()
    parking = parking.intersection(REGION)

    # rail ballast
    rails = [r for r in rlines if r["kind"] == "rail" and r["group"] < 0]
    ballast = shapely.union_all([flat_buffer(r["p"], 2.1) for r in rails]) if rails else Polygon()
    # platforms
    plats = []
    for r in inf:
        if r["class"] == "platform":
            g = to_world(r["geometry"])
            if g.geom_type == "LineString" and g.intersects(REGION):
                plats.append(g.buffer(3.2, cap_style="flat"))
            elif g.geom_type in ("Polygon", "MultiPolygon"):
                plats.append(g)
    platforms = Polygon()
    if plats:
        track_clear = shapely.union_all([flat_buffer(r["p"], 1.85) for r in rails])
        platforms = shapely.union_all(plats).difference(track_clear).difference(all_carriage)
        platforms = shapely.union_all([p for p in polys_of(platforms) if p.area > 20])
    ballast = ballast.difference(all_carriage).difference(platforms)

    # sidewalks from road specs + footways
    sw_polys = []
    curb_zone = []
    for r in road:
        sp = r["sw"]
        if not sp:
            continue
        gap, w = sp
        outer = flat_buffer(r["p"], r["hw"] + gap + w)
        inner = flat_buffer(r["p"], r["hw"] + gap)
        sw_polys.append(outer.difference(inner))
        curb_zone.append(flat_buffer(r["p"], r["hw"] + 0.8))
    foot_by = defaultdict(list)
    for r in road:
        if r["cls"] in FOOT:
            sid = r["surf"]
            foot_by[sid].append(rl_buffer(r, r["hw"]))
    pave_zone = Point(CENTER).buffer(1500)
    sidewalks = shapely.union_all(sw_polys) if sw_polys else Polygon()
    sw_pave = sidewalks.intersection(pave_zone)
    sw_asph = sidewalks.difference(pave_zone)
    # apartment-zone sidewalks outside the centre stay asphalt
    blocked = shapely.union_all([all_carriage.buffer(0.15), ballast, platforms, water])
    pav = shapely.union_all([sw_pave] + foot_by.get(S_PAVING, [])).difference(blocked)
    swa = shapely.union_all([sw_asph] + foot_by.get(S_SIDEWALK, [])).difference(blocked).difference(pav)
    fdirt = shapely.union_all(foot_by.get(S_DIRT, []) + foot_by.get(S_GRAVEL, [])).difference(blocked).difference(pav).difference(swa) \
        if (foot_by.get(S_DIRT) or foot_by.get(S_GRAVEL)) else Polygon()
    parking = parking.difference(shapely.union_all([pav, swa, ballast, platforms]))
    curbzone = shapely.union_all(curb_zone) if curb_zone else Polygon()
    log("sidewalks", round(pav.area / 1e6, 3), round(swa.area / 1e6, 3), "km2; ballast", round(ballast.area / 1e6, 3),
        "platforms", round(platforms.area, 0), "m2; parking", round(parking.area / 1e6, 3))

    surfaces = dict(carriage)
    # dirt paths merge with dirt roads, keeping distinct polygons is unnecessary
    if not fdirt.is_empty:
        surfaces[S_DIRT] = shapely.union_all([surfaces.get(S_DIRT, Polygon()), fdirt])
    surfaces[S_PAVING] = pav
    surfaces[S_SIDEWALK] = swa
    surfaces[S_BALLAST] = ballast
    surfaces[S_PLATFORM] = platforms
    surfaces[S_PARKING] = parking
    for k in list(surfaces):
        surfaces[k] = surfaces[k].intersection(REGION)
    return dict(surfaces=surfaces, carriage=all_carriage, curbzone=curbzone, sidewalk_raised=shapely.union_all([pav, swa]),
                road=road, rails=rails, water=water)


# ================================================================== ground mesh
class Pool:
    """Polyline pool: tile-clipped polylines packed as u16 coordinates."""

    def __init__(self):
        self.recs = []
        self.coords = []
        self.n = 0

    def add(self, pts, kind, style=0, width=0.0, group=-1, clip=True):
        pts = np.asarray(pts, dtype=np.float64)
        if len(pts) < 2:
            return
        if group >= 0 or not clip:
            # bridge polylines: stored in the tile of their first point, world coords must fit that tile +-1 km
            i, j = tile_of(*pts[len(pts) // 2])
            self._put(pts, i, j, kind, style, width, group)
            return
        ls = LineString(pts)
        x0, z0, x1, z1 = ls.bounds
        ti0, tj0 = tile_of(x0, z0)
        ti1, tj1 = tile_of(x1, z1)
        for i in range(ti0, ti1 + 1):
            for j in range(tj0, tj1 + 1):
                bx = tile_box(i, j)
                if ti0 == ti1 and tj0 == tj1:
                    self._put(pts, i, j, kind, style, width, group)
                    continue
                c = shapely.clip_by_rect(ls, *bx)
                for piece in merge_lines(c):
                    self._put(np.array(piece.coords), i, j, kind, style, width, group)

    def _put(self, pts, i, j, kind, style, width, group):
        x0, z0, _, _ = tile_box(i, j)
        q = np.round((pts - np.array([x0 - TILE / 2, z0 - TILE / 2])) * QS / 1.0)
        # polylines use a tile-relative origin shifted by half a tile so bridge lines may overhang
        q = np.clip(q, 0, 65535).astype("<u2")
        self.recs.append([i + j * NT, kind, style, int(round(width * 100)), group, self.n, len(pts)])
        self.coords.append(q)
        self.n += len(pts)

    def finish(self, pk):
        c = np.concatenate(self.coords) if self.coords else np.zeros((0, 2), "<u2")
        pk.index["lpos"] = pk.packer.add(c.ravel())
        pk.index["lrec"] = pk.packer.add(np.array(self.recs, "<i4").ravel() if self.recs else np.zeros(0, "<i4"))
        log(f"polylines: {len(self.recs)} records, {self.n} points")


class PackIndex:
    def __init__(self):
        self.packer = Packer()
        self.index = {}


def vertex_attrs(V, surf, road_tree, road_lines, rail_tree, rail_lines, junctions, jtree, any_tree, any_lines):
    """Per-vertex [lat cm, lanes, hw dm, wear] and direction for draped ground vertices."""
    n = len(V)
    lat = np.zeros(n)
    lanes = np.zeros(n, int)
    hw = np.zeros(n)
    wear = np.full(n, 255)
    dc = np.zeros(n)
    ds = np.zeros(n)
    pts = shapely.points(V)

    def near(tree, lines, mask):
        idx = np.nonzero(mask)[0]
        if len(idx) == 0 or tree is None:
            return
        q = tree.query_nearest(pts[idx], return_distance=False, all_matches=False)
        pi, li = q
        order = np.argsort(pi)
        pi, li = pi[order], li[order]
        uniq, first = np.unique(pi, return_index=True)
        li = li[first]
        vid = idx[uniq]
        ls = np.array([lines[k]["line"] for k in li], dtype=object)
        s = shapely.line_locate_point(ls, pts[vid])
        L = shapely.length(ls)
        p0 = shapely.get_coordinates(shapely.line_interpolate_point(ls, np.clip(s - 0.75, 0, L)))
        p1 = shapely.get_coordinates(shapely.line_interpolate_point(ls, np.clip(s + 0.75, 0, L)))
        pc = shapely.get_coordinates(shapely.line_interpolate_point(ls, s))
        t = p1 - p0
        tl = np.maximum(np.linalg.norm(t, axis=1), 1e-9)
        t /= tl[:, None]
        d = V[vid] - pc
        cr = t[:, 0] * d[:, 1] - t[:, 1] * d[:, 0]  # >0: right side (x east, z south)
        dist = np.linalg.norm(d, axis=1)
        lat[vid] = np.sign(cr) * dist
        lanes[vid] = [lines[k]["lanes"] for k in li]
        hw[vid] = [lines[k]["hw"] for k in li]
        th = np.arctan2(t[:, 1], t[:, 0])
        dc[vid] = np.cos(2 * th)
        ds[vid] = np.sin(2 * th)

    carr = (surf <= S_DIRT) | (surf == S_PAVING_ROAD)
    near(road_tree, road_lines, carr)
    near(rail_tree, rail_lines, (surf == S_BALLAST) | (surf == S_PLATFORM))
    near(any_tree, any_lines, (surf == S_PAVING) | (surf == S_SIDEWALK) | (surf == S_PARKING))
    lanes[~carr] = 0
    lat[(surf == S_PAVING) | (surf == S_SIDEWALK) | (surf == S_PARKING)] = 0
    hw[(surf == S_PAVING) | (surf == S_SIDEWALK) | (surf == S_PARKING)] = 0
    # junction fade of wheel-track wear
    if jtree is not None and carr.any():
        idx = np.nonzero(carr)[0]
        pi, ji = jtree.query_nearest(pts[idx], return_distance=False)
        order = np.argsort(pi)
        pi, ji = pi[order], ji[order]
        uniq, first = np.unique(pi, return_index=True)
        ji = ji[first]
        vid = idx[uniq]
        d = np.linalg.norm(V[vid] - junctions["pts"][ji], axis=1)
        r = junctions["r"][ji]
        wear[vid] = np.clip((d - r) / 8.0, 0, 1) * 255
    wear[surf == S_PARKING] = 0
    return lat, lanes, hw, wear, dc, ds


def build_ground(polys, rlines, junctions):
    pk = PackIndex()
    surfaces = polys["surfaces"]
    road_lines = [r for r in polys["road"] if r["cls"] not in FOOT]
    any_lines = polys["road"]
    rail_lines = polys["rails"]
    road_tree = STRtree([r["line"] for r in road_lines]) if road_lines else None
    any_tree = STRtree([r["line"] for r in any_lines]) if any_lines else None
    rail_tree = STRtree([r["line"] for r in rail_lines]) if rail_lines else None
    jtree = STRtree(shapely.points(junctions["pts"])) if len(junctions["r"]) else None
    tiles = []
    GP, GL, GA, GD, GI = [], [], [], [], []
    vtot = itot = 0
    for sid, g in surfaces.items():
        shapely.prepare(g)
    for j in range(NT):
        for i in range(NT):
            bx = tile_box(i, j)
            tb = box(*bx)
            Vs, Is, Ss = [], [], []
            nv = 0
            for sid, g in surfaces.items():
                if g.is_empty or not g.intersects(tb):
                    continue
                res = triangulate_grid(g, bx)
                if res is None:
                    continue
                V, T = res
                Vs.append(V)
                Is.append(T + nv)
                Ss.append(np.full(len(V), sid))
                nv += len(V)
            if not Vs:
                continue
            V = np.concatenate(Vs)
            T = np.concatenate(Is)
            S = np.concatenate(Ss)
            lat, lanes, hw, wear, dc, ds = vertex_attrs(V, S, road_tree, road_lines, rail_tree, rail_lines,
                                                        junctions, jtree, any_tree, any_lines)
            q = np.clip(np.round((V - np.array(bx[:2])) * QS), 0, 65535).astype("<u2")
            GP.append(q.ravel())
            GL.append(np.clip(np.round(lat * 100), -32767, 32767).astype("<i2"))
            GA.append(np.stack([S, lanes, np.clip(np.round(hw * 10), 0, 255), wear], 1).astype("u1").ravel())
            GD.append(np.stack([np.round(dc * 127), np.round(ds * 127)], 1).astype("i1").ravel())
            GI.append(T.astype("<u4").ravel())
            tiles.append(dict(i=i, j=j, v0=vtot, nv=len(V), i0=itot, ni=int(T.size)))
            vtot += len(V)
            itot += int(T.size)
        log(f"  ground row {j + 1}/{NT}: {vtot} verts, {itot // 3} tris")
    pk.index["gpos"] = pk.packer.add(np.concatenate(GP))
    pk.index["glat"] = pk.packer.add(np.concatenate(GL))
    pk.index["gatt"] = pk.packer.add(np.concatenate(GA))
    pk.index["gdir"] = pk.packer.add(np.concatenate(GD))
    pk.index["gidx"] = pk.packer.add(np.concatenate(GI))
    log(f"ground: {len(tiles)} tiles, {vtot} vertices, {itot // 3} triangles")

    # skirts (raised surfaces), curbs
    pool = Pool()
    carriage = polys["carriage"]
    for sid in (S_PAVING, S_SIDEWALK, S_BALLAST, S_PLATFORM):
        g = surfaces.get(sid)
        if g is None or g.is_empty:
            continue
        for poly in polys_of(g):
            if poly.area < 2:
                continue
            # orient: exterior CCW / holes CW in the (x, z) math frame -> the polygon interior is always
            # on the (-tz, tx) side of travel, so the outward normal is (tz, -tx)
            poly = shapely.geometry.polygon.orient(poly, 1.0)
            for ring in [poly.exterior] + list(poly.interiors):
                pool.add(np.array(ring.coords), K_SKIRT, sid, 0)
    # curbs: carriageway edge portions in the curb zone that are not already bounded by raised sidewalks
    cz = polys["curbzone"]
    if not cz.is_empty:
        edge = carriage.boundary.intersection(cz)
        edge = edge.difference(polys["sidewalk_raised"].buffer(0.35))
        n = 0
        for ls in merge_lines(edge):
            if ls.length < 1.0:
                continue
            pts = np.array(ls.coords)
            # side: which side of the line is the road? sample a point 0.3 m to the right
            mid = len(pts) // 2
            a = pts[max(mid - 1, 0)]
            b = pts[min(mid + 1, len(pts) - 1)] if len(pts) > 2 else pts[-1]
            if np.allclose(a, b):
                a, b = pts[0], pts[-1]
            t = (b - a) / max(np.linalg.norm(b - a), 1e-9)
            rp = (a + b) / 2 + np.array([-t[1], t[0]]) * 0.3
            road_right = carriage.contains(Point(rp))
            pool.add(pts, K_CURB, 1 if road_right else 0, 0.16)
            n += 1
        log(f"curbs: {n} polylines")
    return tiles, pk, pool


# ================================================================== bridge decks
def build_bridge_decks(groups, rlines, pk):
    """Deck footprints (grid triangulated, world coords) + parapet/wall lines + piers."""
    BP, BI, BA, BL, BD = [], [], [], [], []
    vtot = itot = 0
    by_group = defaultdict(list)
    for r in rlines:
        if r["group"] >= 0:
            by_group[r["group"]].append(r)
    for g in groups:
        mem = by_group.get(g["id"], [])
        if not mem:
            g["out"] = dict(id=g["id"], empty=True)
            continue
        axp, axc = g["axis"], g["axc"]
        roads = [r for r in mem if r["kind"] == "road" and r["cls"] not in FOOT]
        feet = [r for r in mem if r["kind"] == "road" and r["cls"] in FOOT]
        rails = [r for r in mem if r["kind"] == "rail"]
        has_foot = len(feet) > 0
        parts, carr, walk, ball = [], [], [], []
        for r in mem:
            if r["kind"] == "rail":
                w = 2.9
                ball.append(flat_buffer(r["p"], 2.2))
            elif r["cls"] in FOOT:
                w = max(r["hw"], 1.25) + 0.35
                walk.append(flat_buffer(r["p"], w - 0.35))
            else:
                extra = 0.6 if has_foot else 2.1
                w = r["hw"] + extra
                carr.append(flat_buffer(r["p"], r["hw"]))
                walk.append(flat_buffer(r["p"], r["hw"] + extra - 0.35))
            parts.append(flat_buffer(r["p"], w))
        foot = shapely.union_all(parts)
        foot = shapely.union_all([p for p in polys_of(foot) if p.area > 1.0])
        carr_u = shapely.union_all(carr).intersection(foot) if carr else Polygon()
        ball_u = shapely.union_all(ball).intersection(foot).difference(carr_u) if ball else Polygon()
        walk_u = shapely.union_all(walk).intersection(foot).difference(carr_u).difference(ball_u) if walk else Polygon()
        rest = foot.difference(shapely.union_all([carr_u, walk_u, ball_u]))
        v0 = vtot
        i0 = itot
        bxs = foot.bounds
        bb = (np.floor(bxs[0] / 5) * 5 - 5, np.floor(bxs[1] / 5) * 5 - 5, np.ceil(bxs[2] / 5) * 5 + 5, np.ceil(bxs[3] / 5) * 5 + 5)
        layers = [(carr_u, S_ASPH if not roads or roads[0]["surf"] in (S_ASPH, S_ASPH_OLD) else roads[0]["surf"]),
                  (walk_u, S_SIDEWALK), (ball_u, S_BALLAST), (rest, S_SIDEWALK)]
        for geom, sid in layers:
            if geom.is_empty:
                continue
            res = triangulate_grid(geom, bb, cell=5.0, sub=40.0)
            if res is None:
                continue
            V, T = res
            n = len(V)
            # attrs: lat/lanes relative to nearest road member
            lat = np.zeros(n)
            lanes = np.zeros(n, int)
            hw = np.zeros(n)
            dc = np.zeros(n)
            ds = np.zeros(n)
            ref = roads if sid <= S_DIRT and roads else (rails if sid == S_BALLAST and rails else mem)
            for k in range(n):
                best = None
                for r in ref:
                    d = r["line"].distance(Point(V[k]))
                    if best is None or d < best[0]:
                        best = (d, r)
                r = best[1]
                s = r["line"].project(Point(V[k]))
                tt = tangent(r["p"], r["c"], s, 0.75)
                pc = interp(r["p"], r["c"], s)
                dd = V[k] - pc
                cr = tt[0] * dd[1] - tt[1] * dd[0]
                if sid <= S_DIRT or sid == S_BALLAST:
                    lat[k] = np.sign(cr) * np.linalg.norm(dd)
                    lanes[k] = r["lanes"] if sid <= S_DIRT else 0
                    hw[k] = r["hw"]
                th = math.atan2(tt[1], tt[0])
                dc[k] = math.cos(2 * th)
                ds[k] = math.sin(2 * th)
            BP.append(V.astype("<f4").ravel())
            BI.append((T + (vtot - v0)).astype("<u4").ravel())
            BL.append(np.clip(np.round(lat * 100), -32767, 32767).astype("<i2"))
            BA.append(np.stack([np.full(n, sid), lanes, np.clip(np.round(hw * 10), 0, 255), np.full(n, 255)], 1).astype("u1").ravel())
            BD.append(np.stack([np.round(dc * 127), np.round(ds * 127)], 1).astype("i1").ravel())
            vtot += n
            itot += T.size
        # outline: footprint boundary without the end caps (ends connect to the approach roads)
        caps = []
        for r in mem:
            for k, (pt, sgn) in enumerate(((r["p"][0], 1), (r["p"][-1], -1))):
                c = r["c"]
                tt = tangent(r["p"], c, 0.0 if k == 0 else c[-1], 1.0)
                nrm = np.array([-tt[1], tt[0]])
                a = pt - nrm * (r["hw"] + 6)
                b = pt + nrm * (r["hw"] + 6)
                caps.append(LineString([a, b]).buffer(0.25, cap_style="flat"))
        capu = shapely.union_all(caps)
        outline = []
        for poly in polys_of(foot):
            for ring in [poly.exterior] + list(poly.interiors):
                pieces = merge_lines(ring.difference(capu))
                for ls in pieces:
                    if ls.length < 1.0:
                        continue
                    pts = np.array(ls.coords)
                    # outward normal: which side is outside the footprint?
                    mid = len(pts) // 2
                    a = pts[max(mid - 1, 0)]
                    b = pts[min(mid + 1, len(pts) - 1)]
                    if np.allclose(a, b):
                        a, b = pts[0], pts[-1]
                    t = (b - a) / max(np.linalg.norm(b - a), 1e-9)
                    rp = (a + b) / 2 + np.array([-t[1], t[0]]) * 0.2
                    out_right = not foot.contains(Point(rp))
                    outline.append(dict(p=r1(pts, 2), outRight=bool(out_right)))
        # piers inside the real bridge range (not ramps)
        br0, br1 = g["bridge_range"]
        span = br1 - br0
        piers = []
        L = axc[-1]
        if span > 28:
            nsp = max(2, int(round(span / 30)))
            for k in range(1, nsp):
                s = br0 + span * k / nsp
                pc = interp(axp, axc, s)
                tt = tangent(axp, axc, s, 2.0)
                nrm = np.array([-tt[1], tt[0]])
                # width across the footprint at this station
                probe = LineString([pc - nrm * 40, pc + nrm * 40]).intersection(foot)
                ws = [np.dot(np.array(q) - pc, nrm) for ls in lines_of(probe) for q in ls.coords]
                if not ws:
                    continue
                piers.append(dict(s=round(float(s), 2), x=round(float(pc[0]), 2), z=round(float(pc[1]), 2),
                                  nx=round(float(nrm[0]), 4), nz=round(float(nrm[1]), 4),
                                  w0=round(float(min(ws)), 2), w1=round(float(max(ws)), 2)))
        g["out"] = dict(
            id=g["id"], kind=g["kind"],
            axis=r1(axp, 2), L=round(float(L), 2),
            range=[round(float(br0), 2), round(float(br1), 2)],
            cross=[[round(float(sc + (g["ax"]["a"] - g["ax"]["ea"])), 2), round(float(clr), 2)] for sc, clr, _, _ in g["cross"]],
            wet=[round(float(s + (g["ax"]["a"] - g["ax"]["ea"])), 2) for s in g["wet_s"]],
            v=[v0, vtot - v0], i=[i0, itot - i0],
            outline=outline, piers=piers,
            name=g["ax"]["seg"]["name"],
            rail=len(rails) > 0, road=len(roads) > 0, foot=len(feet) > 0,
        )
    if BP:
        pk.index["bpos"] = pk.packer.add(np.concatenate(BP))
        pk.index["bidx"] = pk.packer.add(np.concatenate(BI))
        pk.index["blat"] = pk.packer.add(np.concatenate(BL))
        pk.index["batt"] = pk.packer.add(np.concatenate(BA))
        pk.index["bdir"] = pk.packer.add(np.concatenate(BD))
    log(f"bridge decks: {vtot} verts {itot // 3} tris")


# ================================================================== rail
def build_rail(rlines, segs, polys, pool):
    from roads_rail import rail_objects
    return rail_objects(rlines, polys, pool, log)


def build_markings(rlines, polys, junctions, graph, pool):
    from roads_marks import markings
    return markings(rlines, polys, junctions, graph, pool, log)


def build_furniture(rlines, segs, polys, junctions, graph, marks, bld_tree, bld_geoms, water, zone_at, pool, groups):
    from roads_furniture import furniture
    return furniture(rlines, segs, polys, junctions, graph, marks, bld_tree, bld_geoms, water, zone_at, pool, groups, log)


def build_power(bld_tree):
    from roads_power import power
    return power(to_world, REGION, log)


if __name__ == "__main__":
    main()
