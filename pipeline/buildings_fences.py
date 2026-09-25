"""Street fences of private-house plots (заборы) for build_buildings.py.

Plot boundaries are not in the open data, so they are inferred:
  * every private house is attached to its nearest drivable road (<= 45 m);
  * houses on the same road side are ordered along the road; each plot runs to
    the midpoints between neighbouring houses (4..14 m either side of the house);
  * the street fence line is set per road side at a consistent offset
    (median distance of the house fronts, clamped to [road half width + verge, +4 m]);
  * the fence is interrupted where the house itself stands on the street line,
    gets a gate, and short side fences between plots;
  * all pieces are clipped against building footprints and road carriageways.
Output: list of pieces (x0, y0, x1, y1, type, height, rgb) in pipeline coordinates.
Types: 0 corrugated sheet, 1 corrugated sheet with brick pillars, 2 wooden planks,
       3 metal picket (solid rendering), 4 gate (sheet metal in a frame).
"""
import math
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

import buildings_features as bf

# keep in sync with pipeline/build_roads.py WIDTH (full widths)
ROAD_W = {"trunk": 16, "primary": 14, "secondary": 12, "tertiary": 9, "residential": 7, "unclassified": 6,
          "living_street": 6, "service": 4.5, "track": 3.5}
VERGE = {"trunk": 6, "primary": 5, "secondary": 4, "tertiary": 3, "residential": 2.2, "unclassified": 2.2,
         "living_street": 2.0, "service": 1.8, "track": 1.8}

SHEET = [(69, 50, 46), (47, 69, 56), (94, 33, 41), (150, 153, 157), (30, 60, 120), (170, 172, 172), (110, 60, 40)]
WOOD = [(120, 96, 70), (100, 88, 76), (60, 100, 70), (70, 100, 130), (140, 120, 90)]
PICKET = [(40, 40, 40), (60, 90, 60), (40, 60, 100), (90, 60, 40)]


def load_drive_roads():
    import os
    import pyarrow.parquet as pq
    from shapely import from_wkb
    from config import RAW, to_local
    tr = to_local()
    t = pq.read_table(os.path.join(RAW, "transportation_segment.parquet"), columns=["subtype", "class", "geometry"]).to_pylist()
    lines, cls = [], []
    for r in t:
        if r["subtype"] != "road" or r["class"] not in ROAD_W:
            continue
        g = shapely.transform(from_wkb(r["geometry"]), lambda c: np.column_stack(tr.transform(c[:, 0], c[:, 1])))
        if g.geom_type == "LineString" and g.length > 1:
            lines.append(g)
            cls.append(r["class"])
    return np.array(lines, dtype=object), cls


