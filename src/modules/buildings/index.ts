// Buildings module: ~57k cleaned Overture footprints with inferred heights,
// typologies, roofs and materials (pipeline/build_buildings.py), meshed per
// 512 m tile in Web Workers, rendered with a procedural facade/roof shader.
//
// Service 'buildings': { hideById, hideInPolygon, infoAt, count, ... } (see BuildingsAPI)
// Colliders: prisms from footprints (ctx.registerColliders).
import * as THREE from 'three';
import type { AppContext, CityModule, StaticCollider } from '../../core/context';
import { fetchBuffer, fetchJSON, dataUrl } from '../../core/data';
import { parseBuildings, decodeRings, type BuildingData, Rec, REC_SIZE, R, TYP_NAMES, FLAG } from './format';
import { floorBase, fenceEnds, type TileMesh } from './mesher';
import { createBuildingMaterial, enableStreetLamps, makeUniforms, noiseTexture, type BuildingUniforms } from './material';

export interface BuildingInfo {
  index: number;
  id: string;
  name?: string;
  levels: number;
  height: number;      // metres from ground (lowest point) to the top of the roof
  cls: string;         // typology name
  base: number;        // floor base elevation (m a.s.l.)
  top: number;         // roof top elevation (m a.s.l.)
  labelled: boolean;   // levels from OSM tags (true) or inferred (false)
}

export interface BuildingsAPI {
  count: number;
  /** Hide buildings by Overture id (full or first 16 hex digits), 'w123'/'r123' OSM ids or '#<index>'. */
  hideById(ids: string[]): Promise<number>;
  /** Hide buildings whose centroid lies inside the xz polygon (flat [x0,z0,x1,z1,...]) or that mostly overlap it. */
  hideInPolygon(ringXZ: number[]): number;
  infoAt(x: number, z: number): BuildingInfo | null;
  /** Indices of buildings whose footprint bbox intersects the circle. */
  query(x: number, z: number, r: number): number[];
  /** Outer ring of building i (world x,z interleaved). */
  footprint(i: number): Float64Array | null;
  /** Roof-top elevation at x,z if inside a building, else null. */
  roofAt(x: number, z: number): number | null;
  /** Overture id prefix (8-4-4 hex) of building i, or '#i' before the id table is loaded. */
  idOf(i: number): string;
  /** Info for building index i. */
  info(i: number): BuildingInfo | null;
  /** Rendering statistics of the buildings layer (meshes installed / visible, triangles). */
  stats(): { meshes: number; visible: number; triangles: number; visibleTriangles: number; detailChunks: number; hidden: number };
  ready: Promise<void>;
}

const TILE_DETAIL_RADIUS: Record<string, number> = { low: 200, medium: 400, high: 560, ultra: 800 };
const GRID = 64; // spatial index cell (m)

/** A unit of meshing: base chunks cover 2x2 data tiles (1024 m), detail chunks one data tile (512 m). */
interface Chunk {
  key: string;
  tiles: number[];
  cx: number; cz: number;   // mesh origin (centre)
  half: number;             // half size (m)
  detail: boolean;
  mesh: THREE.Mesh | null;
  wanted: boolean;
  pending: boolean;
  version: number;          // bumped when the hidden set changes
  built: number;            // version of the installed mesh
}

const BASE_GROUP = 2; // data tiles per base chunk side

class WorkerPool {
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private queue: Array<{ msg: any; prio: () => number; resolve: (v: any) => void; reject: (e: any) => void }> = [];
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; w: number }>();
  private nextId = 1;

  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('../../workers/buildings.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this.onMessage(i, e.data);
      w.onerror = (e) => {
        console.error('[buildings] worker error', e.message);
        // fail the jobs of this worker instead of hanging the app's ready state
        for (const [id, job] of this.waiting) if (job.w === i) { this.waiting.delete(id); job.reject(new Error(e.message || 'worker error')); }
        this.busy[i] = false;
        this.pump();
      };
      this.workers.push(w);
      this.busy.push(false);
    }
  }

  each(fn: (w: Worker, i: number) => void): void { this.workers.forEach(fn); }

  get size(): number { return this.workers.length; }

  broadcast(msg: any): void { for (const w of this.workers) w.postMessage(msg); }

  run(msg: any, prio: () => number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, prio, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    for (let i = 0; i < this.workers.length; i++) {
      if (this.busy[i] || !this.queue.length) continue;
      // pick highest priority (lowest value)
      let bi = 0, bv = Infinity;
      for (let k = 0; k < this.queue.length; k++) {
        const v = this.queue[k].prio();
        if (v < bv) { bv = v; bi = k; }
      }
      const job = this.queue.splice(bi, 1)[0];
      const id = this.nextId++;
      this.busy[i] = true;
      this.waiting.set(id, { resolve: job.resolve, reject: job.reject, w: i });
      this.workers[i].postMessage({ ...job.msg, id });
    }
  }

  private onMessage(i: number, data: any): void {
    if (data.type === 'ready') return;
    const job = this.waiting.get(data.id);
    if (job) {
      this.waiting.delete(data.id);
      this.busy[job.w] = false;
      if (data.type === 'error') job.reject(new Error(data.message)); else job.resolve(data);
    } else {
      this.busy[i] = false;
    }
    this.pump();
  }
}

