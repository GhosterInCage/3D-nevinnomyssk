// Geometry kit for the hand-modelled landmarks.
//
// A Geo accumulates triangles with per-vertex position, normal, uv (metres, surface
// parametrisation used by the procedural patterns), colour (linear RGB) and a
// surface descriptor aSurf = (pattern, roughness, metalness, flags) that the
// landmark material decodes (see material.ts). Everything that shares one
// material ends up in one BufferGeometry -> one draw call per landmark part.
import * as THREE from 'three';

export type RGB = [number, number, number];
export type V3 = [number, number, number];

/** Surface patterns (decoded in material.ts). */
export const P = {
  PLAIN: 0,
  CONCRETE: 1,   // slip-formed / cast concrete: lift joints, formwork, stains
  BRICK: 2,      // running bond brick
  CORR: 3,       // vertical corrugated / profiled sheet
  PANEL: 4,      // Soviet 6 x 1.2 m wall panels
  GLAZING: 5,    // industrial strip glazing (steel mullions)
  METAL: 6,      // painted steel
  GOLD: 7,       // gilded (metal = 1)
  STONE: 8,      // white stone / smooth render
  GRATE: 9,      // steel grating (platforms)
  LAMP: 10,      // emissive lamp (aviation lights, lanterns)
  ROOFSEAM: 11,  // standing-seam roofing (ribs along v)
  TILES: 12,     // ceramic tiles (turbine hall floor, memorial slabs)
  WINDOW: 13,    // dark window pane (civic buildings, churches) - lit at night if WINLIT
  GRANITE: 14,   // polished granite (memorial)
  ASPHALT: 15,
} as const;

/** Flags (bit field in aSurf.w). */
export const F = {
  FLOOD: 1,      // floodlit at night (warm, from below)
  NOGRIME: 2,    // no dirt / streaks
  WINLIT: 4,     // some panes lit at night
  BLINK: 8,      // lamp blinks (obstruction lights)
  ALWAYS: 16,    // lamp also visible by day
} as const;

const _c = new THREE.Color();
/** sRGB hex/css colour -> linear RGB triple. */
export function col(c: string | number, mul = 1): RGB {
  _c.set(c as any);
  return [_c.r * mul, _c.g * mul, _c.b * mul];
}
export function mix3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

export class Geo {
  private p: number[] = [];
  private n: number[] = [];
  private t: number[] = [];
  private c: number[] = [];
  private s: number[] = [];
  private idx: number[] = [];
  private cr = 0.5; private cg = 0.5; private cb = 0.5;
  private sp = 0; private sr = 0.85; private sm = 0; private sf = 0;
  private mat: THREE.Matrix4 | null = null;
  private nmat = new THREE.Matrix3();
  private stack: Array<THREE.Matrix4 | null> = [];

  get vertexCount(): number { return this.p.length / 3; }
  get triangleCount(): number { return this.idx.length / 3; }

  /** Set the current colour and surface for subsequent primitives. */
  paint(color: RGB, pat: number = P.PLAIN, rough = 0.85, metal = 0, flags = 0): this {
    this.cr = color[0]; this.cg = color[1]; this.cb = color[2];
    this.sp = pat; this.sr = rough; this.sm = metal; this.sf = flags;
    return this;
  }

  /** Push a transform (applied on top of the current one). */
  push(m: THREE.Matrix4): this {
    this.stack.push(this.mat);
    this.mat = this.mat ? this.mat.clone().multiply(m) : m.clone();
    this.nmat.getNormalMatrix(this.mat);
    return this;
  }
  /** Push translation + rotation about Y (radians) + optional uniform scale. */
  at(x: number, y: number, z: number, rotY = 0, scale = 1): this {
    _q.setFromAxisAngle(_up, rotY);
    _s.set(scale, scale, scale);
    return this.push(_m.compose(_v.set(x, y, z), _q, _s));
  }
  pop(): this {
    this.mat = this.stack.pop() ?? null;
    if (this.mat) this.nmat.getNormalMatrix(this.mat);
    return this;
  }

