// Ground sampling (identical to the terrain module's bicubic surface) + draped ground tiles:
// carriageways, sidewalks, ballast, platforms (pre-triangulated by the pipeline), skirts, curbs
// and road markings. Tiles are merged into 2 x 2 super-tiles to keep draw calls low.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import type { HeightField } from '../../core/heightfield';
import { view, type RoadsData, type PolyRec, type TileRec } from './data';
import { ELEV, S } from './materials';
import { SurfaceBuilder, densify, vertexNormals } from './geom';

/** Catmull-Rom bicubic height, the same surface the terrain module renders (see terrain/shaders.ts). */
export class Ground {
  private d: Float32Array;
  private n: number;
  private half: number;
  private res: number;
  constructor(hf: HeightField) {
    this.d = hf.data;
    this.n = hf.n;
    this.half = hf.half;
    this.res = hf.res;
  }

  private at(i: number, j: number): number {
    const n = this.n - 1;
    i = i < 0 ? 0 : i > n ? n : i;
    j = j < 0 ? 0 : j > n ? n : j;
    return this.d[j * this.n + i];
  }

  height(x: number, z: number): number {
    let gx = (x + this.half) / this.res, gz = (z + this.half) / this.res;
    const mx = this.n - 1.001;
    gx = gx < 0 ? 0 : gx > mx ? mx : gx;
    gz = gz < 0 ? 0 : gz > mx ? mx : gz;
    const fx = Math.floor(gx), fz = Math.floor(gz);
    const tx = gx - fx, tz = gz - fz;
    const bx = fx - 1, bz = fz - 1;
    const wx0 = -0.5 * tx * tx * tx + tx * tx - 0.5 * tx, wx1 = 1.5 * tx * tx * tx - 2.5 * tx * tx + 1;
    const wx2 = -1.5 * tx * tx * tx + 2 * tx * tx + 0.5 * tx, wx3 = 0.5 * tx * tx * tx - 0.5 * tx * tx;
    const wz0 = -0.5 * tz * tz * tz + tz * tz - 0.5 * tz, wz1 = 1.5 * tz * tz * tz - 2.5 * tz * tz + 1;
    const wz2 = -1.5 * tz * tz * tz + 2 * tz * tz + 0.5 * tz, wz3 = 0.5 * tz * tz * tz - 0.5 * tz * tz;
    const wz = [wz0, wz1, wz2, wz3];
    let h = 0;
    for (let j = 0; j < 4; j++) {
      const r = this.at(bx, bz + j) * wx0 + this.at(bx + 1, bz + j) * wx1 + this.at(bx + 2, bz + j) * wx2 + this.at(bx + 3, bz + j) * wx3;
      h += r * wz[j];
    }
    return h;
  }

  normal(x: number, z: number, out: number[] = [0, 1, 0]): number[] {
    const e = 1.5;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    const l = Math.hypot(hx, 2 * e, hz);
    out[0] = -hx / l; out[1] = (2 * e) / l; out[2] = -hz / l;
    return out;
  }
}

export interface SurfaceY {
  /** Road surface height for a polyline point (terrain or bridge deck of `group`). */
  (x: number, z: number, group: number): number;
}

export interface TileMeshes {
  key: number;
  cx: number;
  cz: number;
  ground: THREE.Mesh | null;
  marks: THREE.Mesh | null;
}

const K_SKIRT = 0, K_CURB = 1, K_MARK = 2;
const nrmTmp = [0, 1, 0];

