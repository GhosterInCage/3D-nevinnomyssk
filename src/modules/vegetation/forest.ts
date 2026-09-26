// Tree/shrub rendering: species model library, near/mid mesh LODs (instanced, rebuilt around the
// camera every frame with CPU frustum culling) and the far impostor field (1 km chunks with
// continuous density LOD). All layers cross-fade with complementary screen-space dithering.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import type { VegData } from './data';
import { SPECIES, SPECIES_BY_ID, HEDGE_ID, type SpeciesDef } from './species';
import type { PartArrays, TreeModel } from './treegen';
import { makeTreeMaterials, VU } from './materials';
import { ImpostorAtlas, impostorQuad, makeImpostorMaterials, type BakeSource, type ImpostorUniforms } from './impostor';

export interface ForestParams {
  R0: number;          // mesh LOD0 end (m)
  R1: number;          // mesh LOD1 end / impostor start (m)
  band: number;        // cross-fade band (fraction of the radius)
  S0: number;          // shrub LOD0 end
  S1: number;          // shrub draw distance
  thinStart: number;   // impostor density thinning starts (m)
  thinPow: number;
  drawDistance: number;
  shadowFar: number;
  impFrames: number;
  impFramePx: number;
  impBlend: boolean;
}

export function forestParams(q: string, drawDistance: number, shadowFar: number): ForestParams {
  switch (q) {
    case 'low': return { R0: 0, R1: 90, band: 0.15, S0: 0, S1: 90, thinStart: 500, thinPow: 1.3, drawDistance, shadowFar: Math.min(shadowFar, 400), impFrames: 8, impFramePx: 32, impBlend: false };
    case 'medium': return { R0: 45, R1: 190, band: 0.14, S0: 28, S1: 190, thinStart: 900, thinPow: 1.2, drawDistance, shadowFar: Math.min(shadowFar, 900), impFrames: 8, impFramePx: 48, impBlend: true };
    case 'ultra': return { R0: 110, R1: 420, band: 0.12, S0: 60, S1: 420, thinStart: 2400, thinPow: 1.1, drawDistance, shadowFar, impFrames: 8, impFramePx: 96, impBlend: true };
    case 'high':
    default: return { R0: 75, R1: 300, band: 0.12, S0: 45, S1: 300, thinStart: 1600, thinPow: 1.15, drawDistance, shadowFar: Math.min(shadowFar, 1800), impFrames: 8, impFramePx: 64, impBlend: true };
  }
}

export interface Textures {
  leaves: THREE.Texture;
  bark: Record<string, { map: THREE.Texture; normal: THREE.Texture }>;
}

function toGeometry(p: PartArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(p.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(p.color, 3));
  g.setAttribute('wind', new THREE.BufferAttribute(p.wind, 3));
  g.setIndex(new THREE.BufferAttribute(p.index, 1));
  g.computeBoundingSphere();
  return g;
}

class LodSet {
  attr: THREE.InstancedBufferAttribute;
  meshes: THREE.InstancedMesh[] = [];
  count = 0;
  constructor(private parts: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material; depth: THREE.Material }>, private group: THREE.Object3D, cap: number, shadows: boolean, name: string) {
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    for (const p of parts) {
      if (!p.geo.getAttribute('position') || p.geo.getAttribute('position').count === 0) continue;
      const m = new THREE.InstancedMesh(p.geo, p.mat, cap);
      m.instanceMatrix = this.attr;
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = shadows;
      m.receiveShadow = true;
      m.customDepthMaterial = p.depth;
      m.name = name;
      m.userData.noPathTrace = false;
      this.meshes.push(m);
      group.add(m);
    }
  }
  get capacity(): number { return this.attr.count; }
  ensure(n: number): void {
    if (n <= this.capacity) return;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    a.setUsage(THREE.DynamicDrawUsage);
    a.array.set(this.attr.array as Float32Array);
    this.attr = a;
    for (const m of this.meshes) { m.instanceMatrix = a; (m as any).count = Math.min(m.count, cap); }
  }
  commit(): void {
    for (const m of this.meshes) { m.count = this.count; m.visible = this.count > 0; }
    this.attr.clearUpdateRanges();
    this.attr.addUpdateRange(0, Math.max(16, this.count * 16));
    this.attr.needsUpdate = true;
  }
  dispose(): void { for (const m of this.meshes) { this.group.remove(m); m.dispose(); } }
}

