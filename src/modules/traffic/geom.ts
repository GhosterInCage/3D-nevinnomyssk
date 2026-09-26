// Procedural mesh builder for vehicles / rolling stock / figures.
// Non-indexed triangles with per-vertex colour, a material vector aMat = (roughness, metalness,
// flags, emissive code) and a wheel attribute aWheel = (centreY, centreZ, isWheel) used by the
// traffic uber-material (see materials.ts). Normals are auto-smoothed by angle.
import * as THREE from 'three';

export type V3 = [number, number, number];

export interface MatSpec {
  c: V3;          // base colour (linear)
  r: number;      // roughness
  m: number;      // metalness
  paint?: boolean; // multiplied by the per-instance paint colour
  cc?: boolean;    // clearcoat
  e?: number;      // emissive code (materials.ts)
}

export const MAT = {
  paint: { c: [1, 1, 1], r: 0.32, m: 0.0, paint: true, cc: true } as MatSpec,
  glass: { c: [0.025, 0.032, 0.04], r: 0.03, m: 0.0, cc: true } as MatSpec,
  glassLit: { c: [0.03, 0.036, 0.042], r: 0.04, m: 0.0, cc: true, e: 5 } as MatSpec,
  trim: { c: [0.028, 0.028, 0.03], r: 0.62, m: 0.0 } as MatSpec,
  grille: { c: [0.02, 0.02, 0.022], r: 0.5, m: 0.2 } as MatSpec,
  rubber: { c: [0.022, 0.022, 0.022], r: 0.92, m: 0.0 } as MatSpec,
  chrome: { c: [0.75, 0.75, 0.76], r: 0.12, m: 1.0 } as MatSpec,
  rim: { c: [0.5, 0.51, 0.53], r: 0.35, m: 0.85 } as MatSpec,
  rimDark: { c: [0.12, 0.12, 0.13], r: 0.5, m: 0.6 } as MatSpec,
  head: { c: [0.8, 0.8, 0.78], r: 0.08, m: 0.3, cc: true, e: 1 } as MatSpec,
  tail: { c: [0.42, 0.02, 0.015], r: 0.15, m: 0.0, cc: true, e: 2 } as MatSpec,
  amber: { c: [0.6, 0.3, 0.02], r: 0.2, m: 0.0, cc: true, e: 3 } as MatSpec,
  sign: { c: [0.05, 0.03, 0.01], r: 0.3, m: 0.0, e: 4 } as MatSpec,
  plate: { c: [0.8, 0.8, 0.78], r: 0.45, m: 0.1 } as MatSpec,
  under: { c: [0.035, 0.034, 0.033], r: 0.95, m: 0.0 } as MatSpec,
  steel: { c: [0.3, 0.3, 0.31], r: 0.55, m: 0.7 } as MatSpec,
};

