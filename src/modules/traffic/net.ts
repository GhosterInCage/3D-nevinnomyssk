// Road network for the traffic simulation: wraps the `roads` service graph (preferred: shares node
// ids, bridge decks, signals and the rendered carriageway heights) or the module's own fallback graph
// (public/data/traffic/graph.bin.gz, used with ?only=traffic). Provides right-hand lane geometry,
// junction trims, signal approaches, bus stops per edge and surface heights.
import type { AppContext } from '../../core/context';
import { fetchBuffer, fetchJSON } from '../../core/data';

export const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street',
  'service', 'track', 'pedestrian', 'footway', 'path', 'cycleway', 'steps', 'bridleway', 'unknown'];
const CLS_ID: Record<string, number> = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
export const C = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5, unclassified: 6, living: 7,
  service: 8, track: 9, pedestrian: 10, footway: 11, path: 12, cycleway: 13, steps: 14, bridleway: 15, unknown: 16,
};
/** default free speed by class (m/s) */
const SPEED = [25, 20, 16.7, 16.7, 14, 11, 12, 5.5, 5.5, 7, 3, 3, 3, 3, 1, 3, 8];
/** relative importance for route choice at junctions */
export const CLS_ROUTE = [3, 3, 2.6, 2.4, 1.8, 0.8, 0.9, 0.3, 0.12, 0.08, 0, 0, 0, 0, 0, 0, 0.1];
/** moving vehicles per metre of carriageway per direction at "normal daytime" traffic */
export const CLS_DENSITY = [0.022, 0.02, 0.018, 0.016, 0.01, 0.0028, 0.004, 0.001, 0.0012, 0.0004, 0, 0, 0, 0, 0, 0, 0.001];

export interface NetEdge {
  a: number; b: number; cls: number;
  width: number; lanes: number;
  /** +1 only a->b, -1 only b->a, 0 both */
  dir: number;
  speed: number;
  pts: Float32Array;
  cum: Float32Array;
  len: number;
  bridge: number;
  drive: boolean;
  foot: boolean;
  trimA: number;
  trimB: number;
  /** bus stops: [s (a->b), side (+1 right of a->b, -1 left)] */
  stops: number[] | null;
  cx: number; cz: number; r: number;
}

export interface SignalApproach { phase: number }

interface RoadsLike {
  graph: { nodes: Float32Array; edges: Array<{ a: number; b: number; cls: string; width: number; lanes: number; dir: number; speed: number; points: Float32Array; bridge: number; tunnel?: boolean }> };
  roadSurfaceY?: (x: number, z: number, bridge?: number) => number;
  signals?: Array<{ x: number; z: number; heading: number; phase: number; node: number }>;
  signalState?: (phase: number, t: number) => string;
}

export class Net {
  nodes!: Float32Array;
  edges: NetEdge[] = [];
  /** per node: incident edge refs (edge*2 + end, end 0 = at a, 1 = at b) */
  incStart!: Int32Array;
  inc!: Int32Array;
  /** drivable degree */
  deg!: Uint8Array;
  /** signal approaches keyed by edge*2+end */
  signals = new Map<number, SignalApproach>();
  roads: RoadsLike | null = null;
  source = 'none';

  constructor(private ctx: AppContext) {}

  async load(): Promise<void> {
    const roads = this.ctx.get<RoadsLike>('roads');
    if (roads && roads.graph && roads.graph.edges && roads.graph.edges.length) {
      this.roads = roads;
      this.fromRoads(roads);
      this.source = 'roads';
    } else {
      await this.fromFallback();
      this.source = 'fallback';
    }
    this.buildTopology();
  }

  private fromRoads(r: RoadsLike): void {
    this.nodes = r.graph.nodes;
    for (const e of r.graph.edges) {
      const cls = CLS_ID[e.cls] ?? C.unknown;
      this.addEdge(e.a, e.b, cls, e.width, e.lanes, e.dir, e.speed, e.points, e.bridge ?? -1, !!e.tunnel);
    }
  }