function geometryFrom(m: TileMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  g.setAttribute('aA', new THREE.BufferAttribute(m.aA, 4, false));
  g.setAttribute('aC', new THREE.BufferAttribute(m.aC, 4, true));
  g.setAttribute('aW', new THREE.BufferAttribute(m.aW, 4, false));
  g.setAttribute('color', new THREE.BufferAttribute(m.color, 3, true));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  const b = m.bbox;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}

function pointInRing(x: number, z: number, r: ArrayLike<number>): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], zi = r[2 * i + 1], xj = r[2 * j], zj = r[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

class Buildings {
  d!: BuildingData;
  rec!: Rec;
  meta: any = {};
  ground!: Float32Array; // gMin, gMax per building
  fground: Float32Array = new Float32Array(0); // ground at both ends of each fence
  hidden!: Uint8Array;
  base = new Map<number, Chunk>();   // key: base chunk index
  detail = new Map<number, Chunk>(); // key: data tile index
  group = new THREE.Group();
  mat!: THREE.MeshStandardMaterial;
  /** proxy for the path tracer: per-vertex average albedo */
  ptMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  u: BuildingUniforms = makeUniforms();
  pool!: WorkerPool;
  gridStart!: Uint32Array;
  gridItems!: Uint32Array;
  gridN = 0;
  bboxes!: Float32Array; // minX, minZ, maxX, maxZ
  ids: { hi: Uint32Array; lo: Uint32Array; osm: Uint32Array; kind: Uint8Array } | null = null;
  idsPromise: Promise<void> | null = null;
  private lastLodCheck = -1;
  private detailRadius = 450;
  private initialDone = false;

  constructor(private ctx: AppContext) {}

  private t0 = performance.now();
  private timing: Record<string, number> = {};
  private mark(k: string): void { this.timing[k] = Math.round(performance.now() - this.t0); }

  async init(): Promise<void> {
    const ctx = this.ctx;
    this.t0 = performance.now();
    // worker pool first: the data file is fetched and gunzipped inside a worker
    const nw = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.pool = new WorkerPool(nw);
    const url = new URL(dataUrl('buildings/buildings.bin.gz'), location.href).href;
    const [buf, meta, noise] = await Promise.all([
      this.pool.run({ type: 'fetch', url }, () => 0).then((r) => { this.mark('data'); return r.buf as ArrayBuffer; })
        .catch((e) => { console.warn('[buildings] worker fetch failed, falling back', e); return fetchBuffer('buildings/buildings.bin.gz'); }),
      fetchJSON('buildings/meta.json').catch(() => ({})).then((m) => { this.mark('meta'); return m; }),
      // 1 MB raw bytes, no gunzip: fetch on the main thread (does not wait for a worker to boot)
      fetch(new URL(`${import.meta.env.BASE_URL}textures/buildings/noise.bin`, location.href).href)
        .then((r) => { if (!r.ok) throw new Error(`noise.bin ${r.status}`); return r.arrayBuffer(); })
        .then((buf) => { this.mark('noise'); return noiseTexture(buf); })
        .catch((e) => { console.warn('[buildings] noise texture', e); return null; }),
    ]);
    this.mark('fetched');
    this.meta = meta;
    this.d = parseBuildings(buf);
    this.rec = new Rec(this.d);
    this.u.uNoise.value = noise ?? this.fallbackNoise();
    const hf = ctx.heightfield;
    this.u.bHF.value = hf.texture;
    this.u.bHFP.value.set(hf.half, hf.res, hf.n);
    const extra: Record<string, THREE.IUniform> = {};
    this.mat = ctx.registerMaterial(createBuildingMaterial(this.u, extra));
    // street lamps light the facades at night once the roads module is up
    if (ctx.settings.wants('roads')) {
      ctx.need<any>('roads').then((roads) => {
        try {
          if (enableStreetLamps(this.mat, extra, roads)) console.info('[buildings] street-lamp facade lighting on');
        } catch (e) { console.warn('[buildings] street lamps', e); }
      });
    }
    this.group.name = 'buildings';
    ctx.scene.add(this.group);
    if (!ctx.settings.wants('sky')) this.fallbackLights();
    const t0 = performance.now();
    this.computeGround();
    this.buildIndex();
    this.hidden = new Uint8Array(this.d.n);
    const t1 = performance.now();
    this.mark('ground');
    // each worker gets its own copy of the dataset + ground heights
    this.pool.each((w) => {
      w.postMessage({ type: 'init', buf: buf.slice(0), ground: this.ground.slice(0), hidden: this.hidden.slice(0), fground: this.fground.slice(0) });
    });
    const d = this.d, tx = d.tilesX, gN = Math.ceil(tx / BASE_GROUP);
    for (let t = 0; t < d.nTiles; t++) {
      const cnt = d.tileStart[t + 1] - d.tileStart[t];
      if (!cnt) continue;
      const x = t % tx, z = Math.floor(t / tx);
      this.detail.set(t, {
        key: `d${t}`, tiles: [t], cx: d.originX + (x + 0.5) * d.tileSize, cz: d.originZ + (z + 0.5) * d.tileSize,
        half: d.tileSize / 2, detail: true, mesh: null, wanted: false, pending: false, version: 0, built: -1,
      });
      const gx = Math.floor(x / BASE_GROUP), gz = Math.floor(z / BASE_GROUP), g = gz * gN + gx;
      let c = this.base.get(g);
      if (!c) {
        const size = d.tileSize * BASE_GROUP;
        c = { key: `b${g}`, tiles: [], cx: d.originX + (gx + 0.5) * size, cz: d.originZ + (gz + 0.5) * size,
          half: size / 2, detail: false, mesh: null, wanted: true, pending: false, version: 0, built: -1 };
        this.base.set(g, c);
      }
      c.tiles.push(t);
    }
    console.info(`[buildings] ${this.d.n} buildings in ${this.detail.size} tiles / ${this.base.size} base chunks; ground+index ${(t1 - t0).toFixed(0)} ms; ${nw} workers`);
    this.idsPromise = this.loadIds();
    ctx.events.on('settings', () => this.updateDetailRadius());
  }

  async mesh(): Promise<void> {
    const ctx = this.ctx;
    // initial content: all base tiles (nearest first) + detail tiles around the start camera
    this.updateDetailRadius();
    // mark the detail chunks around the start camera (no jobs yet), then send every worker ONE batch
    // with its share of detail + base chunks, nearest first (one reply per worker = few main-thread tasks)
    this.updateLod(true, false);
    const p = ctx.camera.position;
    const d2 = (c: Chunk) => Math.hypot(c.cx - p.x, c.cz - p.z) - (c.detail ? 1e6 : 0);
    const all = [...this.detail.values()].filter((c) => c.wanted).concat([...this.base.values()]).sort((a, b) => d2(a) - d2(b));
    const nb = this.pool.size;
    const batches: Chunk[][] = Array.from({ length: nb }, () => []);
    all.forEach((c, i) => batches[i % nb].push(c));
    const jobs = batches.filter((b) => b.length).map((b) => this.buildBatch(b));
    this.mark('queued');
    await Promise.all(jobs);
    this.mark('meshed');
    this.initialDone = true;
    let tris = 0;
    for (const c of this.base.values()) if (c.mesh) tris += (c.mesh.geometry.index?.count ?? 0) / 3;
    let dtris = 0;
    for (const c of this.detail.values()) if (c.mesh) dtris += (c.mesh.geometry.index?.count ?? 0) / 3;
    console.info(`[buildings] timing(ms) ${JSON.stringify(this.timing)}; base ${Math.round(tris / 1000)}k tris, detail ${Math.round(dtris / 1000)}k tris`);
  }

  /** Minimal lighting for isolated tests (?only=buildings) when the sky module is not loaded. */
  private fallbackLights(): void {
    const ctx = this.ctx;
    const sun = new THREE.DirectionalLight(0xfff4e6, 3.0);
    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x6a6050, 1.1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -600; sc.right = sc.top = 600; sc.near = 10; sc.far = 6000;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    ctx.scene.add(sun, sun.target, hemi);
    if (!ctx.scene.background) ctx.backdrop.scene.background = new THREE.Color(0x9ec3e6);
    ctx.scene.fog = ctx.scene.fog ?? new THREE.Fog(0xb8cde0, 3000, 30000);
    ctx.onUpdate(() => {
      const d = ctx.env.sunDirection;
      const c = ctx.camera.position;
      const look = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      const focus = c.clone().addScaledVector(look, Math.min(500, 150 + ctx.cameraAGL));
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(d, 3000);
      sun.intensity = 3.2 * Math.max(0, d.y) ** 0.4;
      hemi.intensity = 0.15 + 1.0 * Math.max(0, d.y + 0.1) ** 0.5;
    });
  }

  private fallbackNoise(): THREE.Texture {
    const n = 64;
    const data = new Uint8Array(n * n * 4);
    for (let i = 0; i < data.length; i++) data[i] = 100 + Math.floor(Math.random() * 56);
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }

  private updateDetailRadius(): void {
    this.detailRadius = TILE_DETAIL_RADIUS[this.ctx.settings.quality] ?? 450;
  }

  // ------------------------------------------------------------------ ground & spatial index
  private computeGround(): void {
    const d = this.d, hf = this.ctx.heightfield;
    const g = new Float32Array(d.n * 2);
    this.bboxes = new Float32Array(d.n * 4);
    const dv = d.dv;
    for (let i = 0; i < d.n; i++) {
      const o = d.recOff + i * REC_SIZE;
      const cx = dv.getFloat32(o + R.cx, true), cz = dv.getFloat32(o + R.cz, true);
      const vs = dv.getUint32(o + R.vertStart, true);
      const rs = dv.getUint32(o + R.ringStart, true);
      const len = d.ringLen[rs];
      const q = dv.getUint8(o + R.flags) & FLAG.Q2 ? 0.02 : 0.01;
      let mn = hf.sample(cx, cz), mx = mn;
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
      let px = 0, pz = 0;
      for (let k = 0; k < len; k++) {
        const x = cx + d.verts[2 * (vs + k)] * q, z = cz + d.verts[2 * (vs + k) + 1] * q;
        const h = hf.sample(x, z);
        if (h < mn) mn = h; if (h > mx) mx = h;
        if (k > 0) {
          const h2 = hf.sample((x + px) / 2, (z + pz) / 2);
          if (h2 < mn) mn = h2; if (h2 > mx) mx = h2;
        }
        px = x; pz = z;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
      }
      g[2 * i] = mn; g[2 * i + 1] = mx;
      this.bboxes[4 * i] = bx0; this.bboxes[4 * i + 1] = bz0; this.bboxes[4 * i + 2] = bx1; this.bboxes[4 * i + 3] = bz1;
    }
    this.ground = g;
    // fences: ground at both ends
    const fg = new Float32Array(d.nFences * 2);
    for (let t = 0; t < d.nTiles; t++) {
      for (let f = d.fenceStart[t]; f < d.fenceStart[t + 1]; f++) {
        const [x0, z0, x1, z1] = fenceEnds(d, f, t);
        fg[2 * f] = hf.sample(x0, z0);
        fg[2 * f + 1] = hf.sample(x1, z1);
      }
    }
    this.fground = fg;
  }

  private buildIndex(): void {
    const d = this.d;
    const half = -d.originX;
    const n = Math.ceil((2 * half) / GRID);
    this.gridN = n;
    const counts = new Uint32Array(n * n + 1);
    const cellsOf = (i: number, cb: (c: number) => void) => {
      const x0 = Math.max(0, Math.floor((this.bboxes[4 * i] + half) / GRID));
      const z0 = Math.max(0, Math.floor((this.bboxes[4 * i + 1] + half) / GRID));
      const x1 = Math.min(n - 1, Math.floor((this.bboxes[4 * i + 2] + half) / GRID));
      const z1 = Math.min(n - 1, Math.floor((this.bboxes[4 * i + 3] + half) / GRID));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cb(z * n + x);
    };
    for (let i = 0; i < d.n; i++) cellsOf(i, (c) => counts[c + 1]++);
    for (let c = 0; c < n * n; c++) counts[c + 1] += counts[c];
    const items = new Uint32Array(counts[n * n]);
    const fill = counts.slice(0, n * n);
    for (let i = 0; i < d.n; i++) cellsOf(i, (c) => { items[fill[c]++] = i; });
    this.gridStart = counts;
    this.gridItems = items;
  }

  query(x: number, z: number, r: number): number[] {
    const half = -this.d.originX, n = this.gridN;
    const x0 = Math.max(0, Math.floor((x - r + half) / GRID)), x1 = Math.min(n - 1, Math.floor((x + r + half) / GRID));
    const z0 = Math.max(0, Math.floor((z - r + half) / GRID)), z1 = Math.min(n - 1, Math.floor((z + r + half) / GRID));
    const out = new Set<number>();
    const bb = this.bboxes;
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
      const c = gz * n + gx;
      for (let k = this.gridStart[c]; k < this.gridStart[c + 1]; k++) {
        const i = this.gridItems[k];
        // circle vs bbox
        const cx = Math.max(bb[4 * i], Math.min(x, bb[4 * i + 2]));
        const cz = Math.max(bb[4 * i + 1], Math.min(z, bb[4 * i + 3]));
        if ((cx - x) ** 2 + (cz - z) ** 2 <= r * r) out.add(i);
      }
    }
    return [...out];
  }

  // ------------------------------------------------------------------ heights
  floorBaseOf(i: number): number {
    this.rec.at(i);
    return floorBase(this.ground[2 * i], this.ground[2 * i + 1], this.rec.socle) + this.rec.minHeight * 0;
  }

  topOf(i: number): number {
    this.rec.at(i);
    const fb = floorBase(this.ground[2 * i], this.ground[2 * i + 1], this.rec.socle);
    return fb + this.rec.height + this.rec.roofHeight;
  }

  // ------------------------------------------------------------------ tile building
  private build(c: Chunk): Promise<void> {
    return this.buildBatch([c]);
  }

  /** Build several chunks in one worker round-trip (results install together). */
  private buildBatch(list: Chunk[]): Promise<void> {
    const cs = list.filter((c) => !c.pending);
    if (!cs.length) return Promise.resolve();
    for (const c of cs) c.pending = true;
    const vers = cs.map((c) => c.version);
    const jobs = cs.map((c) => ({ key: c.key, tiles: c.tiles, ox: c.cx, oz: c.cz, detail: c.detail }));
    const prio = () => Math.min(...cs.map((c) => this.priority(c)));
    return this.pool.run({ type: 'build', jobs }, prio)
      .then((res) => {
        const again: Chunk[] = [];
        if (!this.initialDone) this.timing.workerMs = Math.max(this.timing.workerMs ?? 0, Math.round(res.ms));
        res.results.forEach((r: any, k: number) => {
          const c = cs[k];
          c.pending = false;
          if (!c.wanted) return;
          this.install(c, r.mesh);
          c.built = vers[k];
          if (c.version !== vers[k]) again.push(c);
        });
        if (again.length) return this.buildBatch(again);
      })
      .catch((e) => { for (const c of cs) c.pending = false; console.warn('[buildings] build failed', cs.map((c) => c.key).join(','), e); });
  }

  private priority(c: Chunk): number {
    const p = this.ctx.camera.position;
    const d = Math.hypot(c.cx - p.x, c.cz - p.z);
    return c.detail ? d - 1e6 : d; // detail first (it is what the camera is close to)
  }

  private install(c: Chunk, m: TileMesh | null): void {
    if (c.mesh) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
      c.mesh = null;
    }
    if (!m || m.index.length === 0) return;
    const g = geometryFrom(m);
    const mesh = new THREE.Mesh(g, this.mat);
    mesh.position.set(c.cx, 0, c.cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `bld-${c.key}`;
    mesh.userData.ptMaterial = this.ptMat;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    c.mesh = mesh;
  }

  private dropMesh(c: Chunk): void {
    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    c.built = -1;
  }

  // ------------------------------------------------------------------ LOD / streaming
  updateLod(force = false, launch = true): Promise<void>[] {
    const ctx = this.ctx;
    const p = ctx.camera.position;
    const agl = ctx.cameraAGL;
    // detail only makes sense near the ground
    const radius = agl > 900 ? 0 : this.detailRadius * (agl > 400 ? 0.6 : 1);
    this.u.uDetailDist.value = radius;
    const drawDist = ctx.settings.profile.drawDistance;
    const jobs: Promise<void>[] = [];
    const dist = (c: Chunk) => Math.hypot(Math.max(0, Math.abs(p.x - c.cx) - c.half), Math.max(0, Math.abs(p.z - c.cz) - c.half));
    const todo: Chunk[] = [];
    for (const c of this.detail.values()) {
      const dd = dist(c);
      if (dd < radius) {
        if (!c.wanted) c.wanted = true;
        if (c.built !== c.version && !c.pending) todo.push(c);
      } else if (c.wanted && dd > radius + 150) {
        c.wanted = false;
        this.dropMesh(c);
      }
    }
    if (todo.length && launch) {
      // split across the workers, nearest first
      todo.sort((a, b) => dist(a) - dist(b));
      const nb = Math.min(todo.length, this.pool.size);
      const batches: Chunk[][] = Array.from({ length: nb }, () => []);
      todo.forEach((c, i) => batches[i % nb].push(c));
      for (const bt of batches) jobs.push(this.buildBatch(bt));
    }
    for (const c of this.base.values()) {
      if (c.mesh) c.mesh.visible = dist(c) < drawDist;
    }
    if (jobs.length && !force) this.ctx.pending(Promise.all(jobs));
    return jobs;
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const env = ctx.env;
    this.u.uNight.value = env.night;
    const sy = env.sunDirection.y;
    this.u.uDay.value = THREE.MathUtils.smoothstep(sy, -0.12, 0.35);
    this.u.uTime.value = env.elapsed;
    const h = env.hours;
    // share of lit windows: evening peak, low after midnight
    const lit = h >= 17 && h < 22 ? 0.42 : h >= 22 || h < 1 ? 0.3 : h < 5 ? 0.08 : h < 8 ? 0.22 : 0.3;
    this.u.uLitFrac.value = lit;
    // fake reflection colours follow the sun
    const day = this.u.uDay.value;
    this.u.uSkyZenith.value.setRGB(0.18 * day + 0.01, 0.35 * day + 0.015, 0.75 * day + 0.03);
    this.u.uSkyHorizon.value.setRGB(0.7 * day + 0.02, 0.76 * day + 0.02, 0.82 * day + 0.04);
    this.u.uGroundRefl.value.setRGB(0.09 * day + 0.01, 0.09 * day + 0.01, 0.085 * day + 0.012);
    // LOD check ~4x per second or when the camera moved a lot
    const now = performance.now();
    if (this.initialDone && (now - this.lastLodCheck > 250)) {
      this.lastLodCheck = now;
      this.updateLod();
    }
    void dt;
  }

  // ------------------------------------------------------------------ hiding
  private markHidden(list: number[]): void {
    if (!list.length) return;
    const affected = new Set<number>();
    for (const i of list) {
      if (this.hidden[i]) continue;
      this.hidden[i] = 1;
      this.rec.at(i);
      const o = this.d.recOff + i * REC_SIZE;
      const cx = this.d.dv.getFloat32(o + R.cx, true), cz = this.d.dv.getFloat32(o + R.cz, true);
      const tx = Math.floor((cx - this.d.originX) / this.d.tileSize), tz = Math.floor((cz - this.d.originZ) / this.d.tileSize);
      affected.add(Math.max(0, Math.min(this.d.tilesX - 1, tz)) * this.d.tilesX + Math.max(0, Math.min(this.d.tilesX - 1, tx)));
    }
    if (!affected.size) return;
    this.pool.broadcast({ type: 'hidden', hidden: this.hidden.slice(0) });
    const jobs: Promise<void>[] = [];
    const gN = Math.ceil(this.d.tilesX / BASE_GROUP);
    const groups = new Set<number>();
    for (const t of affected) {
      const x = t % this.d.tilesX, z = Math.floor(t / this.d.tilesX);
      groups.add(Math.floor(z / BASE_GROUP) * gN + Math.floor(x / BASE_GROUP));
      const c = this.detail.get(t);
      if (c) { c.version++; if (c.wanted) jobs.push(this.build(c)); }
    }
    const bl: Chunk[] = [];
    for (const g of groups) {
      const c = this.base.get(g);
      if (c) { c.version++; bl.push(c); }
    }
    if (bl.length) jobs.push(this.buildBatch(bl));
    this.ctx.pending(Promise.all(jobs));
  }

  hideInPolygon(ring: number[]): number {
    if (!ring || ring.length < 6) return 0;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < ring.length; k += 2) {
      x0 = Math.min(x0, ring[k]); x1 = Math.max(x1, ring[k]);
      z0 = Math.min(z0, ring[k + 1]); z1 = Math.max(z1, ring[k + 1]);
    }
    const cands = this.query((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + 1);
    const hit: number[] = [];
    for (const i of cands) {
      const o = this.d.recOff + i * REC_SIZE;
      const cx = this.d.dv.getFloat32(o + R.cx, true), cz = this.d.dv.getFloat32(o + R.cz, true);
      if (pointInRing(cx, cz, ring)) { hit.push(i); continue; }
      // or most footprint vertices inside
      const r = decodeRings(this.d, i)[0];
      let inside = 0;
      for (let k = 0; k < r.length; k += 2) if (pointInRing(r[k], r[k + 1], ring)) inside++;
      if (inside * 2 > r.length / 2) hit.push(i);
    }
    this.markHidden(hit);
    return hit.length;
  }

  private async loadIds(): Promise<void> {
    try {
      const buf = await fetchBuffer('buildings/ids.bin.gz');
      const dv = new DataView(buf);
      const n = dv.getUint32(4, true);
      let o = 8;
      const hi = new Uint32Array(buf.slice(o, o + 4 * n)); o += 4 * n;
      const lo = new Uint32Array(buf.slice(o, o + 4 * n)); o += 4 * n;
      const osm = new Uint32Array(buf.slice(o, o + 4 * n)); o += 4 * n;
      const kind = new Uint8Array(buf.slice(o, o + n));
      this.ids = { hi, lo, osm, kind };
    } catch (e) {
      console.warn('[buildings] ids not available', e);
    }
  }

  idOf(i: number): string {
    if (!this.ids) return `#${i}`;
    const h = this.ids.hi[i].toString(16).padStart(8, '0') + this.ids.lo[i].toString(16).padStart(8, '0');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
  }

  async hideById(ids: string[]): Promise<number> {
    if (!this.idsPromise) this.idsPromise = this.loadIds();
    await this.idsPromise;
    const want = new Set<string>();
    const osmWant = new Set<string>();
    const idx: number[] = [];
    for (const s of ids) {
      if (!s) continue;
      if (s[0] === '#') { const i = +s.slice(1); if (i >= 0 && i < this.d.n) idx.push(i); continue; }
      const m = /^([nwr])(\d+)$/.exec(s);
      if (m) { osmWant.add(`${m[1]}${m[2]}`); continue; }
      want.add(s.replace(/-/g, '').toLowerCase().slice(0, 16));
    }
    if (this.ids) {
      const kinds = ['', 'n', 'w', 'r'];
      for (let i = 0; i < this.d.n; i++) {
        if (want.size) {
          const h = this.ids.hi[i].toString(16).padStart(8, '0') + this.ids.lo[i].toString(16).padStart(8, '0');
          if (want.has(h)) { idx.push(i); continue; }
        }
        if (osmWant.size && this.ids.kind[i] && osmWant.has(kinds[this.ids.kind[i]] + this.ids.osm[i])) idx.push(i);
      }
    }
    this.markHidden(idx);
    return idx.length;
  }

  stats(): { meshes: number; visible: number; triangles: number; visibleTriangles: number; detailChunks: number; hidden: number } {
    let meshes = 0, visible = 0, triangles = 0, visibleTriangles = 0, detailChunks = 0, hidden = 0;
    const cam = this.ctx.camera;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const box = new THREE.Box3();
    for (const c of [...this.base.values(), ...this.detail.values()]) {
      if (!c.mesh) continue;
      meshes++;
      if (c.detail) detailChunks++;
      const t = (c.mesh.geometry.index?.count ?? 0) / 3;
      triangles += t;
      box.copy(c.mesh.geometry.boundingBox!).applyMatrix4(c.mesh.matrixWorld);
      if (c.mesh.visible && frustum.intersectsBox(box)) { visible++; visibleTriangles += t; }
    }
    for (let i = 0; i < this.hidden.length; i++) hidden += this.hidden[i];
    return { meshes, visible, triangles, visibleTriangles, detailChunks, hidden };
  }

  // ------------------------------------------------------------------ queries
  buildingAt(x: number, z: number): number {
    const c = this.query(x, z, 0.01);
    for (const i of c) {
      if (this.hidden[i]) continue;
      const rings = decodeRings(this.d, i);
      if (!pointInRing(x, z, rings[0])) continue;
      let inHole = false;
      for (let k = 1; k < rings.length; k++) if (pointInRing(x, z, rings[k])) inHole = true;
      if (!inHole) return i;
    }
    return -1;
  }

  infoAt(x: number, z: number): BuildingInfo | null {
    const i = this.buildingAt(x, z);
    return i < 0 ? null : this.infoOf(i);
  }

  infoOf(i: number): BuildingInfo {
    const r = this.rec.at(i);
    const ni = r.nameIdx;
    const fb = floorBase(this.ground[2 * i], this.ground[2 * i + 1], r.socle);
    const top = fb + r.height + r.roofHeight;
    return {
      index: i,
      id: this.idOf(i),
      name: ni !== 0xffff ? this.meta?.names?.[ni] : undefined,
      levels: r.levels,
      height: Math.round((top - this.ground[2 * i]) * 10) / 10,
      cls: TYP_NAMES[r.typology] ?? 'building',
      base: fb,
      top,
      labelled: !!(r.flags & FLAG.LABELLED),
    };
  }

  roofAt(x: number, z: number): number | null {
    const i = this.buildingAt(x, z);
    return i < 0 ? null : this.topOf(i);
  }

  colliders(x: number, z: number, r: number): StaticCollider[] {
    const out: StaticCollider[] = [];
    for (const i of this.query(x, z, r)) {
      if (this.hidden[i]) continue;
      const ring = decodeRings(this.d, i)[0];
      const rec = this.rec.at(i);
      const fb = floorBase(this.ground[2 * i], this.ground[2 * i + 1], rec.socle);
      const minY = rec.minHeight > 0 ? fb + rec.minHeight : this.ground[2 * i] - 1;
      const maxY = fb + rec.height + rec.roofHeight * 0.5;
      out.push({ kind: 'prism', key: `bld:${i}`, ring: new Float32Array(ring), minY, maxY });
    }
    return out;
  }
}

