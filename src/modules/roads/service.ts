// The 'roads' service: road graph for traffic, nearest-road queries, street names, road/rail/sidewalk
// masks for other modules, bridge-aware surface heights, traffic-signal phases, lamp positions.
import { view, type RoadsData } from './data';

export interface RoadEdge {
  a: number;
  b: number;
  cls: string;
  width: number;
  lanes: number;
  oneway: boolean;
  /** +1: traffic only a->b (along points), -1: only b->a, 0: both */
  dir: number;
  name?: string;
  speed: number;
  link: boolean;
  tunnel: boolean;
  /** bridge group id or -1 */
  bridge: number;
  /** x,z pairs from node a to node b */
  points: Float32Array;
  /** surface height per point (terrain or bridge deck); filled at init */
  y: Float32Array;
}

export interface NearestResult {
  x: number; z: number; dirX: number; dirZ: number; width: number; cls: string; name?: string;
  edge: number; t: number; s: number; dist: number; y: number;
}

const DRIVE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service', 'track']);

export class RoadGraph {
  nodes: Float32Array;
  edges: RoadEdge[] = [];
  names: string[];
  private cell = 50;
  private grid = new Map<number, number[]>();
  private railGrid = new Map<number, number[]>();
  private rails: Array<{ p: Float32Array; hw: number }> = [];

  constructor(data: RoadsData, heightOf: (x: number, z: number, bridge: number) => number) {
    const buf = data.graphBuf;
    const g = data.meta.graph;
    this.names = data.meta.names;
    this.nodes = new Float32Array(view(buf, g.nodes));
    const ea = view(buf, g.ea), eb = view(buf, g.eb), ecls = view(buf, g.ecls), ew = view(buf, g.ewidth);
    const el = view(buf, g.elanes), ef = view(buf, g.eflags), es = view(buf, g.espeed), en = view(buf, g.ename);
    const ebr = view(buf, g.ebridge), eoff = view(buf, g.eoff), epts = view(buf, g.epts) as Float32Array;
    const classes: string[] = g.classes;
    const n = g.count[1];
    for (let i = 0; i < n; i++) {
      const pts = epts.slice(eoff[i] * 2, eoff[i + 1] * 2);
      const f = ef[i];
      const bridge = ebr[i];
      const y = new Float32Array(pts.length / 2);
      for (let k = 0; k < y.length; k++) y[k] = heightOf(pts[k * 2], pts[k * 2 + 1], bridge);
      const e: RoadEdge = {
        a: ea[i], b: eb[i], cls: classes[ecls[i]] ?? 'unknown', width: ew[i] / 10, lanes: el[i],
        oneway: (f & 3) !== 0, dir: f & 1 ? 1 : f & 2 ? -1 : 0, name: en[i] >= 0 ? this.names[en[i]] : undefined,
        speed: es[i], link: (f & 4) !== 0, tunnel: (f & 8) !== 0, bridge, points: pts, y,
      };
      this.edges.push(e);
      this.index(this.grid, i, pts, e.width / 2 + 2);
    }
    for (const t of data.objects.rail.tracks) {
      const p = new Float32Array(t.p);
      this.rails.push({ p, hw: 2.2 });
      this.index(this.railGrid, this.rails.length - 1, p, 3);
    }
  }

  private key(i: number, j: number): number { return (i + 1000) * 4096 + (j + 1000); }

  private index(grid: Map<number, number[]>, id: number, p: Float32Array, pad: number): void {
    const seen = new Set<number>();
    for (let k = 0; k < p.length / 2 - 1; k++) {
      const x0 = Math.min(p[k * 2], p[k * 2 + 2]) - pad, x1 = Math.max(p[k * 2], p[k * 2 + 2]) + pad;
      const z0 = Math.min(p[k * 2 + 1], p[k * 2 + 3]) - pad, z1 = Math.max(p[k * 2 + 1], p[k * 2 + 3]) + pad;
      for (let i = Math.floor(x0 / this.cell); i <= Math.floor(x1 / this.cell); i++) {
        for (let j = Math.floor(z0 / this.cell); j <= Math.floor(z1 / this.cell); j++) {
          const kk = this.key(i, j);
          if (seen.has(kk)) continue;
          seen.add(kk);
          let l = grid.get(kk);
          if (!l) { l = []; grid.set(kk, l); }
          l.push(id);
        }
      }
    }
  }

