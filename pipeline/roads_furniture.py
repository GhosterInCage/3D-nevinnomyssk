"""Street furniture for build_roads.py.

Output (objects.json.gz -> "furniture"):
  lights:  flat list, 6 numbers per item [x, z, heading, type, group, chain]
           heading = direction the lamp arm points (deg cw from north, towards the road)
           type: 0 LED steel pole 10 m, 1 HPS concrete pole 9 m, 2 distribution pole with lamp,
                 3 bridge lamp (on parapet, group = bridge group), 4 distribution pole without lamp
           chain = index into chains (-1 = none)
  chains:  [[i0, i1, ...]] consecutive distribution poles carrying overhead wires (0.4 kV SIP)
  signals: [[x, z, heading, phase, node], ...]  signal pole facing drivers of one approach
  stops:   [[x, z, heading, type, nameIndex], ...]  bus stops (heading = shelter opening, towards road);
           type 0 modern glass shelter, 1 Soviet concrete pavilion, 2 sign pole only
  stopNames: [str]
  benches: [[x, z, heading], ...]
  signs:   [[x, z, heading, type], ...]  type 0 pedestrian crossing (5.19, double sided), 1 give way (2.4),
           2 stop (2.5)
  crossings: [[x, z, tx, tz, hw, len], ...]  zebra centres (for curb ramps / pedestrians)
Fences / walls / guard rails go to the polyline pool (kinds K_FENCE / K_WALL / K_GUARD).
"""
import math
import os
from collections import defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from config import RAW
from roads_mesh import cumlen, interp, tangent, offset_polyline, lines_of, polys_of, to_world

K_FENCE, K_WALL, K_GUARD = 4, 5, 7
FOOT = {"footway", "path", "cycleway", "steps", "pedestrian", "bridleway"}
MAJOR = {"motorway", "trunk", "primary", "secondary", "tertiary"}
DRIVE = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service", "track"}
Z_RURAL, Z_PRIVATE, Z_APART, Z_INDUSTRIAL = range(4)


def hdg(tx, tz):
    return float(math.degrees(math.atan2(tx, -tz)) % 360)