/** Build the draped geometry of one super-tile (tiles = pipeline tiles inside it). */
export function buildSuperTile(ctx: AppContext, data: RoadsData, tiles: TileRec[], polys: PolyRec[], ground: Ground, surfY: SurfaceY,
  mats: { ground: THREE.Material; marks: THREE.Material }): { ground: THREE.Mesh | null; marks: THREE.Mesh | null; tris: number } {
  const { meta, ground: buf } = data;
  const gpos = view(buf, meta.arrays.gpos) as Uint16Array;
  const glat = view(buf, meta.arrays.glat) as Int16Array;
  const gatt = view(buf, meta.arrays.gatt) as Uint8Array;
  const gdir = view(buf, meta.arrays.gdir) as Int8Array;
  const gidx = view(buf, meta.arrays.gidx) as Uint32Array;
  const T = meta.tile, H = meta.half, QS = meta.qs;

  // ---- count
  let nv = 0, ni = 0;
  for (const t of tiles) { nv += t.nv; ni += t.ni; }
  const sb = new SurfaceBuilder(); // skirts + curbs appended after the pre-built ground vertices
  for (const p of polys) {
    if (p.kind === K_SKIRT) addSkirt(sb, p, ground);
    else if (p.kind === K_CURB) addCurb(sb, p, ground);
  }
  const nvTot = nv + sb.count;
  const pos = new Float32Array(nvTot * 3);
  const nor = new Float32Array(nvTot * 3);
  const att = new Uint8Array(nvTot * 4);
  const lat = new Int16Array(nvTot);
  const dir = new Int8Array(nvTot * 2);
  const idx = nvTot > 65535 ? new Uint32Array(ni + sb.idx.length) : new Uint16Array(ni + sb.idx.length);
  let v = 0, k = 0;
  for (const t of tiles) {
    const x0 = -H + t.i * T, z0 = -H + t.j * T;
    for (let a = 0; a < t.nv; a++) {
      const src = t.v0 + a;
      const x = x0 + gpos[src * 2] / QS, z = z0 + gpos[src * 2 + 1] / QS;
      const surf = gatt[src * 4];
      const y = ground.height(x, z) + (ELEV[surf] ?? 0.05);
      const o = (v + a) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      ground.normal(x, z, nrmTmp);
      nor[o] = nrmTmp[0]; nor[o + 1] = nrmTmp[1]; nor[o + 2] = nrmTmp[2];
    }
    att.set(gatt.subarray(t.v0 * 4, (t.v0 + t.nv) * 4), v * 4);
    lat.set(glat.subarray(t.v0, t.v0 + t.nv), v);
    dir.set(gdir.subarray(t.v0 * 2, (t.v0 + t.nv) * 2), v * 2);
    for (let a = 0; a < t.ni; a++) idx[k + a] = gidx[t.i0 + a] + v;
    v += t.nv;
    k += t.ni;
  }
  // append skirts/curbs
  for (let a = 0; a < sb.count; a++) {
    const o = (v + a) * 3;
    pos[o] = sb.pos[a * 3]; pos[o + 1] = sb.pos[a * 3 + 1]; pos[o + 2] = sb.pos[a * 3 + 2];
    nor[o] = sb.nrm[a * 3]; nor[o + 1] = sb.nrm[a * 3 + 1]; nor[o + 2] = sb.nrm[a * 3 + 2];
    att[(v + a) * 4] = sb.att[a * 4]; att[(v + a) * 4 + 1] = sb.att[a * 4 + 1];
    att[(v + a) * 4 + 2] = sb.att[a * 4 + 2]; att[(v + a) * 4 + 3] = sb.att[a * 4 + 3];
  }
  for (let a = 0; a < sb.idx.length; a++) idx[k + a] = sb.idx[a] + v;

  let groundMesh: THREE.Mesh | null = null;
  if (idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aAtt', new THREE.BufferAttribute(att, 4));
    g.setAttribute('aLat', new THREE.BufferAttribute(lat, 1));
    g.setAttribute('aDir', new THREE.BufferAttribute(dir, 2, true));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    groundMesh = new THREE.Mesh(g, mats.ground);
    groundMesh.receiveShadow = true;
    groundMesh.castShadow = false;
    groundMesh.name = 'roads-ground';
    groundMesh.matrixAutoUpdate = false;
  }

  // ---- markings
  const mb = new SurfaceBuilder();
  for (const p of polys) if (p.kind === K_MARK) addMarking(mb, p, surfY, ground);
  let marks: THREE.Mesh | null = null;
  const mg = mb.build(true);
  if (mg) {
    marks = new THREE.Mesh(mg, mats.marks);
    marks.receiveShadow = true;
    marks.renderOrder = 1;
    marks.name = 'roads-markings';
    marks.matrixAutoUpdate = false;
  }
  return { ground: groundMesh, marks, tris: (idx.length + (mg?.index?.count ?? 0)) / 3 };
}