  private async fromFallback(): Promise<void> {
    const meta = await fetchJSON<any>('traffic/meta.json');
    const buf = await fetchBuffer('traffic/graph.bin.gz');
    const g = meta.graph;
    const v = (rec: [string, number, number]) => {
      const [dt, off, n] = rec;
      switch (dt) {
        case 'f32': return new Float32Array(buf, off, n);
        case 'i32': return new Int32Array(buf, off, n);
        case 'u32': return new Uint32Array(buf, off, n);
        case 'u16': return new Uint16Array(buf, off, n);
        default: return new Uint8Array(buf, off, n);
      }
    };
    this.nodes = new Float32Array(v(g.nodes) as Float32Array);
    const ea = v(g.ea), eb = v(g.eb), ecls = v(g.ecls), ew = v(g.ewidth), el = v(g.elanes), ef = v(g.eflags), es = v(g.espeed);
    const eoff = v(g.eoff), epts = v(g.epts) as Float32Array;
    const classes: string[] = g.classes;
    for (let i = 0; i < g.count[1]; i++) {
      const f = ef[i];
      const cls = CLS_ID[classes[ecls[i]]] ?? C.unknown;
      this.addEdge(ea[i], eb[i], cls, ew[i] / 10, el[i], f & 1 ? 1 : f & 2 ? -1 : 0, es[i], epts.slice(eoff[i] * 2, eoff[i + 1] * 2), -1, false);
    }
  }

