// Photo mode: freezes the camera, gathers the scene relevant to the view,
// builds a BVH in a worker and progressively path traces the frame with
// three-gpu-pathtracer. The image is displayed through the sky module's post
// pipeline when it is active (aerial perspective, clouds, bloom, AgX grade)
// or tone-mapped directly otherwise.
import * as THREE from 'three';
import { WebGLPathTracer, PhysicalCamera } from 'three-gpu-pathtracer';
import { MeshBVH } from 'three-mesh-bvh';
import type { AppContext, RenderPipeline } from '../../core/context';
import type { Quality } from '../../core/settings';
import type { PTBuildRequest, PTBuildResult, PTItem, PTSrcGeo } from '../../workers/pathtracer-build.worker';
import { Gatherer, nextFrame, type Candidate } from './gather';
import { MaterialResolver } from './materials';
import { buildTerrainProxy, terrainMacroMaterial } from './terrain';
import { GroundBake } from './groundBake';
import { TreeCollector } from './vegetation';
import { analyticSky, blackEquirect, constantEnv, pmremToEquirect } from './env';
import { CompositeQuad, DepthPrepass, Denoiser, StandaloneDisplay } from './display';
import { Overlay } from './overlay';
import { patchLightSelection } from './kernelPatch';

export type PhotoState = 'idle' | 'building' | 'rendering' | 'error';

export interface PhotoOptions {
  /** stop accumulating at this many samples per pixel */
  spp?: number;
  quality?: Quality;
  /** gather radius override (m) */
  radius?: number;
  /** triangle budget override (non-tree scene content) */
  budget?: number;
  /** path tracer resolution relative to the drawing buffer */
  renderScale?: number;
  bounces?: number;
  dof?: boolean;
  fStop?: number;
  /** focus distance (m); default: distance to the scene point at the image centre */
  focus?: number;
  denoise?: boolean;
  trees?: boolean;
  /** bake the terrain module's ground shader into a high-resolution albedo map (default true) */
  groundBake?: boolean;
  /** display through the sky module's post pipeline when available (default true) */
  composite?: boolean;
}

interface Preset {
  radius: number; instR: number; budget: number;
  treeR: number; treeBudget: number; lod0: number; lod1: number;
  tex: number; bounces: number; s0: number; n: number; scale: number; maxTex: number;
}

const PRESETS: Record<Quality, Preset> = {
  low: { radius: 1600, instR: 400, budget: 0.8e6, treeR: 450, treeBudget: 0.25e6, lod0: 20, lod1: 80, tex: 512, bounces: 3, s0: 3, n: 48, scale: 0.5, maxTex: 24 },
  medium: { radius: 3500, instR: 700, budget: 2.0e6, treeR: 1000, treeBudget: 0.7e6, lod0: 35, lod1: 160, tex: 1024, bounces: 4, s0: 2, n: 64, scale: 0.75, maxTex: 40 },
  high: { radius: 6500, instR: 1000, budget: 4.0e6, treeR: 1600, treeBudget: 1.3e6, lod0: 50, lod1: 260, tex: 1024, bounces: 5, s0: 2, n: 80, scale: 1, maxTex: 64 },
  ultra: { radius: 11000, instR: 1500, budget: 7.0e6, treeR: 2600, treeBudget: 2.2e6, lod0: 70, lod1: 400, tex: 2048, bounces: 6, s0: 1.5, n: 96, scale: 1, maxTex: 96 },
};

const SUN_ANGULAR_RADIUS = 0.00465; // rad (0.267 deg)

/** Pipeline installed while photo mode is on. */
class PhotoPipeline implements RenderPipeline {
  constructor(private photo: PhotoMode, readonly prev: RenderPipeline | null) {}
  render(dt: number): void { this.photo.renderFrame(dt, this.prev); }
  setSize(w: number, h: number, pr: number): void {
    this.prev?.setSize(w, h, pr);
    this.photo.onResize();
  }
}

export class PhotoMode {
  state: PhotoState = 'idle';
  message = '';
  private pt: any = null; // WebGLPathTracer (private members used)
  private ptScene = new THREE.Scene();
  private ptCam = new PhysicalCamera(55, 1, 0.1, 1e5);
  private origin = new THREE.Vector3();
  private pipeline: PhotoPipeline | null = null;
  private resolver: MaterialResolver | null = null;
  private trees: TreeCollector | null = null;
  private groundBake: GroundBake | null = null;
  private bakeMat: THREE.MeshStandardMaterial | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private bvh: MeshBVH | null = null;
  private depth: DepthPrepass | null = null;
  private denoiser: Denoiser | null = null;
  private composite: CompositeQuad | null = null;
  private standalone: StandaloneDisplay | null = null;
  private overlay: Overlay | null = null;
  private worker: Worker | null = null;
  private envTex: THREE.DataTexture | null = null;
  private bgTex: THREE.DataTexture | null = null;
  private black = blackEquirect();
  private sun: THREE.DirectionalLight | null = null;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private lights: THREE.Light[] = [];
  private buildId = 0;
  private cancelled = false;
  private compositeMode = false;
  private floatOK = false;
  private floatBlendOK = false;
  private preset!: Preset;
  private opts: Required<Pick<PhotoOptions, 'spp' | 'dof' | 'fStop' | 'denoise' | 'bounces'>> & PhotoOptions = { spp: 4096, dof: false, fStop: 2.8, denoise: true, bounces: 4 };
  private lastShown = -1;
  private lastShowWall = 0;
  private tilesPerFrame = 1;
  private sampleT0 = 0;
  private buildT0 = 0;
  private sampleTimes: number[] = [];
  private donePromise: Promise<void> | null = null;
  private doneResolve: (() => void) | null = null;
  private camSig = '';
  private listeners: Array<() => void> = [];
  private kernelPatched = false;
  /** probability of sampling the light set (vs the sky) in next-event estimation */
  private lightProb = 0.7;
  readonly stats: Record<string, any> = {};

