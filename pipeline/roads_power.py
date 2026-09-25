"""Power grid for build_roads.py: pylons and overhead lines from Overture infrastructure.

Output (objects.json.gz -> "power"):
  towers: flat list, 4 numbers per tower [x, z, heading, type]
          heading = line direction at the tower (deg cw from north)
          type: 0 P500 wine-glass (500 kV), 1 P330 wine-glass (330 kV), 2 P110-2 double-circuit lattice,
                3 P110-1 single-circuit lattice, 4 P35 lattice, 5 concrete 10 kV pole, 6 substation portal
  lines:  [{v: kV, c: circuits, b: conductors per phase bundle, t: [tower indices in order]}]
"""
import os
from collections import defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import Point
from shapely.strtree import STRtree

from config import RAW

LIM = 10150.0


def _volt(s):
    if not s:
        return 0
    best = 0
    for part in str(s).replace(",", ";").split(";"):
        try:
            best = max(best, int(float(part.strip())))
        except ValueError:
            pass
    return best


def power(to_world, region, log):
    tbl = pq.read_table(os.path.join(RAW, "base_infrastructure.parquet"), columns=["class", "subtype", "geometry", "source_tags"]).to_pylist()
    towers = []  # dict(x,z,kind,heading,v,c)
    lines = []
    for r in tbl:
        cls = r["class"]
        tags = dict(r["source_tags"] or {})
        if cls in ("power_tower", "power_pole", "portal"):
            if "disused" in tags or tags.get("power") == "disused":
                continue
            g = to_world(r["geometry"])
            if g.geom_type != "Point" or abs(g.x) > LIM or abs(g.y) > LIM:
                continue
            towers.append(dict(x=g.x, z=g.y, kind=cls, heading=None, v=0, c=1))
        elif cls in ("power_line", "minor_line"):
            g = to_world(r["geometry"])
            v = _volt(tags.get("voltage"))
            if cls == "minor_line" and not v:
                v = 10000
            try:
                circ = int(tags.get("circuits") or 0)
            except ValueError:
                circ = 0
            if not circ:
                try:
                    circ = max(1, int(tags.get("cables") or 3) // 3)
                except ValueError:
                    circ = 1
            bundle = {"single": 1, "double": 2, "triple": 3, "quad": 4}.get(tags.get("wires", ""), 1)
            for ls in ([g] if g.geom_type == "LineString" else list(getattr(g, "geoms", []))):
                lines.append(dict(p=np.array(ls.coords), v=v, c=min(circ, 2), b=bundle, cls=cls))
    tree = STRtree(shapely.points([(t["x"], t["z"]) for t in towers])) if towers else None
    out_lines = []
    for ln in lines:
        seq = []
        runs = []
        for q in ln["p"]:
            if abs(q[0]) > LIM or abs(q[1]) > LIM:
                if len(seq) >= 2:
                    runs.append(seq)
                seq = []
                continue
            k = None
            if tree is not None:
                j = tree.query_nearest(Point(q), max_distance=4.0)
                if len(j):
                    k = int(j[0])
            if k is None:
                towers.append(dict(x=float(q[0]), z=float(q[1]), kind="virtual", heading=None, v=0, c=1))
                k = len(towers) - 1
            if seq and seq[-1] == k:
                continue
            seq.append(k)
        if len(seq) >= 2:
            runs.append(seq)
        for seq in runs:
            v = ln["v"]
            if not v:
                kinds = [towers[k]["kind"] for k in seq]
                v = 10000 if kinds.count("power_pole") > len(kinds) / 2 else 110000
            for k in seq:
                towers[k]["v"] = max(towers[k]["v"], v)
                towers[k]["c"] = max(towers[k]["c"], ln["c"])
            # headings: bisector of the adjacent spans
            for i, k in enumerate(seq):
                if towers[k]["heading"] is not None:
                    continue
                a = seq[max(0, i - 1)]
                b = seq[min(len(seq) - 1, i + 1)]
                dx = towers[b]["x"] - towers[a]["x"]
                dz = towers[b]["z"] - towers[a]["z"]
                if abs(dx) + abs(dz) < 1e-6:
                    continue
                towers[k]["heading"] = float(np.degrees(np.arctan2(dx, -dz)) % 360)
            out_lines.append(dict(v=int(round(v / 1000)), c=ln["c"], b=ln["b"], t=seq))
    flat = []
    types = defaultdict(int)
    for t in towers:
        v = t["v"]
        if t["kind"] == "portal":
            typ = 6
        elif t["kind"] == "power_pole" or (0 < v < 20000):
            typ = 5
        elif v >= 450000:
            typ = 0
        elif v >= 300000:
            typ = 1
        elif v >= 100000 or v == 0:
            typ = 2 if t["c"] >= 2 else 3
        else:
            typ = 4
        types[typ] += 1
        flat += [round(t["x"], 2), round(t["z"], 2), round(t["heading"] if t["heading"] is not None else 0.0, 1), typ]
    log(f"power: {len(towers)} towers {dict(types)}, {len(out_lines)} line runs, "
        f"{sum(len(l['t']) - 1 for l in out_lines)} spans")
    return dict(towers=flat, lines=out_lines)
