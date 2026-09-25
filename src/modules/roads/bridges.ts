// Bridges and overpasses: deck profile (runtime, from the final terrain + water levels), deck
// surfaces, slab fascia / retaining walls on ramps, parapets with railings, underside, piers with
// cap beams, abutments; physics trimesh colliders.
import * as THREE from 'three';
import type { AppContext, StaticCollider } from '../../core/context';
import { view, type BridgeRec, type RoadsData } from './data';
import { Polyline, SurfaceBuilder, densify, MeshBuilder } from './geom';
import { PT, type Ground } from './ground';
import { S } from './materials';

const GRADE = 0.05;
const DECK = 1.3; // slab + girder depth under the deck top

export class Bridge {
  readonly rec: BridgeRec;
  readonly axis: Polyline;
  hA = 0;
  hB = 0;
  R = 0;
  ramp = 1;
  minX = Infinity; minZ = Infinity; maxX = -Infinity; maxZ = -Infinity;
  halfWidth = 6;

  constructor(rec: BridgeRec) {
    this.rec = rec;
    this.axis = new Polyline(rec.axis);
  }

  profile(ground: Ground, waterLevel: (x: number, z: number) => number | null): void {
    const ax = this.axis, L = ax.length;
    const p0 = ax.at(0), p1 = ax.at(L);
    this.hA = ground.height(p0[0], p0[1]);
    this.hB = ground.height(p1[0], p1[1]);
    let R = 0;
    for (const [s, clr] of this.rec.cross) {
      const q = ax.at(s);
      R = Math.max(R, ground.height(q[0], q[1]) + clr - this.lerp(s));
    }
    for (const s of this.rec.wet) {
      const q = ax.at(s);
      let lvl = waterLevel(q[0], q[1]);
      if (lvl === null) {
        // no water service: lowest ground around the crossing + 1 m
        let mn = Infinity;
        for (let k = -3; k <= 3; k++) { const r = ax.at(s + k * 6); mn = Math.min(mn, ground.height(r[0], r[1])); }
        lvl = mn + 1.0;
      }
      const need = this.rec.kind === 'foot' ? 2.6 : this.rec.kind === 'rail' ? 4.2 : 4.0;
      R = Math.max(R, lvl + need + DECK - 1.0 - this.lerp(s));
    }
    // a little camber on every bridge
    R = Math.max(R, Math.min(0.8, L * 0.004));
    this.R = R;
    this.ramp = Math.min((1.5 * R) / GRADE, L / 2);
  }

  lerp(s: number): number {
    const L = this.axis.length || 1;
    return this.hA + ((this.hB - this.hA) * Math.max(0, Math.min(L, s))) / L;
  }

  deckAt(s: number): number {
    const L = this.axis.length;
    const u = Math.min(s, L - s) / Math.max(this.ramp, 1e-3);
    const t = Math.max(0, Math.min(1, u));
    return this.lerp(s) + 0.05 + this.R * t * t * (3 - 2 * t);
  }

  heightAt(x: number, z: number): number {
    return this.deckAt(this.axis.project(x, z).s);
  }

  inRamp(s: number): boolean {
    return s < this.rec.range[0] - 0.5 || s > this.rec.range[1] + 0.5;
  }
}

export class Bridges {
  readonly list: Array<Bridge | null> = [];
  meshes: THREE.Object3D[] = [];
  private colliders: Array<{ b: Bridge; col: StaticCollider }> = [];

  constructor(private ctx: AppContext, private data: RoadsData, private ground: Ground) {
    for (const r of data.objects.bridges) this.list[r.id] = r && !r.empty && r.axis?.length >= 4 ? new Bridge(r) : null;
  }

  computeProfiles(waterLevel: (x: number, z: number) => number | null): void {
    for (const b of this.list) {
      if (!b) continue;
      try { b.profile(this.ground, waterLevel); } catch (e) { console.warn('[roads] bridge profile', e); }
    }
  }

  heightAt(group: number, x: number, z: number): number {
    const b = this.list[group];
    return b ? b.heightAt(x, z) : this.ground.height(x, z);
  }