  constructor(private ctx: AppContext) {}

  get active(): boolean { return this.state === 'building' || this.state === 'rendering'; }
  get samples(): number { return this.pt && this.state === 'rendering' ? Math.floor(this.pt.samples) : 0; }

  // ------------------------------------------------------------------ capabilities
  private checkSupport(): string | null {
    const r = this.ctx.renderer;
    if (!r.capabilities.isWebGL2) return 'Photo mode needs WebGL 2.';
    const gl = r.getContext() as WebGL2RenderingContext;
    this.floatOK = !!r.extensions.has('EXT_color_buffer_float');
    this.floatBlendOK = !!r.extensions.has('EXT_float_blend');
    if (!this.floatOK) return 'Photo mode needs float render targets (EXT_color_buffer_float), which this GPU/browser does not offer.';
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (maxTex < 4096) return `Photo mode needs 4096 px textures (this GPU: ${maxTex}).`;
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    this.stats.maxLayers = maxLayers;
    return null;
  }

  private ensureOverlay(): void {
    if (this.overlay || this.ctx.settings.shot) return;
    this.overlay = new Overlay({
      onExit: () => this.stop(),
      onSave: () => { void this.saveImage(); },
      onDof: (on) => { this.opts.dof = on; this.applyCamera(); },
      onFStop: (f) => { this.opts.fStop = f; this.applyCamera(); },
      onDenoise: (on) => { this.opts.denoise = on; this.lastShown = -1; },
      onBounces: (n) => { this.opts.bounces = n; if (this.pt) { this.pt.bounces = n; this.pt.reset(); this.resetStats(); } },
    }, { dof: this.opts.dof, fStop: this.opts.fStop, denoise: this.opts.denoise, bounces: this.opts.bounces });
  }

  private status(text: string, progress: number | null, kind: 'busy' | 'live' | 'error' = 'busy'): void {
    this.message = text;
    this.overlay?.setStatus(text, progress, kind);
  }

  // ------------------------------------------------------------------ lifecycle
  async start(o: PhotoOptions = {}): Promise<string> {
    if (this.active) return this.state;
    const ctx = this.ctx;
    const q = (o.quality ?? ctx.settings.quality) as Quality;
    const prm = ctx.settings.params;
    const num = (k: string) => { const v = prm.get(k); return v !== null && v !== '' && Number.isFinite(+v) ? +v : undefined; };
    this.preset = { ...PRESETS[q] ?? PRESETS.medium };
    const soft = this.softwareGL();
    this.opts = {
      spp: o.spp ?? num('ptspp') ?? (ctx.settings.shot ? 16 : 4096),
      dof: o.dof ?? (prm.get('ptdof') === '1'),
      fStop: o.fStop ?? num('ptfstop') ?? 2.8,
      denoise: o.denoise ?? (prm.get('ptdenoise') !== '0'),
      bounces: o.bounces ?? num('ptbounces') ?? this.preset.bounces,
      radius: o.radius ?? num('ptradius'),
      budget: o.budget ?? num('ptbudget'),
      renderScale: o.renderScale ?? num('ptscale') ?? (soft ? 1 : this.preset.scale),
      focus: o.focus ?? num('ptfocus'),
      trees: o.trees ?? (prm.get('pttrees') !== '0'),
      groundBake: o.groundBake ?? (prm.get('ptbake') !== '0'),
      quality: q,
    };
    this.ensureOverlay();
    this.overlay?.show(true);
    const err = this.checkSupport();
    if (err) {
      this.state = 'error';
      this.status(err, null, 'error');
      console.warn('[pathtracer]', err);
      setTimeout(() => { if (this.state === 'error') { this.state = 'idle'; this.overlay?.show(false); } }, 6000);
      return 'unsupported';
    }
    this.state = 'building';
    this.cancelled = false;
    this.buildT0 = performance.now();
    ctx.paused = true;
    ctx.camera.updateMatrixWorld();
    this.camSig = this.cameraSignature();
    const prev = ctx.getPipeline();
    this.pipeline = new PhotoPipeline(this, prev);
    const sky = ctx.get<any>('sky');
    this.compositeMode = !!(sky && sky.pipeline && prev === sky.pipeline) && o.composite !== false && prm.get('ptcomposite') !== '0';
    ctx.setPipeline(this.pipeline);
    this.installInput();
    this.status('Collecting scene…', 0);
    this.donePromise = new Promise<void>((r) => { this.doneResolve = r; });
    // screenshots wait for the requested sample count
    if (ctx.settings.shot) ctx.pending(this.donePromise);
    const id = ++this.buildId;
    try {
      await this.build(id);
      if (this.cancelled || id !== this.buildId) return 'cancelled';
      this.state = 'rendering';
      this.resetStats();
      const n = this.stats.triangles as number;
      this.stats.buildMs = Math.round(performance.now() - this.buildT0);
      console.info(`[pathtracer] ready in ${this.stats.buildMs} ms: ${(n / 1e6).toFixed(2)} M triangles, ${this.stats.materials} materials, ${this.stats.textures} textures, composite=${this.compositeMode}`);
      return 'rendering';
    } catch (e: any) {
      if (this.cancelled || id !== this.buildId) return 'cancelled';
      console.error('[pathtracer] build failed', e);
      this.state = 'error';
      this.status(`Photo mode failed: ${e?.message || e}`, null, 'error');
      this.restore();
      this.doneResolve?.();
      setTimeout(() => { if (this.state === 'error') { this.state = 'idle'; this.overlay?.show(false); } }, 6000);
      return 'error';
    }
  }

  stop(): void {
    if (this.state === 'idle') return;
    this.cancelled = true;
    this.buildId++;
    this.worker?.terminate();
    this.worker = null;
    this.restore();
    this.state = 'idle';
    this.overlay?.show(false);
    this.doneResolve?.();
  }

