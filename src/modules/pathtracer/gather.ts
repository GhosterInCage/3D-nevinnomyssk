// Scene gathering for the path tracer: walks ctx.scene, keeps the meshes that
// matter for the frozen view (distance, angular size, frustum + shadow reach),
// expands InstancedMesh / BatchedMesh instances into per-instance matrices,
// converts every source geometry into a canonical float form (once per
// geometry) and resolves materials through MaterialResolver. The result is a
// build job for the worker (src/workers/pathtracer-build.worker.ts).
import * as THREE from 'three';
import type { PTItem, PTSrcGeo } from '../../workers/pathtracer-build.worker';
import { MaterialResolver } from './materials';

export interface GatherParams {
  /** re-centring offset: world = pt + origin */
  origin: THREE.Vector3;
  camera: THREE.PerspectiveCamera;
  /** max distance for regular meshes (m) */
  radius: number;
  /** max distance for instanced props (m) */
  instanceRadius: number;
  /** triangle budget for everything gathered here */
  triBudget: number;
  /** min angular radius (rad) of an object/instance to be kept */
  minAngle: number;
  /** direction towards the sun (world) for shadow-caster inclusion */
  sunDir: THREE.Vector3;
  /** objects (and their subtrees) to ignore */
  exclude: Set<THREE.Object3D>;
  /** keep everything within this distance regardless of the frustum (reflections, GI) */
  keepNear: number;
  /** time slice budget per frame (ms) */
  sliceMs: number;
}

interface Candidate {
  obj: THREE.Mesh;
  mat: THREE.MeshPhysicalMaterial;
  geoKey: string;
  getGeo: () => PTSrcGeo;
  /** world matrices (not yet re-centred) of kept instances */
  mats: Float32Array;
  cols: Float32Array | null;
  tris: number; // per instance
  dist: number;
  planarUV: boolean;
}

export interface Gathered {
  geos: PTSrcGeo[];
  items: PTItem[];
  materials: THREE.MeshPhysicalMaterial[];
  /** triangles per material (for texture priority) */
  matTris: number[];
  triangles: number;
  stats: Record<string, number>;
  skippedMaterials: Map<string, number>;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _s = new THREE.Sphere();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

export function nextFrame(): Promise<void> {
  return new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(fin);
    setTimeout(fin, 50); // rAF is throttled in background tabs
  });
}

/** Canonical float copy of (a range of) a geometry. */
export function canonGeometry(geo: THREE.BufferGeometry, range: { start: number; count: number } | null, wantColor: boolean, wantTan: boolean): PTSrcGeo {
  const posA = geo.getAttribute('position') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  const nrmA = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uvA = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const colA = wantColor ? (geo.getAttribute('color') as THREE.BufferAttribute | undefined) : undefined;
  const index = geo.getIndex();
  let verts: Uint32Array | null = null; // source vertex ids (compaction)
  let idx: Uint32Array | null = null;
  if (index) {
    const start = range ? range.start : Math.max(0, geo.drawRange.start);
    const end = Math.min(index.count, range ? range.start + range.count : (Number.isFinite(geo.drawRange.count) ? start + geo.drawRange.count : index.count));
    const n = Math.max(0, end - start) - (Math.max(0, end - start) % 3);
    const src = index.array as ArrayLike<number>;
    if (n < index.count * 0.9 || posA.count > n * 1.5) {
      // compact the vertex set to what this range uses
      const remap = new Int32Array(posA.count).fill(-1);
      const used: number[] = [];
      idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const v = src[start + i];
        let r = remap[v];
        if (r < 0) { r = remap[v] = used.length; used.push(v); }
        idx[i] = r;
      }
      verts = Uint32Array.from(used);
    } else {
      idx = new Uint32Array(n);
      if (src instanceof Uint32Array || src instanceof Uint16Array) idx.set((src as Uint32Array).subarray(start, start + n));
      else for (let i = 0; i < n; i++) idx[i] = src[start + i];
    }
  } else {
    const start = range ? range.start : Math.max(0, geo.drawRange.start);
    const end = Math.min(posA.count, range ? range.start + range.count : (Number.isFinite(geo.drawRange.count) ? start + geo.drawRange.count : posA.count));
    const n = Math.max(0, end - start) - (Math.max(0, end - start) % 3);
    if (start !== 0 || n !== posA.count) {
      verts = new Uint32Array(n);
      for (let i = 0; i < n; i++) verts[i] = start + i;
    }
  }
  const V = verts ? verts.length : posA.count;
  const vid = (i: number) => (verts ? verts[i] : i);
  const pos = new Float32Array(V * 3);
  const fast = !verts && !(posA as any).isInterleavedBufferAttribute && posA.array instanceof Float32Array && posA.itemSize === 3 && !posA.normalized;
  if (fast) pos.set((posA.array as Float32Array).subarray(0, V * 3));
  else for (let i = 0; i < V; i++) { const s = vid(i); pos[3 * i] = posA.getX(s); pos[3 * i + 1] = posA.getY(s); pos[3 * i + 2] = posA.getZ(s); }
  const plain = (a: any, size: number) => !verts && a && !a.isInterleavedBufferAttribute && a.array instanceof Float32Array && a.itemSize === size && !a.normalized;
  let nrm: Float32Array | null = null;
  if (nrmA && nrmA.itemSize >= 3) {
    if (plain(nrmA, 3)) nrm = (nrmA.array as Float32Array).slice(0, V * 3);
    else {
      nrm = new Float32Array(V * 3);
      for (let i = 0; i < V; i++) { const s = vid(i); nrm[3 * i] = nrmA.getX(s); nrm[3 * i + 1] = nrmA.getY(s); nrm[3 * i + 2] = nrmA.getZ(s); }
    }
  }
  let uv: Float32Array | null = null;
  if (uvA && uvA.itemSize >= 2) {
    if (plain(uvA, 2)) uv = (uvA.array as Float32Array).slice(0, V * 2);
    else {
      uv = new Float32Array(V * 2);
      for (let i = 0; i < V; i++) { const s = vid(i); uv[2 * i] = uvA.getX(s); uv[2 * i + 1] = uvA.getY(s); }
    }
  }
  let col: Float32Array | null = null;
  if (colA) {
    col = new Float32Array(V * 4);
    const four = colA.itemSize >= 4;
    for (let i = 0; i < V; i++) {
      const s = vid(i);
      col[4 * i] = colA.getX(s); col[4 * i + 1] = colA.getY(s); col[4 * i + 2] = colA.getZ(s); col[4 * i + 3] = four ? colA.getW(s) : 1;
    }
  }
  return { pos, nrm, uv, col, idx, tan: wantTan && !!uv };
}