  private addEdge(a: number, b: number, cls: number, width: number, lanes: number, dir: number, speedKmh: number, pts: Float32Array, bridge: number, tunnel: boolean): void {
    const n = pts.length >> 1;
    const cum = new Float32Array(n);
    let acc = 0;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (i > 0) acc += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
      cum[i] = acc;
      x0 = Math.min(x0, pts[i * 2]); x1 = Math.max(x1, pts[i * 2]);
      z0 = Math.min(z0, pts[i * 2 + 1]); z1 = Math.max(z1, pts[i * 2 + 1]);
    }
    const drive = cls <= C.track || cls === C.unknown;
    const foot = cls >= C.pedestrian && cls <= C.bridleway;
    const sp = speedKmh > 5 ? Math.min(speedKmh / 3.6, SPEED[cls] * 1.25) : SPEED[cls];
    this.edges.push({
      a, b, cls, width, lanes: Math.max(drive ? 1 : 0, lanes), dir, speed: sp, pts, cum, len: acc, bridge,
      drive: drive && !tunnel && acc > 0.5, foot: foot && !tunnel, trimA: 0, trimB: 0, stops: null,
      cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, r: Math.hypot(x1 - x0, z1 - z0) / 2,
    });
  }

  private buildTopology(): void {
    const nn = this.nodes.length >> 1;
    const cnt = new Int32Array(nn + 1);
    this.deg = new Uint8Array(nn);
    for (const e of this.edges) {
      if (!e.drive && !e.foot) continue;
      cnt[e.a]++; cnt[e.b]++;
      if (e.drive) { this.deg[e.a] = Math.min(255, this.deg[e.a] + 1); this.deg[e.b] = Math.min(255, this.deg[e.b] + 1); }
    }
    this.incStart = new Int32Array(nn + 1);
    for (let i = 0; i < nn; i++) this.incStart[i + 1] = this.incStart[i] + cnt[i];
    this.inc = new Int32Array(this.incStart[nn]);
    const fill = new Int32Array(nn);
    this.edges.forEach((e, i) => {
      if (!e.drive && !e.foot) return;
      this.inc[this.incStart[e.a] + fill[e.a]++] = i * 2;
      this.inc[this.incStart[e.b] + fill[e.b]++] = i * 2 + 1;
    });
    // junction trims (drivable)
    const nodeTrim = new Float32Array(nn);
    for (let n = 0; n < nn; n++) {
      const d = this.deg[n];
      if (d < 2) continue;
      let hw = 0;
      for (let k = this.incStart[n]; k < this.incStart[n + 1]; k++) {
        const e = this.edges[this.inc[k] >> 1];
        if (e.drive) hw = Math.max(hw, e.width / 2);
      }
      nodeTrim[n] = d >= 3 ? hw + 1.2 : Math.min(3, hw * 0.6);
    }
    // signals (roads service): stop line distance per approach
    const stopAt = new Map<number, number>();
    if (this.roads?.signals) {
      for (const s of this.roads.signals) {
        const n = s.node;
        if (n < 0 || n >= nn) continue;
        const hr = (s.heading * Math.PI) / 180;
        const hx = Math.sin(hr), hz = -Math.cos(hr); // facing drivers = pointing away from the node
        let best = -1, bd = -2;
        for (let k = this.incStart[n]; k < this.incStart[n + 1]; k++) {
          const ref = this.inc[k];
          const e = this.edges[ref >> 1];
          if (!e.drive) continue;
          const [tx, tz] = this.outDir(ref >> 1, ref & 1);
          const d = tx * hx + tz * hz;
          if (d > bd) { bd = d; best = ref; }
        }
        if (best < 0 || bd < 0.7) continue;
        this.signals.set(best, { phase: s.phase });
        const along = (s.x - this.nodes[n * 2]) * hx + (s.z - this.nodes[n * 2 + 1]) * hz;
        stopAt.set(best, Math.max(along, stopAt.get(best) ?? 0));
      }
    }
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      if (!e.drive) continue;
      let ta = nodeTrim[e.a], tb = nodeTrim[e.b];
      const sa = stopAt.get(i * 2), sb = stopAt.get(i * 2 + 1);
      if (sa !== undefined) ta = Math.max(ta, sa - 0.5);
      if (sb !== undefined) tb = Math.max(tb, sb - 0.5);
      const maxT = e.len * 0.42;
      e.trimA = Math.min(ta, maxT);
      e.trimB = Math.min(tb, maxT);
    }
  }

  /** Unit direction leaving node at `end` along edge ei (end 0 = at a). */
  outDir(ei: number, end: number): [number, number] {
    const e = this.edges[ei];
    const p = e.pts, n = p.length >> 1;
    // look ~6 m along the edge for a stable direction
    let x0: number, z0: number, x1 = 0, z1 = 0;
    if (end === 0) {
      x0 = p[0]; z0 = p[1];
      for (let i = 1; i < n; i++) { x1 = p[i * 2]; z1 = p[i * 2 + 1]; if (e.cum[i] >= 6) break; }
    } else {
      x0 = p[(n - 1) * 2]; z0 = p[(n - 1) * 2 + 1];
      for (let i = n - 2; i >= 0; i--) { x1 = p[i * 2]; z1 = p[i * 2 + 1]; if (e.len - e.cum[i] >= 6) break; }
    }
    const l = Math.hypot(x1 - x0, z1 - z0) || 1;
    return [(x1 - x0) / l, (z1 - z0) / l];
  }

  /** Attach bus stops ([x, z, heading, ...] from roads furniture) to the nearest drivable edges. */
  attachStops(stops: number[][]): void {
    const grid = this.edgeGrid();
    for (const st of stops) {
      const x = st[0], z = st[1];
      let best = -1, bd = 22, bs = 0, bside = 1;
      for (const ei of grid.query(x, z, 25)) {
        const e = this.edges[ei];
        if (!e.drive || e.cls >= C.service) continue;
        const r = nearestOnPolyline(e.pts, e.cum, x, z);
        if (r.d < bd) { bd = r.d; best = ei; bs = r.s; bside = r.side; }
      }
      if (best < 0) continue;
      const e = this.edges[best];
      if (bs < e.trimA + 8 || bs > e.len - e.trimB - 8) continue;
      (e.stops ??= []).push(bs, bside);
    }
  }

  private _grid: EdgeGrid | null = null;
  edgeGrid(): EdgeGrid {
    if (!this._grid) this._grid = new EdgeGrid(this.edges);
    return this._grid;
  }

  lanesInDir(e: NetEdge): number {
    if (e.dir !== 0) return Math.max(1, e.lanes);
    return Math.max(1, e.lanes >> 1);
  }

  /** Lateral offset (right of travel) of lane k (0 = kerb lane). */
  laneOffset(e: NetEdge, k: number): number {
    const n = this.lanesInDir(e);
    if (e.dir !== 0) {
      const lw = e.width / n;
      return e.width / 2 - (Math.min(k, n - 1) + 0.5) * lw;
    }
    if (n === 1 && e.lanes <= 1) return Math.max(0.9, Math.min(e.width / 4, 1.6));
    const lw = e.width / (2 * n);
    return (n - Math.min(k, n - 1) - 0.5) * lw;
  }

  /** travel-direction allowed? dir = +1 (a->b) / -1 */
  allowed(e: NetEdge, dir: number): boolean {
    return e.dir === 0 || e.dir === dir;
  }

  laneStart(e: NetEdge, dir: number): number { return dir > 0 ? e.trimA : e.trimB; }
  laneEnd(e: NetEdge, dir: number): number { return e.len - (dir > 0 ? e.trimB : e.trimA); }
  endNode(e: NetEdge, dir: number): number { return dir > 0 ? e.b : e.a; }

  /**
   * Point at travel distance s (from the start node of direction dir) with lateral offset `off`
   * (right-hand). Tangents are blended over +-3 m around polyline vertices so offsets stay continuous.
   * out = [x, z, tx, tz]
   */
  pos(e: NetEdge, dir: number, s: number, off: number, out: Float64Array): void {
    const u = dir > 0 ? s : e.len - s;
    const p = e.pts, c = e.cum, n = c.length;
    let lo = 0, hi = n - 1;
    if (u <= 0) { lo = 0; hi = 1; }
    else if (u >= c[n - 1]) { lo = n - 2; hi = n - 1; }
    else {
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= u) lo = m; else hi = m; }
    }
    if (lo < 0) lo = 0;
    const k = lo;
    const L = c[k + 1] - c[k];
    const t = L > 1e-6 ? Math.min(1, Math.max(0, (u - c[k]) / L)) : 0;
    const dx = p[k * 2 + 2] - p[k * 2], dz = p[k * 2 + 3] - p[k * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    let tx = dx / l, tz = dz / l;
    const x = p[k * 2] + dx * t, z = p[k * 2 + 1] + dz * t;
    // blend with neighbour segment tangents near vertices
    const B = Math.min(3, L * 0.45);
    const dStart = u - c[k], dEnd = c[k + 1] - u;
    if (dStart < B && k > 0) {
      const px = p[k * 2] - p[k * 2 - 2], pz = p[k * 2 + 1] - p[k * 2 - 1];
      const pl = Math.hypot(px, pz) || 1;
      const w = 0.5 * (1 - dStart / B);
      tx = tx * (1 - w) + (px / pl) * w; tz = tz * (1 - w) + (pz / pl) * w;
    } else if (dEnd < B && k + 2 < n) {
      const nx = p[k * 2 + 4] - p[k * 2 + 2], nz = p[k * 2 + 5] - p[k * 2 + 3];
      const nl = Math.hypot(nx, nz) || 1;
      const w = 0.5 * (1 - dEnd / B);
      tx = tx * (1 - w) + (nx / nl) * w; tz = tz * (1 - w) + (nz / nl) * w;
    }
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    if (dir < 0) { tx = -tx; tz = -tz; }
    // right of travel = (-tz, tx)
    out[0] = x - tz * off;
    out[1] = z + tx * off;
    out[2] = tx;
    out[3] = tz;
  }

  /** Top of the carriageway at x,z (bridge deck when bridge >= 0). */
  surfaceY(x: number, z: number, bridge: number): number {
    const r = this.roads;
    if (r?.roadSurfaceY) {
      try { return r.roadSurfaceY(x, z, bridge); } catch { /* fall through */ }
    }
    return this.ctx.heightfield.sample(x, z) + 0.06;
  }

  signalRed(ref: number, t: number, distToLine: number, v: number): boolean {
    const s = this.signals.get(ref);
    if (!s || !this.roads?.signalState) return false;
    const st = this.roads.signalState(s.phase, t);
    if (st === 'red') return true;
    if (st === 'yellow') return distToLine > (v * v) / 7 + 1.5;
    return false;
  }
}