  // ------------------------------------------------------------------ low level
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    if (this.mat) {
      _v.set(x, y, z).applyMatrix4(this.mat);
      _n.set(nx, ny, nz).applyMatrix3(this.nmat).normalize();
      x = _v.x; y = _v.y; z = _v.z; nx = _n.x; ny = _n.y; nz = _n.z;
    }
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.t.push(u, v);
    this.c.push(this.cr, this.cg, this.cb);
    this.s.push(this.sp, this.sr, this.sm, this.sf);
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }

  /** Planar quad a-b-c-d (counter-clockwise seen from the front). uv: metres along a->b and a->d. */
  quad(a: V3, b: V3, c: V3, d: V3, u0 = 0, v0 = 0): void {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = d[0] - a[0], e2y = d[1] - a[1], e2z = d[2] - a[2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const lu = Math.hypot(e1x, e1y, e1z), lv = Math.hypot(e2x, e2y, e2z);
    const i0 = this.vert(a[0], a[1], a[2], nx, ny, nz, u0, v0);
    const i1 = this.vert(b[0], b[1], b[2], nx, ny, nz, u0 + lu, v0);
    const i2 = this.vert(c[0], c[1], c[2], nx, ny, nz, u0 + lu, v0 + lv);
    const i3 = this.vert(d[0], d[1], d[2], nx, ny, nz, u0, v0 + lv);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /** Flat triangle with automatic normal. */
  tri3(a: V3, b: V3, c: V3): void {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const uvOf = (p: V3): [number, number] => Math.abs(ny) > 0.7 ? [p[0], p[2]] : Math.abs(nx) > Math.abs(nz) ? [p[2], p[1]] : [p[0], p[1]];
    const ua = uvOf(a), ub = uvOf(b), uc = uvOf(c);
    this.idx.push(
      this.vert(a[0], a[1], a[2], nx, ny, nz, ua[0], ua[1]),
      this.vert(b[0], b[1], b[2], nx, ny, nz, ub[0], ub[1]),
      this.vert(c[0], c[1], c[2], nx, ny, nz, uc[0], uc[1]),
    );
  }

  // ------------------------------------------------------------------ primitives
  /** Axis-aligned box (in the current frame) from min to max corner. faces: bit mask -x,+x,-y,+y,-z,+z (default all). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, faces = 63): this {
    if (faces & 1) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], 0, y0);
    if (faces & 2) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], 0, y0);
    if (faces & 4) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (faces & 8) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], x0, z0);
    if (faces & 16) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], 0, y0);
    if (faces & 32) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 0, y0);
    return this;
  }

  /** Box centred on (cx, cz) with base at y0, size sx * h * sz, rotated about Y. */
  boxC(cx: number, y0: number, cz: number, sx: number, h: number, sz: number, rotY = 0, faces = 63): this {
    this.at(cx, y0, cz, rotY);
    this.box(-sx / 2, 0, -sz / 2, sx / 2, h, sz / 2, faces);
    return this.pop();
  }

  /** Oriented square-section beam between two points (lattices, braces, rails). */
  beam(a: V3, b: V3, w: number, d = w): this {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-4) return this;
    const dir = new THREE.Vector3(dx / L, dy / L, dz / L);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(a[0], a[1], a[2]), q, new THREE.Vector3(1, 1, 1));
    this.push(m);
    this.box(-w / 2, 0, -d / 2, w / 2, L, d / 2, 1 | 2 | 16 | 32);
    this.pop();
    return this;
  }

  /**
   * Surface of revolution around the local Y axis at (cx, y0, cz).
   * prof = [r0, y0, r1, y1, ...] (y relative to y0). smooth: shared normals along the profile.
   */
  lathe(cx: number, y0: number, cz: number, prof: number[], seg = 24, smooth = true, a0 = 0, a1 = Math.PI * 2): this {
    const np = prof.length / 2;
    if (np < 2) return this;
    // profile normals (in r-y plane)
    const segN: Array<[number, number]> = [];
    const segLen: number[] = [0];
    for (let k = 0; k < np - 1; k++) {
      const dr = prof[2 * k + 2] - prof[2 * k], dy = prof[2 * k + 3] - prof[2 * k + 1];
      const l = Math.hypot(dr, dy) || 1;
      segN.push([dy / l, -dr / l]);
      segLen.push(segLen[k] + l);
    }
    const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
    const ringVerts = seg + 1;
    const emitRing = (k: number, nr: number, ny: number, vv: number): number => {
      const r = prof[2 * k], y = prof[2 * k + 1];
      const base = this.vertexCount;
      for (let i = 0; i < ringVerts; i++) {
        const a = a0 + ((a1 - a0) * i) / seg;
        const ca = Math.cos(a), sa = Math.sin(a);
        const uu = (full ? a : a - a0) * Math.max(r, 0.05);
        this.vert(cx + r * ca, y0 + y, cz + r * sa, nr * ca, ny, nr * sa, uu, vv);
      }
      return base;
    };
    if (smooth) {
      const rings: number[] = [];
      for (let k = 0; k < np; k++) {
        let nr = 0, ny = 0;
        if (k > 0) { nr += segN[k - 1][0]; ny += segN[k - 1][1]; }
        if (k < np - 1) { nr += segN[k][0]; ny += segN[k][1]; }
        const l = Math.hypot(nr, ny) || 1;
        rings.push(emitRing(k, nr / l, ny / l, segLen[k]));
      }
      for (let k = 0; k < np - 1; k++) this.stitch(rings[k], rings[k + 1], seg);
    } else {
      for (let k = 0; k < np - 1; k++) {
        const r0 = emitRing(k, segN[k][0], segN[k][1], segLen[k]);
        const r1 = emitRing(k + 1, segN[k][0], segN[k][1], segLen[k + 1]);
        this.stitch(r0, r1, seg);
      }
    }
    return this;
  }

  private stitch(r0: number, r1: number, seg: number): void {
    for (let i = 0; i < seg; i++) {
      const a = r0 + i, b = r0 + i + 1, c = r1 + i + 1, d = r1 + i;
      // winding: outward normals for counter-clockwise angle order seen from outside
      this.idx.push(a, c, b, a, d, c);
    }
  }

  /** Flat disc (cap) at height y, facing up (up=true) or down. */
  disc(cx: number, y: number, cz: number, r: number, seg = 24, up = true, rIn = 0): this {
    const ny = up ? 1 : -1;
    if (rIn <= 0) {
      const c0 = this.vert(cx, y, cz, 0, ny, 0, cx, cz);
      const b = this.vertexCount;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        this.vert(cx + r * Math.cos(a), y, cz + r * Math.sin(a), 0, ny, 0, cx + r * Math.cos(a), cz + r * Math.sin(a));
      }
      for (let i = 0; i < seg; i++) up ? this.tri(c0, b + i + 1, b + i) : this.tri(c0, b + i, b + i + 1);
    } else {
      const b = this.vertexCount;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        this.vert(cx + rIn * ca, y, cz + rIn * sa, 0, ny, 0, cx + rIn * ca, cz + rIn * sa);
        this.vert(cx + r * ca, y, cz + r * sa, 0, ny, 0, cx + r * ca, cz + r * sa);
      }
      for (let i = 0; i < seg; i++) {
        const i0 = b + 2 * i, o0 = i0 + 1, i1 = i0 + 2, o1 = i0 + 3;
        if (up) { this.tri(i0, o1, o0); this.tri(i0, i1, o1); } else { this.tri(i0, o0, o1); this.tri(i0, o1, i1); }
      }
    }
    return this;
  }

  /** Cylinder / cone frustum with optional caps. */
  cyl(cx: number, y0: number, cz: number, r0: number, r1: number, h: number, seg = 16, capBottom = false, capTop = true): this {
    this.lathe(cx, y0, cz, [r0, 0, r1, h], seg, true);
    if (capTop && r1 > 0) this.disc(cx, y0 + h, cz, r1, seg, true);
    if (capBottom && r0 > 0) this.disc(cx, y0, cz, r0, seg, false);
    return this;
  }

  /** Horizontal cylinder along local X (pipes, drums, tanks lying down). */
  hcyl(x0: number, x1: number, y: number, z: number, r: number, seg = 12, caps = true): this {
    const m = new THREE.Matrix4().makeRotationZ(-Math.PI / 2);
    m.setPosition(x0, y, z);
    this.push(m);
    this.cyl(0, 0, 0, r, r, x1 - x0, seg, caps, caps);
    return this.pop();
  }

  /** Cylinder between two arbitrary points (pipes, stays). */
  pipe(a: V3, b: V3, r: number, seg = 8, caps = false): this {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-4) return this;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / L, dy / L, dz / L));
    this.push(new THREE.Matrix4().compose(new THREE.Vector3(a[0], a[1], a[2]), q, new THREE.Vector3(1, 1, 1)));
    this.cyl(0, 0, 0, r, r, L, seg, caps, caps);
    return this.pop();
  }

  /** UV sphere (or upper hemisphere). */
  sphere(cx: number, cy: number, cz: number, r: number, seg = 16, rings = 10, hemi = false): this {
    const prof: number[] = [];
    const k0 = hemi ? rings / 2 : 0;
    for (let k = k0; k <= rings; k++) {
      const a = Math.PI * (1 - k / rings) - Math.PI / 2; // -pi/2..pi/2 (bottom to top)
      prof.push(Math.max(1e-4, r * Math.cos(a)), r * Math.sin(a));
    }
    return this.lathe(cx, cy, cz, prof, seg, true);
  }

  /** Extruded polygon (ring = x,z pairs, any winding). Walls get flat normals and uv = (along, height). */
  prism(ring: ArrayLike<number>, y0: number, y1: number, top = true, bottom = false): this {
    const n = ring.length / 2;
    if (n < 3) return this;
    // orientation: make counter-clockwise when viewed from +Y (x right, z down -> signed area < 0)
    let area = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1];
    }
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) pts.push([ring[2 * i], ring[2 * i + 1]]);
    if (area > 0) pts.reverse();
    let u = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-4) continue;
      this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], u, y0);
      u += L;
    }
    if (top || bottom) {
      const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      if (top) {
        const b = this.vertexCount;
        for (const p of pts) this.vert(p[0], y1, p[1], 0, 1, 0, p[0], p[1]);
        for (const t of tris) {
          // ensure upward facing
          const A = pts[t[0]], B = pts[t[1]], C = pts[t[2]];
          const cr = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
          if (cr < 0) this.tri(b + t[0], b + t[1], b + t[2]); else this.tri(b + t[0], b + t[2], b + t[1]);
        }
      }
      if (bottom) {
        const b = this.vertexCount;
        for (const p of pts) this.vert(p[0], y0, p[1], 0, -1, 0, p[0], p[1]);
        for (const t of tris) {
          const A = pts[t[0]], B = pts[t[1]], C = pts[t[2]];
          const cr = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
          if (cr < 0) this.tri(b + t[0], b + t[2], b + t[1]); else this.tri(b + t[0], b + t[1], b + t[2]);
        }
      }
    }
    return this;
  }

  /** Gable roof over a box footprint (local frame: ridge along X). */
  gable(x0: number, x1: number, z0: number, z1: number, yEave: number, yRidge: number, over = 0.4): this {
    const zm = (z0 + z1) / 2;
    const X0 = x0 - over, X1 = x1 + over, Z0 = z0 - over, Z1 = z1 + over;
    const slope = (yRidge - yEave) / (zm - z0);
    const yE = yEave - slope * over;
    this.quad([X1, yE, Z0], [X0, yE, Z0], [X0, yRidge, zm], [X1, yRidge, zm]);
    this.quad([X0, yE, Z1], [X1, yE, Z1], [X1, yRidge, zm], [X0, yRidge, zm]);
    // gable walls
    this.tri3([x0, yEave, z1], [x0, yRidge, zm], [x0, yEave, z0]);
    this.tri3([x1, yEave, z0], [x1, yRidge, zm], [x1, yEave, z1]);
    return this;
  }

  /** Railing along a polyline (top rail + posts + mid rail). pts: x,y,z triples. */
  railing(pts: number[], h = 1.1, post = 1.5, w = 0.05): this {
    for (let k = 0; k + 5 < pts.length; k += 3) {
      const a: V3 = [pts[k], pts[k + 1], pts[k + 2]], b: V3 = [pts[k + 3], pts[k + 4], pts[k + 5]];
      const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      this.beam([a[0], a[1] + h, a[2]], [b[0], b[1] + h, b[2]], w, w);
      this.beam([a[0], a[1] + h * 0.5, a[2]], [b[0], b[1] + h * 0.5, b[2]], w * 0.7, w * 0.7);
      const np = Math.max(1, Math.round(L / post));
      for (let i = 0; i < np; i++) {
        const t = i / np;
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
        this.beam([x, y, z], [x, y + h, z], w, w);
      }
    }
    return this;
  }

  /** Circular railing (platform around a chimney/tank). */
  ringRailing(cx: number, y: number, cz: number, r: number, h = 1.1, seg = 24, w = 0.05): this {
    const pts: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push(cx + r * Math.cos(a), y, cz + r * Math.sin(a));
    }
    return this.railing(pts, h, (2 * Math.PI * r) / seg, w);
  }

  /** Append another Geo's triangles (already in final coordinates). */
  append(o: Geo): this {
    const b = this.vertexCount;
    this.p.push(...o.p); this.n.push(...o.n); this.t.push(...o.t); this.c.push(...o.c); this.s.push(...o.s);
    for (const i of o.idx) this.idx.push(i + b);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('lmUv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    const s = new Uint8Array(this.s.length);
    for (let i = 0; i < this.s.length; i += 4) {
      s[i] = this.s[i];
      s[i + 1] = Math.round(THREE.MathUtils.clamp(this.s[i + 1], 0, 1) * 255);
      s[i + 2] = Math.round(THREE.MathUtils.clamp(this.s[i + 2], 0, 1) * 255);
      s[i + 3] = this.s[i + 3];
    }
    g.setAttribute('aSurf', new THREE.Uint8BufferAttribute(s, 4, false));
    const nv = this.vertexCount;
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Raw triangle soup for trimesh colliders (positions + indices). */
  collider(): { vertices: Float32Array; indices: Uint32Array } {
    return { vertices: new Float32Array(this.p), indices: new Uint32Array(this.idx) };
  }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