  private restore(): void {
    const ctx = this.ctx;
    if (this.pipeline && ctx.getPipeline() === this.pipeline) ctx.setPipeline(this.pipeline.prev);
    this.pipeline = null;
    ctx.paused = false;
    try { ctx.input.consume(); ctx.input.buttons = 0; ctx.controller.enter(ctx); } catch { /* ignore */ }
    this.removeInput();
    this.releaseScene();
    ctx.get<any>('sky')?.requestRender?.();
  }

  /** Free the big GPU/CPU buffers (keeps the compiled path tracer for next time). */
  private releaseScene(): void {
    try {
      if (this.pt) {
        // swap in an empty scene so the BVH / attribute textures shrink back
        const empty = new THREE.Scene();
        this.pt.setScene(empty, new THREE.PerspectiveCamera());
      }
    } catch (e) { console.warn('[pathtracer] release', e); }
    this.geometry?.dispose();
    this.geometry = null;
    this.bvh = null;
    this.depth?.setGeometry(null);
    this.resolver?.dispose();
    this.resolver = null;
    this.envTex?.dispose(); this.envTex = null;
    this.bgTex?.dispose(); this.bgTex = null;
    for (const l of this.lights) this.ptScene.remove(l);
    this.lights = [];
    this.sun = null;
  }

  // ------------------------------------------------------------------ build
  private async build(id: number): Promise<void> {
    const ctx = this.ctx;
    const P = this.preset;
    const o = this.opts;
    const cam = ctx.camera;
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const terrain = ctx.get<any>('terrain');
    const gy = terrain?.heightAt ? terrain.heightAt(camPos.x, camPos.z) : ctx.heightfield?.sample(camPos.x, camPos.z) ?? 0;
    this.origin.set(Math.round(camPos.x), Math.round(Number.isFinite(gy) ? gy : 0), Math.round(camPos.z));
    const agl = Math.max(1, camPos.y - (Number.isFinite(gy) ? gy : 0));
    const slice = ctx.settings.shot ? 200 : 12;
    const check = () => { if (this.cancelled || id !== this.buildId) throw new Error('cancelled'); };

    const T: Record<string, number> = {};
    let tt = performance.now();
    const lap = (k: string) => { const n = performance.now(); T[k] = Math.round(n - tt); tt = n; };
    this.stats.timings = T;
    // ---- lighting first (also needed to pick shadow casters)
    this.setupLighting();
    lap('lighting');
    check();

    // ---- scene
    const radius = o.radius ?? P.radius;
    const fovRad = THREE.MathUtils.degToRad(cam.fov);
    const pixAngle = fovRad / Math.max(240, ctx.height * ctx.pixelRatio * (o.renderScale ?? 1));
    this.resolver?.dispose();
    const g = new Gatherer({
      origin: this.origin, camera: cam, radius, instanceRadius: P.instR,
      triBudget: (o.budget ?? P.budget) + (o.trees ? P.treeBudget : 0),
      minAngle: pixAngle * 0.6, sunDir: this.sunDir, exclude: new Set(), keepNear: Math.max(80, agl * 0.5), sliceMs: slice,
    });
    this.resolver = g.resolver;
    g.sceneRoot = ctx.scene;
    const extra: Candidate[] = [];
    let treeStats: Record<string, number> = {};
    if (o.trees && TreeCollector.available(ctx)) {
      try {
        this.trees?.dispose();
        this.trees = new TreeCollector(ctx);
        if (this.trees.excluded) (g as any).p.exclude.add(this.trees.excluded);
        this.status('Collecting trees…', 0.05);
        const r = await this.trees.collect(g, { radius: Math.min(radius, P.treeR), lod0: P.lod0, lod1: P.lod1, budget: P.treeBudget, sliceMs: slice }, camPos,
          (f) => this.status('Collecting trees…', 0.05 + 0.1 * f));
        extra.push(...r.cands);
        treeStats = r.stats;
        lap('trees');
      } catch (e) {
        console.warn('[pathtracer] trees unavailable', e);
      }
    }
    check();
    // high-resolution ground albedo from the terrain module's own shader
    let bake: { x0: number; z0: number; size: number; material: THREE.Material } | null = null;
    if (o.groundBake && ctx.get('terrain')) {
      this.status('Baking ground albedo…', 0.14);
      await nextFrame();
      try {
        this.groundBake ??= new GroundBake(ctx);
        const macro = (terrainMacroMaterial(ctx, camPos) as any).map ?? null;
        const half = THREE.MathUtils.clamp(180 + agl * 2, 200, 800);
        const res = this.groundBake.bake(camPos.x, camPos.z, half, P.tex, macro);
        const mean = res ? this.groundBake.meanLuminance() : 0;
        this.stats.groundBake = res ? `${Math.round(2 * half)} m @ ${P.tex}px, mean ${mean.toFixed(3)}` : 'failed';
        lap('bake');
        if (res && mean > 0.01 && mean < 0.9) {
          this.bakeMat?.dispose();
          this.bakeMat = new THREE.MeshStandardMaterial({ map: res.texture, roughness: 0.95, metalness: 0 });
          this.bakeMat.name = 'pt-ground-bake';
          bake = { x0: res.x0, z0: res.z0, size: res.size, material: this.bakeMat };
        }
      } catch (e) {
        console.warn('[pathtracer] ground bake', e);
      }
    }
    check();
    // terrain proxy (the CDLOD mesh is displaced on the GPU and flagged noPathTrace)
    this.status('Meshing terrain…', 0.15);
    const s0 = Math.max(P.s0, Math.min(16, agl / 60));
    const tp = await buildTerrainProxy(ctx, { s0, n: P.n, center: camPos, origin: this.origin, extent: 30000, sliceMs: slice, bake },
      (f) => this.status('Meshing terrain…', 0.15 + 0.1 * f));
    check();
    if (tp) {
      const m = new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, this.origin.z);
      tp.parts.forEach((part, i) => {
        const mat = g.resolver.resolve(new THREE.Object3D(), part.material, 0, false);
        if (!mat) return;
        const tris = part.geo.idx ? part.geo.idx.length / 3 : 0;
        extra.push({ obj: new THREE.Mesh(), mat, geoKey: `terrain${i}`, getGeo: () => part.geo, mats: Float32Array.from(m.elements), cols: null, tris, dist: 0, planarUV: false });
      });
    }
    lap('terrain');
    // (terrain triangles are not counted against the scene budget)
    (g as any).p.triBudget += tp ? tp.triangles : 0;
    this.status('Collecting scene…', 0.25);
    const gathered = await g.gather(extra, (f) => this.status('Collecting scene…', 0.25 + 0.15 * f));
    lap('gather');
    check();
    const droppedTex = MaterialResolver.limitTextures(gathered.materials, gathered.matTris, Math.min(P.maxTex, (this.stats.maxLayers ?? 256) - 1));
    const textures = MaterialResolver.textures(gathered.materials);
    Object.assign(this.stats, gathered.stats, treeStats, {
      terrainTris: tp?.triangles ?? 0, terrainRings: tp?.rings ?? 0, textures: textures.length, droppedTextures: droppedTex,
      skippedMaterials: Object.fromEntries(gathered.skippedMaterials),
    });