  private candidates(grid: Map<number, number[]>, x: number, z: number, r: number): Set<number> {
    const out = new Set<number>();
    for (let i = Math.floor((x - r) / this.cell); i <= Math.floor((x + r) / this.cell); i++) {
      for (let j = Math.floor((z - r) / this.cell); j <= Math.floor((z + r) / this.cell); j++) {
        const l = grid.get(this.key(i, j));
        if (l) for (const e of l) out.add(e);
      }
    }
    return out;
  }

  /** Nearest point on a road centre line (drivable roads unless `any`). */
  nearest(x: number, z: number, maxDist = 200, any = false): NearestResult | null {
    let best: NearestResult | null = null;
    let r = 25;
    while (r <= maxDist * 2) {
      for (const ei of this.candidates(this.grid, x, z, r)) {
        const e = this.edges[ei];
        if (!any && !DRIVE.has(e.cls)) continue;
        const p = e.points;
        let acc = 0;
        for (let k = 0; k < p.length / 2 - 1; k++) {
          const ax = p[k * 2], az = p[k * 2 + 1], bx = p[k * 2 + 2], bz = p[k * 2 + 3];
          const dx = bx - ax, dz = bz - az;
          const L2 = dx * dx + dz * dz;
          const L = Math.sqrt(L2);
          let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + dx * t, qz = az + dz * t;
          const d = Math.hypot(qx - x, qz - z);
          if (d <= maxDist && (!best || d < best.dist)) {
            const y = e.y[k] + (e.y[k + 1] - e.y[k]) * t;
            best = { x: qx, z: qz, dirX: dx / (L || 1), dirZ: dz / (L || 1), width: e.width, cls: e.cls, name: e.name, edge: ei, t, s: acc + L * t, dist: d, y };
          }
          acc += L;
        }
      }
      const bb = best as NearestResult | null;
      if (bb && bb.dist <= r) break;
      r *= 2;
    }
    return best;
  }

  /** True if (x,z) lies on a carriageway / footway (within half width + margin) or on a rail bed. */
  isRoad(x: number, z: number, margin = 0, includeFoot = true, includeRail = true): boolean {
    for (const ei of this.candidates(this.grid, x, z, 1)) {
      const e = this.edges[ei];
      if (e.tunnel) continue;
      if (!includeFoot && !DRIVE.has(e.cls)) continue;
      if (distToPolyline(e.points, x, z) <= e.width / 2 + margin) return true;
    }
    if (includeRail) {
      for (const ri of this.candidates(this.railGrid, x, z, 1)) {
        const r = this.rails[ri];
        if (distToPolyline(r.p, x, z) <= r.hw + margin) return true;
      }
    }
    return false;
  }

  /** Distance from (x,z) to the nearest carriageway edge (negative inside), capped at maxDist. */
  distanceToRoad(x: number, z: number, maxDist = 50): number {
    let best = maxDist;
    for (const ei of this.candidates(this.grid, x, z, maxDist)) {
      const e = this.edges[ei];
      if (e.tunnel) continue;
      const d = distToPolyline(e.points, x, z) - e.width / 2;
      if (d < best) best = d;
    }
    return best;
  }
}

export function distToPolyline(p: Float32Array, x: number, z: number): number {
  let best = Infinity;
  for (let k = 0; k < p.length / 2 - 1; k++) {
    const ax = p[k * 2], az = p[k * 2 + 1], bx = p[k * 2 + 2], bz = p[k * 2 + 3];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = (ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Two-phase fixed-time signal plan (s): green 26, yellow 3, all-red 2 per phase; 62 s cycle. */
export function signalState(phase: number, t: number, offset = 0): 'green' | 'yellow' | 'red' {
  const cyc = 62;
  let u = (t + offset + (phase ? cyc / 2 : 0)) % cyc;
  if (u < 0) u += cyc;
  if (u < 26) return 'green';
  if (u < 29) return 'yellow';
  return 'red';
}