export function nearestOnPolyline(p: Float32Array, cum: Float32Array, x: number, z: number): { d: number; s: number; side: number } {
  let bd = Infinity, bs = 0, side = 1;
  for (let k = 0; k < (p.length >> 1) - 1; k++) {
    const ax = p[k * 2], az = p[k * 2 + 1], bx = p[k * 2 + 2], bz = p[k * 2 + 3];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t, qz = az + dz * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < bd) {
      bd = d; bs = cum[k] + Math.sqrt(L2) * t;
      // right of a->b = (-dz, dx)
      side = (x - qx) * -dz + (z - qz) * dx >= 0 ? 1 : -1;
    }
  }
  return { d: bd, s: bs, side };
}

/** Coarse uniform grid over edges (by bounding circle). */
export class EdgeGrid {
  private cell = 64;
  private map = new Map<number, number[]>();
  constructor(private edges: NetEdge[]) {
    edges.forEach((e, i) => {
      const r = e.r + 2;
      for (let gx = Math.floor((e.cx - r) / this.cell); gx <= Math.floor((e.cx + r) / this.cell); gx++) {
        for (let gz = Math.floor((e.cz - r) / this.cell); gz <= Math.floor((e.cz + r) / this.cell); gz++) {
          const k = (gx + 2048) * 4096 + (gz + 2048);
          let l = this.map.get(k);
          if (!l) this.map.set(k, (l = []));
          l.push(i);
        }
      }
    });
  }
  query(x: number, z: number, r: number): Set<number> {
    const out = new Set<number>();
    for (let gx = Math.floor((x - r) / this.cell); gx <= Math.floor((x + r) / this.cell); gx++) {
      for (let gz = Math.floor((z - r) / this.cell); gz <= Math.floor((z + r) / this.cell); gz++) {
        const l = this.map.get((gx + 2048) * 4096 + (gz + 2048));
        if (l) for (const i of l) out.add(i);
      }
    }
    return out;
  }
}