    // ---- worker: merge + BVH
    this.status('Building BVH…', 0.4);
    const res = await this.runWorker(id, gathered.geos, gathered.items);
    lap('worker');
    check();
    this.status('Uploading to GPU…', 0.92);
    await nextFrame();
    check();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(res.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(res.normal, 3));
    geo.setAttribute('tangent', new THREE.BufferAttribute(res.tangent, 4));
    geo.setAttribute('uv', new THREE.BufferAttribute(res.uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(res.color, 4));
    geo.setAttribute('materialIndex', new THREE.BufferAttribute(res.materialIndex, 1));
    geo.setIndex(new THREE.BufferAttribute(res.index, 1));
    const bvh = MeshBVH.deserialize({ version: 1, roots: res.roots, index: res.index, indirectBuffer: res.indirect } as any, geo, { setIndex: false });
    this.geometry = geo;
    this.bvh = bvh;
    Object.assign(this.stats, { triangles: res.triangles, vertices: res.vertices, mergeMs: Math.round(res.ms.merge), bvhMs: Math.round(res.ms.bvh), materials: gathered.materials.length });

    // ---- path tracer
    const pt = this.ensurePathTracer();
    pt.textureSize.set(P.tex, P.tex);
    pt.bounces = o.bounces;
    pt.transmissiveBounces = 12;
    pt.filterGlossyFactor = 0.5;
    pt.multipleImportanceSampling = true;
    pt.renderScale = o.renderScale ?? 1;
    // split big frames into tiles so a single dispatch stays short (GPU watchdogs, UI latency)
    const px = ctx.width * ctx.height * ctx.pixelRatio * ctx.pixelRatio * pt.renderScale * pt.renderScale;
    const tl = this.softwareGL() ? 1 : THREE.MathUtils.clamp(Math.round(Math.sqrt(px / 0.6e6)), 1, 4);
    pt.tiles.set(tl, tl);
    this.stats.tiles = tl;
    this.setupCamera();
    this.ptScene.environment = this.envTex;
    this.ptScene.background = this.compositeMode ? null : (this.bgTex ?? this.envTex);
    pt._updateFromResults(this.ptScene, this.ptCam, {
      materials: gathered.materials, geometry: geo, bvh, bvhChanged: true, needsMaterialIndexUpdate: true,
    });
    this.applyBackground();
    this.lastShown = -1;
    if (this.opts.focus === undefined) this.autoFocus();
    this.applyCamera();
    // depth for aerial perspective / denoise
    if (!this.depth) this.depth = new DepthPrepass(ctx.renderer, true);
    this.depth.setGeometry(geo);
    lap('upload');
  }

  private ensurePathTracer(): any {
    if (this.pt) return this.pt;
    const pt: any = new WebGLPathTracer(this.ctx.renderer);
    pt.renderToCanvas = false;
    pt.rasterizeScene = false;
    pt.renderDelay = 0;
    pt.minSamples = 0;
    pt.fadeDuration = 0;
    pt.dynamicLowRes = false;
    pt.synchronizeRenderSize = true;
    pt.tiles.set(1, 1);
    this.kernelPatched = patchLightSelection(pt._pathTracer.material, 0.7);
    this.pt = pt;
    return pt;
  }

