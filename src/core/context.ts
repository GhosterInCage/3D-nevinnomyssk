// AppContext: the single object every module receives. Owns renderer, scenes,
// camera, heightfield, environment, controllers, service registry and the
// frame loop. See docs/ARCHITECTURE.md for the contracts.
import * as THREE from 'three';
import { Events } from './events';
import { Environment } from './env';
import { HeightField, type TerrainManifest } from './heightfield';
import { Settings } from './settings';
import { Input, FlyController, type Controller } from './controls';

export interface CityModule {
  /** Unique id; also the folder name under src/modules/. */
  id: string;
  /** Ids of modules whose init() must complete before this one's init() runs (if they are loaded). */
  after?: string[];
  init(ctx: AppContext): Promise<void> | void;
  /** Per-frame update, called before rendering. */
  update?(dt: number, ctx: AppContext): void;
}

/** A replaceable rendering strategy (post-processing, path tracing...). */
export interface RenderPipeline {
  render(dt: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  dispose?(): void;
}

/** Static collision shapes that the physics module streams in around the player. */
export type StaticCollider =
  | { kind: 'box'; key: string; center: [number, number, number]; halfExtents: [number, number, number]; rotationY: number }
  | { kind: 'prism'; key: string; ring: Float32Array; minY: number; maxY: number }
  | { kind: 'trimesh'; key: string; vertices: Float32Array; indices: Uint32Array }
  | { kind: 'cylinder'; key: string; center: [number, number, number]; radius: number; halfHeight: number };

export interface ColliderProvider {
  id: string;
  /** Colliders whose footprint intersects the xz circle. Keys must be stable. */
  query(x: number, z: number, radius: number): StaticCollider[];
}

export interface Manifest {
  name: string;
  origin: { lon: number; lat: number };
  proj: string;
  region: { half: number; res: number; n: number };
  terrain: TerrainManifest;
}

type Updater = { order: number; fn: (dt: number, ctx: AppContext) => void };

export class AppContext {
  readonly settings: Settings;
  readonly events = new Events();
  readonly env = new Environment();
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** Main world scene (everything within ~25 km). */
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Backdrop scene rendered before the main scene with its own depth range
   * (sky dome, far mountains / Caucasus horizon, celestial bodies). Its camera
   * copies the main camera's transform every frame.
   */
  readonly backdrop = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(55, 1, 50, 600000) };
  readonly input: Input;
  private lastTime = -1;
  manifest!: Manifest;
  heightfield!: HeightField;

  /** Materials registered by modules; the lighting module hooks shadows/CSM into them. */
  readonly materials = new Set<THREE.Material>();
  readonly colliderProviders: ColliderProvider[] = [];
  readonly controllers = new Map<string, Controller>();
  controller: Controller;

  frame = 0;
  private updaters: Updater[] = [];
  private services = new Map<string, any>();
  private waiters = new Map<string, Array<(v: any) => void>>();
  private pipeline: RenderPipeline;
  private pendingWork: Promise<unknown>[] = [];
  private _paused = false;
  width = 1;
  height = 1;
  pixelRatio = 1;