function triCount(geo: THREE.BufferGeometry, range: { start: number; count: number } | null): number {
  if (range) return Math.floor(range.count / 3);
  const idx = geo.getIndex();
  const n = idx ? idx.count : (geo.getAttribute('position')?.count ?? 0);
  const dr = geo.drawRange;
  return Math.floor(Math.min(n, Number.isFinite(dr.count) ? dr.count : n) / 3);
}

export class Gatherer {
  readonly resolver = new MaterialResolver();
  private frustum = new THREE.Frustum();
  private camPos = new THREE.Vector3();
  private shadowDir = new THREE.Vector3();
  private tanSun = 1;

  constructor(private p: GatherParams) {
    const cam = p.camera;
    cam.updateMatrixWorld();
    const proj = cam.projectionMatrix.clone();
    this.frustum.setFromProjectionMatrix(_m.multiplyMatrices(proj, cam.matrixWorldInverse));
    // widen side planes slightly (motion of instances, bounce light just outside the view)
    for (const pl of this.frustum.planes) pl.constant += 4;
    this.camPos.setFromMatrixPosition(cam.matrixWorld);
    this.shadowDir.set(-p.sunDir.x, 0, -p.sunDir.z);
    if (this.shadowDir.lengthSq() > 1e-8) this.shadowDir.normalize();
    this.tanSun = Math.max(0.08, p.sunDir.y) / Math.max(0.05, Math.hypot(p.sunDir.x, p.sunDir.z));
  }

  /** Is a world sphere relevant for the frozen view? Returns the distance or -1. */
  test(center: THREE.Vector3, radius: number, maxDist: number): number {
    const d = Math.max(0, center.distanceTo(this.camPos) - radius);
    if (d > maxDist) return -1;
    if (d > this.p.keepNear && radius / Math.max(d, 1) < this.p.minAngle) return -1;
    if (d <= this.p.keepNear) return d;
    _s.center.copy(center); _s.radius = radius;
    if (this.frustum.intersectsSphere(_s)) return d;
    // shadow reach: the object's shadow may fall into view
    if (this.p.sunDir.y > 0.02) {
      const h = Math.min(250, radius * 2);
      const L = Math.min(400, h / this.tanSun);
      _s.center.copy(center).addScaledVector(this.shadowDir, L * 0.5);
      _s.radius = radius + L * 0.5;
      if (this.frustum.intersectsSphere(_s)) return d;
    }
    return -1;
  }