interface SpeciesRT {
  def: SpeciesDef;
  model: TreeModel;
  slot: number;
  lod0: LodSet | null;
  lod1: LodSet;
  isTree: boolean;
  fade0: { value: THREE.Vector4 };
  fade1: { value: THREE.Vector4 };
}

interface Chunk {
  i: number; j: number;
  cx: number; cz: number;
  mesh: THREE.Mesh | null;
  n: number;
  dirty: boolean;
}

const CHUNK = 1024;

export class Forest {
  readonly group = new THREE.Group();
  /** key = species id * 8 + variant */
  readonly species = new Map<number, SpeciesRT>();
  /** species id -> variants */
  readonly variants = new Map<number, SpeciesRT[]>();
  private atlas: ImpostorAtlas | null = null;
  private impMat: THREE.MeshStandardMaterial | null = null;
  private impDepth: THREE.MeshDepthMaterial | null = null;
  readonly impU: ImpostorUniforms = { uImpLod: { value: new THREE.Vector4() }, uImpMisc: { value: new THREE.Vector4(1500, 1, 0, 0) } };
  private chunks: Chunk[] = [];
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private quad = impostorQuad();
  stats = { lod0: 0, lod1: 0, imp: 0, chunks: 0, meshTris: 0, meshCalls: 0 };

  /** Ground height as rendered: the terrain service's bicubic surface when present, else HeightField. */
  readonly ground: { sample(x: number, z: number): number };

  constructor(private ctx: AppContext, private data: VegData, public p: ForestParams) {
    this.group.name = 'vegetation-forest';
    ctx.scene.add(this.group);
    const t = ctx.get<any>('terrain');
    this.ground = t && typeof t.heightAt === 'function'
      ? { sample: (x: number, z: number) => { const h = t.heightAt(x, z); return Number.isFinite(h) ? h : ctx.heightfield.sample(x, z); } }
      : { sample: (x: number, z: number) => ctx.heightfield.sample(x, z) };
  }

  /** Runtime species (variant) used for instance k. */
  pick(k: number): SpeciesRT | undefined {
    const arr = this.variants.get(this.data.sp[k]);
    if (!arr) return undefined;
    return arr.length === 1 ? arr[0] : arr[Math.floor(this.data.rank[k] * 9973) % arr.length];
  }

  addSpecies(def: SpeciesDef, model: TreeModel, tex: Textures, slot: number, variant = 0): void {
    const bark = tex.bark[def.bark];
    const isTree = def.kind === 'tree';
    const fade0 = { value: new THREE.Vector4() };
    const fade1 = { value: new THREE.Vector4() };
    const leafTint = new THREE.Color(...def.leafTint);
    const barkTint = new THREE.Color(...def.barkTint);
    const stiff = def.name === 'poplar_italica' ? 1.3 : def.kind === 'shrub' ? 0.6 : def.kind === 'hedge' ? 0.3 : 1;
    const mk = (part: PartArrays, leaves: boolean, fade: { value: THREE.Vector4 }, lod: number) => {
      const geo = toGeometry(part);
      const { mat, depth } = makeTreeMaterials({
        leaves, map: leaves ? tex.leaves : bark.map, normalMap: leaves ? null : (lod === 0 ? bark.normal : null),
        color: leaves ? leafTint : barkTint, roughness: leaves ? def.roughness : 0.92, modelH: model.height,
        stiff, translucency: def.translucency, fade, key: `${def.name}-${lod}`,
      });
      this.ctx.registerMaterial(mat);
      return { geo, mat, depth };
    };
    const lod0 = (isTree ? this.p.R0 : this.p.S0) > 0 || def.kind === 'hedge'
      ? new LodSet([mk(model.lod0.bark, false, fade0, 0), mk(model.lod0.leaves, true, fade0, 0)], this.group, 64, true, `veg-${def.name}-lod0`)
      : null;
    const lod1 = new LodSet([mk(model.lod1.bark, false, fade1, 1), mk(model.lod1.leaves, true, fade1, 1)], this.group, 256, true, `veg-${def.name}-lod1`);
    // shrubs and hedges are small: skip them in the water mirror pass (trees stay: bank reflections)
    if (!isTree) for (const set of [lod0, lod1]) for (const m of set?.meshes ?? []) m.userData.noReflect = true;
    const rt: SpeciesRT = { def, model, slot, lod0, lod1, isTree, fade0, fade1 };
    this.species.set(def.id * 8 + variant, rt);
    const arr = this.variants.get(def.id) ?? [];
    arr.push(rt);
    this.variants.set(def.id, arr);
  }