  build(mats: { deck: THREE.Material; struct: THREE.Material; railing: THREE.Material }): { tris: number } {
    const { meta, ground: buf } = this.data;
    const bpos = view(buf, meta.arrays.bpos) as Float32Array;
    const bidx = view(buf, meta.arrays.bidx) as Uint32Array;
    const batt = view(buf, meta.arrays.batt) as Uint8Array;
    const blat = view(buf, meta.arrays.blat) as Int16Array;
    const bdir = view(buf, meta.arrays.bdir) as Int8Array;
    const deck = new SurfaceBuilder();
    const st = new SurfaceBuilder();
    const rail = new MeshBuilder();
    const railUv: number[] = [];
    let tris = 0;
    for (const b of this.list) {
      if (!b) continue;
      const r = b.rec;
      const [v0, nv] = r.v;
      const [i0, ni] = r.i;
      const base = deck.count;
      const colV: number[] = [];
      const colI: number[] = [];
      const sOf = new Float32Array(nv);
      for (let k = 0; k < nv; k++) {
        const x = bpos[(v0 + k) * 2], z = bpos[(v0 + k) * 2 + 1];
        const pr = b.axis.project(x, z);
        sOf[k] = pr.s;
        const surf = batt[(v0 + k) * 4];
        const y = b.deckAt(pr.s) + (surf === S.BALLAST ? 0.3 : 0);
        deck.vert(x, y, z, 0, 1, 0, surf, batt[(v0 + k) * 4 + 1], batt[(v0 + k) * 4 + 2], 255, blat[v0 + k],
          bdir[(v0 + k) * 2] / 127, bdir[(v0 + k) * 2 + 1] / 127);
        colV.push(x, y, z);
        b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
        b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
      }
      for (let k = 0; k < ni; k += 3) {
        const a = bidx[i0 + k], c = bidx[i0 + k + 1], d = bidx[i0 + k + 2];
        deck.tri(base + a, base + c, base + d);
        colI.push(a, c, d);
        // underside (only under the real span, not the ramps)
        const sm = (sOf[a] + sOf[c] + sOf[d]) / 3;
        if (!b.inRamp(sm)) {
          const verts = [a, c, d].map((q) => {
            const x = bpos[(v0 + q) * 2], z = bpos[(v0 + q) * 2 + 1];
            return st.vert(x, b.deckAt(sOf[q]) - DECK, z, 0, -1, 0, S.STRUCT);
          });
          st.tri(verts[0], verts[2], verts[1]);
        }
      }
      // ---- outline: fascia / retaining walls + parapet + railing
      const isRoad = r.road;
      const parH = isRoad ? 0.85 : 0.35;
      for (const ol of r.outline) {
        const pts = densify(ol.p, 3);
        const n = pts.length >> 1;
        if (n < 2) continue;
        const sgn = ol.outRight ? 1 : -1;
        let prev: number[] | null = null;
        let along = 0;
        let prevRail: number[] | null = null;
        for (let i = 0; i < n; i++) {
          const x = pts[i * 2], z = pts[i * 2 + 1];
          if (i > 0) along += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
          const a = Math.max(0, i - 1), c = Math.min(n - 1, i + 1);
          let tx = pts[c * 2] - pts[a * 2], tz = pts[c * 2 + 1] - pts[a * 2 + 1];
          const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
          const ox = -tz * sgn, oz = tx * sgn; // outward
          const s = b.axis.project(x, z).s;
          const top = b.deckAt(s) + (r.rail && !isRoad ? 0.45 : 0);
          const ramp = b.inRamp(s);
          const bot = ramp ? this.ground.height(x, z) - 0.6 : top - DECK;
          const ix = x - ox * 0.28, iz = z - oz * 0.28;
          const v = [
            st.vert(x, bot, z, ox, 0, oz, S.STRUCT),               // 0 outer bottom
            st.vert(x, top + parH, z, ox, 0, oz, S.STRUCT),        // 1 outer top
            st.vert(x, top + parH, z, 0, 1, 0, S.STRUCT),          // 2 cap outer
            st.vert(ix, top + parH, iz, 0, 1, 0, S.STRUCT),        // 3 cap inner
            st.vert(ix, top + parH, iz, -ox, 0, -oz, S.STRUCT),    // 4 inner top
            st.vert(ix, top - 0.05, iz, -ox, 0, -oz, S.STRUCT),    // 5 inner bottom (deck)
          ];
          if (prev) {
            // outward = (-tz, tx)*sgn ; travel +t. For sgn=+1 outward is "right": quads (prev, cur) CCW from outside
            const q = (p0: number, p1: number, c1: number, c0: number) => (sgn > 0 ? st.quad(p0, c0, c1, p1) : st.quad(p0, p1, c1, c0));
            q(prev[0], prev[1], v[1], v[0]);
            q(prev[2], prev[3], v[3], v[2]);
            q(prev[4], prev[5], v[5], v[4]);
            tris += 6;
          }
          prev = v;
          colV.push(ix, top + parH, iz, ix, top - 0.2, iz);
          // railing above the parapet (road bridges: on the outer edge; others: the main guard)
          const rh = isRoad ? 0.35 : 0.8;
          const rb = top + parH, rt = rb + rh;
          const mx = x - ox * 0.1, mz = z - oz * 0.1;
          const r0 = rail.vert(mx, rb, mz, ox, 0, oz);
          const r1 = rail.vert(mx, rt, mz, ox, 0, oz);
          railUv.push(along, 0, along, 1);
          if (prevRail) {
            rail.idx.push(prevRail[0], r0, r1, prevRail[0], r1, prevRail[1]);
          }
          prevRail = [r0, r1];
        }
      }
      // ---- piers
      for (const p of r.piers) {
        const topY = b.deckAt(p.s) - DECK;
        const w0 = p.w0 + 0.8, w1 = p.w1 - 0.8;
        const span = w1 - w0;
        const ncol = Math.max(2, Math.round(span / 6) + 1);
        let minG = Infinity;
        for (let k = 0; k < ncol; k++) {
          const u = w0 + (span * k) / Math.max(1, ncol - 1);
          minG = Math.min(minG, this.ground.height(p.x + p.nx * u, p.z + p.nz * u));
        }
        if (topY - minG < 1.6) continue;
        // cap beam
        box(st, p.x + p.nx * (w0 + w1) / 2, topY - 0.55, p.z + p.nz * (w0 + w1) / 2, p.nx, p.nz, span + 1.2, 1.1, 1.3);
        for (let k = 0; k < ncol; k++) {
          const u = w0 + (span * k) / Math.max(1, ncol - 1);
          const cx = p.x + p.nx * u, cz = p.z + p.nz * u;
          const g = this.ground.height(cx, cz) - 1.5;
          cylinder(st, cx, g, cz, topY - 1.1, 0.6, 12);
        }
      }
      // ---- abutments at the ends of the real span
      for (const s of r.range) {
        const y = b.deckAt(s) - DECK;
        const q = b.axis.at(s);
        const t = b.axis.tangent(s, 2);
        const nx = -t[1], nz = t[0];
        // width from the outline points near this station
        let w0 = Infinity, w1 = -Infinity;
        for (const ol of r.outline) {
          for (let i = 0; i < ol.p.length; i += 2) {
            const dx = ol.p[i] - q[0], dz = ol.p[i + 1] - q[1];
            if (Math.abs(dx * t[0] + dz * t[1]) > 6) continue;
            const u = dx * nx + dz * nz;
            w0 = Math.min(w0, u); w1 = Math.max(w1, u);
          }
        }
        if (!isFinite(w0)) continue;
        const g = this.ground.height(q[0], q[1]);
        if (y - g < 0.4) continue;
        const h = y - g + 1.0;
        box(st, q[0] + nx * (w0 + w1) / 2, g - 1.0 + h / 2, q[1] + nz * (w0 + w1) / 2, nx, nz, w1 - w0, h, 1.6);
      }
      // collider
      if (colI.length) {
        this.colliders.push({
          b,
          col: { kind: 'trimesh', key: `roads-bridge-${r.id}`, vertices: new Float32Array(colV), indices: new Uint32Array(colI) },
        });
      }
    }
    const out: THREE.Object3D[] = [];
    const dg = deck.build();
    if (dg) {
      const m = new THREE.Mesh(dg, mats.deck);
      m.receiveShadow = true; m.castShadow = true; m.name = 'roads-bridge-decks'; m.userData.ptMaterial = PT.asphalt;
      out.push(m);
      tris += (dg.index?.count ?? 0) / 3;
    }
    const sg = st.build();
    if (sg) {
      const m = new THREE.Mesh(sg, mats.struct);
      m.receiveShadow = true; m.castShadow = true; m.name = 'roads-bridge-structures'; m.userData.ptMaterial = PT.concrete;
      out.push(m);
      tris += (sg.index?.count ?? 0) / 3;
    }
    const rg = rail.build(false);
    if (rg) {
      rg.setAttribute('uv', new THREE.Float32BufferAttribute(railUv, 2));
      const m = new THREE.Mesh(rg, mats.railing);
      m.castShadow = true; m.receiveShadow = true; m.name = 'roads-bridge-railings';
      out.push(m);
    }
    for (const m of out) { m.matrixAutoUpdate = false; m.updateMatrix(); this.ctx.scene.add(m); }
    this.meshes = out;
    // colliders
    this.ctx.registerColliders({
      id: 'roads-bridges',
      query: (x, z, rad) => this.colliders.filter(({ b }) => x + rad >= b.minX && x - rad <= b.maxX && z + rad >= b.minZ && z - rad <= b.maxZ).map((c) => c.col),
    });
    return { tris };
  }
}

