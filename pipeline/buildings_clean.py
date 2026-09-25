"""Stage 1 of build_buildings.py: load Overture footprints, clean and de-duplicate.

- project to the local frame, clip to the region
- make_valid, explode multipolygons, simplify (ML footprints are pixel-derived)
- drop slivers (area < 8 m2 or narrow side < 1.8 m)
- de-duplicate Microsoft-ML vs OSM (OSM wins), ML vs ML, OSM vs OSM
- subtract remaining partial overlaps from the ML footprint
- square up near-orthogonal footprints (+-12 deg), keeping holes
Result: list of dict records cached in data/processed/buildings_clean.pkl
"""
import math
import os
import pickle
import re
import time

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely import from_wkb, STRtree

from config import RAW, PROC, REGION_HALF, to_local
from buildings_geom import polygons_of, square_polygon, mrr_dims, orthogonality

CACHE = os.path.join(PROC, "buildings_clean.pkl")


def _load_raw():
    tab = pq.read_table(os.path.join(RAW, "buildings_building.parquet"))
    rows = tab.to_pylist()
    tr = to_local()
    recs = []
    for r in rows:
        g = from_wkb(r["geometry"])
        g = shapely.transform(g, lambda c: np.column_stack(tr.transform(c[:, 0], c[:, 1])))
        src = r["sources"][0] if r["sources"] else {}
        ds = src.get("dataset", "")
        osm_id = 0
        osm_kind = 0
        rid = src.get("record_id") or ""
        m = re.match(r"([nwr])(\d+)", rid)
        if ds == "OpenStreetMap" and m:
            osm_kind = {"n": 1, "w": 2, "r": 3}[m.group(1)]
            osm_id = int(m.group(2))
        name = (r["names"] or {}).get("primary") if r["names"] else None
        recs.append(dict(
            id=r["id"], osm=ds == "OpenStreetMap", osm_id=osm_id, osm_kind=osm_kind,
            geom=g, name=name, cls=r["class"], subtype=r["subtype"],
            levels=r["num_floors"], height=r["height"], min_height=r["min_height"],
            roof_shape=r["roof_shape"], underground=bool(r["is_underground"]),
        ))
    return recs


def _clean_one(g, osm):
    tol = 0.15 if osm else 0.45
    out = []
    for p in polygons_of(g, 4.0):
        p = p.simplify(tol, preserve_topology=True)
        for q in polygons_of(p, 4.0):
            # drop tiny holes
            if q.interiors:
                holes = [h for h in q.interiors if shapely.Polygon(h).area > 12.0]
                q = shapely.Polygon(q.exterior, holes)
            out.append(q)
    return out


def load_clean(force=False, verbose=True):
    if not force and os.path.exists(CACHE):
        with open(CACHE, "rb") as f:
            return pickle.load(f)
    t0 = time.time()
    raw = _load_raw()
    lim = REGION_HALF - 20
    recs = []
    for r in raw:
        if r["underground"]:
            continue
        c = r["geom"].centroid
        if abs(c.x) > lim or abs(c.y) > lim:
            continue
        for p in _clean_one(r["geom"], r["osm"]):
            rr = dict(r)
            rr["geom"] = p
            recs.append(rr)
    n0 = len(recs)

    def sliver(p):
        if p.area < 8.0:
            return True
        L, W, _, _ = mrr_dims(p)
        return W < 1.8 or (W < 3.0 and L / max(W, 1e-3) > 12)

    recs = [r for r in recs if not sliver(r["geom"])]
    n1 = len(recs)

    # ---------------------------------------------------------- de-duplication
    geoms = np.array([r["geom"] for r in recs], dtype=object)
    area = shapely.area(geoms)
    osm = np.array([r["osm"] for r in recs])
    tree = STRtree(geoms)
    a_idx, b_idx = tree.query(geoms, predicate="intersects")
    keep = np.ones(len(recs), bool)
    m = a_idx < b_idx
    a_idx, b_idx = a_idx[m], b_idx[m]
    inter = shapely.area(shapely.intersection(geoms[a_idx], geoms[b_idx]))
    # process larger overlaps first
    order = np.argsort(-inter)
    subtract = {}  # ml index -> list of osm geoms to subtract
    stats = dict(ml_vs_osm=0, ml_vs_ml=0, osm_vs_osm=0, trimmed=0)
    for k in order:
        a, b = a_idx[k], b_idx[k]
        if not keep[a] or not keep[b] or inter[k] < 0.5:
            continue
        smaller = a if area[a] <= area[b] else b
        frac = inter[k] / min(area[a], area[b])
        if osm[a] != osm[b]:
            ml = a if not osm[a] else b
            o = b if ml == a else a
            if inter[k] / area[ml] > 0.25 or inter[k] / area[o] > 0.5:
                keep[ml] = False
                stats["ml_vs_osm"] += 1
            else:
                subtract.setdefault(ml, []).append(geoms[o])
        elif not osm[a]:
            if frac > 0.3:
                keep[smaller] = False
                stats["ml_vs_ml"] += 1
            else:
                big = b if smaller == a else a
                subtract.setdefault(smaller, []).append(geoms[big])
        else:
            # OSM vs OSM: exact duplicates or a part inside a bigger outline
            ra, rb = recs[a], recs[b]
            if frac > 0.8 and (ra["levels"] == rb["levels"] or ra["levels"] is None or rb["levels"] is None):
                # keep the one with more information
                sa = (ra["levels"] is not None) + (ra["name"] is not None) + (ra["cls"] is not None)
                sb = (rb["levels"] is not None) + (rb["name"] is not None) + (rb["cls"] is not None)
                drop = smaller if sa == sb else (a if sa < sb else b)
                keep[drop] = False
                stats["osm_vs_osm"] += 1
    for i, gs in subtract.items():
        if not keep[i]:
            continue
        try:
            d = geoms[i].difference(shapely.union_all(gs))
        except Exception:
            continue
        ps = [p for p in polygons_of(d, 8.0) if not sliver(p)]
        if not ps:
            keep[i] = False
            continue
        geoms[i] = max(ps, key=lambda p: p.area)
        stats["trimmed"] += 1
    recs2 = []
    for i, r in enumerate(recs):
        if keep[i]:
            r["geom"] = geoms[i]
            recs2.append(r)
    recs = recs2
    n2 = len(recs)

    # ---------------------------------------------------------- squaring
    nsq = 0
    for r in recs:
        p = r["geom"]
        r["ortho"] = False
        q, theta = square_polygon(p, tol_deg=12.0 if not r["osm"] else 9.0)
        if q is not None:
            inter = p.intersection(q).area
            iou = inter / max(p.union(q).area, 1e-9)
            if iou > (0.86 if not r["osm"] else 0.9) and q.area > 6:
                r["geom"] = q
                r["ortho"] = True
                nsq += 1
        r["theta"] = theta
    # remove overlaps introduced by squaring? small, ignored.
    if verbose:
        print(f"[clean] raw {len(raw)} -> in region {n0} -> no slivers {n1} -> dedup {n2} "
              f"({stats}) squared {nsq}  {time.time() - t0:.1f}s")
    with open(CACHE, "wb") as f:
        pickle.dump(recs, f)
    return recs


if __name__ == "__main__":
    rs = load_clean(force=True)
    print(len(rs), sum(r["osm"] for r in rs), "osm")
