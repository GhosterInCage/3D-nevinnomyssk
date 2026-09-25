// Small geometry helpers shared by the roads module builders.
import * as THREE from 'three';

/** Polyline over x/z pairs with arc-length parametrisation. */
export class Polyline {
  readonly p: Float32Array;
  readonly c: Float32Array;
  readonly n: number;
  constructor(p: ArrayLike<number>) {
    this.p = p instanceof Float32Array ? p : new Float32Array(p);
    this.n = this.p.length >> 1;
    this.c = new Float32Array(this.n);
    for (let i = 1; i < this.n; i++) {
      this.c[i] = this.c[i - 1] + Math.hypot(this.p[i * 2] - this.p[i * 2 - 2], this.p[i * 2 + 1] - this.p[i * 2 - 1]);
    }
  }

  get length(): number { return this.c[this.n - 1] ?? 0; }

  private seg(s: number): number {
    const c = this.c;
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m; else hi = m;
    }
    return lo;
  }

  /** Point at arc length s -> out[0..1]. */
  at(s: number, out: number[] = [0, 0]): number[] {
    if (this.n < 2) { out[0] = this.p[0]; out[1] = this.p[1]; return out; }
    s = Math.max(0, Math.min(this.length, s));
    const i = this.seg(s);
    const L = this.c[i + 1] - this.c[i];
    const t = L > 1e-9 ? (s - this.c[i]) / L : 0;
    out[0] = this.p[i * 2] + (this.p[i * 2 + 2] - this.p[i * 2]) * t;
    out[1] = this.p[i * 2 + 1] + (this.p[i * 2 + 3] - this.p[i * 2 + 1]) * t;
    return out;
  }

  /** Unit tangent at s (central difference over +-h). */
  tangent(s: number, h = 1, out: number[] = [0, 0]): number[] {
    const a = this.at(s - h, [0, 0]);
    const b = this.at(s + h, [0, 0]);
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    out[0] = dx / l; out[1] = dz / l;
    return out;
  }

  /** Project a point: arc length, distance and signed side (+1 = right, i.e. (-tz, tx) side). */
  project(x: number, z: number): { s: number; d: number; side: number } {
    let best = Infinity, bs = 0, side = 1;
    const p = this.p;
    for (let i = 0; i < this.n - 1; i++) {
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz;
      let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t - x, qz = az + dz * t - z;
      const d = qx * qx + qz * qz;
      if (d < best) {
        best = d;
        bs = this.c[i] + t * Math.sqrt(L2);
        // right of travel: (-dz, dx)
        side = (-dz * (x - ax) + dx * (z - az)) >= 0 ? 1 : -1;
      }
    }
    return { s: bs, d: Math.sqrt(best), side };
  }
}

/** Resample a polyline so that no segment exceeds `step` (keeps original vertices). */
export function densify(p: ArrayLike<number>, step: number): Float32Array {
  const out: number[] = [];
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = p[i * 2], z = p[i * 2 + 1];
    if (i > 0) {
      const px = p[i * 2 - 2], pz = p[i * 2 - 1];
      const L = Math.hypot(x - px, z - pz);
      const k = Math.ceil(L / step);
      for (let j = 1; j < k; j++) out.push(px + ((x - px) * j) / k, pz + ((z - pz) * j) / k);
    }
    out.push(x, z);
  }
  return new Float32Array(out);
}

/** Per-vertex offset normals (right = (-tz, tx)), mitred and clamped. */
export function vertexNormals(p: ArrayLike<number>): Float32Array {
  const n = p.length >> 1;
  const out = new Float32Array(n * 2);
  const seg: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    let dx = p[i * 2 + 2] - p[i * 2], dz = p[i * 2 + 3] - p[i * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    seg.push(-dz, dx);
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 2, i);
    let nx = seg[a * 2] + seg[b * 2], nz = seg[a * 2 + 1] + seg[b * 2 + 1];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    const cos = nx * seg[b * 2] + nz * seg[b * 2 + 1];
    const k = 1 / Math.max(cos, 0.4);
    out[i * 2] = nx * k;
    out[i * 2 + 1] = nz * k;
  }
  return out;
}

/** Accumulates vertices in the roads "surface" vertex format. */
export class SurfaceBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  att: number[] = [];
  lat: number[] = [];
  dir: number[] = [];
  idx: number[] = [];
  get count(): number { return this.pos.length / 3; }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, surf: number, a1 = 0, a2 = 0, a3 = 255, lat = 0, dc = 0, ds = 0): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.att.push(surf, a1, a2, a3);
    this.lat.push(lat);
    this.dir.push(dc, ds);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }

  build(floatLat = false): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aAtt', new THREE.BufferAttribute(new Uint8Array(this.att), 4));
    g.setAttribute('aLat', floatLat ? new THREE.Float32BufferAttribute(this.lat, 1) : new THREE.BufferAttribute(new Int16Array(this.lat), 1));
    g.setAttribute('aDir', new THREE.BufferAttribute(new Int8Array(this.dir.map((v) => Math.round(v * 127))), 2, true));
    const nv = this.count;
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Simple mergeable triangle soup with position/normal/color (for props, structures). */
export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  emi: number[] = [];
  idx: number[] = [];
  get count(): number { return this.pos.length / 3; }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, r = 1, g = 1, b = 1, e = 0): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(r, g, b);
    this.emi.push(e);
    return this.pos.length / 3 - 1;
  }

  build(withColor = true, withEmit = false): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (withEmit) g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.emi, 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Append a THREE geometry (non-indexed or indexed) transformed by matrix into a MeshBuilder. */
export function appendGeometry(mb: MeshBuilder, geo: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color | [number, number, number], emit = 0): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const base = mb.count;
  const c = Array.isArray(color) ? color : [color.r, color.g, color.b];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    if (nor) n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); else n.set(0, 1, 0);
    mb.vert(v.x, v.y, v.z, n.x, n.y, n.z, c[0], c[1], c[2], emit);
  }
  const index = geo.getIndex();
  if (index) for (let i = 0; i < index.count; i++) mb.idx.push(base + index.getX(i));
  else for (let i = 0; i < pos.count; i++) mb.idx.push(base + i);
}

export function headingToDir(h: number): [number, number] {
  const r = (h * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}
