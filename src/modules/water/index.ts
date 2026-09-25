// Water module: rivers (Kuban, Bolshoy Zelenchuk), the Nevinnomyssk canal, streams, ponds,
// reservoirs and industrial settling ponds as tiled surface meshes built by pipeline/build_water.py,
// shaded by a patched MeshPhysicalMaterial (see material.ts) with planar reflections.
//
// Service 'water':
//   isWater(x, z)  -> boolean          visible open water at world x/z
//   levelAt(x, z)  -> number | null    water-surface elevation (m ASL)
//   depthAt(x, z)  -> number | null    water depth over the terrain height field
//   flowAt(x, z)   -> {x, z} | null    surface flow velocity (m/s, world axes)
//   bodyAt(x, z)   -> WaterBody | null body metadata (name, type, colour...)
//   bodies, meshes, material, reflection (debug handles)
import * as THREE from 'three';
import type { AppContext, CityModule } from '../../core/context';
import { loadWaterData, type WaterBody, type WaterData, type WaterTile } from './data';
import { WaterMaterial, makePathTracerProxy, type WaterUniforms } from './material';
import { PlanarReflection } from './reflection';
import { FallbackEnvironment } from './envFallback';
import { buildPierWakes } from './piers';

const TEX_BASE = `${import.meta.env.BASE_URL}textures/water/`;

export interface WaterService {
  isWater(x: number, z: number): boolean;
  levelAt(x: number, z: number): number | null;
  depthAt(x: number, z: number): number | null;
  flowAt(x: number, z: number): { x: number; z: number } | null;
  bodyAt(x: number, z: number): WaterBody | null;
  bodies: WaterBody[];
  meshes: THREE.Mesh[];
  material: WaterMaterial;
  reflection: PlanarReflection;
}