/** Oriented box (x axis along (nx, nz)) into a surface builder. */
export function box(sb: SurfaceBuilder, cx: number, cy: number, cz: number, nx: number, nz: number, lx: number, ly: number, lz: number, surf: number = S.STRUCT): void {
  const ux = nx, uz = nz;          // length axis
  const wx = -nz, wz = nx;         // width axis
  const hx = lx / 2, hy = ly / 2, hz = lz / 2;
  const corner = (a: number, b: number, c: number) => [cx + ux * a * hx + wx * c * hz, cy + b * hy, cz + uz * a * hx + wz * c * hz];
  const faces: Array<[number[], number[][]]> = [
    [[ux, 0, uz], [corner(1, -1, -1), corner(1, -1, 1), corner(1, 1, 1), corner(1, 1, -1)]],
    [[-ux, 0, -uz], [corner(-1, -1, 1), corner(-1, -1, -1), corner(-1, 1, -1), corner(-1, 1, 1)]],
    [[wx, 0, wz], [corner(1, -1, 1), corner(-1, -1, 1), corner(-1, 1, 1), corner(1, 1, 1)]],
    [[-wx, 0, -wz], [corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1)]],
    [[0, 1, 0], [corner(-1, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(-1, 1, 1)]],
    [[0, -1, 0], [corner(-1, -1, 1), corner(1, -1, 1), corner(1, -1, -1), corner(-1, -1, -1)]],
  ];
  for (const [n, q] of faces) {
    const v = q.map((c) => sb.vert(c[0], c[1], c[2], n[0], n[1], n[2], surf));
    // ensure outward winding
    const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]];
    const e2 = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] >= 0) sb.quad(v[0], v[1], v[2], v[3]);
    else sb.quad(v[0], v[3], v[2], v[1]);
  }
}

/** Vertical cylinder from y0 to y1. */
export function cylinder(sb: SurfaceBuilder, cx: number, y0: number, cz: number, y1: number, r: number, seg: number, surf: number = S.STRUCT): void {
  const ring: number[][] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const nx = Math.cos(a), nz = Math.sin(a);
    ring.push([sb.vert(cx + nx * r, y0, cz + nz * r, nx, 0, nz, surf), sb.vert(cx + nx * r, y1, cz + nz * r, nx, 0, nz, surf)]);
  }
  for (let i = 0; i < seg; i++) {
    const [a0, a1] = ring[i], [b0, b1] = ring[i + 1];
    // outward: angle increases counter-clockwise in x-z math frame -> seen from outside
    sb.quad(a0, a1, b1, b0);
  }
}

export function makeRailingTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 64);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 128, 7);      // top rail
  g.fillRect(0, 56, 128, 5);     // bottom rail
  for (let i = 0; i < 8; i++) g.fillRect(i * 16 + 6, 0, 4, 64); // balusters
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