  constructor(container: HTMLElement, settings: Settings) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      preserveDrawingBuffer: settings.shot,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.id = 'scene';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 80000);
    this.camera.position.set(1200, 720, 2600);
    this.scene.add(this.camera); // allow camera-attached objects
    this.backdrop.scene.add(this.backdrop.camera);

    this.input = new Input(this.canvas);
    const fly = new FlyController();
    this.controllers.set(fly.name, fly);
    this.controller = fly;

    this.pipeline = new BasicPipeline(this);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // ---------------------------------------------------------------- services
  /** Publish an API object for other modules (e.g. 'terrain', 'water', 'physics'). */
  provide<T>(name: string, api: T): void {
    this.services.set(name, api);
    const w = this.waiters.get(name);
    if (w) { this.waiters.delete(name); w.forEach((r) => r(api)); }
    this.events.emit(`service:${name}`, api);
  }

  get<T = any>(name: string): T | undefined {
    return this.services.get(name);
  }

  /** Resolve when a service is provided. Never rejects; may never resolve if the module is not loaded. */
  need<T = any>(name: string): Promise<T> {
    if (this.services.has(name)) return Promise.resolve(this.services.get(name));
    return new Promise((res) => {
      const w = this.waiters.get(name) ?? [];
      w.push(res);
      this.waiters.set(name, w);
    });
  }

  // ---------------------------------------------------------------- registries
  registerMaterial<T extends THREE.Material>(m: T): T {
    if (!this.materials.has(m)) {
      this.materials.add(m);
      this.events.emit('material:added', m);
    }
    return m;
  }

  registerColliders(p: ColliderProvider): void {
    this.colliderProviders.push(p);
    this.events.emit('colliders:added', p);
  }

  registerController(c: Controller): void {
    this.controllers.set(c.name, c);
    this.events.emit('controller:added', c);
  }

  setController(name: string): boolean {
    const c = this.controllers.get(name);
    if (!c || c === this.controller) return !!c;
    this.controller.exit(this);
    this.controller = c;
    c.enter(this);
    this.events.emit('controller', name);
    return true;
  }

  /** Register a per-frame callback. Lower order runs first (default 0). Returns an unsubscribe fn. */
  onUpdate(fn: (dt: number, ctx: AppContext) => void, order = 0): () => void {
    const u = { order, fn };
    this.updaters.push(u);
    this.updaters.sort((a, b) => a.order - b.order);
    return () => { this.updaters = this.updaters.filter((x) => x !== u); };
  }

  /** Delay the "ready" signal (used by screenshot tests) until this work finishes. */
  pending<T>(p: Promise<T>): Promise<T> {
    this.pendingWork.push(p.catch(() => undefined));
    return p;
  }

  async settle(): Promise<void> {
    let n = -1;
    while (n !== this.pendingWork.length) {
      n = this.pendingWork.length;
      await Promise.all(this.pendingWork);
    }
  }

  // ---------------------------------------------------------------- rendering
  setPipeline(p: RenderPipeline | null): RenderPipeline {
    const prev = this.pipeline;
    this.pipeline = p ?? new BasicPipeline(this);
    this.pipeline.setSize(this.width, this.height, this.pixelRatio);
    this.events.emit('pipeline', this.pipeline);
    return prev;
  }

  getPipeline(): RenderPipeline { return this.pipeline; }

  set paused(v: boolean) { this._paused = v; }
  get paused(): boolean { return this._paused; }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.settings.profile.pixelRatio);
    this.width = w; this.height = h; this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pipeline.setSize(w, h, pr);
    this.events.emit('resize', { width: w, height: h, pixelRatio: pr });
  }

  /** Height of the camera above the terrain. */
  get cameraAGL(): number {
    const p = this.camera.position;
    return this.heightfield ? p.y - this.heightfield.sample(p.x, p.z) : p.y;
  }

  private syncCameras(): void {
    const cam = this.camera;
    // dynamic near plane keeps depth precision high from street level to orbit
    const agl = Math.max(0.1, this.cameraAGL);
    const near = THREE.MathUtils.clamp(agl * 0.004, 0.2, 40);
    if (Math.abs(near - cam.near) / cam.near > 0.1) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    const bc = this.backdrop.camera;
    bc.position.copy(cam.position);
    bc.quaternion.copy(cam.quaternion);
    if (bc.fov !== cam.fov || bc.aspect !== cam.aspect) {
      bc.fov = cam.fov; bc.aspect = cam.aspect; bc.updateProjectionMatrix();
    }
    bc.updateMatrixWorld();
  }

  tick(): void {
    const now = performance.now();
    const dt = this.lastTime < 0 ? 1 / 60 : Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.env.update(dt);
    if (!this._paused) this.controller.update(dt, this);
    this.camera.updateMatrixWorld();
    this.syncCameras();
    for (const u of this.updaters) {
      try { u.fn(dt, this); } catch (e) { console.error('[update]', e); }
    }
    this.syncCameras();
    this.pipeline.render(dt);
    this.frame++;
    this.events.emit('frame', this.frame);
  }

  start(): void {
    this.renderer.setAnimationLoop(() => this.tick());
  }
}

/** Default pipeline: backdrop, then main scene, tone-mapped by the renderer. */
export class BasicPipeline implements RenderPipeline {
  constructor(private ctx: AppContext) {}
  render(): void {
    const r = this.ctx.renderer;
    r.autoClear = false;
    r.setRenderTarget(null);
    r.clear(true, true, true);
    r.render(this.ctx.backdrop.scene, this.ctx.backdrop.camera);
    r.clearDepth();
    r.render(this.ctx.scene, this.ctx.camera);
  }
  setSize(): void { /* renderer already sized */ }
}