/** Raised surface edge: vertical face (sidewalk/platform) or sloped shoulder (ballast). */
function addSkirt(sb: SurfaceBuilder, p: PolyRec, ground: Ground): void {
  const sid = p.style;
  const top = ELEV[sid] ?? 0.18;
  const slope = sid === S.BALLAST;
  const surf = sid === S.BALLAST ? S.BALLAST : sid === S.PLATFORM ? S.STRUCT : S.CURB;
  const pts = densify(p.pts, 8);
  const n = pts.length >> 1;
  let prevTop = -1, prevBot = -1;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    // tangent
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = pts[b * 2] - pts[a * 2], tz = pts[b * 2 + 1] - pts[a * 2 + 1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const ox = tz, oz = -tx; // outward (rings oriented by the pipeline)
    const h = ground.height(x, z);
    let bx = x, bz = z, by = h - 0.06;
    if (slope) { bx = x + ox * 0.55; bz = z + oz * 0.55; by = ground.height(bx, bz) - 0.05; }
    const ny = slope ? 0.8 : 0.0;
    const nl = Math.hypot(ox, ny, oz);
    const vt = sb.vert(x, h + top, z, ox / nl, ny / nl, oz / nl, surf, 0, 0, 255, 0);
    const vb = sb.vert(bx, by, bz, ox / nl, ny / nl, oz / nl, surf, 0, 0, 255, 0);
    if (prevTop >= 0) {
      // winding: faces outward
      sb.tri(prevTop, vt, vb);
      sb.tri(prevTop, vb, prevBot);
    }
    prevTop = vt; prevBot = vb;
  }
}

/** Curb stone along a carriageway edge: road face, 16 cm top, back face. style 1 = road on the right. */
function addCurb(sb: SurfaceBuilder, p: PolyRec, ground: Ground): void {
  const pts = densify(p.pts, 5);
  const n = pts.length >> 1;
  if (n < 2) return;
  const nrm = vertexNormals(pts);
  const sgn = p.style === 1 ? -1 : 1; // direction away from the road
  const W = 0.16, TOP = ELEV[S.CURB];
  let prev: number[] | null = null;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    const ax = nrm[i * 2] * sgn, az = nrm[i * 2 + 1] * sgn; // away from road
    const h0 = ground.height(x, z);
    const x1 = x + ax * W, z1 = z + az * W;
    const h1 = ground.height(x1, z1);
    const l = Math.hypot(ax, az) || 1;
    const nx = ax / l, nz = az / l;
    // road face (normal towards the road), top, back face
    const v0 = sb.vert(x, h0 - 0.02, z, -nx, 0, -nz, S.CURB);
    const v1 = sb.vert(x, h0 + TOP, z, -nx, 0.3, -nz, S.CURB);
    const v2 = sb.vert(x, h0 + TOP, z, 0, 1, 0, S.CURB);
    const v3 = sb.vert(x1, h1 + TOP, z1, 0, 1, 0, S.CURB);
    const cur = [v0, v1, v2, v3];
    if (prev) {
      // determine winding: travel direction x (away vector) must give outward faces
      const flip = sgn > 0;
      const q = (a: number, b: number, c: number, d: number) => (flip ? sb.quad(a, d, c, b) : sb.quad(a, b, c, d));
      q(prev[0], cur[0], cur[1], prev[1]);
      q(prev[2], cur[2], cur[3], prev[3]);
    }
    prev = cur;
  }
}

/** Painted marking strip (width p.width) with the along-line distance in aLat (for dashes). */
function addMarking(mb: SurfaceBuilder, p: PolyRec, surfY: SurfaceY, ground: Ground): void {
  const pts = densify(p.pts, 6);
  const n = pts.length >> 1;
  if (n < 2) return;
  const nrm = vertexNormals(pts);
  const w = Math.max(0.08, p.width) / 2;
  const surf = p.style === 6 ? S.MARK_YELLOW : S.MARK_WHITE;
  let along = 0;
  let prevL = -1, prevR = -1;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    if (i > 0) along += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
    const nx = nrm[i * 2] * w, nz = nrm[i * 2 + 1] * w;
    const yl = surfY(x - nx, z - nz, p.group) + 0.012;
    const yr = surfY(x + nx, z + nz, p.group) + 0.012;
    ground.normal(x, z, nrmTmp);
    const vl = mb.vert(x - nx, yl, z - nz, nrmTmp[0], nrmTmp[1], nrmTmp[2], surf, p.style, 0, 255, along);
    const vr = mb.vert(x + nx, yr, z + nz, nrmTmp[0], nrmTmp[1], nrmTmp[2], surf, p.style, 0, 255, along);
    if (prevL >= 0) {
      // right = (-tz, tx): with travel along +t, left/right strips -> CCW seen from above
      mb.tri(prevL, prevR, vr);
      mb.tri(prevL, vr, vl);
    }
    prevL = vl; prevR = vr;
  }
}