async function loadTexture(name: string, anisotropy: number): Promise<THREE.Texture> {
  const t = await new THREE.TextureLoader().loadAsync(TEX_BASE + name);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function makeBodyTexture(bodies: WaterBody[]): THREE.DataTexture {
  const n = Math.max(1, bodies.length);
  const data = new Float32Array(n * 2 * 4);
  for (const b of bodies) {
    const o0 = b.idx * 4, o1 = (n + b.idx) * 4;
    data[o0] = b.albedo[0]; data[o0 + 1] = b.albedo[1]; data[o0 + 2] = b.albedo[2]; data[o0 + 3] = b.ext;
    data[o1] = b.rough; data[o1 + 1] = b.wind; data[o1 + 2] = b.typeId; data[o1 + 3] = b.speed;
  }
  const t = new THREE.DataTexture(data, n, 2, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

class WaterSystem {
  readonly group = new THREE.Group();
  readonly meshes: THREE.Mesh[] = [];
  readonly material: WaterMaterial;
  readonly reflection = new PlanarReflection();
  private readonly uniforms: WaterUniforms;
  private readonly fallbackEnv: FallbackEnvironment;
  private usingFallbackEnv = false;
  private probes: Float32Array;          // x, y, z of sample water vertices (reflection plane choice)
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private planeY: number | null = null;
  private frameNo = 0;
  private hfTexture: THREE.DataTexture;
  private hfVersion = -1;
  private underwater: THREE.Mesh;
  private underwaterMat: THREE.ShaderMaterial;
  private hit = { a: 0, b: 0, c: 0, wa: 0, wb: 0, wc: 0 };
  private tileSize: number;
  private lastReflPos = new THREE.Vector3(1e9, 0, 0);
  private lastReflDir = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private reflAge = 0;
  private noReflectScan = -1e9;
  private hideInReflection: THREE.Object3D[] = [];
  private lastReflOk = false;
  private half: number;

  constructor(private ctx: AppContext, readonly data: WaterData, tex: Record<string, THREE.Texture>) {
    const hf = ctx.heightfield;
    this.half = hf.half;
    this.tileSize = data.meta.tile;
    // own nearest-filtered copy of the height field (R32F linear filtering is optional in WebGL2);
    // the shader does the bilinear interpolation with texelFetch, matching HeightField.sample().
    this.hfTexture = new THREE.DataTexture(hf.data, hf.n, hf.n, THREE.RedFormat, THREE.FloatType);
    this.hfTexture.minFilter = this.hfTexture.magFilter = THREE.NearestFilter;
    this.hfTexture.generateMipmaps = false;
    this.hfTexture.flipY = false;
    this.hfTexture.needsUpdate = true;

    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(2, -1) },
      uRain: { value: 0 },
      uNight: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDetail: { value: 1 },
      tRipple: { value: tex.ripple },
      tWave: { value: tex.wave },
      tFoam: { value: tex.foam },
      tNoise: { value: tex.noise },
      tHF: { value: this.hfTexture },
      uHF: { value: new THREE.Vector3(hf.half, hf.res, hf.n) },
      tBodies: { value: makeBodyTexture(data.meta.bodies) },
      tReflect: { value: this.reflection.target.texture },
      uReflMatrix: { value: this.reflection.textureMatrix },
      uReflY: { value: 0 },
      uReflOn: { value: 0 },
    };
    this.material = ctx.registerMaterial(new WaterMaterial(this.uniforms));
    const proxy = makePathTracerProxy(tex.ripple);
    this.fallbackEnv = new FallbackEnvironment(ctx);

    this.group.name = 'water';
    const probes: number[] = [];
    for (const t of data.tiles) {
      const m = new THREE.Mesh(t.geometry, this.material);
      m.name = `water-${t.meta.i}-${t.meta.j}`;
      m.position.set(t.meta.cx, 0, t.meta.cz);
      m.receiveShadow = true;
      m.castShadow = false;
      m.userData.ptMaterial = proxy;
      m.userData.isWater = true;
      m.userData.noReflect = true;
      m.renderOrder = 1;
      m.updateMatrix();
      m.matrixAutoUpdate = false;
      this.meshes.push(m);
      this.group.add(m);
      const step = Math.max(1, Math.floor(t.x.length / 120));
      for (let k = 0; k < t.x.length; k += step) {
        if (t.attr[k * 4] < 32) continue;        // skip margin vertices outside the mapped shore
        probes.push(t.x[k], t.y[k], t.z[k]);
      }
    }
    this.probes = new Float32Array(probes);
    ctx.scene.add(this.group);

    // underwater tint (camera-attached full-screen quad)
    this.underwaterMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(0.05, 0.06, 0.045) }, amount: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform vec3 color; uniform float amount; varying vec2 vUv; void main(){ float v = 0.75 + 0.25*vUv.y; gl_FragColor = vec4(color*v*amount, amount); }',
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.underwater = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.underwaterMat);
    this.underwater.frustumCulled = false;
    this.underwater.renderOrder = 1e6;
    this.underwater.visible = false;
    this.underwater.userData.noPathTrace = true;
    ctx.camera.add(this.underwater);

    this.applyQuality();
    ctx.events.on('settings', () => this.applyQuality());
    ctx.events.on('resize', () => this.applyQuality());
  }

  applyQuality(): void {
    const q = this.ctx.settings.quality;
    const scale = { low: 0, medium: 0.35, high: 0.5, ultra: 0.75 }[q] ?? 0.5;
    this.reflection.scale = scale;
    this.reflection.maxDistance = { low: 2000, medium: 5000, high: 9000, ultra: 16000 }[q] ?? 6000;
    this.uniforms.uDetail.value = q === 'low' ? 0.8 : 1.0;
    const on = this.ctx.settings.profile.waterReflections && scale > 0;
    this.material.setPlanar(on);
    if (on) this.reflection.setSize(this.ctx.width, this.ctx.height, this.ctx.pixelRatio);
  }

  /** Objects flagged `userData.noReflect = true` by any module are skipped in the mirror pass. */
  private scanNoReflect(): void {
    this.noReflectScan = this.frameNo;
    const list: THREE.Object3D[] = [this.group, this.underwater];
    const visit = (o: THREE.Object3D) => {
      if (o === this.group) return;
      if (o.userData && o.userData.noReflect === true && o.visible) { list.push(o); return; }
      for (const c of o.children) visit(c);
    };
    try { visit(this.ctx.scene); visit(this.ctx.backdrop.scene); } catch { /* ignore */ }
    this.hideInReflection = list;
  }

  // ------------------------------------------------------------------ queries
  locate(x: number, z: number): WaterTile | null {
    const T = this.tileSize, H = this.half;
    const i = Math.floor((x + H) / T), j = Math.floor((z + H) / T);
    const t0 = this.data.byKey.get(j * 100 + i);
    if (t0 && t0.locate(x, z, this.hit)) return t0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const t = this.data.byKey.get((j + dj) * 100 + i + di);
        if (t && t.locate(x, z, this.hit)) return t;
      }
    }
    return null;
  }

  private interp(arr: ArrayLike<number>, stride = 1, off = 0): number {
    const h = this.hit;
    return arr[h.a * stride + off] * h.wa + arr[h.b * stride + off] * h.wb + arr[h.c * stride + off] * h.wc;
  }

  levelAt(x: number, z: number): number | null {
    const t = this.locate(x, z);
    if (!t) return null;
    const lvl = this.interp(t.y);
    const shore = this.interp(t.attr, 4, 0) / 4 - 8;
    const g = this.ctx.heightfield.sample(x, z);
    if (shore < 0 && lvl <= g + 0.02) return null;    // mesh margin over dry bank
    if (lvl < g - 0.05) return null;                  // bar / island above the water line
    return lvl;
  }

  flowAt(x: number, z: number): { x: number; z: number } | null {
    const t = this.locate(x, z);
    if (!t) return null;
    return { x: this.interp(t.flow, 2, 0) * 0.05, z: this.interp(t.flow, 2, 1) * 0.05 };
  }

  bodyAt(x: number, z: number): WaterBody | null {
    const t = this.locate(x, z);
    if (!t) return null;
    const h = this.hit;
    const k = h.wa >= h.wb && h.wa >= h.wc ? h.a : h.wb >= h.wc ? h.b : h.c;
    return this.data.meta.bodies[t.body[k]] ?? null;
  }

  // ------------------------------------------------------------------ per frame
  private choosePlane(): number | null {
    const cam = this.ctx.camera;
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const p = this.probes, cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    const maxD2 = this.reflection.maxDistance * this.reflection.maxDistance;
    let best = Infinity, y: number | null = null;
    const v = new THREE.Vector3();
    const planes = this.frustum.planes;
    for (let k = 0; k < p.length; k += 3) {
      const dx = p[k] - cx, dy = p[k + 1] - cy, dz = p[k + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= best || d2 > maxD2 || p[k + 1] > cy - 0.3) continue;
      v.set(p[k], p[k + 1], p[k + 2]);
      let inside = true;
      for (let s = 0; s < 6; s++) if (planes[s].distanceToPoint(v) < -40) { inside = false; break; }
      if (!inside) continue;
      best = d2; y = p[k + 1];
    }
    return y;
  }

  update(dt: number): void {
    const ctx = this.ctx, u = this.uniforms, env = ctx.env;
    this.frameNo++;
    u.uTime.value = env.elapsed;
    u.uWind.value.set(env.wind.x, env.wind.y);
    u.uRain.value = env.rain;
    u.uNight.value = env.night;
    u.uSunDir.value.copy(env.sunDirection);

    // height field edits (terrain flattening etc.)
    const hfTex = (ctx.heightfield as any)._texture as THREE.Texture | undefined;
    if (hfTex && hfTex.version !== this.hfVersion) {
      if (this.hfVersion >= 0) this.hfTexture.needsUpdate = true;
      this.hfVersion = hfTex.version;
    }

    // environment: the sky module's scene.environment when present, else our analytic fallback
    if (ctx.scene.environment) {
      if (this.usingFallbackEnv) {
        this.material.envMap = null;
        this.material.needsUpdate = true;
        this.usingFallbackEnv = false;
      }
    } else {
      const t = this.fallbackEnv.update();
      if (t && this.material.envMap !== t) {
        const recompile = !this.usingFallbackEnv;
        this.material.envMap = t;
        if (recompile) this.material.needsUpdate = true;
        this.usingFallbackEnv = true;
      }
      this.material.envMapIntensity = 1.0;
    }

    // planar reflection
    const pt = ctx.get<{ active?: boolean }>('pathtracer');
    const wantPlanar = !!(this.material.defines && 'WATER_PLANAR' in this.material.defines) && !(pt && pt.active);
    let on = 0;
    if (wantPlanar) {
      if (this.frameNo % 3 === 1 || this.planeY === null) this.planeY = this.choosePlane();
      if (this.planeY !== null) {
        // medium quality refreshes the mirror every other frame while the view is nearly static;
        // the texture matrix stays paired with the target, so the lookup remains geometrically exact
        const cam = ctx.camera;
        cam.getWorldDirection(this.tmpDir);
        const moved = cam.position.distanceTo(this.lastReflPos) > 2 || this.tmpDir.angleTo(this.lastReflDir) > 0.02 ||
          Math.abs(this.planeY - this.reflection.planeY) > 0.05;
        const every = ctx.settings.quality === 'medium' ? 2 : 1;
        if (moved || ++this.reflAge >= every || !this.lastReflOk) {
          this.reflection.setSize(ctx.width, ctx.height, ctx.pixelRatio);
          if (this.frameNo - this.noReflectScan > 120) this.scanNoReflect();
          this.lastReflOk = this.reflection.render(ctx, this.planeY, this.hideInReflection);
          this.reflAge = 0;
          this.lastReflPos.copy(cam.position);
          this.lastReflDir.copy(this.tmpDir);
        }
        if (this.lastReflOk) {
          on = 1;
          u.uReflY.value = this.reflection.planeY;
        }
      }
    }
    u.uReflOn.value = on;

    // underwater tint
    const c = ctx.camera.position;
    let uw = 0;
    const lvl = c.y < ctx.heightfield.sample(c.x, c.z) + 40 ? this.levelAt(c.x, c.z) : null;
    if (lvl !== null && c.y < lvl - 0.05) {
      uw = THREE.MathUtils.clamp((lvl - c.y) * 4, 0, 1) * 0.92;
      const b = this.bodyAt(c.x, c.z);
      if (b) this.underwaterMat.uniforms.color.value.setRGB(b.albedo[0], b.albedo[1], b.albedo[2]).multiplyScalar(0.8 * (1 - env.night * 0.9));
    }
    this.underwaterMat.uniforms.amount.value = uw;
    this.underwater.visible = uw > 0.001;
    void dt;
  }
}

