"""Road / rail conflict filter for build_buildings.py (cross-module rule with `roads`).

Microsoft-ML footprints are detected from imagery and sometimes land on a road
carriageway or a rail bed: sheds in dacha streets where the OSM centreline is
slightly off, bridge decks, parked lorries, platform canopies. The roads module
renders the carriageways from the same Overture segments, so a building there
would be cut by the road.

  * carriageway = drivable segment buffered by (build_roads.py WIDTH / 2 - 0.5 m),
    tunnels excluded; rail = centreline +- 2.2 m
  * ML footprint with > 30 % of its area on a carriageway/rail -> dropped
  * ML footprint with 8..30 % -> carriageway subtracted; kept if the remaining
    largest piece is >= 60 % of the original and not a sliver, else dropped
  * OSM footprints (human mapped) are never touched
"""
import os

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely import from_wkb

from config import RAW, to_local
from buildings_geom import mrr_dims

# keep in sync with pipeline/build_roads.py WIDTH (full widths, m)
WIDTH = {"motorway": 20, "trunk": 16, "primary": 14, "secondary": 12, "tertiary": 9, "residential": 7,
         "unclassified": 6, "living_street": 6, "service": 4.5, "track": 3.5, "unknown": 5}
RAIL_HALF = 2.2


def _is_tunnel(r):
    for f in (r.get("road_flags") or []) + (r.get("rail_flags") or []):
        if "is_tunnel" in (f.get("values") or []):
            return True
    return False


def carriageways():
    tr = to_local()
    t = pq.read_table(os.path.join(RAW, "transportation_segment.parquet"),
                      columns=["subtype", "class", "road_flags", "rail_flags", "geometry"]).to_pylist()
    polys = []
    for r in t:
        if _is_tunnel(r):
            continue
        g = shapely.transform(from_wkb(r["geometry"]), lambda c: np.column_stack(tr.transform(c[:, 0], c[:, 1])))
        if r["subtype"] == "road" and r["class"] in WIDTH:
            polys.append(g.buffer(WIDTH[r["class"]] / 2 - 0.5, cap_style="flat"))
        elif r["subtype"] == "rail":
            polys.append(g.buffer(RAIL_HALF, cap_style="flat"))
    return np.array(polys, dtype=object)


def filter_on_roads(recs, drop_frac=0.3, trim_frac=0.08, verbose=True):
    """Returns (keep mask, n_dropped, n_trimmed). Trimmed records get a new 'geom' in place."""
    P = carriageways()
    tree = shapely.STRtree(P)
    geoms = np.array([r["geom"] for r in recs], dtype=object)
    osm = np.array([r["osm"] for r in recs])
    bi, pi = tree.query(geoms, predicate="intersects")
    keep = np.ones(len(recs), bool)
    hits = {}
    for b, p in zip(bi, pi):
        if not osm[b]:
            hits.setdefault(int(b), []).append(int(p))
    dropped = trimmed = 0
    for b, ps in hits.items():
        g = geoms[b]
        u = shapely.union_all(P[ps])
        ov = shapely.intersection(g, u).area
        frac = ov / max(g.area, 1e-6)
        if frac <= trim_frac:
            continue
        if frac > drop_frac:
            keep[b] = False
            dropped += 1
            continue
        rest = shapely.difference(g, u.buffer(0.3))
        pieces = [q for q in getattr(rest, "geoms", [rest]) if q.geom_type == "Polygon" and not q.is_empty]
        if not pieces:
            keep[b] = False
            dropped += 1
            continue
        q = max(pieces, key=lambda x: x.area).simplify(0.3, preserve_topology=True)
        L, W, _, _ = mrr_dims(q) if q.area > 0 else (0, 0, 0, 0)
        if q.area < 0.6 * g.area or q.area < 8.0 or W < 1.8:
            keep[b] = False
            dropped += 1
            continue
        recs[b]["geom"] = shapely.geometry.polygon.orient(q, 1.0)
        trimmed += 1
    if verbose:
        print(f"[roads] ML footprints on carriageways/rail: {dropped} dropped, {trimmed} trimmed")
    return keep, dropped, trimmed
