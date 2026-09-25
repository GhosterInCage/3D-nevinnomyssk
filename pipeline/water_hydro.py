"""Raster hydrology helpers for build_water.py.

RiverGrid rasterises a river-system polygon at a fine resolution and provides:
  * geodesic (along-channel) distance from inflow pixels  -> robust chainage for water levels
    (immune to meander limbs lying close to each other, unlike projecting onto a centreline)
  * a potential-flow solution (Laplace, Dirichlet 0 at inflows / 1 at outflows, Neumann at the banks)
    whose gradient is a physically plausible depth-averaged flow direction that splits around islands,
    never reverses in braids and is ~zero in dead-end backwaters.
  * NDWI water polygons for river reaches that have no mapped riverbank polygon.
"""
import math

import numpy as np
import shapely
from affine import Affine
from rasterio import features
from scipy import ndimage, sparse
from scipy.sparse import csgraph
from scipy.sparse.linalg import spsolve

NB8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
NB4 = [(-1, 0), (1, 0), (0, -1), (0, 1)]


class RiverGrid:
    def __init__(self, geom, res=5.0, pad=30.0):
        minx, miny, maxx, maxy = geom.bounds
        minx -= pad; miny -= pad; maxx += pad; maxy += pad
        self.res = res
        self.x0, self.y1 = minx, maxy
        self.w = int(math.ceil((maxx - minx) / res))
        self.h = int(math.ceil((maxy - miny) / res))
        self.T = Affine(res, 0, minx, 0, -res, maxy)      # cell-centred: centre of (r,c) = x0+(c+.5)res
        self.mask = features.rasterize([(geom, 1)], out_shape=(self.h, self.w), transform=self.T,
                                       all_touched=True, dtype=np.uint8).astype(bool)
        self.idx = np.full(self.mask.shape, -1, np.int64)
        self.n = int(self.mask.sum())
        self.idx[self.mask] = np.arange(self.n)
        self.rr, self.cc = np.nonzero(self.mask)
        self._graph = None

    # ---------------------------------------------------------------- coordinates
    def xy(self, r, c):
        return self.x0 + (c + 0.5) * self.res, self.y1 - (r + 0.5) * self.res

    def rc(self, x, y):
        return (self.y1 - np.asarray(y)) / self.res - 0.5, (np.asarray(x) - self.x0) / self.res - 0.5

    def pixels_near(self, x, y, radius, extra=None):
        px, py = self.xy(self.rr, self.cc)
        d = np.hypot(px - x, py - y)
        sel = d < radius
        if extra is not None:
            sel &= extra(px, py)
        return np.nonzero(sel)[0]

    # ---------------------------------------------------------------- graph
    def graph(self):
        if self._graph is None:
            a, b, w = [], [], []
            for dr, dc in NB8:
                r2 = self.rr + dr
                c2 = self.cc + dc
                ok = (r2 >= 0) & (r2 < self.h) & (c2 >= 0) & (c2 < self.w)
                r2, c2 = r2[ok], c2[ok]
                j = self.idx[r2, c2]
                good = j >= 0
                a.append(self.idx[self.rr[ok], self.cc[ok]][good])
                b.append(j[good])
                w.append(np.full(good.sum(), math.hypot(dr, dc) * self.res))
            a = np.concatenate(a); b = np.concatenate(b); w = np.concatenate(w)
            self._graph = sparse.csr_matrix((w, (a, b)), shape=(self.n, self.n))
        return self._graph

    def geodesic(self, sources):
        """Along-channel distance (m) from the source pixel set (node ids). inf where unreachable."""
        if len(sources) == 0:
            return np.full(self.n, np.inf)
        d = csgraph.dijkstra(self.graph(), directed=False, indices=np.asarray(sources), min_only=True)
        return d

    def to_raster(self, v, fill=np.nan):
        out = np.full(self.mask.shape, fill, np.float64)
        out[self.rr, self.cc] = v
        return out

    def filled(self, v):
        """Raster of node values with every non-mask/non-finite cell set to the nearest valid value."""
        r = self.to_raster(v)
        bad = ~np.isfinite(r)
        if bad.all():
            return np.zeros_like(r)
        _, (ir, ic) = ndimage.distance_transform_edt(bad, return_indices=True)
        return r[ir, ic]

    def sample(self, raster, x, y, order=1):
        r, c = self.rc(x, y)
        return ndimage.map_coordinates(raster, [r, c], order=order, mode="nearest")

    # ---------------------------------------------------------------- potential flow
    def laplace(self, zero_nodes, one_nodes):
        """Solve the graph Laplacian (4-neighbour) with phi=0 on zero_nodes, phi=1 on one_nodes.
        Nodes in components without Dirichlet nodes get NaN."""
        n = self.n
        fixed = np.full(n, np.nan)
        fixed[np.asarray(zero_nodes, int)] = 0.0
        fixed[np.asarray(one_nodes, int)] = 1.0
        a, b = [], []
        for dr, dc in NB4:
            r2 = self.rr + dr
            c2 = self.cc + dc
            ok = (r2 >= 0) & (r2 < self.h) & (c2 >= 0) & (c2 < self.w)
            j = np.full(n, -1)
            j[ok] = self.idx[r2[ok], c2[ok]]
            good = j >= 0
            a.append(np.nonzero(good)[0])
            b.append(j[good])
        a = np.concatenate(a); b = np.concatenate(b)
        adj = sparse.csr_matrix((np.ones(len(a)), (a, b)), shape=(n, n))
        # components that contain at least one Dirichlet node
        ncomp, lab = csgraph.connected_components(adj, directed=False)
        has = np.zeros(ncomp, bool)
        has[lab[np.isfinite(fixed)]] = True
        live = has[lab]
        free = live & ~np.isfinite(fixed)
        fi = np.nonzero(free)[0]
        pos = np.full(n, -1)
        pos[fi] = np.arange(len(fi))
        deg = np.asarray(adj.sum(1)).ravel()
        # rows for free nodes: deg*phi_i - sum_{j free} phi_j = sum_{j fixed} phi_j
        rows_a = pos[a]
        m_free = (rows_a >= 0)
        aa, bb = a[m_free], b[m_free]
        ra = pos[aa]
        rb = pos[bb]
        both = rb >= 0
        L = sparse.csr_matrix((np.concatenate([deg[fi], -np.ones(both.sum())]),
                               (np.concatenate([np.arange(len(fi)), ra[both]]), np.concatenate([np.arange(len(fi)), rb[both]]))),
                              shape=(len(fi), len(fi)))
        rhs = np.zeros(len(fi))
        fb = ~both
        vals = fixed[bb[fb]]
        vals = np.where(np.isfinite(vals), vals, 0.0)
        np.add.at(rhs, ra[fb], vals)
        phi = np.full(n, np.nan)
        phi[np.isfinite(fixed)] = fixed[np.isfinite(fixed)]
        if len(fi):
            phi[fi] = spsolve(L.tocsc(), rhs)
        return phi

    def flow_field(self, phi, smooth_px=1.5):
        """Unit flow direction (u east, v north) + relative speed from the potential gradient."""
        P = self.filled(phi)
        gr, gc = np.gradient(P)          # d/drow (southwards), d/dcol (east)
        u = gc / self.res                 # dphi/dx
        v = -gr / self.res                # dphi/dy (north)
        m = self.mask.astype(float)
        if smooth_px > 0:
            wsum = ndimage.gaussian_filter(m, smooth_px) + 1e-9
            u = ndimage.gaussian_filter(u * m, smooth_px) / wsum
            v = ndimage.gaussian_filter(v * m, smooth_px) / wsum
        mag = np.hypot(u, v)
        return u / (mag + 1e-12), v / (mag + 1e-12), mag