def build_fences(recs, typ, house_types, rnd_of, verbose=True):
    roads, rcls = load_drive_roads()
    tree = STRtree(roads)
    geoms = [r["geom"] for r in recs]
    btree = STRtree(np.array(geoms, dtype=object))
    # road carriageway polygons (for clipping)
    carriage = [roads[i].buffer(ROAD_W[rcls[i]] / 2 + 0.6, cap_style=2) for i in range(len(roads))]
    ctree = STRtree(np.array(carriage, dtype=object))
    houses = [k for k in range(len(recs)) if typ[k] in house_types]
    att = []
    cen = [recs[k]["geom"].centroid for k in houses]
    idx, dist = tree.query_nearest(np.array(cen, dtype=object), max_distance=45.0, return_distance=True, all_matches=False)
    for (hi, j), dd in zip(idx.T, dist):
        k = houses[hi]
        line = roads[j]
        c = cen[hi]
        s = line.project(c)
        q = np.array(line.interpolate(s).coords[0])
        a = np.array(line.interpolate(max(0.0, s - 2)).coords[0])
        b = np.array(line.interpolate(min(line.length, s + 2)).coords[0])
        t = b - a
        tl = np.hypot(*t)
        if tl < 1e-6:
            continue
        t /= tl
        n = np.array([-t[1], t[0]])
        cv = np.array([c.x, c.y]) - q
        side = 1 if cv @ n >= 0 else -1
        n = n * side
        g = recs[k]["geom"]
        pts = np.asarray(g.exterior.coords) - q
        alongs = pts @ t
        outs = pts @ n
        if outs.min() < 0.5:  # house straddles the road line: ignore
            continue
        att.append(dict(k=k, j=int(j), side=side, s=s + float(np.mean(alongs)) * 0.0, q=q, t=t, n=n,
                        a=float(alongs.min()), b=float(alongs.max()), dn=float(outs.min()),
                        hw=ROAD_W[rcls[j]] / 2, verge=VERGE[rcls[j]]))
    groups = defaultdict(list)
    for h in att:
        groups[(h["j"], h["side"])].append(h)
    pieces = []
    for key, hs in groups.items():
        hs.sort(key=lambda h: h["s"])
        base = hs[0]["hw"] + hs[0]["verge"]
        offs = [min(max(h["dn"], base), base + 4.0) for h in hs]
        off = float(np.median(offs))
        rnd = rnd_of(f"street{key}")
        # most of a street shares a few fence styles; each plot picks one
        for i, h in enumerate(hs):
            r = rnd_of(f"fence{h['k']}")
            s0 = h["s"] + h["a"] - 4.0
            s1 = h["s"] + h["b"] + 4.0
            if i > 0:
                s0 = max(s0, 0.5 * (hs[i - 1]["s"] + h["s"]))
            else:
                s0 = max(s0, h["s"] - 14)
            if i + 1 < len(hs):
                s1 = min(s1, 0.5 * (hs[i + 1]["s"] + h["s"]))
            else:
                s1 = min(s1, h["s"] + 14)
            s0 = max(s0, h["s"] - 14)
            s1 = min(s1, h["s"] + 14)
            if s1 - s0 < 3:
                continue
            fo = min(off, h["dn"] + 0.3)  # never behind the house front
            q, t, n = h["q"], h["t"], h["n"]
            P = lambda s, o: q + t * (s - h["s"]) + n * o  # noqa: E731
            u = r.u()
            ftype = 0 if u < 0.62 else 1 if u < 0.72 else 2 if u < 0.9 else 3
            if ftype in (0, 1):
                col = r.pick(SHEET)
                height = r.rng(1.7, 2.05)
            elif ftype == 2:
                col = r.pick(WOOD)
                height = r.rng(1.5, 1.85)
            else:
                col = r.pick(PICKET)
                height = r.rng(1.4, 1.7)
            segs = []
            house_on_line = h["dn"] < fo + 1.2
            if house_on_line:
                ha, hb = h["s"] + h["a"] - 0.15, h["s"] + h["b"] + 0.15
                if ha - s0 > 1.0:
                    segs.append((s0, ha))
                if s1 - hb > 1.0:
                    segs.append((hb, s1))
            else:
                segs.append((s0, s1))
            if not segs:
                continue
            # gate in the longest segment
            li = int(np.argmax([b - a for a, b in segs]))
            a, b = segs[li]
            if b - a > 5.5:
                gw = r.rng(3.0, 3.8)
                gs = a + r.rng(0.5, b - a - gw - 0.5)
                segs = segs[:li] + [(a, gs), (gs, gs + gw, "gate"), (gs + gw, b)] + segs[li + 1:]
            for sg in segs:
                a, b = sg[0], sg[1]
                if b - a < 0.4:
                    continue
                is_gate = len(sg) == 3
                line = LineString([P(a, fo), P(b, fo)])
                pieces.append((line, 4 if is_gate else ftype, height + (0.05 if is_gate else 0.0),
                               r.pick(SHEET) if is_gate and ftype != 2 else col))
            # side fence on the right boundary (shared with the next plot)
            depth = r.rng(10, 18)
            if i + 1 < len(hs) or r.u() < 0.5:
                line = LineString([P(s1, fo), P(s1, fo + depth)])
                pieces.append((line, 0 if ftype in (0, 1) else ftype, height - 0.1, col))
            if i == 0:
                line = LineString([P(s0, fo), P(s0, fo + depth)])
                pieces.append((line, 0 if ftype in (0, 1) else ftype, height - 0.1, col))
    # clip against buildings and carriageways, split into <= 8 m pieces
    out = []
    lines = np.array([p[0] for p in pieces], dtype=object)
    for pi, (line, ftype, height, col) in enumerate(pieces):
        g = line
        near_b = btree.query(g.buffer(0.5))
        if len(near_b):
            g = g.difference(shapely.union_all([geoms[i].buffer(0.25) for i in near_b]))
        near_c = ctree.query(g)
        if len(near_c) and not g.is_empty:
            g = g.difference(shapely.union_all([carriage[i] for i in near_c]))
        if g.is_empty:
            continue
        parts = [g] if g.geom_type == "LineString" else [x for x in getattr(g, "geoms", []) if x.geom_type == "LineString"]
        for p in parts:
            L = p.length
            if L < 0.5:
                continue
            nseg = max(1, int(math.ceil(L / 8.0)))
            c = np.asarray(p.coords)
            a, b = c[0], c[-1]
            for m in range(nseg):
                p0 = a + (b - a) * (m / nseg)
                p1 = a + (b - a) * ((m + 1) / nseg)
                out.append((float(p0[0]), float(p0[1]), float(p1[0]), float(p1[1]), ftype, height, col))
    if verbose:
        print(f"[fences] {len(att)} houses on streets, {len(groups)} street sides, {len(out)} fence pieces")
    return out
