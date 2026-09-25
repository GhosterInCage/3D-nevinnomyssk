"""Road markings for build_roads.py (Russian GOST R 51256 style).

Polylines go to the pool as kind K_MARK with a style (see MARK_STYLES in build_roads.py) and a width.
  * centre lines: 1.3 double solid on 4+ lane roads, 1.5 dashed on 2-lane roads (1.1 solid near junctions)
  * lane dividers: 1.5 dashed
  * edge lines: 1.2 solid on rural trunk / secondary roads
  * zebra crossings (1.14.1) at infrastructure 'crossing' points (stripes parallel to the road)
  * stop lines (1.12) on approaches of signalised junctions
Returns crossings / signal approaches for the furniture step.
"""
import os
from collections import defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from config import RAW
from roads_mesh import cumlen, interp, tangent, offset_polyline, resample, lines_of, merge_lines

K_MARK = 2
M_SOLID, M_DASH_URBAN, M_DASH_RURAL, M_EDGE, M_ZEBRA, M_STOP, M_ZEBRA_Y, M_DASH_SHORT = range(8)
MAJOR = {"motorway", "trunk", "primary", "secondary", "tertiary"}
FOOT = {"footway", "path", "cycleway", "steps", "pedestrian", "bridleway"}
DRIVE = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service"}


def load_points(classes, to_world_fn=None):
    from roads_mesh import to_world
    tbl = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet"), columns=["class", "geometry", "source_tags", "names"]).to_pylist()
    out = []
    for r in tbl:
        if r["class"] not in classes:
            continue
        g = to_world(r["geometry"])
        if g.geom_type != "Point":
            g = g.centroid
        tags = dict(r["source_tags"] or {})
        out.append(dict(cls=r["class"], x=g.x, z=g.y, tags=tags, name=(r["names"] or {}).get("primary")))
    return out