  /** Bake impostors for all tree species and create the far-field material. */
  bakeImpostors(tex: Textures): void {
    const trees = [...this.species.values()].filter((s) => s.slot >= 0);
    const atlas = new ImpostorAtlas(Math.max(1, trees.length), this.p.impFrames, this.p.impFramePx);
    // bake from LOD1 (the impostor replaces LOD1, so their silhouettes match)
    const sources: BakeSource[] = trees.map((s) => ({
      slot: s.slot,
      bark: toGeometry(s.model.lod1.bark),
      leaves: toGeometry(s.model.lod1.leaves),
      barkMap: tex.bark[s.def.bark].map,
      leafMap: tex.leaves,
      barkTint: new THREE.Color(...s.def.barkTint),
      leafTint: new THREE.Color(...s.def.leafTint),
      centerY: s.model.centerY,
      radius: s.model.radius,
      height: s.model.height,
    }));
    atlas.bake(this.ctx.renderer, sources);
    for (const src of sources) { src.bark.dispose(); src.leaves.dispose(); }
    this.atlas = atlas;
    const { mat, depth } = makeImpostorMaterials(atlas, this.impU, { blend: this.p.impBlend, translucency: 0.45 });
    this.ctx.registerMaterial(mat);
    this.impMat = mat; this.impDepth = depth;
  }

  get atlasTexture(): THREE.Texture | null { return this.atlas?.albedo ?? null; }
  get atlasTarget(): THREE.WebGLRenderTarget | null { return this.atlas?.rt ?? null; }