  private runWorker(id: number, geos: PTSrcGeo[], items: PTItem[]): Promise<PTBuildResult> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('../../workers/pathtracer-build.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      const transfer: Transferable[] = [];
      for (const gg of geos) {
        for (const a of [gg.pos, gg.nrm, gg.uv, gg.col, gg.idx]) if (a && !transfer.includes(a.buffer as ArrayBuffer)) transfer.push(a.buffer as ArrayBuffer);
      }
      for (const it of items) {
        transfer.push(it.m.buffer as ArrayBuffer);
        if (it.c) transfer.push(it.c.buffer as ArrayBuffer);
      }
      w.onmessage = (e: MessageEvent<any>) => {
        const d = e.data;
        if (id !== this.buildId) { w.terminate(); reject(new Error('cancelled')); return; }
        if (d.type === 'progress') {
          const f = d.stage === 'merge' ? 0.4 + 0.1 * d.p : 0.5 + 0.4 * d.p;
          this.status(d.stage === 'merge' ? 'Merging geometry…' : `Building BVH… ${Math.round(d.p * 100)}%`, f);
        } else if (d.type === 'done') {
          w.terminate();
          if (this.worker === w) this.worker = null;
          resolve(d as PTBuildResult);
        } else if (d.type === 'error') {
          w.terminate();
          if (this.worker === w) this.worker = null;
          reject(new Error(d.error));
        }
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(`worker: ${e.message}`)); };
      const req: PTBuildRequest = { type: 'build', id, geos, items };
      // shared geometry buffers may appear in several geos; dedupe done above
      w.postMessage(req, transfer);
    });
  }

  // ------------------------------------------------------------------ lighting
  private setupLighting(): void {
    const ctx = this.ctx;
    const r = ctx.renderer;
    const sky = ctx.get<any>('sky');
    this.envTex?.dispose(); this.envTex = null;
    this.bgTex?.dispose(); this.bgTex = null;
    for (const l of this.lights) this.ptScene.remove(l);
    this.lights = [];
    // key light
    let dir = ctx.env.sunDirection.clone();
    let color = ctx.env.sunColor.clone();
    let intensity = ctx.env.sunIntensity;
    const key: THREE.DirectionalLight | undefined = sky?.sunLight;
    if (key && key.isDirectionalLight) {
      key.updateMatrixWorld();
      key.target.updateMatrixWorld();
      const a = new THREE.Vector3().setFromMatrixPosition(key.matrixWorld);
      const b = new THREE.Vector3().setFromMatrixPosition(key.target.matrixWorld);
      if (a.distanceToSquared(b) > 1e-6) dir = a.sub(b).normalize();
      color = key.color.clone();
      intensity = key.visible === false ? 0 : key.intensity;
      try {
        const cs = sky.cloudShadowAt?.(ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z);
        if (Number.isFinite(cs)) intensity *= THREE.MathUtils.clamp(cs, 0, 1);
      } catch { /* ignore */ }
    } else if (!sky) {
      // no sky module: plain sun
      intensity = 3.0 * Math.pow(THREE.MathUtils.clamp(dir.y * 4, 0, 1), 0.7);
    }
    this.sunDir.copy(dir);
    if (intensity > 1e-4) {
      const sun = new THREE.DirectionalLight(color, intensity);
      sun.name = 'pt-sun';
      sun.position.copy(dir);
      sun.target.position.set(0, 0, 0);
      sun.updateMatrixWorld();
      sun.target.updateMatrixWorld();
      this.ptScene.add(sun, sun.target);
      this.sun = sun;
      this.lights.push(sun);
    }
    // street lamps at night: the roads module only drives a handful of real SpotLights (plus
    // shader light pools the path tracer cannot see), so add one spot light per nearby lamp
    const cam = ctx.camera.position;
    const lampXZ: number[] = [];
    const roads = ctx.get<any>('roads');
    const night = ctx.env.night;
    if (night > 0.05 && roads && typeof roads.lamps === 'function') {
      try {
        const L: number[] = roads.lamps();
        const I = (roads.uniforms?.rsLampI?.value ?? 70) * night;
        const near: Array<[number, number]> = [];
        for (let i = 0; i < L.length; i += 3) {
          const d = Math.hypot(L[i] - cam.x, L[i + 1] - cam.z);
          if (d < 320) near.push([d, i]);
        }
        near.sort((a, b) => a[0] - b[0]);
        const terrain = ctx.get<any>('terrain');
        for (const [, i] of near.slice(0, 64)) {
          const x = L[i], z = L[i + 1];
          const gy = terrain?.heightAt ? terrain.heightAt(x, z) : ctx.heightfield.sample(x, z);
          const sl = new THREE.SpotLight(L[i + 2] === 1 ? 0xffa045 : 0xfff1dc, I, 60, 1.25, 0.65, 2);
          sl.name = 'pt-lamp';
          sl.position.set(x - this.origin.x, gy + 8.8 - this.origin.y, z - this.origin.z);
          sl.target.position.set(sl.position.x, sl.position.y - 10, sl.position.z);
          this.ptScene.add(sl, sl.target);
          sl.updateMatrixWorld(); sl.target.updateMatrixWorld();
          this.lights.push(sl);
          lampXZ.push(x, z);
        }
        this.stats.lamps = lampXZ.length / 2;
      } catch (e) { console.warn('[pathtracer] lamps', e); }
    }
    // other local lights near the camera (headlights, landmark lights; dedupe the roads' real lamp spots)
    const locals: Array<{ l: THREE.Light; d: number }> = [];
    ctx.scene.traverseVisible((o: any) => {
      if (!(o.isPointLight || o.isSpotLight) || o.userData?.noPathTrace || !(o.intensity > 0)) return;
      const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      const d = p.distanceTo(cam);
      for (let i = 0; i < lampXZ.length; i += 2) if (Math.hypot(lampXZ[i] - p.x, lampXZ[i + 1] - p.z) < 3) return;
      if (d < 600) locals.push({ l: o, d });
    });
    locals.sort((a, b) => a.d - b.d);
    for (const { l } of locals.slice(0, 32)) {
      const c = (l as any).clone(false) as THREE.PointLight | THREE.SpotLight;
      c.position.setFromMatrixPosition(l.matrixWorld).sub(this.origin);
      c.quaternion.identity(); c.scale.set(1, 1, 1);
      if ((c as any).isSpotLight) {
        const sl = l as THREE.SpotLight;
        const t = new THREE.Object3D();
        t.position.setFromMatrixPosition(sl.target.matrixWorld).sub(this.origin);
        (c as THREE.SpotLight).target = t;
        this.ptScene.add(t);
        t.updateMatrixWorld();
      }
      this.ptScene.add(c);
      c.updateMatrixWorld();
      this.lights.push(c);
    }
    this.stats.localLights = Math.min(32, locals.length);
    // environment
    const floatOK = this.floatOK;
    let env: THREE.DataTexture | null = null;
    const envMap: THREE.Texture | null = sky?.envMap ?? (ctx.scene.environment as THREE.Texture | null);
    if (envMap && (envMap as any).mapping === THREE.CubeUVReflectionMapping) {
      env = pmremToEquirect(r, envMap, 512, 256, floatOK, ctx.scene.environmentIntensity ?? 1);
    }
    if (!env) env = analyticSky(r, dir, 512, 256, floatOK, false, color, intensity);
    if (!env) env = constantEnv(0.3);
    this.envTex = env;
    this.lightProb = this.estimateLightProb(env, intensity, dir, night > 0.3 && lampXZ.length > 0);
    this.stats.lightProb = +this.lightProb.toFixed(2);
    if (!this.compositeMode) {
      // visible background with a sun disc
      this.bgTex = sky ? null : analyticSky(r, dir, 1024, 512, floatOK, true, color, intensity);
    }
  }

  /** Share of NEE samples for the lights: roughly their share of the direct irradiance. */
  private estimateLightProb(env: THREE.DataTexture, sunI: number, dir: THREE.Vector3, lamps: boolean): number {
    if (lamps) return 0.8;
    let eSky = 0;
    try {
      const { data, width: w, height: h } = env.image as { data: Float32Array; width: number; height: number };
      // cosine-weighted irradiance on a horizontal surface from the upper hemisphere
      for (let y = 0; y < h; y++) {
        const v = (y + 0.5) / h;
        const phi = (1 - v) * Math.PI; // polar angle from +y
        const cosT = Math.cos(phi);
        if (cosT <= 0) continue;
        const dOmega = (2 * Math.PI / w) * (Math.PI / h) * Math.sin(phi);
        for (let x = 0; x < w; x++) {
          const i = 4 * (y * w + x);
          eSky += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * cosT * dOmega;
        }
      }
    } catch { eSky = 1; }
    const eSun = sunI * Math.max(0.35, dir.y);
    if (!(eSun > 0)) return 0.5;
    return THREE.MathUtils.clamp(eSun / (eSun + eSky), 0.3, 0.85);
  }

  private applyBackground(): void {
    const pt = this.pt;
    if (!pt) return;
    const mat = pt._pathTracer.material;
    if (this.kernelPatched && mat.uniforms.ptLightProb) mat.uniforms.ptLightProb.value = this.lightProb;
    if (this.compositeMode) {
      // primary misses -> transparent black so the sky post pipeline shows through
      mat.backgroundMap = this.black;
      mat.backgroundAlpha = 0;
      mat.backgroundIntensity = 0;
    }
  }

  /** Jitter the sun direction inside the solar disc (soft penumbrae), per sample. */
  private jitterSun(sample: number): void {
    const sun = this.sun;
    if (!sun || !this.pt) return;
    // R2 low-discrepancy sequence on the disc
    const a1 = 0.7548776662466927, a2 = 0.5698402909980532;
    const u = (0.5 + a1 * sample) % 1, v = (0.5 + a2 * sample) % 1;
    const r = SUN_ANGULAR_RADIUS * Math.sqrt(u), th = 2 * Math.PI * v;
    const d = this.sunDir;
    const t = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const b1 = t.cross(d).normalize();
    const b2 = new THREE.Vector3().crossVectors(d, b1);
    sun.position.copy(d).addScaledVector(b1, r * Math.cos(th)).addScaledVector(b2, r * Math.sin(th)).normalize();
    sun.updateMatrixWorld();
    const lights = [...this.lights].sort((x, y) => (x.uuid < y.uuid ? 1 : x.uuid > y.uuid ? -1 : 0));
    try { this.pt._pathTracer.material.lights.updateFrom(lights, []); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ camera
  private setupCamera(): void {
    const cam = this.ctx.camera;
    const c = this.ptCam;
    c.fov = cam.fov;
    c.aspect = cam.aspect;
    c.zoom = cam.zoom;
    c.filmGauge = cam.filmGauge;
    c.near = Math.min(cam.near, 0.3);
    c.far = 1e5;
    c.position.setFromMatrixPosition(cam.matrixWorld).sub(this.origin);
    c.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(cam.matrixWorld));
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
  }

  private applyCamera(): void {
    const c = this.ptCam;
    // DOF off = negligible aperture (keeps FEATURE_DOF compiled in: no shader recompile on toggle)
    c.fStop = this.opts.dof ? this.opts.fStop : 1e9;
    c.apertureBlades = 6;
    c.apertureRotation = 0.3;
    if (this.opts.focus !== undefined) c.focusDistance = this.opts.focus;
    if (this.pt && this.state !== 'idle') { this.pt.setCamera(c); this.resetStats(); }
  }

  /** Focus at the scene point under the image centre (or given NDC). */
  private autoFocus(ndcX = 0, ndcY = 0): number | null {
    if (!this.bvh) return null;
    const ray = new THREE.Ray();
    const c = this.ptCam;
    c.updateMatrixWorld();
    ray.origin.setFromMatrixPosition(c.matrixWorld);
    ray.direction.set(ndcX, ndcY, 0.5).unproject(c).sub(ray.origin).normalize();
    const hit = (this.bvh as any).raycastFirst(ray, THREE.DoubleSide);
    const dist = hit ? hit.distance : null;
    if (dist && Number.isFinite(dist)) {
      c.focusDistance = Math.max(0.5, dist);
      this.opts.focus = undefined;
      if (this.pt && this.state === 'rendering') { this.pt.setCamera(c); this.resetStats(); }
    }
    return dist;
  }

  private cameraSignature(): string {
    const e = this.ctx.camera.matrixWorld.elements;
    return e.map((v) => v.toFixed(3)).join(',') + `|${this.ctx.camera.fov}`;
  }

  // ------------------------------------------------------------------ input
  private installInput(): void {
    const canvas = this.ctx.canvas;
    const block = (e: Event) => {
      if (!this.active) return;
      if (e.target !== canvas) return;
      e.stopImmediatePropagation();
      if (e.type === 'wheel') e.preventDefault();
    };
    const down = { x: 0, y: 0, t: 0 };
    const onDown = (e: PointerEvent) => { if (!this.active || e.target !== canvas) return; down.x = e.clientX; down.y = e.clientY; down.t = performance.now(); block(e); };
    const onUp = (e: PointerEvent) => {
      if (!this.active || e.target !== canvas) return;
      block(e);
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 600) return;
      if (this.state !== 'rendering' || !this.opts.dof) return;
      const rect = canvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      const d = this.autoFocus(nx, ny);
      if (d) { this.overlay?.flashFocus(e.clientX, e.clientY); }
    };
    const opts = { capture: true, passive: false } as AddEventListenerOptions;
    window.addEventListener('pointerdown', onDown, opts);
    window.addEventListener('pointerup', onUp, opts);
    for (const ev of ['click', 'dblclick', 'wheel', 'contextmenu']) window.addEventListener(ev, block, opts);
    this.listeners.push(() => {
      window.removeEventListener('pointerdown', onDown, opts);
      window.removeEventListener('pointerup', onUp, opts);
      for (const ev of ['click', 'dblclick', 'wheel', 'contextmenu']) window.removeEventListener(ev, block, opts);
    });
  }

  private removeInput(): void {
    for (const f of this.listeners) f();
    this.listeners = [];
  }

  // ------------------------------------------------------------------ rendering
  private softwareGL(): boolean {
    try {
      const gl = this.ctx.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      return /swiftshader|llvmpipe|software|basic render/i.test(name);
    } catch { return false; }
  }

  private resetStats(): void {
    this.sampleT0 = performance.now();
    this.sampleTimes = [];
    this.lastShown = -1;
    this.lastShowWall = 0;
  }

  onResize(): void {
    if (this.pt && this.state === 'rendering') {
      const f = this.ptCam.focusDistance;
      this.setupCamera();
      this.ptCam.focusDistance = f;
      this.applyCamera();
    }
  }

  private ptSize(): { w: number; h: number } {
    const t = this.pt?.target;
    return { w: t?.width ?? 1, h: t?.height ?? 1 };
  }

  /** Called by PhotoPipeline every frame. */
  renderFrame(dt: number, prev: RenderPipeline | null): void {
    const ctx = this.ctx;
    if (this.state !== 'rendering' || !this.pt) {
      // live (frozen) view while the scene builds
      prev?.render(dt);
      return;
    }
    // the shot harness (or a script) moved the camera: restart photo mode for the new view
    if (this.cameraSignature() !== this.camSig) {
      this.camSig = this.cameraSignature();
      this.state = 'idle';
      const o = { ...this.opts, focus: undefined };
      this.restore();
      void this.start(o);
      return;
    }
    const pt = this.pt;
    const shot = ctx.settings.shot;
    const soft = this.softwareGL();
    const target = this.opts.spp;
    // adapt the amount of path tracing per frame to keep the UI responsive
    if (!shot && !soft) {
      if (dt > 1 / 24) this.tilesPerFrame = Math.max(1, this.tilesPerFrame * 0.8);
      else if (dt < 1 / 45) this.tilesPerFrame = Math.min(16, this.tilesPerFrame * 1.1 + 0.05);
    } else this.tilesPerFrame = 1;
    const before = pt.samples;
    let n = Math.max(1, Math.round(this.tilesPerFrame));
    if (pt.samples < target) {
      while (n-- > 0 && pt.samples < target) {
        if (Number.isInteger(pt.samples)) this.jitterSun(Math.round(pt.samples));
        pt.renderSample();
        if (pt.isCompiling) break;
      }
    }
    const samples = Math.floor(pt.samples);
    if (samples > Math.floor(before)) this.sampleTimes.push(performance.now());
    const done = samples >= target;
    if (pt.isCompiling) this.status('Compiling path tracing shaders…', 0.97);
    else {
      const secs = (performance.now() - this.sampleT0) / 1000;
      this.status(`${samples} spp · ${secs.toFixed(1)} s${done ? ' · done' : ''} · ${(this.stats.triangles / 1e6).toFixed(2)} M tris`, done ? null : Math.min(1, samples / Math.min(target, 256)), 'live');
    }
    // display: every frame on real GPUs; throttled on software GL / screenshots
    const now = performance.now();
    let show = samples !== this.lastShown && samples > 0;
    if (show && (soft || shot)) {
      const milestone = (samples & (samples - 1)) === 0; // powers of two
      show = done || (milestone && now - this.lastShowWall > 15000) || now - this.lastShowWall > 60000;
    }
    if (samples === 0 && this.lastShown < 0 && !pt.isCompiling) {
      // nothing accumulated yet: keep the live view
      prev?.render(dt);
      return;
    }
    if (show) {
      this.display(dt, prev, samples);
      this.lastShown = samples;
      this.lastShowWall = performance.now();
      if (done) {
        const tt = (this.sampleTimes[this.sampleTimes.length - 1] ?? now) - this.sampleT0;
        this.stats.sppTimeMs = Math.round(tt / Math.max(1, samples));
        if (this.doneResolve) {
          console.info(`[pathtracer] ${samples} spp in ${(tt / 1000).toFixed(1)} s (${this.stats.sppTimeMs} ms/spp at ${this.ptSize().w}x${this.ptSize().h})`);
          const r = this.doneResolve; this.doneResolve = null;
          // let the frame reach the canvas first
          setTimeout(r, 50);
        }
      }
    }
    if (shot || soft) {
      // finish the frame (software GL: avoid queueing work behind the compositor)
      const gl = ctx.renderer.getContext();
      gl.finish();
    }
  }

  private display(dt: number, prev: RenderPipeline | null, samples: number): void {
    const ctx = this.ctx;
    const r = ctx.renderer;
    const pt = this.pt;
    const { w, h } = this.ptSize();
    // depth of the frozen view
    if (this.depth && (this.depth.rt.width !== w || this.depth.rt.height !== h || this.lastShown < 0)) this.depth.render(this.ptCam, w, h);
    let tex: THREE.Texture = pt.target.texture;
    if (this.opts.denoise) {
      if (!this.denoiser) this.denoiser = new Denoiser(r, this.floatOK);
      // blur radius shrinks with the sample count (strong at 1 spp, gone by ~256 spp)
      const k = THREE.MathUtils.clamp(1 - Math.log2(samples + 1) / 8, 0, 1);
      const sigma = 2.8 * k * k + (samples < 512 ? 0.35 : 0);
      const range = 0.05 + 0.35 * k * k;
      tex = this.denoiser.render(tex, this.depth?.rt.depthTexture ?? null, w, h, sigma, range, this.ptCam.near, this.ptCam.far, r.toneMappingExposure || 1);
    }
    const sky = ctx.get<any>('sky');
    if (this.compositeMode && prev && sky?.pipeline === prev) {
      if (!this.composite) this.composite = new CompositeQuad();
      const u = this.composite.material.uniforms;
      u.tColor.value = tex;
      u.tDepth.value = this.depth?.rt.depthTexture ?? null;
      u.uNF.value.set(this.ptCam.near, this.ptCam.far, ctx.camera.near, ctx.camera.far);
      const pipe = prev as any;
      const n8 = pipe.n8ao;
      const n8Enabled = n8 ? n8.enabled : false;
      if (n8) n8.enabled = false; // the path tracer already has real occlusion
      const scene = ctx.scene;
      const kids = scene.children.slice();
      scene.children.length = 0;
      scene.children.push(this.composite.mesh);
      (this.composite.mesh as any).parent = scene;
      try {
        sky.requestRender?.();
        prev.render(dt);
      } catch (e) {
        console.error('[pathtracer] composite', e);
      } finally {
        scene.children.length = 0;
        for (const k of kids) scene.children.push(k);
        (this.composite.mesh as any).parent = null;
        if (n8) n8.enabled = n8Enabled;
      }
    } else {
      if (!this.standalone) this.standalone = new StandaloneDisplay(r);
      this.standalone.render(tex);
    }
  }

  // ------------------------------------------------------------------ export
  async saveImage(download = true): Promise<Blob | null> {
    if (this.state !== 'rendering' || !this.pt) return null;
    const ctx = this.ctx;
    // re-render the current image and snapshot the canvas in the same task
    this.lastShown = -1;
    this.display(0, this.pipeline?.prev ?? null, Math.floor(this.pt.samples));
    this.lastShown = Math.floor(this.pt.samples);
    const blob = await new Promise<Blob | null>((res) => ctx.canvas.toBlob((b) => res(b), 'image/png'));
    if (blob && download) {
      const d = new Date();
      const pad = (x: number) => String(x).padStart(2, '0');
      const name = `nevinnomyssk-photo-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${this.samples}spp.png`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }
    return blob;
  }

  /** Re-light (time of day / weather changed) without rebuilding the BVH. */
  relight(): void {
    if (this.state !== 'rendering' || !this.pt) return;
    try {
      this.setupLighting();
      this.ptScene.environment = this.envTex;
      this.ptScene.background = this.compositeMode ? null : (this.bgTex ?? this.envTex);
      this.pt.updateEnvironment();
      this.pt.updateLights();
      this.applyBackground();
      this.resetStats();
    } catch (e) {
      console.warn('[pathtracer] relight failed', e);
    }
  }

  /** Debug: statistics of the raw accumulation target (and the denoised one). */
  probe(): Record<string, unknown> {
    if (!this.pt) return {};
    const r = this.ctx.renderer;
    const stat = (rt: THREE.WebGLRenderTarget) => {
      const w = rt.width, h = rt.height;
      const buf = new Float32Array(w * h * 4);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      let sr = 0, sg = 0, sb = 0, sa = 0, zero = 0, nan = 0, max = 0;
      for (let i = 0; i < w * h; i++) {
        const R = buf[4 * i], G = buf[4 * i + 1], B = buf[4 * i + 2], A = buf[4 * i + 3];
        if (!Number.isFinite(R + G + B + A)) { nan++; continue; }
        sr += R; sg += G; sb += B; sa += A;
        if (R + G + B < 1e-5) zero++;
        max = Math.max(max, R, G, B);
      }
      const n = w * h;
      return { w, h, mean: [sr / n, sg / n, sb / n, sa / n].map((x) => +x.toFixed(4)), zeroFrac: +(zero / n).toFixed(3), nan, max: +max.toFixed(3) };
    };
    const out: Record<string, unknown> = { raw: stat(this.pt.target) };
    if (this.denoiser) out.denoised = stat(this.denoiser.rt);
    const m = this.pt._pathTracer.material;
    out.defines = { ...m.defines };
    out.env = { totalSum: m.envMapInfo.totalSum, envW: m.envMapInfo.map?.image?.width, intensity: m.environmentIntensity };
    out.lights = m.lights.count;
    out.alpha = this.pt._pathTracer.alpha;
    out.bounces = m.bounces;
    return out;
  }

  /** Debug: the raw accumulation (exposure, Reinhard, sRGB) as a PNG data URL. */
  rawImage(): string | null {
    if (!this.pt) return null;
    const rt = this.pt.target as THREE.WebGLRenderTarget;
    const w = rt.width, h = rt.height;
    const buf = new Float32Array(w * h * 4);
    this.ctx.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    const img = g.createImageData(w, h);
    const ex = this.ctx.renderer.toneMappingExposure || 1;
    const enc = (x: number) => { x = x * ex; x = x / (1 + x); x = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(x * 255))); };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = 4 * ((h - 1 - y) * w + x), di = 4 * (y * w + x);
      const a = buf[si + 3];
      img.data[di] = enc(buf[si]); img.data[di + 1] = enc(buf[si + 1]); img.data[di + 2] = enc(buf[si + 2]);
      img.data[di + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  /** Resolves when the requested sample count has been reached (or photo mode stopped). */
  whenDone(): Promise<void> { return this.donePromise ?? Promise.resolve(); }

  dispose(): void {
    this.stop();
    this.depth?.dispose();
    this.denoiser?.dispose();
    this.composite?.dispose();
    this.standalone?.dispose();
    this.overlay?.dispose();
    this.trees?.dispose();
    try { this.pt?.dispose(); } catch { /* ignore */ }
    this.pt = null;
  }
}