def markings(rlines, polys, junctions, graph, pool, log):
    carriage = polys["carriage"]
    jp = junctions["pts"]
    jr = junctions["r"]
    discs = shapely.buffer(shapely.points(jp), jr + 0.6) if len(jr) else np.array([])
    nears = shapely.buffer(shapely.points(jp), jr + 15) if len(jr) else np.array([])
    dtree = STRtree(discs) if len(discs) else None
    ntree = STRtree(nears) if len(nears) else None
    inner = carriage.buffer(-0.12)
    # tile the (huge) carriageway polygon so per-line clipping stays local
    TS = 256.0
    inner_tiles = {}
    bx0, bz0, bx1, bz1 = inner.bounds
    for i in range(int(np.floor(bx0 / TS)), int(np.floor(bx1 / TS)) + 1):
        for j in range(int(np.floor(bz0 / TS)), int(np.floor(bz1 / TS)) + 1):
            t = shapely.clip_by_rect(inner, i * TS - 30, j * TS - 30, (i + 1) * TS + 30, (j + 1) * TS + 30)
            if not t.is_empty:
                inner_tiles[(i, j)] = t

    def local_inner(g):
        x0, z0, x1, z1 = g.bounds
        parts = [inner_tiles[(i, j)] for i in range(int(np.floor(x0 / TS)), int(np.floor(x1 / TS)) + 1)
                 for j in range(int(np.floor(z0 / TS)), int(np.floor(z1 / TS)) + 1) if (i, j) in inner_tiles]
        if not parts:
            return None
        u = parts[0] if len(parts) == 1 else shapely.union_all(parts)
        return shapely.clip_by_rect(u, x0 - 1, z0 - 1, x1 + 1, z1 + 1)

    def local_union(tree, geoms, g):
        if tree is None:
            return None
        idx = tree.query(g)
        if len(idx) == 0:
            return None
        return shapely.union_all(geoms[idx])

    n_mark = 0

    def emit(pts, style, width, group, clip=True):
        nonlocal n_mark
        ls = LineString(pts)
        if clip and group < 0:
            g = ls
            jd = local_union(dtree, discs, g)
            if jd is not None:
                g = g.difference(jd)
            li = local_inner(ls)
            g = g.intersection(li) if li is not None else LineString()
            pieces = merge_lines(g)
        else:
            pieces = [ls]
        for pc in pieces:
            if pc.length < 1.0:
                continue
            p = np.array(pc.coords)
            jn = local_union(ntree, nears, pc) if style in (M_DASH_URBAN, M_DASH_RURAL) and group < 0 else None
            if jn is not None:
                # solid (1.1) in the last ~20 m before junctions
                near = pc.intersection(jn)
                far = pc.difference(jn)
                for q in merge_lines(near):
                    if q.length > 1.0:
                        pool.add(np.array(q.coords), K_MARK, M_SOLID, width, group)
                        n_mark += 1
                for q in merge_lines(far):
                    if q.length > 1.0:
                        pool.add(np.array(q.coords), K_MARK, style, width, group)
                        n_mark += 1
                continue
            pool.add(p, K_MARK, style, width, group)
            n_mark += 1

    for r in rlines:
        if r["kind"] != "road" or r["cls"] in FOOT:
            continue
        if not (r["cls"] in MAJOR or r["sub"] == "link"):
            continue
        if r["surf"] not in (0, 1, 2):
            continue
        if r["c"][-1] < 8:
            continue
        p = resample(r["p"], 4.0)
        hw, lanes, g = r["hw"], r["lanes"], r["group"]
        rural = r["zone"] == 0
        dash = M_DASH_RURAL if rural else M_DASH_URBAN
        if r["oneway"] == 0:
            if lanes >= 4:
                emit(offset_polyline(p, 0.1), M_SOLID, 0.1, g)
                emit(offset_polyline(p, -0.1), M_SOLID, 0.1, g)
                emit(offset_polyline(p, hw / 2), dash, 0.1, g)
                emit(offset_polyline(p, -hw / 2), dash, 0.1, g)
            elif lanes >= 2:
                emit(p, dash, 0.1, g)
        else:
            if lanes >= 2:
                emit(p, dash, 0.1, g)
        if r["cls"] in ("trunk", "motorway", "primary") or (rural and r["cls"] == "secondary"):
            emit(offset_polyline(p, hw - 0.35), M_EDGE, 0.15, g)
            emit(offset_polyline(p, -(hw - 0.35)), M_EDGE, 0.15, g)
    log(f"markings: {n_mark} line polylines")

    # ---------------- parking stalls (perpendicular 2.5 m bays along the long sides of each lot)
    n_park = 0
    parking = polys["surfaces"].get(9)
    for pg in ([] if parking is None else [q for q in getattr(parking, "geoms", [parking]) if q.geom_type == "Polygon"]):
        if pg.area < 180:
            continue
        rr = np.array(pg.minimum_rotated_rectangle.exterior.coords)[:4]
        e0, e1 = rr[1] - rr[0], rr[2] - rr[1]
        if np.linalg.norm(e0) < np.linalg.norm(e1):
            rr = np.roll(rr, -1, axis=0)
            e0, e1 = rr[1] - rr[0], rr[2] - rr[1]
        L, W = np.linalg.norm(e0), np.linalg.norm(e1)
        if L < 8 or W < 5.5:
            continue
        u, v = e0 / L, e1 / W
        inner_p = pg.buffer(-0.25)
        rows = [(rr[0], v)] + ([(rr[3], -v)] if W >= 13 else [])
        for base, dirv in rows:
            k = 1
            while k * 2.5 < L - 1.0:
                a = base + u * k * 2.5
                ln = LineString([a, a + dirv * 5.0]).intersection(inner_p)
                for piece in lines_of(ln):
                    if piece.length > 2.0:
                        pool.add(np.array(piece.coords), K_MARK, M_SOLID, 0.1, -1)
                        n_park += 1
                k += 1
    log(f"markings: {n_park} parking stall lines")

    # ---------------- zebra crossings
    pts = load_points({"crossing", "traffic_signals", "give_way", "stop"})
    road_l = [r for r in rlines if r["kind"] == "road" and r["cls"] in DRIVE and r["group"] < 0]
    tree = STRtree([r["line"] for r in road_l])
    crossings = []
    for c in pts:
        if c["cls"] != "crossing":
            continue
        t = c["tags"]
        kind = t.get("crossing", "")
        mk = t.get("crossing:markings", "")
        if kind in ("unmarked", "no") or mk == "no":
            continue
        if not (kind in ("marked", "zebra", "traffic_signals", "uncontrolled", "") or mk):
            continue
        P = Point(c["x"], c["z"])
        j = tree.query_nearest(P, max_distance=6.0)
        if len(j) == 0:
            continue
        r = road_l[int(j[0])]
        if r["cls"] == "service" and not mk.startswith("zebra"):
            continue
        if r["surf"] not in (0, 1, 2, 10):
            continue
        s = r["line"].project(P)
        pc = interp(r["p"], r["c"], s)
        tt = tangent(r["p"], r["c"], s, 2.0)
        nrm = np.array([-tt[1], tt[0]])
        hw = r["hw"]
        ln = 4.0 if r["cls"] in MAJOR else 3.0
        W = 2 * hw - 0.5
        nst = max(2, int(np.floor((W + 0.55) / 1.1)))
        start = -(nst - 1) * 1.1 / 2
        bicol = "bicolour" in mk or "yellow" in t.get("crossing:markings:colour", "")
        for k in range(nst):
            u = start + k * 1.1
            a = pc + nrm * u - tt * ln / 2
            b = pc + nrm * u + tt * ln / 2
            style = M_ZEBRA_Y if (bicol and k % 2 == 1) else M_ZEBRA
            pool.add(np.array([a, b]), K_MARK, style, 0.55, -1)
        signal = kind == "traffic_signals" or "traffic_signals" in t.get("crossing", "")
        crossings.append(dict(x=float(pc[0]), z=float(pc[1]), tx=float(tt[0]), tz=float(tt[1]), hw=float(hw), len=ln,
                              signal=bool(signal), cls=r["cls"], rid=r["id"]))
    log(f"markings: {len(crossings)} zebra crossings")

    # ---------------- signalised junction approaches + stop lines
    nodes = graph["nodes"]
    edges = graph["edges"]
    inc = defaultdict(list)
    for ei, e in enumerate(edges):
        if e["cls"] not in DRIVE or e["tunnel"]:
            continue
        inc[e["a"]].append((ei, 0))
        inc[e["b"]].append((ei, 1))
    ntree = STRtree(shapely.points(nodes))
    cr_pts = np.array([[c["x"], c["z"]] for c in crossings]) if crossings else np.zeros((0, 2))
    signals = []
    seen = set()
    for c in pts:
        if c["cls"] != "traffic_signals":
            continue
        P = Point(c["x"], c["z"])
        cand = ntree.query(P.buffer(14))
        best = None
        for k in cand:
            if len(inc.get(int(k), [])) < 2:
                continue
            d = np.hypot(*(nodes[k] - [c["x"], c["z"]]))
            deg = len(inc[int(k)])
            score = d - (6 if deg >= 3 else 0)
            if best is None or score < best[0]:
                best = (score, int(k))
        if best is None:
            continue
        nk = best[1]
        if nk in seen:
            continue
        seen.add(nk)
        node = nodes[nk]
        deg = len(inc[nk])
        rj = 0.0
        for ei, end in inc[nk]:
            rj = max(rj, edges[ei]["w"] / 2)
        approaches = []
        for ei, end in inc[nk]:
            e = edges[ei]
            p = e["pts"] if end == 0 else e["pts"][::-1]
            cl = cumlen(p)
            has_cw = False
            d0 = (rj + 1.5) if deg >= 3 else 2.5
            # a zebra near the node on this approach pushes the stop line back
            if len(cr_pts):
                q = interp(p, cl, min(cl[-1], d0 + 2))
                dd = np.hypot(cr_pts[:, 0] - q[0], cr_pts[:, 1] - q[1])
                if dd.min() < 6:
                    has_cw = True
            d = d0 + (4.5 if has_cw else 0.5)
            if cl[-1] < d + 2:
                continue
            pc = interp(p, cl, d)
            t_out = tangent(p, cl, d, 1.5)
            t_in = -t_out
            right_in = np.array([-t_in[1], t_in[0]])
            hw = e["w"] / 2
            # which directions may approach the node on this edge?
            toward_ok = True
            if e["oneway"] == 1 and end == 0:
                toward_ok = False  # forward only: a -> b, node at a => traffic leaves
            if e["oneway"] == -1 and end == 1:
                toward_ok = False
            if toward_ok:
                if e["oneway"] != 0:
                    a, b = pc - right_in * (hw - 0.3), pc + right_in * (hw - 0.3)
                else:
                    a, b = pc + right_in * 0.15, pc + right_in * (hw - 0.3)
                if e["bridge"] < 0:
                    pool.add(np.array([a, b]), K_MARK, M_STOP, 0.4, -1)
            heading = float(np.degrees(np.arctan2(t_out[0], -t_out[1])) % 360)  # facing out = towards drivers
            approaches.append(dict(x=float(pc[0]), z=float(pc[1]), rx=float(right_in[0]), rz=float(right_in[1]), hw=float(hw),
                                   heading=heading, toward=toward_ok, edge=ei, ang=float(np.arctan2(t_out[1], t_out[0]))))
        if not approaches:
            continue
        # two phase groups by axis
        a0 = approaches[0]["ang"]
        for ap in approaches:
            dth = abs(((ap["ang"] - a0) + np.pi / 2) % np.pi - np.pi / 2)
            ap["phase"] = 0 if dth < np.pi / 4 else 1
        signals.append(dict(node=nk, x=float(node[0]), z=float(node[1]), deg=deg, app=approaches))
    log(f"markings: {len(signals)} signalised nodes")
    return dict(crossings=crossings, signals=signals, points=pts)