  // ------------------------------------------------------------------ far field
  initChunks(): void {
    const n = Math.ceil(20480 / CHUNK);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      this.chunks.push({ i, j, cx: -10240 + (i + 0.5) * CHUNK, cz: -10240 + (j + 0.5) * CHUNK, mesh: null, n: 0, dirty: true });
    }
  }

  private buildChunk(ch: Chunk): void {
    const d = this.data, hf = this.ctx.heightfield;
    if (ch.mesh) { this.group.remove(ch.mesh); ch.mesh.geometry.dispose(); ch.mesh = null; }
    ch.dirty = false;
    const x0 = -10240 + ch.i * CHUNK, z0 = -10240 + ch.j * CHUNK;
    const idx: number[] = [];
    d.forCells(x0 + 1, z0 + 1, x0 + CHUNK - 1, z0 + CHUNK - 1, (c) => {
      const s = d.cellStart[c], e = d.cellStart[c + 1];
      if (s === e) return;
      d.ensureHeights(c, this.ground);
      for (let k = s; k < e; k++) {
        if (d.removed[k]) continue;
        const sp = this.pick(k);
        if (!sp || sp.slot < 0) continue;
        idx.push(k);
      }
    });
    ch.n = idx.length;
    if (!idx.length || !this.impMat) return;
    idx.sort((a, b) => d.rank[a] - d.rank[b]);
    const pos = new Float32Array(idx.length * 4), dim = new Float32Array(idx.length * 4);
    let ymin = Infinity, ymax = -Infinity;
    for (let t = 0; t < idx.length; t++) {
      const k = idx[t];
      const sp = this.pick(k)!;
      const sY = d.h[k] / sp.model.height;
      let sXZ = d.w[k] / sp.model.crown;
      sXZ = Math.min(Math.max(sXZ, sY * 0.65), sY * 1.5);
      pos[t * 4] = d.x[k]; pos[t * 4 + 1] = d.y[k]; pos[t * 4 + 2] = d.z[k]; pos[t * 4 + 3] = d.rot[k];
      dim[t * 4] = sY; dim[t * 4 + 1] = sXZ; dim[t * 4 + 2] = sp.slot; dim[t * 4 + 3] = d.rank[k];
      ymin = Math.min(ymin, d.y[k]); ymax = Math.max(ymax, d.y[k] + d.h[k]);
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', this.quad.position);
    g.setIndex(this.quad.index);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 4));
    g.setAttribute('iDim', new THREE.InstancedBufferAttribute(dim, 4));
    g.instanceCount = idx.length;
    const cy = (ymin + ymax) / 2;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(ch.cx, cy, ch.cz), Math.hypot(CHUNK / 2, CHUNK / 2, (ymax - ymin) / 2) + 60);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, ymin, z0), new THREE.Vector3(x0 + CHUNK, ymax + 40, z0 + CHUNK));
    const m = new THREE.Mesh(g, this.impMat);
    m.customDepthMaterial = this.impDepth!;
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = `veg-imp-${ch.i}-${ch.j}`;
    m.userData.noPathTrace = true;
    m.userData.chunkMinY = ymin;
    ch.mesh = m;
    this.group.add(m);
  }

  /** Build dirty chunks in order of distance; stops after `budgetMs`. Returns true when all are built. */
  buildChunks(budgetMs: number, maxDist = Infinity): boolean {
    const cam = this.ctx.camera.position;
    const t0 = performance.now();
    const todo = this.chunks.filter((c) => c.dirty).map((c) => ({ c, d: Math.hypot(c.cx - cam.x, c.cz - cam.z) })).filter((e) => e.d < maxDist + CHUNK);
    todo.sort((a, b) => a.d - b.d);
    for (const { c } of todo) {
      this.buildChunk(c);
      if (performance.now() - t0 > budgetMs) return false;
    }
    return true;
  }

  get pendingChunks(): number { return this.chunks.filter((c) => c.dirty).length; }

  markDirtyAround(x0: number, z0: number, x1: number, z1: number): void {
    for (const c of this.chunks) {
      const cx0 = -10240 + c.i * CHUNK, cz0 = -10240 + c.j * CHUNK;
      if (cx0 > x1 || cx0 + CHUNK < x0 || cz0 > z1 || cz0 + CHUNK < z0) continue;
      c.dirty = true;
    }
  }

  // ------------------------------------------------------------------ per-frame
  update(): void {
    const cam = this.ctx.camera;
    const P = cam.position;
    const p = this.p;
    VU.uCamPos.value.copy(P);
    const b0 = p.R0 * p.band, b1 = p.R1 * p.band;
    // fade uniforms (complementary)
    for (const s of this.species.values()) {
      if (this.galleryHold) { s.fade0.value.set(0, 0, 0, 0); s.fade1.value.set(0, 0, 0, 0); continue; }
      if (s.isTree) {
        s.fade0.value.set(0, 0, p.R0 - b0, p.R0);
        s.fade1.value.set(p.R0 > 0 ? p.R0 - b0 : 0, p.R0 > 0 ? p.R0 : 0, s.slot >= 0 ? p.R1 - b1 : 0, s.slot >= 0 ? p.R1 : 0);
        if (s.slot < 0) s.fade1.value.set(p.R0 > 0 ? p.R0 - b0 : 0, p.R0 > 0 ? p.R0 : 0, p.R1 * 0.9, p.R1);
      } else {
        const sb0 = p.S0 * p.band;
        s.fade0.value.set(0, 0, p.S0 - sb0, p.S0);
        s.fade1.value.set(p.S0 > 0 ? p.S0 - sb0 : 0, p.S0 > 0 ? p.S0 : 0, p.S1 * 0.8, p.S1);
      }
    }
    this.impU.uImpLod.value.set(p.R1 - b1, p.R1, p.thinStart, p.thinPow);
    const aglS = Math.max(0, P.y - this.ctx.heightfield.sample(P.x, P.z));
    const shadowDist = this.ctx.settings.profile.shadowFar + aglS * 0.55;
    this.impU.uImpMisc.value.x = shadowDist;
    const dbg: Set<string> = (globalThis as any).__vegdbg ?? new Set();

    // ---- near / mid instance lists
    cam.updateMatrixWorld();
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    for (const s of this.species.values()) { if (s.lod0) s.lod0.count = 0; s.lod1.count = 0; }
    const d = this.data, hf = this.ctx.heightfield;
    const mirror = !!this.ctx.get('water');
    const range = Math.max(p.R1, p.S1) + 30;
    const agl = P.y - hf.sample(P.x, P.z);
    let n0 = 0, n1 = 0;
    if (agl < range) {
      const hr = Math.sqrt(Math.max(0, range * range - agl * agl)) + 40;
      d.forCells(P.x - hr, P.z - hr, P.x + hr, P.z + hr, (c) => {
        const s = d.cellStart[c], e = d.cellStart[c + 1];
        if (s === e) return;
        const col = c % d.C, row = (c / d.C) | 0;
        const cx = d.origin + (col + 0.5) * d.cell, cz = d.origin + (row + 0.5) * d.cell;
        if (Math.hypot(cx - P.x, cz - P.z) > hr + d.cell) return;
        d.ensureHeights(c, this.ground);
        for (let k = s; k < e; k++) {
          if (d.removed[k]) continue;
          const sp = this.pick(k);
          if (!sp) continue;
          const h = d.h[k];
          const x = d.x[k], y = d.y[k], z = d.z[k];
          const dy = y + h * 0.5 - P.y;
          const dx = x - P.x, dz = z - P.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const R0 = sp.isTree ? p.R0 : p.S0, R1 = sp.isTree ? p.R1 : p.S1;
          const bb = R0 * p.band;
          const in0 = sp.lod0 && dist < R0;
          const in1 = dist >= R0 - bb && dist < R1;
          if (!in0 && !in1) continue;
          if (sp.def.id === HEDGE_ID) {
            if (this.pushHedge(sp, k, dist, R0)) n0++;
            continue;
          }
          this.sphere.center.set(x, y + h * 0.5, z);
          this.sphere.radius = Math.max(h, d.w[k]) * 0.65 + 1;
          if (!this.frustum.intersectsSphere(this.sphere)) {
            // the water mirror pass reuses these lists: keep trees whose reflection is in view
            if (!mirror || !sp.isTree) continue;
            this.sphere.center.y = y - h * 0.5;
            if (!this.frustum.intersectsSphere(this.sphere)) continue;
          }
          const sY = h / sp.model.height;
          let sXZ = d.w[k] / sp.model.crown;
          sXZ = Math.min(Math.max(sXZ, sY * 0.65), sY * 1.5);
          if (in0) { this.push(sp.lod0!, x, y, z, d.rot[k], sXZ, sY, sXZ); n0++; }
          if (in1) { this.push(sp.lod1, x, y, z, d.rot[k], sXZ, sY, sXZ); n1++; }
        }
      });
    }
    let tris = 0, calls = 0;
    for (const s of this.species.values()) {
      s.lod0?.commit(); s.lod1.commit();
      for (const set of [s.lod0, s.lod1]) {
        if (!set || !set.count) continue;
        for (const m of set.meshes) { tris += set.count * (m.geometry.index ? m.geometry.index.count / 3 : 0); calls++; }
      }
    }
    this.stats.lod0 = n0; this.stats.lod1 = n1; this.stats.meshTris = tris; this.stats.meshCalls = calls;

    // ---- far chunks
    let nImp = 0, nCh = 0;
    for (const ch of this.chunks) {
      const m = ch.mesh;
      if (!m) continue;
      const x0 = -10240 + ch.i * CHUNK, z0 = -10240 + ch.j * CHUNK;
      const qx = Math.max(x0, Math.min(P.x, x0 + CHUNK)), qz = Math.max(z0, Math.min(P.z, z0 + CHUNK));
      const ymin = m.userData.chunkMinY as number;
      const dmin = Math.hypot(qx - P.x, qz - P.z, Math.max(0, ymin - P.y, P.y - ymin - 200));
      const fx = Math.max(Math.abs(P.x - x0), Math.abs(P.x - x0 - CHUNK)), fz = Math.max(Math.abs(P.z - z0), Math.abs(P.z - z0 - CHUNK));
      const dmax = Math.hypot(fx, fz, P.y - ymin);
      const vis = dmin < p.drawDistance && dmax > p.R1 - b1 && !dbg.has('noimp');
      m.visible = vis;
      if (!vis) continue;
      const keep = dmin > p.thinStart ? Math.pow(p.thinStart / dmin, p.thinPow) * 1.18 : 1;
      const g = m.geometry as THREE.InstancedBufferGeometry;
      g.instanceCount = Math.min(ch.n, Math.ceil(ch.n * Math.min(1, keep)) + 1);
      m.castShadow = dmin < shadowDist && !dbg.has('noimpshadow');
      nImp += g.instanceCount; nCh++;
    }
    this.stats.imp = nImp; this.stats.chunks = nCh;
  }

  private push(set: LodSet, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): void {
    set.ensure(set.count + 1);
    const a = set.attr.array as Float32Array;
    const o = set.count * 16;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    a[o] = c * sx; a[o + 1] = 0; a[o + 2] = -s * sx; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = s * sz; a[o + 9] = 0; a[o + 10] = c * sz; a[o + 11] = 0;
    a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
    set.count++;
  }

  /** Hedges are stored as (centre, length, direction); expand into 2 m modules. */
  private pushHedge(sp: SpeciesRT, k: number, dist: number, R0: number): boolean {
    const d = this.data;
    const L = d.w[k];
    const n = Math.max(1, Math.round(L / 2));
    const seg = L / n;
    const dirx = Math.cos(d.rot[k]), dirz = -Math.sin(d.rot[k]);
    this.sphere.center.set(d.x[k], d.y[k] + 0.6, d.z[k]);
    this.sphere.radius = L / 2 + 2;
    if (!this.frustum.intersectsSphere(this.sphere)) return false;
    const set = sp.lod0 && dist < R0 ? sp.lod0 : sp.lod1;
    const sy = d.h[k] / sp.model.height;
    for (let i = 0; i < n; i++) {
      const t = (i - (n - 1) / 2) * seg;
      const x = d.x[k] + dirx * t, z = d.z[k] + dirz * t;
      const y = this.ground.sample(x, z) - 0.1;
      this.push(set, x, y, z, d.rot[k], seg / 2, sy, 1);
    }
    return true;
  }

  /** Debug: rows of every species (LOD0, LOD1, impostor) starting at x,z along +x. */
  debugGallery(x: number, z: number, spacing = 18, only?: number[], lod0Only = false): void {
    const hf = this.ctx.heightfield;
    const g = new THREE.Group();
    g.name = 'veg-gallery';
    let i = 0;
    const list = [...this.species.values()].filter((s) => !only || only.includes(s.def.id));
    const impPos: number[] = [], impDim: number[] = [];
    for (const s of list) {
      const x0 = x + i * spacing * (lod0Only ? 1 : 3);
      i++;
      const rows: Array<[LodSet | null, number]> = lod0Only ? [[s.lod0, 0]] : [[s.lod0, 0], [s.lod1, 1]];
      for (const [set, row] of rows) {
        if (!set) continue;
        const px = x0 + row * spacing, pz = z;
        const y = hf.sample(px, pz);
        for (const m of set.meshes) {
          const im = new THREE.InstancedMesh(m.geometry, m.material as THREE.Material, 1);
          im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(px, y, pz));
          im.customDepthMaterial = m.customDepthMaterial;
          im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
          g.add(im);
        }
      }
      if (s.slot >= 0 && !lod0Only) {
        const px = x0 + 2 * spacing, pz = z;
        impPos.push(px, hf.sample(px, pz), pz, 0);
        impDim.push(1, 1, s.slot, 0);
      }
    }
    if (impPos.length && this.atlas) {
      const u: ImpostorUniforms = { uImpLod: { value: new THREE.Vector4(0, 0.001, 1e9, 1) }, uImpMisc: { value: new THREE.Vector4(1e9, 1, 0, 0) } };
      const { mat, depth } = makeImpostorMaterials(this.atlas, u, { blend: this.p.impBlend, translucency: 0.45 });
      this.ctx.registerMaterial(mat);
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', this.quad.position);
      geo.setIndex(this.quad.index);
      geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(impPos), 4));
      geo.setAttribute('iDim', new THREE.InstancedBufferAttribute(new Float32Array(impDim), 4));
      geo.instanceCount = impPos.length / 4;
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false; m.customDepthMaterial = depth; m.castShadow = true; m.receiveShadow = true;
      g.add(m);
    }
    this.ctx.scene.add(g);
    // keep the fades of the real LOD sets from hiding gallery LODs
    this.galleryHold = true;
  }
  galleryHold = false;

  /** Trunk colliders around a point. */
  colliders(x: number, z: number, r: number): Array<{ key: string; x: number; y: number; z: number; radius: number; half: number }> {
    const out: Array<{ key: string; x: number; y: number; z: number; radius: number; half: number }> = [];
    const d = this.data;
    d.forCells(x - r, z - r, x + r, z + r, (c) => {
      const s = d.cellStart[c], e = d.cellStart[c + 1];
      if (s === e) return;
      d.ensureHeights(c, this.ground);
      for (let k = s; k < e; k++) {
        if (d.removed[k]) continue;
        const sp = this.pick(k);
        if (!sp || !sp.isTree) continue;
        const dx = d.x[k] - x, dz = d.z[k] - z;
        if (dx * dx + dz * dz > r * r) continue;
        const sY = d.h[k] / sp.model.height;
        const radius = Math.max(0.08, sp.model.trunkRadius * sY * 0.9);
        const half = Math.max(1.2, Math.min(sp.model.crownBaseY * sY, 6)) / 2;
        out.push({ key: `veg${k}`, x: d.x[k], y: d.y[k] + half, z: d.z[k], radius, half });
      }
    });
    return out;
  }

  dispose(): void {
    for (const s of this.species.values()) { s.lod0?.dispose(); s.lod1.dispose(); }
    for (const c of this.chunks) if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
    this.ctx.scene.remove(this.group);
  }
}

export { SPECIES, SPECIES_BY_ID };