  async gather(extra: Candidate[] = [], onProgress?: (p: number) => void): Promise<Gathered> {
    const p = this.p;
    const cands: Candidate[] = [...extra];
    const stats: Record<string, number> = { meshes: 0, instanced: 0, instances: 0, batched: 0, skippedNoMat: 0, culled: 0 };
    const roots: THREE.Object3D[] = [];
    const walk = (o: THREE.Object3D) => {
      if (!o.visible || p.exclude.has(o) || o.userData?.noPathTrace) return;
      if ((o as any).isCamera && o !== p.camera) return;
      if ((o as any).isMesh) roots.push(o);
      for (const c of o.children) {
        if (c === p.camera) continue; // camera-attached helpers (underwater tint, HUD)
        walk(c);
      }
    };
    walk(this.sceneRoot);
    let t0 = performance.now();
    for (let k = 0; k < roots.length; k++) {
      if (performance.now() - t0 > p.sliceMs) { onProgress?.(k / roots.length); await nextFrame(); t0 = performance.now(); }
      const o = roots[k] as THREE.Mesh;
      try { this.collect(o, cands, stats); } catch (e) { console.warn('[pathtracer] skipped', o.name, e); }
    }

    // budget: nearest first
    cands.sort((a, b) => a.dist - b.dist);
    const geoIndex = new Map<string, number>();
    const matIndex = new Map<THREE.Material, number>();
    const geos: PTSrcGeo[] = [];
    const items: PTItem[] = [];
    const materials: THREE.MeshPhysicalMaterial[] = [];
    const matTris: number[] = [];
    let tris = 0;
    const ox = p.origin.x, oy = p.origin.y, oz = p.origin.z;
    t0 = performance.now();
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k];
      let n = c.mats.length / 16;
      const add = c.tris * n;
      if (tris + add > p.triBudget) {
        // keep as many instances as fit
        n = Math.floor((p.triBudget - tris) / Math.max(1, c.tris));
        if (n <= 0) { stats.overBudget = (stats.overBudget ?? 0) + 1; continue; }
      }
      if (performance.now() - t0 > p.sliceMs) { await nextFrame(); t0 = performance.now(); }
      let gi = geoIndex.get(c.geoKey);
      if (gi === undefined) {
        const g = c.getGeo();
        if (!g.pos.length) continue;
        gi = geos.length;
        geos.push(g);
        geoIndex.set(c.geoKey, gi);
      }
      let mi = matIndex.get(c.mat);
      if (mi === undefined) { mi = materials.length; materials.push(c.mat); matTris.push(0); matIndex.set(c.mat, mi); }
      const m = c.mats.slice(0, n * 16);
      for (let i = 0; i < n; i++) { m[16 * i + 12] -= ox; m[16 * i + 13] -= oy; m[16 * i + 14] -= oz; }
      items.push({ geo: gi, mat: mi, m, c: c.cols ? c.cols.slice(0, n * 3) : null, dy: 0, puv: c.planarUV } as PTItem);
      tris += c.tris * n;
      matTris[mi] += c.tris * n;
    }
    stats.triangles = tris;
    stats.items = items.length;
    stats.geos = geos.length;
    stats.materials = materials.length;
    return { geos, items, materials, matTris, triangles: tris, stats, skippedMaterials: this.resolver.skipped };
  }

  /** Root to walk (set by the caller). */
  sceneRoot: THREE.Object3D = new THREE.Object3D();

  private collect(o: THREE.Mesh, out: Candidate[], stats: Record<string, number>): void {
    const geo = o.geometry as THREE.BufferGeometry;
    if (!geo || !geo.getAttribute('position')) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = Array.isArray(o.material) && geo.groups.length ? geo.groups : [{ start: -1, count: -1, materialIndex: 0 }];
    const inst = (o as any).isInstancedMesh ? (o as unknown as THREE.InstancedMesh) : null;
    const batch = (o as any).isBatchedMesh ? (o as unknown as THREE.BatchedMesh) : null;
    if (batch) { this.collectBatched(batch, out, stats); return; }
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere!;
    if (!Number.isFinite(bs.radius)) return;
    o.updateWorldMatrix(true, false);
    const mw = o.matrixWorld;
    const scaleW = mw.getMaxScaleOnAxis();

    for (const g of groups) {
      const src = mats[g.materialIndex ?? 0] ?? mats[0];
      if (!src) continue;
      const range = g.start >= 0 ? { start: g.start, count: g.count } : null;
      const tris = triCount(geo, range);
      if (tris <= 0) continue;
      const hasInstColor = !!(inst && inst.instanceColor);
      const mat = this.resolver.resolve(o, src, g.materialIndex ?? 0, hasInstColor);
      if (!mat) { stats.skippedNoMat++; continue; }
      const useGeoColor = !!mat.vertexColors && !!geo.getAttribute('color');
      const wantTan = !!mat.normalMap;
      const planarUV = !geo.getAttribute('uv') && !!(mat.map || mat.normalMap || mat.roughnessMap);
      const geoKey = `${geo.uuid}|${range ? `${range.start}:${range.count}` : 'all'}|${useGeoColor ? 1 : 0}|${wantTan ? 1 : 0}`;
      const getGeo = () => canonGeometry(geo, range, useGeoColor, wantTan);

      if (inst) {
        stats.instanced++;
        const n = inst.count;
        const kept: number[] = [];
        const cols: number[] = [];
        let dmin = Infinity;
        const maxD = Math.min(this.p.radius, this.p.instanceRadius);
        for (let i = 0; i < n; i++) {
          inst.getMatrixAt(i, _m2);
          _m.multiplyMatrices(mw, _m2);
          _v.copy(bs.center).applyMatrix4(_m);
          const r = bs.radius * _m.getMaxScaleOnAxis();
          if (!(r > 0) || !Number.isFinite(r)) continue;
          const d = this.test(_v, r, maxD);
          if (d < 0) continue;
          dmin = Math.min(dmin, d);
          for (let e = 0; e < 16; e++) kept.push(_m.elements[e]);
          if (hasInstColor) { inst.getColorAt(i, _c); cols.push(_c.r, _c.g, _c.b); }
        }
        stats.instances += kept.length / 16;
        if (!kept.length) { stats.culled++; continue; }
        out.push({ obj: o, mat, geoKey, getGeo, mats: Float32Array.from(kept), cols: hasInstColor ? Float32Array.from(cols) : null, tris, dist: dmin, planarUV });
      } else {
        _v.copy(bs.center).applyMatrix4(mw);
        const d = this.test(_v, bs.radius * scaleW, this.p.radius);
        if (d < 0) { stats.culled++; continue; }
        stats.meshes++;
        out.push({ obj: o, mat, geoKey, getGeo, mats: Float32Array.from(mw.elements), cols: null, tris, dist: d, planarUV });
      }
    }
  }

  private collectBatched(b: THREE.BatchedMesh, out: Candidate[], stats: Record<string, number>): void {
    const src = Array.isArray(b.material) ? b.material[0] : b.material;
    const info: any[] = (b as any)._instanceInfo ?? [];
    const hasColor = !!(b as any)._colorsTexture;
    const mat = this.resolver.resolve(b, src, 0, hasColor);
    if (!mat) { stats.skippedNoMat++; return; }
    b.updateWorldMatrix(true, false);
    const mw = b.matrixWorld;
    const geo = b.geometry;
    const byGeo = new Map<number, { m: number[]; c: number[]; d: number; tris: number; range: { start: number; count: number } }>();
    const sph = new THREE.Sphere();
    for (let i = 0; i < info.length; i++) {
      if (!info[i]?.active || !b.getVisibleAt(i)) continue;
      const gid = b.getGeometryIdAt(i);
      const r = b.getGeometryRangeAt(gid) as any;
      if (!r) continue;
      b.getMatrixAt(i, _m2);
      _m.multiplyMatrices(mw, _m2);
      b.getBoundingSphereAt(gid, sph);
      _v.copy(sph.center).applyMatrix4(_m);
      const d = this.test(_v, sph.radius * _m.getMaxScaleOnAxis(), Math.min(this.p.radius, this.p.instanceRadius));
      if (d < 0) continue;
      let e = byGeo.get(gid);
      const idx = geo.getIndex();
      const range = idx ? { start: r.indexStart ?? r.start, count: r.indexCount ?? r.count } : { start: r.vertexStart ?? r.start, count: r.vertexCount ?? r.count };
      if (!e) { e = { m: [], c: [], d, tris: Math.floor(range.count / 3), range }; byGeo.set(gid, e); }
      e.d = Math.min(e.d, d);
      for (let k = 0; k < 16; k++) e.m.push(_m.elements[k]);
      if (hasColor) { b.getColorAt(i, _c); e.c.push(_c.r, _c.g, _c.b); }
    }
    stats.batched++;
    for (const [gid, e] of byGeo) {
      const useGeoColor = !!mat.vertexColors && !hasColor && !!geo.getAttribute('color');
      const wantTan = !!mat.normalMap;
      out.push({
        obj: b as unknown as THREE.Mesh, mat,
        geoKey: `${geo.uuid}|b${gid}|${useGeoColor ? 1 : 0}|${wantTan ? 1 : 0}`,
        getGeo: () => canonGeometry(geo, e.range, useGeoColor, wantTan),
        mats: Float32Array.from(e.m), cols: hasColor ? Float32Array.from(e.c) : null, tris: e.tris, dist: e.d,
        planarUV: !geo.getAttribute('uv') && !!(mat.map || mat.normalMap),
      });
      stats.instances += e.m.length / 16;
    }
  }
}

export type { Candidate };