def ndwi_water_polygons(ndwi, region_half, corridor, exclude=None, thresh=-0.05, up=2, min_area=3000.0):
    """Sub-pixel water polygons from a cell-centred 10 m NDWI grid inside `corridor` (polygon)."""
    H = region_half
    res = 10.0
    minx, miny, maxx, maxy = corridor.bounds
    c0 = max(0, int((minx + H) / res) - 2); c1 = min(ndwi.shape[1], int((maxx + H) / res) + 3)
    r0 = max(0, int((H - maxy) / res) - 2); r1 = min(ndwi.shape[0], int((H - miny) / res) + 3)
    sub = ndwi[r0:r1, c0:c1].astype(np.float64)
    z = ndimage.zoom(sub, up, order=1, grid_mode=True, mode="nearest")
    rr = res / up
    T = Affine(rr, 0, -H + c0 * res, 0, -rr, H - r0 * res)
    cm = features.rasterize([(corridor, 1)], out_shape=z.shape, transform=T, dtype=np.uint8).astype(bool)
    wm = (z > thresh) & cm
    wm = ndimage.binary_closing(wm, iterations=1) & cm
    polys = []
    for geom, val in features.shapes(wm.astype(np.uint8), mask=wm, transform=T, connectivity=8):
        if val != 1:
            continue
        p = shapely.geometry.shape(geom)
        if p.area < min_area:
            continue
        polys.append(p)
    if not polys:
        return None
    g = shapely.union_all(polys)
    # smooth the staircase: small open/close + simplify
    g = g.buffer(2.5, join_style="round").buffer(-2.5, join_style="round").simplify(1.5)
    if exclude is not None:
        g = g.difference(exclude)
    return shapely.make_valid(g)
