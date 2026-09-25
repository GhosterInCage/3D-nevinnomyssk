"""Railway objects for build_roads.py: tracks, electrification (catenary supports), level crossings.

Output (objects.json.gz -> "rail"):
  tracks:    [{p:[x,z,...], el:0|1, dis:0|1, g:bridgeGroup, sup:[[s, type], ...]}]
             sup = catenary supports along the track (arc length s, metres):
                   type 1 = mast on the right side (+normal (-tz,tx)), -1 = mast on the left, 2 = portal/head-span
  portals:   [[x0,z0,x1,z1], ...] rigid cross beams spanning several electrified tracks (station yard)
  crossings: [[x,z,r], ...] level crossings (road over rail): rails are lowered to road level inside r
"""
import numpy as np
import shapely
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from roads_mesh import cumlen, interp, tangent, r1

AZOT_BOX = (-2500, -6000, 4000, -300)  # x0, z0, x1, z1 : industrial network north of the city (not electrified)
MAST_OFF = 3.3
SPAN = 55.0


def _in_box(p, b):
    return b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]


def rail_objects(rlines, polys, pool, log):
    tracks = [r for r in rlines if r["kind"] == "rail"]
    if not tracks:
        return dict(tracks=[], portals=[], crossings=[])
    # ---- electrification: long main-line segments outside the industrial network + parallel yard tracks
    main = []
    for r in tracks:
        s = r["seg"]
        cen = s["p"].mean(0)
        if s["L"] < 1500 or r["disused"]:
            continue
        if _in_box(cen, AZOT_BOX):
            continue
        if cen[1] > 2500 and cen[0] < -800:  # Cherkessk branch (diesel)
            continue
        main.append(r)
    main_ids = {id(r) for r in main}
    main_tree = STRtree([r["line"] for r in main]) if main else None
    for r in tracks:
        r["el"] = False
        if r["disused"]:
            continue
        if id(r) in main_ids:
            r["el"] = True
            continue
        if main_tree is None:
            continue
        mid = interp(r["p"], r["c"], r["c"][-1] / 2)
        if _in_box(mid, AZOT_BOX):
            continue
        near = main_tree.query(Point(mid).buffer(60))
        if len(near) == 0:
            continue
        # parallel?
        t = tangent(r["p"], r["c"], r["c"][-1] / 2, 5.0)
        for k in near:
            m = main[k]
            s = m["line"].project(Point(mid))
            if m["line"].distance(Point(mid)) > 60:
                continue
            tm = tangent(m["p"], m["c"], s, 5.0)
            if abs(np.dot(t, tm)) > 0.94:
                r["el"] = True
                break
    el = [r for r in tracks if r["el"]]
    log(f"rail: {len(tracks)} track lines, {len(el)} electrified ({sum(r['c'][-1] for r in el) / 1000:.1f} km)")
    el_tree = STRtree([r["line"] for r in el]) if el else None
    carriage = polys["carriage"]
    shapely.prepare(carriage)

    # ---- mast candidates
    requests = []
    for ti, r in enumerate(el):
        L = r["c"][-1]
        r["sup"] = []
        if L < 20:
            continue
        n = max(1, int(round(L / SPAN)))
        step = L / n
        for k in range(n + 1):
            s = min(L, k * step)
            pc = interp(r["p"], r["c"], s)
            t = tangent(r["p"], r["c"], s, 2.0)
            nrm = np.array([-t[1], t[0]])
            chosen = None
            for side in (1, -1):
                q = pc + nrm * side * MAST_OFF
                blocked = False
                for j in el_tree.query(Point(q).buffer(2.6)):
                    if el[j] is r:
                        continue
                    if el[j]["line"].distance(Point(q)) < 2.4:
                        blocked = True
                        break
                if not blocked and carriage.contains(Point(q)):
                    blocked = True
                if not blocked:
                    chosen = side
                    break
            if chosen is not None:
                r["sup"].append([s, chosen])
            else:
                requests.append((ti, s, pc, nrm))
    # ---- portals for interior tracks (cluster requests on a 30 m grid)
    portals = []
    used = set()
    for ti, s, pc, nrm in requests:
        key = (int(pc[0] // 30), int(pc[1] // 30))
        if key in used:
            continue
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                used.add((key[0] + dx, key[1] + dz))
        probe = LineString([pc - nrm * 90, pc + nrm * 90])
        offs = []
        hits = []
        for j in el_tree.query(probe):
            ip = el[j]["line"].intersection(probe)
            pts = [ip] if ip.geom_type == "Point" else [g for g in getattr(ip, "geoms", []) if g.geom_type == "Point"]
            for p in pts:
                o = float(np.dot(np.array(p.coords[0]) - pc, nrm))
                offs.append(o)
                hits.append((j, el[j]["line"].project(p), o))
        if len(offs) < 2:
            continue
        # keep the contiguous cluster of tracks around the requesting one (gaps < 12 m)
        order = np.argsort(offs)
        so = np.array(offs)[order]
        i0 = int(np.argmin(np.abs(so)))
        lo, hi = i0, i0
        while lo > 0 and so[lo] - so[lo - 1] < 12:
            lo -= 1
        while hi < len(so) - 1 and so[hi + 1] - so[hi] < 12:
            hi += 1
        a = pc + nrm * (so[lo] - MAST_OFF - 0.4)
        b = pc + nrm * (so[hi] + MAST_OFF + 0.4)
        if carriage.contains(Point(a)) or carriage.contains(Point(b)):
            continue
        portals.append([float(a[0]), float(a[1]), float(b[0]), float(b[1])])
        for k in order[lo:hi + 1]:
            j, sj, _ = hits[k]
            el[j]["sup"] = [x for x in el[j]["sup"] if abs(x[0] - sj) > SPAN * 0.45]
            el[j]["sup"].append([sj, 2])
    for r in el:
        r["sup"].sort(key=lambda x: x[0])
    log(f"rail: {sum(len(r['sup']) for r in el)} catenary supports, {len(portals)} portals")

    # ---- level crossings
    crossings = []
    road_drv = [r for r in polys["road"] if r["cls"] not in ("footway", "path", "steps", "cycleway", "pedestrian")]
    rtree = STRtree([r["line"] for r in road_drv]) if road_drv else None
    for r in tracks:
        if r["group"] >= 0 or rtree is None:
            continue
        for j in rtree.query(r["line"]):
            o = road_drv[j]
            ip = r["line"].intersection(o["line"])
            if ip.is_empty:
                continue
            pts = [ip] if ip.geom_type == "Point" else [g for g in getattr(ip, "geoms", []) if g.geom_type == "Point"]
            for p in pts:
                crossings.append([round(p.x, 2), round(p.y, 2), round(o["hw"] + 1.5, 2)])
    log(f"rail: {len(crossings)} level crossings")
    out_tracks = []
    for r in tracks:
        out_tracks.append(dict(p=r1(r["p"], 2), el=1 if r["el"] else 0, dis=1 if r["disused"] else 0, g=r["group"],
                               sup=[[round(float(s), 2), int(t)] for s, t in r.get("sup", [])]))
    return dict(tracks=out_tracks, portals=[r1(p, 2) for p in portals], crossings=crossings)