const mod: CityModule & { inst?: Buildings } = {
  id: 'buildings',
  after: ['terrain'],
  async init(ctx) {
    const b = new Buildings(ctx);
    mod.inst = b;
    let readyRes!: () => void;
    const ready = new Promise<void>((r) => (readyRes = r));
    const api: BuildingsAPI = {
      get count() { return b.d ? b.d.n : 0; },
      hideById: (ids) => { const p = (b.d ? Promise.resolve() : ready).then(() => b.hideById(ids)); ctx.pending(p); return p; },
      hideInPolygon: (ring) => (b.d ? b.hideInPolygon(ring) : 0),
      infoAt: (x, z) => (b.d ? b.infoAt(x, z) : null),
      query: (x, z, r) => (b.d ? b.query(x, z, r) : []),
      footprint: (i) => (b.d && i >= 0 && i < b.d.n ? decodeRings(b.d, i)[0] : null),
      roofAt: (x, z) => (b.d ? b.roofAt(x, z) : null),
      idOf: (i) => b.idOf(i),
      info: (i) => (b.d && i >= 0 && i < b.d.n ? b.infoOf(i) : null),
      stats: () => (b.d ? b.stats() : { meshes: 0, visible: 0, triangles: 0, visibleTriangles: 0, detailChunks: 0, hidden: 0 }),
      ready,
    } as BuildingsAPI;
    // phase 1: data, ground, index, workers -> publish the service early so that
    // hide requests from other modules are honoured by the first meshing pass
    await b.init();
    ctx.provide('buildings', api);
    ctx.registerColliders({ id: 'buildings', query: (x, z, r) => b.colliders(x, z, r) });
    (window as any).__buildings = b;
    // phase 2: meshing (hide calls that arrive later only rebuild the affected chunks)
    const work = b.mesh().then(() => readyRes());
    ctx.pending(work);
    await work;
  },
  update(dt) {
    const b = mod.inst;
    if (b && b.d) {
      try { b.update(dt); } catch (e) { console.error('[buildings] update', e); }
    }
  },
};
export default mod;