const mod: CityModule = {
  id: 'water',
  // no `after`: the height field comes from core, and the roads module waits (briefly) for our
  // levels to shape its bridges, so the service should appear as early as possible
  async init(ctx: AppContext) {
    const aniso = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy());
    const work = (async () => {
      const [data, ripple, wave, foam, noise] = await Promise.all([
        loadWaterData(),
        loadTexture('ripple_n.png', aniso),
        loadTexture('wave_n.png', aniso),
        loadTexture('foam.png', aniso),
        loadTexture('noise.png', 1),
      ]);
      const sys = new WaterSystem(ctx, data, { ripple, wave, foam, noise });
      const api: WaterService = {
        isWater: (x, z) => sys.levelAt(x, z) !== null,
        levelAt: (x, z) => sys.levelAt(x, z),
        depthAt: (x, z) => {
          const l = sys.levelAt(x, z);
          return l === null ? null : Math.max(0, l - ctx.heightfield.sample(x, z));
        },
        flowAt: (x, z) => sys.flowAt(x, z),
        bodyAt: (x, z) => sys.bodyAt(x, z),
        bodies: data.meta.bodies,
        meshes: sys.meshes,
        material: sys.material,
        reflection: sys.reflection,
      };
      ctx.provide('water', api);
      // late in the frame: after the sky / CSM / camera updates, right before rendering
      ctx.onUpdate((dt) => {
        try { sys.update(dt); } catch (e) { console.error('[water] update failed', e); }
      }, 100);
      console.info(`[water] ${data.tiles.length} tiles, ${data.meta.stats?.triangles ?? '?'} triangles, ${data.meta.bodies.length} bodies`);
      // foam wakes at bridge piers (only when the roads module, which builds the piers, is loaded)
      if (ctx.settings.wants('roads')) {
        try {
          const wakes = await buildPierWakes(ctx, api, { foam, noise }, sys.material.uniforms.uTime);
          if (wakes) sys.group.add(wakes);
        } catch (e) { console.warn('[water] pier wakes skipped', e); }
      }
    })();
    await ctx.pending(work).catch((e) => console.error('[water] init failed', e));
  },
};
export default mod;