def h32(s):
    v = 2166136261
    for ch in str(s):
        v = ((v ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return (v % 100000) / 100000.0


def furniture(rlines, segs, polys, junctions, graph, marks, bld_tree, bld_geoms, water, zone_at, pool, groups, log):
    carriage = polys["carriage"]
    ballast = polys["surfaces"].get(7)
    shapely.prepare(carriage)
    if ballast is not None:
        shapely.prepare(ballast)

    def blocked(q, margin=0.35):
        P = Point(q)
        if abs(q[0]) > 10200 or abs(q[1]) > 10200:
            return True
        if carriage.intersects(P.buffer(margin)):
            return True
        if water.contains(P):
            return True
        if ballast is not None and ballast.intersects(P.buffer(0.8)):
            return True
        for k in bld_tree.query(P):
            if bld_geoms[k].contains(P):
                return True
        return False

    # ---------------------------------------------------------------- street lights
    lights = []  # [x, z, heading, type, group, chain, priority]
    chains = []
    grid = defaultdict(list)

    def near_existing(q, r=9.0):
        gx, gz = int(q[0] // 10), int(q[1] // 10)
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for k in grid[(gx + dx, gz + dz)]:
                    if (lights[k][0] - q[0]) ** 2 + (lights[k][1] - q[1]) ** 2 < r * r:
                        return True
        return False

    def put(q, heading, typ, group=-1, chain=-1):
        lights.append([float(q[0]), float(q[1]), heading, typ, group, chain])
        grid[(int(q[0] // 10), int(q[1] // 10))].append(len(lights) - 1)
        return len(lights) - 1

    prio = {"trunk": 0, "motorway": 0, "primary": 0, "secondary": 1, "tertiary": 2, "residential": 3, "unclassified": 3, "living_street": 3}
    road = [r for r in rlines if r["kind"] == "road" and r["cls"] in prio]
    road.sort(key=lambda r: prio[r["cls"]])
    nchain = 0
    for r in road:
        L = r["c"][-1]
        if L < 15:
            continue
        cls, zone, hw = r["cls"], r["zone"], r["hw"]
        sw = r.get("sw")
        gap = sw[0] if sw else 0.0
        if r["group"] >= 0:
            # bridge: lamps on both parapets every 32 m
            n = max(1, int(L // 32))
            for k in range(n + 1):
                s = (k + 0.5) * L / (n + 1)
                pc = interp(r["p"], r["c"], s)
                t = tangent(r["p"], r["c"], s, 1.0)
                nrm = np.array([-t[1], t[0]])
                for side in ((1, -1) if (k % 2 == 0 or cls in MAJOR) else (1,)):
                    if cls not in MAJOR and side == -1:
                        continue
                    q = pc + nrm * side * (hw + (0.4 if cls in MAJOR else 0.3))
                    if near_existing(q, 8):
                        continue
                    put(q, hdg(*(-nrm * side)), 3, r["group"])
            continue
        mode = None
        if cls in ("trunk", "primary", "secondary", "motorway"):
            if zone != Z_RURAL:
                mode = ("both", 36.0, 0, hw + (gap * 0.5 if gap >= 1 else 0.7))
        elif cls == "tertiary":
            if zone in (Z_APART, Z_INDUSTRIAL):
                mode = ("one", 36.0, 1, hw + (gap * 0.5 if gap >= 1 else 0.7))
            elif zone == Z_PRIVATE:
                mode = ("chain", 38.0, 2, hw + 1.6)
        else:
            if zone in (Z_APART,):
                mode = ("one", 38.0, 1, hw + 0.7)
            elif zone == Z_PRIVATE:
                mode = ("chain", 40.0, 2, hw + 1.7)
            elif zone == Z_INDUSTRIAL and cls == "unclassified":
                mode = ("one", 45.0, 1, hw + 0.8)
        if mode is None:
            continue
        how, spacing, typ, off = mode
        key = r["name"] or r["seg"]["id"]
        side0 = 1 if h32(key) < 0.5 else -1
        n = max(1, int(round(L / spacing)))
        step = L / n
        phase = h32(str(key) + "p") * 0.5
        chain = []
        for k in range(n + 1):
            s = min(L, (k + phase) * step) if n > 1 else L / 2
            if s > L:
                break
            pc = interp(r["p"], r["c"], s)
            t = tangent(r["p"], r["c"], s, 1.5)
            nrm = np.array([-t[1], t[0]])
            sides = [side0]
            if how == "both":
                sides = [side0 if k % 2 == 0 else -side0]
                if cls in ("trunk", "primary") or r["lanes"] >= 4:
                    sides = [1, -1] if k % 2 == 0 else []
            for side in sides:
                ok = None
                for extra in (0.0, 0.8, 1.6, -0.3):
                    q = pc + nrm * side * (off + extra)
                    if not blocked(q):
                        ok = q
                        break
                if ok is None:
                    if how == "chain" and chain:
                        chains.append(chain)
                        chain = []
                    continue
                if near_existing(ok, 12 if how == "chain" else 9):
                    if how == "chain" and chain:
                        chains.append(chain)
                        chain = []
                    continue
                if how == "chain":
                    lamp = (k % 2 == 0)
                    idx = put(ok, hdg(*(-nrm * side)), 2 if lamp else 4, -1, len(chains))
                    chain.append(idx)
                else:
                    put(ok, hdg(*(-nrm * side)), typ)
        if how == "chain" and len(chain) >= 2:
            chains.append(chain)
        elif how == "chain" and chain:
            for i in chain:
                lights[i][5] = -1
    # fix chain indices (chains list order == chain id at creation time only if appended in order)
    for l in lights:
        l[5] = -1
    for ci, ch in enumerate(chains):
        for i in ch:
            lights[i][5] = ci
    log(f"furniture: {len(lights)} street lights / poles, {len(chains)} pole chains")

    # ---------------------------------------------------------------- traffic signals
    signals = []
    for sg in marks["signals"]:
        for ap in sg["app"]:
            if not ap["toward"]:
                continue
            base = np.array([ap["x"], ap["z"]])
            right = np.array([ap["rx"], ap["rz"]])
            for extra in (0.7, 1.5, 2.5):
                q = base + right * (ap["hw"] + extra)
                if not carriage.contains(Point(q)):
                    break
            signals.append([round(float(q[0]), 2), round(float(q[1]), 2), round(ap["heading"], 1), ap["phase"], sg["node"]])
    log(f"furniture: {len(signals)} signal heads")

    # ---------------------------------------------------------------- bus stops
    tbl = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet"), columns=["class", "subtype", "geometry", "source_tags", "names"]).to_pylist()
    drive = [r for r in rlines if r["kind"] == "road" and r["cls"] in DRIVE and r["group"] < 0 and r["cls"] != "track"]
    dtree = STRtree([r["line"] for r in drive])
    anyl = [r for r in rlines if r["kind"] == "road" and r["group"] < 0]
    atree = STRtree([r["line"] for r in anyl])
    stops, stop_names = [], []
    name_idx = {}
    for row in tbl:
        if row["class"] != "bus_stop":
            continue
        g = to_world(row["geometry"])
        P = g if g.geom_type == "Point" else g.centroid
        if abs(P.x) > 10200 or abs(P.y) > 10200:
            continue
        j = dtree.query_nearest(P, max_distance=40)
        if len(j) == 0:
            continue
        r = drive[int(j[0])]
        s = r["line"].project(P)
        pc = interp(r["p"], r["c"], s)
        t = tangent(r["p"], r["c"], s, 2.0)
        nrm = np.array([-t[1], t[0]])
        d = np.array([P.x, P.y]) - pc
        side = 1 if np.dot(d, nrm) >= 0 else -1
        tags = dict(row["source_tags"] or {})
        sw = r.get("sw")
        back = r["hw"] + ((sw[0] + sw[1] + 0.9) if sw else 2.4)
        q = None
        for bb in (back, back - 0.8, back + 1.5, r["hw"] + 1.6):
            cand = pc + nrm * side * bb
            if not blocked(cand, 0.8):
                q = cand
                break
        if q is None:
            continue
        zone = int(zone_at(q[0], q[1]))
        sh = tags.get("shelter")
        if sh == "no":
            typ = 2
        elif sh == "yes" or zone in (Z_APART, Z_INDUSTRIAL) or r["cls"] in MAJOR:
            typ = 1 if (zone in (Z_PRIVATE, Z_RURAL) and h32(str(P.x)) < 0.45) else 0
        else:
            typ = 2 if h32(str(P.y)) < 0.5 else 1
        name = (row["names"] or {}).get("primary") or ""
        if name not in name_idx:
            name_idx[name] = len(stop_names)
            stop_names.append(name)
        stops.append([round(float(q[0]), 2), round(float(q[1]), 2), round(hdg(*(-nrm * side)), 1), typ, name_idx[name]])
    log(f"furniture: {len(stops)} bus stops")

    # ---------------------------------------------------------------- benches
    benches = []
    for row in tbl:
        if row["class"] != "bench":
            continue
        g = to_world(row["geometry"])
        P = g if g.geom_type == "Point" else g.centroid
        if abs(P.x) > 10200 or abs(P.y) > 10200:
            continue
        j = atree.query_nearest(P, max_distance=30)
        heading = 0.0
        if len(j):
            r = anyl[int(j[0])]
            s = r["line"].project(P)
            pc = interp(r["p"], r["c"], s)
            d = pc - np.array([P.x, P.y])
            if np.linalg.norm(d) > 0.1:
                heading = hdg(*(d / np.linalg.norm(d)))
        benches.append([round(P.x, 2), round(P.y, 2), round(heading, 1)])

    # ---------------------------------------------------------------- signs
    signs = []
    for c in marks["crossings"]:
        t = np.array([c["tx"], c["tz"]])
        right = np.array([-t[1], t[0]])
        for sgn in (1, -1):
            q = np.array([c["x"], c["z"]]) - t * sgn * (c["len"] / 2 + 0.3) + right * sgn * (c["hw"] + 0.75)
            if blocked(q, 0.2):
                q = q + right * sgn * 0.8
            signs.append([round(float(q[0]), 2), round(float(q[1]), 2), round(hdg(*(-t * sgn)), 1), 0])
    jp = junctions["pts"]
    jtree = STRtree(shapely.points(jp)) if len(jp) else None
    for p in marks["points"]:
        if p["cls"] not in ("give_way", "stop"):
            continue
        P = Point(p["x"], p["z"])
        j = dtree.query_nearest(P, max_distance=15)
        if len(j) == 0 or jtree is None:
            continue
        r = drive[int(j[0])]
        s = r["line"].project(P)
        pc = interp(r["p"], r["c"], s)
        t = tangent(r["p"], r["c"], s, 2.0)
        k = jtree.query_nearest(P)
        jn = jp[int(k[0])]
        if np.dot(jn - pc, t) < 0:
            t = -t
        right = np.array([-t[1], t[0]])
        q = pc + right * (r["hw"] + 0.8)
        signs.append([round(float(q[0]), 2), round(float(q[1]), 2), round(hdg(*(-t)), 1), 1 if p["cls"] == "give_way" else 2])
    log(f"furniture: {len(signs)} signs, {len(benches)} benches")

    # ---------------------------------------------------------------- fences, walls, guard rails
    nf = 0
    for row in tbl:
        cls = row["class"]
        if cls not in ("fence", "wall", "guard_rail") and not (cls == "substation" and row["subtype"] == "power"):
            continue
        g = to_world(row["geometry"])
        if not g.intersects(shapely.box(-10240, -10240, 10240, 10240)):
            continue
        kind = K_FENCE if cls in ("fence", "substation") else (K_WALL if cls == "wall" else K_GUARD)
        style = 0
        tags = dict(row["source_tags"] or {})
        if cls == "substation":
            style = 1
        if tags.get("fence_type") in ("chain_link", "mesh"):
            style = 1
        ls = []
        if g.geom_type in ("Polygon", "MultiPolygon"):
            for poly in polys_of(g):
                ls.append(np.array(poly.exterior.coords))
        else:
            ls = [np.array(x.coords) for x in lines_of(g)]
        for pts in ls:
            if len(pts) >= 2:
                pool.add(pts, kind, style, 0.1 if kind == K_FENCE else 0.3)
                nf += 1
    log(f"furniture: {nf} fence/wall polylines")
    crossings = [[round(c["x"], 2), round(c["z"], 2), round(c["tx"], 4), round(c["tz"], 4), round(c["hw"], 2), c["len"]] for c in marks["crossings"]]
    flat = []
    for l in lights:
        flat += [round(l[0], 2), round(l[1], 2), round(l[2], 1), l[3], l[4], l[5]]
    return dict(lights=flat, chains=chains, signals=signals, stops=stops, stopNames=stop_names, benches=benches,
                signs=signs, crossings=crossings)
