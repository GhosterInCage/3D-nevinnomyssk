// Procedural tree / shrub generator (no three.js dependency so it runs in a worker).
//
// Broadleaf trees and shrubs grow by space colonisation (Runions et al. 2007) inside a
// species-specific crown envelope; conifers are built from whorls of drooping branches.
// Every model is emitted at two levels of detail from the same skeleton:
//   LOD0: full branch tubes + one leaf-cluster card per twig node (alpha-tested atlas sprite)
//   LOD1: main branches only + every k-th card scaled up (same silhouette, ~1/4 the triangles)
//
// Vertex attributes per part: position(3) normal(3) uv(2) color(3: AO * tint jitter)
// wind(3: branch flex 0..1, phase 0..1, leaf flutter 0..1). Model space: origin at the trunk
// base, +Y up, metres.

export type Envelope = 'ellipsoid' | 'column' | 'dome' | 'round' | 'vase' | 'irregular' | 'weeping' | 'bush' | 'ovate';

export interface GenParams {
  kind: 'broadleaf' | 'conifer' | 'hedge';
  style?: 'spruce' | 'pine' | 'thuja' | 'juniper';
  seed: number;
  height: number;
  crown: number;           // crown width (m)
  envelope?: Envelope;
  crownBase?: number;      // fraction of height where the crown starts
  stems?: number;
  lean?: number;           // radians of random trunk lean
  points?: number;         // attraction points
  segment?: number;        // growth step (m)
  influence?: number;      // influence radius (m)
  kill?: number;           // kill distance (m)
  tropism?: number;        // +up / -down
  trunkRadius: number;     // base radius (m)
  tipRadius?: number;
  pipeExp?: number;
  leafSize: number;        // leaf card size (m)
  leafDensity: number;     // cards per twig node
  leafCell: number;        // atlas cell 0..15 (4x4 atlas, row 0 = top)
  clumps?: number;         // foliage clumps (0 = uniform envelope)
  clumpSize?: number;      // clump radius as a fraction of the crown radius
  leafTilt?: number;       // 0 = cards follow the twig, 1 = random orientation
  leafDroop?: number;      // cards hang down (willow/birch)
  lod1Keep?: number;       // keep every k-th card at LOD1
}

export interface PartArrays {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  color: Float32Array;
  wind: Float32Array;
  index: Uint32Array;
}

export interface TreeModel {
  lod0: { bark: PartArrays; leaves: PartArrays };
  lod1: { bark: PartArrays; leaves: PartArrays };
  /** bounding sphere (model space) centred on the Y axis */
  centerY: number;
  radius: number;
  height: number;
  crown: number;
  trunkRadius: number;
  crownBaseY: number;
}

// ------------------------------------------------------------------ rng / math
class Rng {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next(): number {
    // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  gauss(): number { return (this.next() + this.next() + this.next() - 1.5) * 1.15; }
}

type V3 = [number, number, number];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: V3): V3 => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ geometry builder
class Builder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; col: number[] = []; wind: number[] = []; idx: number[] = [];
  get count() { return this.pos.length / 3; }
  vert(p: V3, n: V3, u: number, v: number, c: V3, w: V3): number {
    this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]); this.wind.push(w[0], w[1], w[2]);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
  build(): PartArrays {
    return {
      position: new Float32Array(this.pos), normal: new Float32Array(this.nrm), uv: new Float32Array(this.uv),
      color: new Float32Array(this.col), wind: new Float32Array(this.wind), index: new Uint32Array(this.idx),
    };
  }
}

// ------------------------------------------------------------------ skeleton
interface Skeleton {
  x: number[]; y: number[]; z: number[];
  parent: number[];
  r: number[];
  tips?: number[];      // terminal descendants (twig nodes have few)
  children: number[][];
  flex: number[];
  depth: number[];      // path length from the root (m)
}

interface Crown { cy: number; rx: number; ry: number; bottom: number; top: number }

function envelopeRadius(env: Envelope, t: number): number {
  // horizontal radius factor (0..1) at relative crown height t (0 = crown bottom, 1 = top)
  switch (env) {
    case 'column': return Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.05)), 0.55) * (1 - 0.35 * t);
    case 'dome': return Math.pow(Math.max(0, Math.sin(Math.PI * (0.25 + 0.75 * t))), 0.5) * (t < 0.15 ? 0.75 + t * 1.6 : 1);
    case 'round': return Math.pow(Math.sin(Math.PI * t), 0.6);
    case 'vase': return Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * t)), 0.7) * (0.55 + 0.45 * Math.min(1, t * 1.6));
    case 'ovate': return Math.pow(Math.sin(Math.PI * t), 0.7) * (1.1 - 0.35 * t);
    case 'weeping': return Math.pow(Math.max(0, Math.sin(Math.PI * (0.1 + 0.9 * t))), 0.45);
    case 'bush': return Math.pow(Math.max(0, Math.sin(Math.PI * (0.3 + 0.7 * t))), 0.5);
    case 'irregular':
    case 'ellipsoid':
    default: return Math.pow(Math.sin(Math.PI * t), 0.65);
  }
}