export function col(hex: number, r = 0.6, m = 0.0, extra: Partial<MatSpec> = {}): MatSpec {
  const c = new THREE.Color(hex);
  return { c: [c.r, c.g, c.b], r, m, ...extra };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();

export class Builder {
  P: number[] = [];
  C: number[] = [];
  A: number[] = [];
  W: number[] = [];
  B: number[] = []; // optional bone id (figures)
  bone = 0;
  wheel: [number, number] | null = null;

  private push(v: V3, m: MatSpec): void {
    this.P.push(v[0], v[1], v[2]);
    this.C.push(m.c[0], m.c[1], m.c[2]);
    this.A.push(m.r, m.m, (m.paint ? 1 : 0) + (m.cc ? 2 : 0), m.e ?? 0);
    if (this.wheel) this.W.push(this.wheel[0], this.wheel[1], 1);
    else this.W.push(0, 0, 0);
    this.B.push(this.bone);
  }

  tri(a: V3, b: V3, c: V3, m: MatSpec, hint?: V3): void {
    if (hint) {
      _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      _b.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      _n.crossVectors(_a, _b);
      if (_n.x * hint[0] + _n.y * hint[1] + _n.z * hint[2] < 0) { const t = b; b = c; c = t; }
    }
    this.push(a, m); this.push(b, m); this.push(c, m);
  }

  /** quad a-b-c-d (a,b,c,d around the perimeter); oriented so the normal agrees with `hint`. */
  quad(a: V3, b: V3, c: V3, d: V3, m: MatSpec, hint?: V3): void {
    if (hint) {
      _a.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      _b.set(d[0] - b[0], d[1] - b[1], d[2] - b[2]);
      _n.crossVectors(_a, _b);
      if (_n.x * hint[0] + _n.y * hint[1] + _n.z * hint[2] < 0) { const t = b; b = d; d = t; }
    }
    this.push(a, m); this.push(b, m); this.push(c, m);
    this.push(a, m); this.push(c, m); this.push(d, m);
  }

  /** Axis-aligned box (optionally rotated about X by rx around its centre). faces: skip mask bits
   *  1 -x, 2 +x, 4 -y, 8 +y, 16 -z, 32 +z */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, m: MatSpec, skip = 0, rx = 0, ry = 0): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const cr = Math.cos(rx), sr = Math.sin(rx), cyy = Math.cos(ry), syy = Math.sin(ry);
    const T = (x: number, y: number, z: number): V3 => {
      // rotate about X then Y
      const y1 = y * cr - z * sr, z1 = y * sr + z * cr;
      const x2 = x * cyy + z1 * syy, z2 = -x * syy + z1 * cyy;
      return [cx + x2, cy + y1, cz + z2];
    };
    const R = (x: number, y: number, z: number): V3 => {
      const y1 = y * cr - z * sr, z1 = y * sr + z * cr;
      return [x * cyy + z1 * syy, y1, -x * syy + z1 * cyy];
    };
    const f = (mask: number, pts: V3[], n: V3) => {
      if (skip & mask) return;
      this.quad(T(...pts[0]), T(...pts[1]), T(...pts[2]), T(...pts[3]), m, R(...n));
    };
    f(1, [[-hx, -hy, -hz], [-hx, hy, -hz], [-hx, hy, hz], [-hx, -hy, hz]], [-1, 0, 0]);
    f(2, [[hx, -hy, -hz], [hx, -hy, hz], [hx, hy, hz], [hx, hy, -hz]], [1, 0, 0]);
    f(4, [[-hx, -hy, -hz], [-hx, -hy, hz], [hx, -hy, hz], [hx, -hy, -hz]], [0, -1, 0]);
    f(8, [[-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz]], [0, 1, 0]);
    f(16, [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz]], [0, 0, -1]);
    f(32, [[-hx, -hy, hz], [-hx, hy, hz], [hx, hy, hz], [hx, -hy, hz]], [0, 0, 1]);
  }

  /** Cylinder along X from x0 to x1 (radius r, centre y/z), optional end caps. */
  cylX(x0: number, x1: number, cy: number, cz: number, r: number, seg: number, m: MatSpec, cap0?: MatSpec | null, cap1?: MatSpec | null, r1 = r): void {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const y0 = Math.cos(a0), z0 = Math.sin(a0), y1 = Math.cos(a1), z1 = Math.sin(a1);
      const am = (a0 + a1) / 2;
      this.quad([x0, cy + y0 * r, cz + z0 * r], [x1, cy + y0 * r1, cz + z0 * r1], [x1, cy + y1 * r1, cz + z1 * r1], [x0, cy + y1 * r, cz + z1 * r], m, [0, Math.cos(am), Math.sin(am)]);
      if (cap0) this.tri([x0, cy, cz], [x0, cy + y0 * r, cz + z0 * r], [x0, cy + y1 * r, cz + z1 * r], cap0, [x0 < x1 ? -1 : 1, 0, 0]);
      if (cap1) this.tri([x1, cy, cz], [x1, cy + y0 * r1, cz + z0 * r1], [x1, cy + y1 * r1, cz + z1 * r1], cap1, [x0 < x1 ? 1 : -1, 0, 0]);
    }
  }

  /** Cylinder along Z (tanks, boilers). */
  cylZ(z0: number, z1: number, cx: number, cy: number, r: number, seg: number, m: MatSpec, cap0?: MatSpec | null, cap1?: MatSpec | null, capBulge = 0): void {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const x0 = Math.cos(a0) * r, y0 = Math.sin(a0) * r, x1 = Math.cos(a1) * r, y1 = Math.sin(a1) * r;
      const am = (a0 + a1) / 2;
      this.quad([cx + x0, cy + y0, z0], [cx + x1, cy + y1, z0], [cx + x1, cy + y1, z1], [cx + x0, cy + y0, z1], m, [Math.cos(am), Math.sin(am), 0]);
      if (cap0) this.tri([cx, cy, z0 - capBulge], [cx + x0, cy + y0, z0], [cx + x1, cy + y1, z0], cap0, [0, 0, z0 < z1 ? -1 : 1]);
      if (cap1) this.tri([cx, cy, z1 + capBulge], [cx + x0, cy + y0, z1], [cx + x1, cy + y1, z1], cap1, [0, 0, z0 < z1 ? 1 : -1]);
    }
  }

  /** Vertical cylinder (Y axis). */
  cylY(y0: number, y1: number, cx: number, cz: number, r0: number, r1: number, seg: number, m: MatSpec, cap0?: MatSpec | null, cap1?: MatSpec | null): void {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const am = (a0 + a1) / 2;
      this.quad([cx + c0 * r0, y0, cz + s0 * r0], [cx + c1 * r0, y0, cz + s1 * r0], [cx + c1 * r1, y1, cz + s1 * r1], [cx + c0 * r1, y1, cz + s0 * r1], m, [Math.cos(am), 0, Math.sin(am)]);
      if (cap0) this.tri([cx, y0, cz], [cx + c0 * r0, y0, cz + s0 * r0], [cx + c1 * r0, y0, cz + s1 * r0], cap0, [0, -1, 0]);
      if (cap1) this.tri([cx, y1, cz], [cx + c0 * r1, y1, cz + s0 * r1], [cx + c1 * r1, y1, cz + s1 * r1], cap1, [0, 1, 0]);
    }
  }

  /** Flat disc in the plane x = const facing sign (for rims, arches). a0..a1 angle range (rad, 0 = +y). */
  discX(x: number, cy: number, cz: number, r: number, seg: number, m: MatSpec, sign: number, a0 = 0, a1 = Math.PI * 2, rIn = 0): void {
    for (let i = 0; i < seg; i++) {
      const t0 = a0 + ((a1 - a0) * i) / seg, t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
      const p0: V3 = [x, cy + Math.cos(t0) * r, cz + Math.sin(t0) * r];
      const p1: V3 = [x, cy + Math.cos(t1) * r, cz + Math.sin(t1) * r];
      if (rIn > 0) {
        const q0: V3 = [x, cy + Math.cos(t0) * rIn, cz + Math.sin(t0) * rIn];
        const q1: V3 = [x, cy + Math.cos(t1) * rIn, cz + Math.sin(t1) * rIn];
        this.quad(q0, p0, p1, q1, m, [sign, 0, 0]);
      } else {
        this.tri([x, cy, cz], p0, p1, m, [sign, 0, 0]);
      }
    }
  }

  get count(): number { return this.P.length / 3; }

  /** Build a BufferGeometry, auto-smoothing normals between faces closer than `angle` degrees. */
  build(angle = 32, withBones = false): THREE.BufferGeometry {
    const n = this.P.length / 3;
    const P = this.P;
    const nt = n / 3;
    const fn = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      const i = t * 9;
      _a.set(P[i], P[i + 1], P[i + 2]);
      _b.set(P[i + 3], P[i + 4], P[i + 5]);
      _c.set(P[i + 6], P[i + 7], P[i + 8]);
      _b.sub(_a); _c.sub(_a);
      _n.crossVectors(_b, _c); // area weighted
      fn[t * 3] = _n.x; fn[t * 3 + 1] = _n.y; fn[t * 3 + 2] = _n.z;
    }
    const key = (i: number) => `${Math.round(P[i * 3] * 500)},${Math.round(P[i * 3 + 1] * 500)},${Math.round(P[i * 3 + 2] * 500)},${this.A[i * 4 + 2]},${this.W[i * 3 + 2]},${this.B[i]}`;
    const groups = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const k = key(i);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(i);
    }
    const cosT = Math.cos((angle * Math.PI) / 180);
    const N = new Float32Array(n * 3);
    for (const g of groups.values()) {
      for (const i of g) {
        const ti = Math.floor(i / 3);
        const ax = fn[ti * 3], ay = fn[ti * 3 + 1], az = fn[ti * 3 + 2];
        const al = Math.hypot(ax, ay, az) || 1;
        let sx = 0, sy = 0, sz = 0;
        for (const j of g) {
          const tj = Math.floor(j / 3);
          const bx = fn[tj * 3], by = fn[tj * 3 + 1], bz = fn[tj * 3 + 2];
          const bl = Math.hypot(bx, by, bz) || 1;
          if ((ax * bx + ay * by + az * bz) / (al * bl) >= cosT) { sx += bx; sy += by; sz += bz; }
        }
        const l = Math.hypot(sx, sy, sz);
        if (l > 1e-12) { N[i * 3] = sx / l; N[i * 3 + 1] = sy / l; N[i * 3 + 2] = sz / l; }
        else { N[i * 3] = ax / al; N[i * 3 + 1] = ay / al; N[i * 3 + 2] = az / al; }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.A, 4));
    g.setAttribute('aWheel', new THREE.Float32BufferAttribute(this.W, 3));
    if (withBones) g.setAttribute('aBone', new THREE.Float32BufferAttribute(this.B, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ------------------------------------------------------------------------------------------ loft
/** Cross-section station of a lofted body (z along the vehicle, +z = front). */
export interface Station {
  z: number;
  yb: number;  // sill / bottom
  yw: number;  // beltline (window bottom)
  yt: number;  // top (roof, hood or deck surface)
  wb: number;  // half width at the sill
  wm: number;  // max half width (body side)
  wt: number;  // half width at the top edge
  cr?: number; // roof crown
}

/** Interval kinds between consecutive stations:
 *  hood / trunk / body: painted top, painted window zone
 *  ws: windshield (glass top + glass side triangle)  rw: rear window with painted C pillar
 *  rwq: rear window + quarter glass   roof: side windows under a painted roof
 *  bp: pillar (black)  pp: pillar (paint)  win: passenger window (lit at night)  door: glazed door */
export type Iv = 'hood' | 'trunk' | 'body' | 'ws' | 'rw' | 'rwq' | 'roof' | 'bp' | 'pp' | 'win' | 'door' | 'wsl';

export interface LoftMats {
  paint: MatSpec;
  glass: MatSpec;
  glassLit?: MatSpec;
  trim: MatSpec;
  under: MatSpec;
  roof?: MatSpec;
  lower?: MatSpec; // optional different colour below the midline (two-tone)
}

/** right-side ring points (x>=0) from bottom centre to top centre */
function ring(s: Station, lod: number): Array<[number, number]> {
  const rr = Math.min(0.07, (s.yt - s.yw) * 0.3);
  const pts: Array<[number, number]> = [
    [0, s.yb],
    [s.wb, s.yb],
    [s.wm, s.yb + (s.yw - s.yb) * 0.32],
    [s.wm, s.yb + (s.yw - s.yb) * 0.72],
    [s.wm * 0.99 - 0.004, s.yw],
    [s.wt, s.yt - rr],
    [s.wt * 0.93 - 0.01, s.yt],
    [0, s.yt + (s.cr ?? 0)],
  ];
  if (lod > 1) return [pts[0], pts[1], pts[4], pts[5], pts[7]];
  if (lod > 0) return [pts[0], pts[1], pts[3], pts[4], pts[5], pts[7]];
  return pts;
}
// segment index -> semantic zone (lod0 has 7 segments, lod1 5, lod2 4)
const ZONES0 = ['under', 'side', 'side', 'side', 'win', 'edge', 'top'];
const ZONES1 = ['under', 'side', 'side', 'win', 'top'];
const ZONES2 = ['under', 'side', 'win', 'top'];

/** Simplify a station list for the far LOD: drop end chamfers, pillars and mid stations. */
export function simplifyStations(st: Station[], iv: Iv[]): { st: Station[]; iv: Iv[] } {
  const keepSt: Station[] = [];
  const keepIv: Iv[] = [];
  const L0 = st[0].z, L1 = st[st.length - 1].z;
  for (let k = 0; k < st.length; k++) {
    const s = st[k];
    const end = k === 0 || k === st.length - 1;
    if (!end && (s.z - L0 < 0.12 || L1 - s.z < 0.12)) continue;
    if (!end && (iv[k] === 'bp' || iv[k] === 'pp' || (iv[k] === 'win' && keepIv[keepIv.length - 1] === 'win'))) continue;
    if (!end && iv[k] === 'hood' && keepIv[keepIv.length - 1] === 'hood') continue;
    keepSt.push(s);
    if (k < iv.length) keepIv.push(iv[k] === 'pp' ? 'win' : iv[k]);
  }
  // window runs: a pillar between windows becomes a continuous band
  for (let k = 0; k < keepIv.length; k++) if (keepIv[k] === 'body' && k > 0 && k < keepIv.length - 1 && keepIv[k - 1] === 'win') keepIv[k] = 'win';
  return { st: keepSt, iv: keepIv };
}

function zoneMat(zone: string, iv: Iv, M: LoftMats, y: number, splitY: number): MatSpec {
  if (zone === 'under') return M.under;
  const body = M.lower && y < splitY ? M.lower : M.paint;
  if (zone === 'side') return body;
  if (zone === 'win') {
    switch (iv) {
      case 'ws': case 'roof': case 'rwq': return M.glass;
      case 'win': case 'door': return M.glassLit ?? M.glass;
      case 'bp': return M.trim;
      default: return M.paint;
    }
  }
  if (zone === 'edge') return M.roof ?? M.paint;
  // top
  if (iv === 'ws' || iv === 'rw' || iv === 'rwq' || iv === 'wsl') return M.glass;
  return M.roof ?? M.paint;
}

export type CapStyle = 'paint' | 'glass';

/** Loft a body through stations (sorted by z ascending = rear to front). */
export function loft(b: Builder, st: Station[], iv: Iv[], M: LoftMats, lod: number, capFront: CapStyle = 'paint', capRear: CapStyle = 'paint', splitY = -1): void {
  const zones = lod > 1 ? ZONES2 : lod > 0 ? ZONES1 : ZONES0;
  const rings = st.map((s) => ring(s, lod));
  for (let k = 0; k < st.length - 1; k++) {
    const A = st[k], B = st[k + 1];
    const ra = rings[k], rb = rings[k + 1];
    const zc = (A.z + B.z) / 2, yc = (A.yb + A.yt + B.yb + B.yt) / 4;
    for (let s = 0; s < ra.length - 1; s++) {
      for (const side of [1, -1]) {
        const p0: V3 = [ra[s][0] * side, ra[s][1], A.z];
        const p1: V3 = [ra[s + 1][0] * side, ra[s + 1][1], A.z];
        const p2: V3 = [rb[s + 1][0] * side, rb[s + 1][1], B.z];
        const p3: V3 = [rb[s][0] * side, rb[s][1], B.z];
        const cx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4, cy = (p0[1] + p1[1] + p2[1] + p3[1]) / 4, cz = (p0[2] + p1[2] + p2[2] + p3[2]) / 4;
        const m = zoneMat(zones[s], iv[k], M, cy, splitY);
        b.quad(p0, p1, p2, p3, m, [cx, cy - yc, (cz - zc) * 0.3]);
      }
    }
  }
  // end caps
  const cap = (idx: number, dir: number, style: CapStyle) => {
    const s = st[idx], r = rings[idx];
    for (let k = 0; k < r.length - 1; k++) {
      const a = r[k], c = r[k + 1];
      const zone = zones[k];
      let m: MatSpec = zone === 'under' ? M.under : (M.lower && (a[1] + c[1]) / 2 < splitY ? M.lower : M.paint);
      if (style === 'glass' && zone === 'win') m = M.glass;
      const p0: V3 = [a[0], a[1], s.z], p1: V3 = [c[0], c[1], s.z], p2: V3 = [-c[0], c[1], s.z], p3: V3 = [-a[0], a[1], s.z];
      if (c[0] < 1e-5) b.tri(p0, p1, p3, m, [0, 0, dir]);
      else if (a[0] < 1e-5) b.tri(p0, p1, p2, m, [0, 0, dir]);
      else b.quad(p0, p1, p2, p3, m, [0, 0, dir]);
    }
  };
  cap(0, -1, capRear);
  cap(st.length - 1, 1, capFront);
}

/** Half width of the body side at height y for station s (for placing decals on the side). */
export function sideX(s: Station, y: number): number {
  if (y <= s.yb) return s.wb;
  const y2 = s.yb + (s.yw - s.yb) * 0.32;
  if (y < y2) return s.wb + (s.wm - s.wb) * (y - s.yb) / Math.max(1e-3, y2 - s.yb);
  if (y <= s.yw) return s.wm;
  const t = Math.min(1, (y - s.yw) / Math.max(1e-3, s.yt - s.yw));
  return s.wm + (s.wt - s.wm) * t;
}

/** Translate a built geometry along z, keeping the wheel axle attribute consistent. */
export function shiftZ(g: THREE.BufferGeometry, dz: number): THREE.BufferGeometry {
  g.translate(0, 0, dz);
  const w = g.getAttribute('aWheel') as THREE.BufferAttribute | undefined;
  if (w) {
    const a = w.array as Float32Array;
    for (let i = 0; i < a.length; i += 3) if (a[i + 2] > 0.5) a[i + 1] += dz;
    w.needsUpdate = true;
  }
  return g;
}

/** Interpolated station at z. */
export function stationAt(st: Station[], z: number): Station {
  if (z <= st[0].z) return st[0];
  for (let k = 0; k < st.length - 1; k++) {
    const A = st[k], B = st[k + 1];
    if (z <= B.z) {
      const t = (z - A.z) / Math.max(1e-6, B.z - A.z);
      const l = (a: number, b: number) => a + (b - a) * t;
      return { z, yb: l(A.yb, B.yb), yw: l(A.yw, B.yw), yt: l(A.yt, B.yt), wb: l(A.wb, B.wb), wm: l(A.wm, B.wm), wt: l(A.wt, B.wt), cr: l(A.cr ?? 0, B.cr ?? 0) };
    }
  }
  return st[st.length - 1];
}