function growBroadleaf(p: GenParams, rng: Rng): { sk: Skeleton; crown: Crown } {
  const H = p.height, W = p.crown;
  const env = p.envelope ?? 'ellipsoid';
  const cb = (p.crownBase ?? 0.3) * H;
  const top = H;
  const crown: Crown = { cy: (cb + top) / 2, rx: W / 2, ry: (top - cb) / 2, bottom: cb, top };
  const seg = p.segment ?? Math.max(0.25, H / 40);
  const infl = p.influence ?? seg * 6;
  const kill = p.kill ?? seg * 2;
  const trop = p.tropism ?? 0.1;
  // foliage clumps: attraction points gather in sub-spheres near the envelope surface, which
  // gives lumpy crowns with gaps and visible limbs instead of a smooth ellipsoid
  const K = p.clumps ?? 8;
  const cSize = p.clumpSize ?? 0.38;
  const insideEnv = (x: number, y: number, z: number, slack = 1.0): boolean => {
    const t = (y - cb) / Math.max(top - cb, 1e-3);
    if (t < -0.02 || t > 1.0) return false;
    const rmax = envelopeRadius(env, Math.min(1, Math.max(0, t))) * crown.rx * slack;
    return Math.hypot(x, z) <= rmax;
  };
  const clumps: Array<{ c: V3; r: number; w: number }> = [];
  let guardC = 0;
  while (clumps.length < K && guardC++ < K * 200) {
    const t = rng.range(0.12, 0.92);
    const y = cb + t * (top - cb);
    const rmax = envelopeRadius(env, t) * crown.rx;
    const a = rng.range(0, Math.PI * 2);
    const rr = rmax * rng.range(0.35, 0.8);
    const c: V3 = [Math.cos(a) * rr, y, Math.sin(a) * rr];
    clumps.push({ c, r: crown.rx * cSize * rng.range(0.7, 1.3), w: rng.range(0.6, 1.4) });
  }
  const wsum = clumps.reduce((a, c) => a + c.w, 0);
  // attraction points
  const nPts = p.points ?? 700;
  const ax: number[] = [], ay: number[] = [], az: number[] = [];
  let guard = 0;
  while (ax.length < nPts && guard++ < nPts * 60) {
    let x: number, y: number, z: number;
    if (clumps.length && rng.next() < 0.78) {
      let u = rng.next() * wsum, k = 0;
      while (k < clumps.length - 1 && u > clumps[k].w) { u -= clumps[k].w; k++; }
      const cl = clumps[k];
      // uniform in ball
      let dx = 0, dy = 0, dz = 0;
      do { dx = rng.range(-1, 1); dy = rng.range(-1, 1); dz = rng.range(-1, 1); } while (dx * dx + dy * dy + dz * dz > 1);
      x = cl.c[0] + dx * cl.r; y = cl.c[1] + dy * cl.r * 0.85; z = cl.c[2] + dz * cl.r;
      if (!insideEnv(x, y, z, 1.12)) continue;
    } else {
      const t = rng.next();
      y = cb + t * (top - cb);
      const rmax = envelopeRadius(env, t) * crown.rx;
      const a = rng.range(0, Math.PI * 2);
      const rr = Math.sqrt(rng.next()) * rmax;
      x = Math.cos(a) * rr; z = Math.sin(a) * rr;
    }
    // hollow the core (most leaves grow on the outer shell)
    const rn = Math.hypot(x / crown.rx, (y - crown.cy) / crown.ry, z / crown.rx);
    if (rn < 0.5 && rng.next() < 0.65) continue;
    ax.push(x); ay.push(y); az.push(z);
  }
  if (env === 'weeping') {
    // curtain of hanging twigs around the outside
    const extra = Math.floor(nPts * 0.35);
    for (let i = 0; i < extra; i++) {
      const a = rng.range(0, Math.PI * 2);
      const t = rng.range(-0.25, 0.5);
      const y = cb + t * (top - cb);
      const rr = crown.rx * rng.range(0.75, 1.0);
      if (y < 0.8) continue;
      ax.push(Math.cos(a) * rr); ay.push(y); az.push(Math.sin(a) * rr);
    }
  }

  const sk: Skeleton = { x: [], y: [], z: [], parent: [], r: [], children: [], flex: [], depth: [] };
  const add = (x: number, y: number, z: number, parent: number): number => {
    sk.x.push(x); sk.y.push(y); sk.z.push(z); sk.parent.push(parent); sk.r.push(0); sk.children.push([]);
    sk.flex.push(0);
    const d = parent >= 0 ? sk.depth[parent] + Math.hypot(x - sk.x[parent], y - sk.y[parent], z - sk.z[parent]) : 0;
    sk.depth.push(d);
    if (parent >= 0) sk.children[parent].push(sk.x.length - 1);
    return sk.x.length - 1;
  };

  // trunks / stems up to the crown base
  const stems = Math.max(1, p.stems ?? 1);
  const lean = p.lean ?? 0.06;
  for (let s = 0; s < stems; s++) {
    const a0 = rng.range(0, Math.PI * 2);
    const off = stems > 1 ? rng.range(0.05, 0.25) * Math.min(1, W / 3) : 0;
    let x = Math.cos(a0) * off, z = Math.sin(a0) * off, y = 0;
    const la = rng.range(0, Math.PI * 2);
    const lm = stems > 1 ? rng.range(0.15, 0.45) : rng.range(0, lean);
    let dir: V3 = norm3([Math.cos(la) * Math.sin(lm), Math.cos(lm), Math.sin(la) * Math.sin(lm)]);
    let prev = add(x, y, z, -1);
    const target = Math.max(cb * (stems > 1 ? rng.range(0.4, 0.8) : 1), seg);
    while (y < target) {
      dir = norm3([dir[0] + rng.gauss() * 0.04, dir[1] + 0.02, dir[2] + rng.gauss() * 0.04]);
      x += dir[0] * seg; y += dir[1] * seg; z += dir[2] * seg;
      prev = add(x, y, z, prev);
    }
  }

  // node spatial hash
  const cs = infl;
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cs)},${Math.floor(y / cs)},${Math.floor(z / cs)}`;
  const grid = new Map<string, number[]>();
  const gridAdd = (i: number) => {
    const k = key(sk.x[i], sk.y[i], sk.z[i]);
    let b = grid.get(k); if (!b) grid.set(k, (b = [])); b.push(i);
  };
  for (let i = 0; i < sk.x.length; i++) gridAdd(i);

  const alive = new Uint8Array(ax.length).fill(1);
  let remaining = ax.length;
  const infl2 = infl * infl, kill2 = kill * kill;
  for (let iter = 0; iter < 400 && remaining > 0; iter++) {
    const acc = new Map<number, V3>();
    for (let a = 0; a < ax.length; a++) {
      if (!alive[a]) continue;
      const gx = Math.floor(ax[a] / cs), gy = Math.floor(ay[a] / cs), gz = Math.floor(az[a] / cs);
      let best = -1, bd = infl2;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const b = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
        if (!b) continue;
        for (const i of b) {
          const d2 = (sk.x[i] - ax[a]) ** 2 + (sk.y[i] - ay[a]) ** 2 + (sk.z[i] - az[a]) ** 2;
          if (d2 < bd) { bd = d2; best = i; }
        }
      }
      if (best < 0) continue;
      if (bd < kill2) { alive[a] = 0; remaining--; continue; }
      const d = Math.sqrt(bd);
      const v = acc.get(best) ?? [0, 0, 0];
      v[0] += (ax[a] - sk.x[best]) / d; v[1] += (ay[a] - sk.y[best]) / d; v[2] += (az[a] - sk.z[best]) / d;
      acc.set(best, v);
    }
    if (acc.size === 0) {
      // nothing in reach: extend the stems upward
      let grew = false;
      const n0 = sk.x.length;
      for (let i = 0; i < n0; i++) {
        if (sk.children[i].length === 0 && sk.y[i] < crown.top && sk.depth[i] < H * 1.5) {
          const pi = sk.parent[i];
          const d: V3 = pi >= 0 ? norm3([sk.x[i] - sk.x[pi], sk.y[i] - sk.y[pi] + 0.2, sk.z[i] - sk.z[pi]]) : [0, 1, 0];
          const j = add(sk.x[i] + d[0] * seg, sk.y[i] + d[1] * seg, sk.z[i] + d[2] * seg, i);
          gridAdd(j); grew = true;
        }
      }
      if (!grew) break;
      continue;
    }
    for (const [i, v] of acc) {
      let d = norm3(v);
      d = norm3([d[0] + rng.gauss() * 0.12, d[1] + trop + rng.gauss() * 0.08, d[2] + rng.gauss() * 0.12]);
      const nx = sk.x[i] + d[0] * seg, ny = Math.max(0.3, sk.y[i] + d[1] * seg), nz = sk.z[i] + d[2] * seg;
      // skip if an existing child already went nearly the same way
      let dup = false;
      for (const c of sk.children[i]) if ((sk.x[c] - nx) ** 2 + (sk.y[c] - ny) ** 2 + (sk.z[c] - nz) ** 2 < seg * seg * 0.1) { dup = true; break; }
      if (dup) continue;
      const j = add(nx, ny, nz, i);
      gridAdd(j);
    }
    if (sk.x.length > 6000) break;
  }
  return { sk, crown };
}

function computeRadii(sk: Skeleton, p: GenParams): void {
  const n = sk.x.length;
  const tip = p.tipRadius ?? 0.012;
  const e = p.pipeExp ?? 2.4;
  const tips = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const ch = sk.children[i];
    if (ch.length === 0) { sk.r[i] = tip; tips[i] = 1; continue; }
    let s = 0;
    for (const c of ch) { s += Math.pow(sk.r[c], e); tips[i] += tips[c]; }
    sk.r[i] = Math.pow(s, 1 / e);
  }
  sk.tips = tips;
  // normalise so the (thickest) root matches the requested trunk radius, keep twigs thin
  let rootMax = 0;
  for (let i = 0; i < n; i++) if (sk.parent[i] < 0) rootMax = Math.max(rootMax, sk.r[i]);
  const k = p.trunkRadius / Math.max(rootMax, 1e-4);
  for (let i = 0; i < n; i++) {
    const r0 = sk.r[i];
    const t = Math.min(1, r0 / rootMax);
    // blend: thick parts follow the trunk scale, thin parts keep the tip radius
    sk.r[i] = Math.max(tip * 0.8, r0 * (1 + (k - 1) * Math.pow(t, 0.35)));
    // root flare
    if (sk.y[i] < 0.8) sk.r[i] *= 1 + 0.35 * Math.exp(-sk.y[i] / 0.3) * t;
  }
  const rt = p.trunkRadius;
  for (let i = 0; i < n; i++) sk.flex[i] = Math.pow(1 - Math.min(1, sk.r[i] / (rt * 0.55)), 1.6);
}

// ------------------------------------------------------------------ conifers
function growConifer(p: GenParams, rng: Rng): { sk: Skeleton; crown: Crown } {
  const H = p.height, W = p.crown;
  const style = p.style ?? 'spruce';
  const cb = (p.crownBase ?? 0.05) * H;
  const crown: Crown = { cy: (cb + H) / 2, rx: W / 2, ry: (H - cb) / 2, bottom: cb, top: H };
  const sk: Skeleton = { x: [], y: [], z: [], parent: [], r: [], children: [], flex: [], depth: [] };
  const add = (x: number, y: number, z: number, parent: number, r: number): number => {
    sk.x.push(x); sk.y.push(y); sk.z.push(z); sk.parent.push(parent); sk.r.push(r); sk.children.push([]); sk.flex.push(0);
    const d = parent >= 0 ? sk.depth[parent] + Math.hypot(x - sk.x[parent], y - sk.y[parent], z - sk.z[parent]) : 0;
    sk.depth.push(d);
    if (parent >= 0) sk.children[parent].push(sk.x.length - 1);
    return sk.x.length - 1;
  };
  const rt = p.trunkRadius;
  const tip = p.tipRadius ?? 0.01;
  // trunk
  const trunk: number[] = [];
  const nSeg = Math.max(8, Math.round(H / 0.5));
  let x = 0, z = 0;
  const lx = rng.gauss() * 0.01, lz = rng.gauss() * 0.01;
  for (let i = 0; i <= nSeg; i++) {
    const y = (i / nSeg) * H;
    const r = Math.max(tip, rt * Math.pow(1 - i / nSeg, style === 'pine' ? 0.7 : 0.9));
    trunk.push(add(x, y, z, i === 0 ? -1 : trunk[i - 1], r));
    x += lx + rng.gauss() * (style === 'pine' ? 0.04 : 0.008); z += lz + rng.gauss() * (style === 'pine' ? 0.04 : 0.008);
  }
  const whorlDy = style === 'thuja' ? 0.22 : style === 'juniper' ? 0.18 : style === 'pine' ? 0.7 : 0.45;
  let phase = rng.range(0, 6.28);
  for (let y = cb; y < H * 0.97; y += whorlDy * rng.range(0.8, 1.2)) {
    const t = (y - cb) / Math.max(0.1, H - cb);
    let prof: number;
    if (style === 'spruce') prof = Math.pow(1 - t, 0.95) * (t < 0.04 ? 0.8 : 1);
    else if (style === 'pine') prof = Math.pow(Math.sin(Math.PI * Math.min(1, 0.35 + t * 0.75)), 0.8);
    else if (style === 'juniper') prof = 1 - t * 0.3;
    else prof = Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + 0.88 * t)), 0.6) * (1 - 0.3 * t);
    const L = Math.max(0.15, crown.rx * prof * rng.range(0.85, 1.1));
    const nb = style === 'thuja' ? 5 : style === 'juniper' ? 7 : style === 'pine' ? Math.round(rng.range(3, 5)) : Math.round(rng.range(5, 7));
    const ti = Math.min(trunk.length - 1, Math.round((y / H) * nSeg));
    phase += 0.7;
    for (let b = 0; b < nb; b++) {
      if (style === 'pine' && rng.next() < 0.25) continue;
      const az = phase + (b / nb) * Math.PI * 2 + rng.gauss() * 0.2;
      let elev: number;
      if (style === 'spruce') elev = -0.25 + 0.55 * t + rng.gauss() * 0.08;       // lower branches droop
      else if (style === 'pine') elev = 0.35 + 0.3 * t + rng.gauss() * 0.15;
      else if (style === 'juniper') elev = -0.05 + rng.gauss() * 0.1;
      else elev = 1.05 + rng.gauss() * 0.1;                                          // thuja: steep upward
      let dir: V3 = [Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev)];
      const nsb = Math.max(2, Math.round(L / 0.35));
      const r0 = Math.max(tip, rt * 0.22 * Math.pow(1 - t, 0.5) * (style === 'pine' ? 1.5 : 1));
      let prev = trunk[ti];
      let bx = sk.x[prev], by = y, bz = sk.z[prev];
      for (let s = 1; s <= nsb; s++) {
        const f = s / nsb;
        dir = norm3([dir[0], dir[1] - (style === 'spruce' ? 0.06 : style === 'pine' ? 0.01 : style === 'juniper' ? 0.03 : -0.02), dir[2]]);
        bx += dir[0] * L / nsb; by += dir[1] * L / nsb; bz += dir[2] * L / nsb;
        prev = add(bx, by, bz, prev, Math.max(tip, r0 * (1 - f * 0.85)));
        // side shoots (flat sprays)
        if (style !== 'thuja' && s < nsb && rng.next() < 0.7) {
          for (const sd of [-1, 1]) {
            const side = norm3(cross(dir, [0, 1, 0]));
            const sl = L * (1 - f) * 0.45 * rng.range(0.6, 1.0);
            if (sl < 0.12) continue;
            const d2 = norm3([dir[0] * 0.6 + side[0] * sd, dir[1] * 0.6 + (style === 'pine' ? 0.25 : -0.05), dir[2] * 0.6 + side[2] * sd]);
            add(bx + d2[0] * sl, by + d2[1] * sl, bz + d2[2] * sl, prev, tip);
          }
        }
      }
    }
  }
  for (let i = 0; i < sk.x.length; i++) sk.flex[i] = Math.pow(1 - Math.min(1, sk.r[i] / (rt * 0.5)), 1.6);
  return { sk, crown };
}

// ------------------------------------------------------------------ meshing
interface MeshOpts { minRadius: number; ringStep: number; radialScale: number }

function buildBark(sk: Skeleton, crown: Crown, b: Builder, o: MeshOpts, rng: Rng): void {
  const n = sk.x.length;
  // chains: follow the thickest child
  const visitedChainStart: number[] = [];
  const roots: number[] = [];
  for (let i = 0; i < n; i++) if (sk.parent[i] < 0) roots.push(i);
  const stack = [...roots];
  const chains: number[][] = [];
  while (stack.length) {
    const s = stack.pop()!;
    const chain: number[] = [];
    if (sk.parent[s] >= 0) chain.push(sk.parent[s]);
    let c = s;
    for (;;) {
      chain.push(c);
      const ch = sk.children[c];
      if (!ch.length) break;
      let best = ch[0];
      for (const k of ch) if (sk.r[k] > sk.r[best]) best = k;
      for (const k of ch) if (k !== best) stack.push(k);
      c = best;
    }
    chains.push(chain);
    visitedChainStart.push(s);
  }
  for (const chain0 of chains) {
    // drop thin tail below the min radius
    let chain = chain0.filter((i, k) => k === 0 || sk.r[i] >= o.minRadius);
    if (chain.length < 2) continue;
    const rStart = sk.r[chain[Math.min(1, chain.length - 1)]];
    // subsample rings (thin branches are nearly straight between nodes)
    const step = o.ringStep * (rStart < 0.1 ? 2 : 1);
    if (step > 1) chain = chain.filter((_, k) => k === 0 || k === chain.length - 1 || k % step === 0);
    const phase = rng.next();
    const radial = Math.max(3, Math.min(12, Math.round((rStart > 0.25 ? 11 : rStart > 0.12 ? 7 : rStart > 0.06 ? 5 : 3) * o.radialScale)));
    // parallel transport frames
    let prevT: V3 | null = null;
    let nrm: V3 = [1, 0, 0];
    let vAcc = 0;
    const rings: number[] = [];
    for (let k = 0; k < chain.length; k++) {
      const i = chain[k];
      const i0 = chain[Math.max(0, k - 1)], i1 = chain[Math.min(chain.length - 1, k + 1)];
      const T = norm3([sk.x[i1] - sk.x[i0], sk.y[i1] - sk.y[i0], sk.z[i1] - sk.z[i0]]);
      if (!prevT) {
        const a: V3 = Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        nrm = norm3(cross(cross(T, a), T));
      } else {
        const bx = cross(prevT, T);
        const bl = len3(bx);
        if (bl > 1e-5) {
          const ax = [bx[0] / bl, bx[1] / bl, bx[2] / bl] as V3;
          const ang = Math.acos(Math.max(-1, Math.min(1, dot(prevT, T))));
          // rotate nrm around ax by ang (Rodrigues)
          const c = Math.cos(ang), s = Math.sin(ang);
          const kd = dot(ax, nrm);
          const kx = cross(ax, nrm);
          nrm = norm3([nrm[0] * c + kx[0] * s + ax[0] * kd * (1 - c), nrm[1] * c + kx[1] * s + ax[1] * kd * (1 - c), nrm[2] * c + kx[2] * s + ax[2] * kd * (1 - c)]);
        }
      }
      prevT = T;
      const bin = cross(T, nrm);
      if (k > 0) vAcc += Math.hypot(sk.x[i] - sk.x[chain[k - 1]], sk.y[i] - sk.y[chain[k - 1]], sk.z[i] - sk.z[chain[k - 1]]);
      // first ring of a child branch uses the child's radius (sunk into the parent)
      const r = k === 0 && sk.parent[chain[0]] >= 0 ? sk.r[chain[1]] * 0.9 : sk.r[i];
      const texScale = 0.6 + r * 5;
      const uRep = Math.max(1, Math.round((2 * Math.PI * r) / texScale));
      const rn = Math.hypot(sk.x[i] / crown.rx, (sk.y[i] - crown.cy) / Math.max(crown.ry, 0.1), sk.z[i] / crown.rx);
      const inCrown = sk.y[i] > crown.bottom;
      let ao = inCrown ? 0.45 + 0.5 * smooth(0.1, 1.0, rn) : 0.8 + 0.2 * Math.min(1, sk.y[i] / 2);
      ao *= 0.8 + 0.2 * Math.min(1, sk.y[i] / 1.5);
      const start = b.count;
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dn: V3 = [nrm[0] * ca + bin[0] * sa, nrm[1] * ca + bin[1] * sa, nrm[2] * ca + bin[2] * sa];
        b.vert([sk.x[i] + dn[0] * r, sk.y[i] + dn[1] * r, sk.z[i] + dn[2] * r], dn, (j / radial) * uRep, vAcc / texScale,
          [ao, ao, ao], [sk.flex[i], phase, 0]);
      }
      rings.push(start);
    }
    for (let k = 0; k < rings.length - 1; k++) {
      const a0 = rings[k], a1 = rings[k + 1];
      for (let j = 0; j < radial; j++) {
        b.tri(a0 + j, a1 + j, a0 + j + 1);
        b.tri(a0 + j + 1, a1 + j, a1 + j + 1);
      }
    }
    // close the tip with a cone point when the chain ends in a twig
    const last = chain[chain.length - 1];
    if (sk.children[last].length === 0) {
      const a0 = rings[rings.length - 1];
      const pi = chain[chain.length - 2];
      const T = norm3([sk.x[last] - sk.x[pi], sk.y[last] - sk.y[pi], sk.z[last] - sk.z[pi]]);
      const tipI = b.vert([sk.x[last] + T[0] * sk.r[last] * 2, sk.y[last] + T[1] * sk.r[last] * 2, sk.z[last] + T[2] * sk.r[last] * 2], T, 0.5, vAcc / 0.6,
        [0.7, 0.7, 0.7], [sk.flex[last], phase, 0]);
      for (let j = 0; j < radial; j++) b.tri(a0 + j, tipI, a0 + j + 1);
    }
  }
}

interface Card { p: V3; up: V3; side: V3; size: number; flex: number; phase: number; tint: number }

function collectCards(sk: Skeleton, crown: Crown, p: GenParams, rng: Rng): Card[] {
  const cards: Card[] = [];
  const n = sk.x.length;
  const tip = p.tipRadius ?? 0.012;
  const thr = Math.max(tip * 2.6, p.kind === 'conifer' ? p.trunkRadius * 0.12 : 0);
  const tilt = p.leafTilt ?? 0.55;
  const droop = p.leafDroop ?? 0;
  const maxTips = p.kind === 'conifer' ? 0 : 5;
  for (let i = 0; i < n; i++) {
    const pi = sk.parent[i];
    if (pi < 0) continue;
    if (sk.tips && p.kind !== 'conifer') { if (sk.tips[i] > maxTips) continue; }
    else if (sk.r[i] > thr) continue;
    if (sk.y[i] < crown.bottom * 0.6 && p.kind !== 'conifer') continue;
    let cnt = p.leafDensity * (sk.children[i].length === 0 ? 1.5 : 0.9);
    while (cnt > 0) {
      if (cnt < 1 && rng.next() > cnt) break;
      cnt -= 1;
      const d: V3 = norm3([sk.x[i] - sk.x[pi], sk.y[i] - sk.y[pi], sk.z[i] - sk.z[pi]]);
      let up: V3 = norm3([
        d[0] + rng.gauss() * tilt, d[1] + rng.gauss() * tilt * 0.6 + 0.15 - droop * 1.6, d[2] + rng.gauss() * tilt,
      ]);
      if (p.kind === 'conifer') up = norm3([d[0] + rng.gauss() * 0.25, d[1] * 0.5 + rng.gauss() * 0.2, d[2] + rng.gauss() * 0.25]);
      // card plane: random roll around the up axis, biased to face outward from the crown
      const out: V3 = norm3([sk.x[i], 0.3 * (sk.y[i] - crown.cy), sk.z[i]]);
      let side = norm3(cross(up, out));
      const roll = rng.gauss() * 0.9;
      const f = cross(side, up);
      side = norm3([side[0] * Math.cos(roll) + f[0] * Math.sin(roll), side[1] * Math.cos(roll) + f[1] * Math.sin(roll), side[2] * Math.cos(roll) + f[2] * Math.sin(roll)]);
      const t = rng.range(-0.15, 0.1);
      cards.push({
        p: [sk.x[i] + d[0] * t, sk.y[i] + d[1] * t, sk.z[i] + d[2] * t], up, side,
        size: p.leafSize * rng.range(0.75, 1.2), flex: sk.flex[i], phase: rng.next(), tint: rng.range(-1, 1),
      });
    }
  }
  return cards;
}

function buildLeaves(cards: Card[], crown: Crown, p: GenParams, b: Builder, keepEvery: number, scale: number, rng: Rng): void {
  const cell = p.leafCell;
  const cx = cell % 4, cy = Math.floor(cell / 4);
  const m = 0.004;
  const u0 = cx / 4 + m, u1 = (cx + 1) / 4 - m;
  const v1 = 1 - cy / 4 - m, v0 = 1 - (cy + 1) / 4 + m;   // flipY textures: v=1 is the top of the image
  for (let k = 0; k < cards.length; k++) {
    if (keepEvery > 1 && k % keepEvery !== 0) continue;
    const c = cards[k];
    const s = c.size * scale;
    const hw = s * 0.5;
    const nC = norm3(cross(c.side, c.up));
    const corners: Array<[number, number]> = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
    const tintJ = 1 + c.tint * 0.09;
    const hue = c.tint * 0.03;
    const idx: number[] = [];
    for (const [sx, sy] of corners) {
      const pp: V3 = [
        c.p[0] + c.side[0] * sx * hw + c.up[0] * sy * s - c.up[0] * s * 0.08,
        c.p[1] + c.side[1] * sx * hw + c.up[1] * sy * s - c.up[1] * s * 0.08,
        c.p[2] + c.side[2] * sx * hw + c.up[2] * sy * s - c.up[2] * s * 0.08,
      ];
      // foliage normal: blend card normal with the crown's radial direction
      const rad = norm3([pp[0] / crown.rx, (pp[1] - crown.cy) / Math.max(crown.ry, 0.1) * 0.8, pp[2] / crown.rx]);
      const facing = dot(nC, rad) < 0 ? -1 : 1;
      const nn = norm3([rad[0] * 0.75 + nC[0] * facing * 0.25, rad[1] * 0.75 + nC[1] * facing * 0.25 + 0.1, rad[2] * 0.75 + nC[2] * facing * 0.25]);
      const rn = Math.hypot(pp[0] / crown.rx, (pp[1] - crown.cy) / Math.max(crown.ry, 0.1), pp[2] / crown.rx);
      let ao = 0.38 + 0.62 * smooth(0.15, 1.05, rn);
      ao *= 0.78 + 0.22 * smooth(crown.bottom, crown.top, pp[1]);
      const col: V3 = [ao * tintJ * (1 + hue), ao * tintJ, ao * tintJ * (1 - hue)];
      idx.push(b.vert(pp, nn, sx < 0 ? u0 : u1, sy < 0.5 ? v0 : v1, col, [c.flex, c.phase, sy > 0.5 ? 1 : 0.25]));
    }
    b.tri(idx[0], idx[1], idx[2]);
    b.tri(idx[0], idx[2], idx[3]);
  }
  void rng;
}

// ------------------------------------------------------------------ hedge module (2 m long)
function buildHedge(p: GenParams, rng: Rng): TreeModel {
  const L = 2.0, W = p.crown, Hh = p.height;
  const mk = (n: number, scale: number) => {
    const b = new Builder();
    const cards: Card[] = [];
    for (let i = 0; i < n; i++) {
      // random point on the hedge surface (top + sides), cards face outwards
      const face = rng.next();
      let pp: V3, out: V3;
      if (face < 0.3) { pp = [rng.range(-L / 2, L / 2), Hh * rng.range(0.85, 1.0), rng.range(-W / 2, W / 2)]; out = [0, 1, 0]; }
      else if (face < 0.65) { pp = [rng.range(-L / 2, L / 2), Hh * rng.range(0.05, 0.95), W / 2 * rng.range(0.7, 1.0)]; out = [0, 0.2, 1]; }
      else { pp = [rng.range(-L / 2, L / 2), Hh * rng.range(0.05, 0.95), -W / 2 * rng.range(0.7, 1.0)]; out = [0, 0.2, -1]; }
      const up = norm3([rng.gauss() * 0.6, 0.8, rng.gauss() * 0.6]);
      const side = norm3(cross(up, norm3(out)));
      cards.push({ p: [pp[0], pp[1] - p.leafSize * 0.4, pp[2]], up, side, size: p.leafSize * rng.range(0.8, 1.2), flex: 0.3, phase: rng.next(), tint: rng.range(-1, 1) });
    }
    const crown: Crown = { cy: Hh / 2, rx: W / 2, ry: Hh / 2, bottom: 0, top: Hh };
    buildLeaves(cards, crown, p, b, 1, scale, rng);
    return b.build();
  };
  return {
    lod0: { bark: new Builder().build(), leaves: mk(Math.round(L * 60), 1) },
    lod1: { bark: new Builder().build(), leaves: mk(Math.round(L * 18), 1.6) },
    centerY: Hh / 2, radius: Math.hypot(L / 2, Hh / 2, W / 2), height: Hh, crown: W, trunkRadius: 0, crownBaseY: 0,
  };
}

// ------------------------------------------------------------------ entry
export function generateTree(p: GenParams): TreeModel {
  const rng = new Rng(p.seed);
  if (p.kind === 'hedge') return buildHedge(p, rng);
  const { sk, crown } = p.kind === 'conifer' ? growConifer(p, rng) : growBroadleaf(p, rng);
  if (p.kind !== 'conifer') computeRadii(sk, p);
  const cards = collectCards(sk, crown, p, rng);
  const b0 = new Builder(), l0 = new Builder(), b1 = new Builder(), l1 = new Builder();
  const tip = p.tipRadius ?? 0.012;
  buildBark(sk, crown, b0, { minRadius: Math.max(tip * 2.5, p.trunkRadius * 0.085), ringStep: 1, radialScale: 1 }, rng);
  buildBark(sk, crown, b1, { minRadius: Math.max(p.trunkRadius * 0.16, tip * 4), ringStep: 2, radialScale: 0.6 }, rng);
  buildLeaves(cards, crown, p, l0, 1, 1, rng);
  const keep = p.lod1Keep ?? 4;
  buildLeaves(cards, crown, p, l1, keep, Math.sqrt(keep) * 0.92, rng);
  // bounds
  let maxY = 0, cyAcc = 0, maxR = 0;
  const pos = l0.pos.length ? l0.pos : b0.pos;
  for (let i = 0; i < b0.pos.length; i += 3) maxY = Math.max(maxY, b0.pos[i + 1]);
  for (let i = 0; i < pos.length; i += 3) maxY = Math.max(maxY, pos[i + 1]);
  cyAcc = maxY / 2;
  const all = [b0.pos, l0.pos];
  for (const arr of all) for (let i = 0; i < arr.length; i += 3) {
    const r = Math.hypot(arr[i], arr[i + 1] - cyAcc, arr[i + 2]);
    if (r > maxR) maxR = r;
  }
  return {
    lod0: { bark: b0.build(), leaves: l0.build() },
    lod1: { bark: b1.build(), leaves: l1.build() },
    centerY: cyAcc, radius: maxR, height: maxY, crown: crown.rx * 2, trunkRadius: p.trunkRadius, crownBaseY: crown.bottom,
  };
}
