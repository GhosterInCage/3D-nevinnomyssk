// Terrain module: CDLOD-streamed bare-earth terrain of the 20.48 km region with a splatted,
// physically based ground material, plus the far terrain (Caucasus / Stavropol upland) in the
// backdrop scene. Provides the 'terrain' service. See docs/modules/terrain.md.
import * as THREE from 'three';
import type { AppContext, CityModule } from '../../core/context';
import type { Quality } from '../../core/settings';
import { fetchJSON } from '../../core/data';
import { Cdlod, MinMaxPyramid } from './cdlod';
import { createDepthMaterial, createGroundMaterial, type Uniforms } from './material';
import { loadClassMap, loadLayerArray, loadLayersJson, loadTexture, type LayersJson } from './assets';
import { GROUND_CLASSES, TerrainSampler } from './sampling';
import { HF_COMMON } from './shaders';
import { FarTerrain } from './far';
import { buildNoiseTexture, buildNormalMap } from './textures';

const LEAF = 80;            // finest node size (m)
const LEVELS = 9;           // 80 m .. 20480 m
const NLAYERS = 14;
const BASE_RANGES = [160, 400, 1500, 3200, 6500, 13000, 26000, 52000, 104000];

interface QualityCfg { gridN: number; rangeScale: number; detailFar: number; micro: boolean; castShadow: boolean; texSize: number }
const QCFG: Record<Quality, QualityCfg> = {
  low: { gridN: 16, rangeScale: 0.7, detailFar: 450, micro: false, castShadow: false, texSize: 512 },
  medium: { gridN: 32, rangeScale: 0.85, detailFar: 1100, micro: true, castShadow: false, texSize: 1024 },
  high: { gridN: 32, rangeScale: 1.0, detailFar: 1800, micro: true, castShadow: true, texSize: 1024 },
  ultra: { gridN: 64, rangeScale: 1.2, detailFar: 2600, micro: true, castShadow: true, texSize: 1024 },
};

// class -> [layer A, layer B, layer C, oriented rows] and [patch coverage of C, patch
// frequency (1/m), A/B blended by lushness (1) or noise (0), 0].
// layers: 0 grass_lush 1 grass_dry 2 ground_mix 3 crop_rows 4 stubble 5 ploughed 6 bare_soil
//         7 gravel 8 forest_floor 9 urban_ground 10 pebbles 11 mud 12 sand 13 clay_rock
const CLASS_DEF: Record<string, [number[], number[]]> = {
  grass: [[0, 1, 2, 0], [0.16, 0.05, 1, 0]],
  crop: [[3, 5, 3, 1], [0, 0, 1, 0]],
  stubble: [[4, 4, 2, 1], [0.1, 0.03, 0, 0]],
  ploughed: [[5, 5, 6, 1], [0.18, 0.04, 0, 0]],
  bare: [[6, 2, 7, 0], [0.12, 0.06, 0, 0]],
  gravel: [[7, 9, 6, 0], [0.2, 0.05, 0, 0]],
  forest: [[8, 2, 0, 0], [0.14, 0.04, 0, 0]],
  urban: [[9, 2, 6, 0], [0.22, 0.07, 1, 0]],
  pebbles: [[10, 12, 11, 0], [0.12, 0.08, 0, 0]],
  mud: [[11, 0, 11, 0], [0, 0, 1, 0]],
  sand: [[12, 10, 12, 0], [0, 0, 0, 0]],
  rock: [[13, 6, 13, 0], [0, 0, 0, 0]],
};

/** Software rasterisers (SwiftShader / llvmpipe) pay heavily for anisotropic filtering. */
function isSoftwareRenderer(r: THREE.WebGLRenderer): boolean {
  try {
    const gl = r.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch { return false; }
}

function ranges(scale: number): number[] {
  const out: number[] = [];
  for (let L = 0; L < LEVELS; L++) {
    const size = LEAF * 2 ** L;
    let r = BASE_RANGES[L] * (L >= 2 ? scale : 1);
    if (L > 0) r = Math.max(r, out[L - 1] + 1.45 * size);
    out.push(r);
  }
  return out;
}

function dataTex1(rgba: [number, number, number, number], srgb = false): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function fallbackArray(): THREE.DataArrayTexture {
  const d = new Uint8Array(4 * NLAYERS);
  for (let k = 0; k < NLAYERS; k++) d.set([128, 128, 128, 255], k * 4);
  const t = new THREE.DataArrayTexture(d, 1, 1, NLAYERS);
  t.needsUpdate = true;
  return t;
}

function classFallback(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedIntegerFormat, THREE.UnsignedByteType);
  t.internalFormat = 'R8UI';
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly uniforms: Uniforms;
  readonly sampler: TerrainSampler;
  material!: THREE.MeshStandardMaterial;
  depthMaterial!: THREE.MeshDepthMaterial;
  cdlod!: Cdlod;
  far: FarTerrain | null = null;
  private meshes: THREE.Mesh[] = [];
  private cfg: QualityCfg;
  private pyramid: MinMaxPyramid;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private orthoBlend: [number, number] | null = null;
  private hfVersion = -1;
  private aniso: number;

  constructor(private ctx: AppContext) {
    const hf = ctx.heightfield;
    this.cfg = QCFG[ctx.settings.quality] ?? QCFG.medium;
    const forced = Number(ctx.settings.params.get('terrainAniso'));
    this.aniso = forced > 0 ? forced : isSoftwareRenderer(ctx.renderer) ? 1 : Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy());
    this.sampler = new TerrainSampler(hf);
    this.pyramid = new MinMaxPyramid(hf.data, hf.n, LEAF / hf.res, LEVELS, 1.5);
    const layerP = Array.from({ length: NLAYERS }, () => new THREE.Vector4(1 / 3, 0.9, 1, 0));
    const layerMean = Array.from({ length: NLAYERS }, () => new THREE.Vector3(0.1, 0.1, 0.08));
    const classDef = GROUND_CLASSES.map((c) => new THREE.Vector4().fromArray(CLASS_DEF[c][0]));
    const classDef2 = GROUND_CLASSES.map((c) => new THREE.Vector4().fromArray(CLASS_DEF[c][1]));
    const grey = dataTex1([90, 90, 80, 255], true);
    this.uniforms = {
      uHeight: { value: hf.texture },
      uHf: { value: new THREE.Vector3(hf.n, hf.half, hf.res) },
      uMorph: { value: [] as THREE.Vector2[] },
      uMicro: { value: new THREE.Vector4(0.06, 50, 140, this.cfg.micro ? 1 : 0) },
      uClip: { value: new THREE.Vector4(-hf.half, -hf.half, hf.half, hf.half) },
      uCamPos: { value: new THREE.Vector3() },
      uClassV: { value: classFallback() },
      uClassNV: { value: 1 },
      uClass: { value: null },
      uClassN: { value: 1 },
      uOrtho: { value: grey },
      uGround: { value: grey },
      uShade: { value: dataTex1([235, 0, 150, 255]) },
      uAlb: { value: fallbackArray() },
      uNrm: { value: fallbackArray() },
      uLayerP: { value: layerP },
      uLayerMean: { value: layerMean },
      uClassDef: { value: classDef },
      uClassDef2: { value: classDef2 },
      uBlend: { value: new THREE.Vector4(2500, 7000, this.cfg.detailFar, 1) },
      uRegion: { value: new THREE.Vector4(-hf.half, -hf.half, hf.size, 1 / hf.size) },
      uLook: { value: new THREE.Vector4(0.55, 0.24, 0.9, 1.0) },
      uDebug: { value: new THREE.Vector4(0, 0, 0, 0) },
      uNormalMap: { value: buildNormalMap(hf) },
      uNoise: { value: buildNoiseTexture() },
    };
    this.uniforms.uClass.value = this.uniforms.uClassV.value;
    this.group.name = 'terrain';
    this.build();
  }

  private build(): void {
    for (const m of this.meshes) { this.group.remove(m); }
    this.meshes = [];
    const hf = this.ctx.heightfield;
    const cfg = this.cfg;
    this.cdlod = new Cdlod({
      x0: -hf.half, z0: -hf.half, size: hf.size, levels: LEVELS, gridN: cfg.gridN,
      ranges: ranges(cfg.rangeScale), morphFraction: 0.35,
      bounds: (level, ix, iz) => this.pyramid.get(level, ix, iz),
      maxPatches: 3000,
    });
    this.uniforms.uMorph.value = this.cdlod.morph;
    const defines = { TERRAIN_LEVELS: LEVELS, TERRAIN_NLAYERS: NLAYERS, TERRAIN_NCLASSES: GROUND_CLASSES.length };
    if (!this.material) {
      this.material = this.ctx.registerMaterial(createGroundMaterial(this.uniforms, defines));
      this.depthMaterial = createDepthMaterial(this.uniforms, defines);
    }
    for (const g of [this.cdlod.full, this.cdlod.half]) {
      const m = new THREE.Mesh(g, this.material);
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.castShadow = cfg.castShadow;
      m.customDepthMaterial = this.depthMaterial;
      m.userData.noPathTrace = true;
      m.userData.ptProxy = (c: THREE.Vector3, r: number, s?: number) => this.pathTraceProxy(c, r, s);
      m.name = g === this.cdlod.full ? 'terrain-patches' : 'terrain-patches-half';
      this.meshes.push(m);
      this.group.add(m);
    }
  }

  setQuality(q: Quality): void {
    const next = QCFG[q] ?? QCFG.medium;
    const rebuild = next.gridN !== this.cfg.gridN;
    this.cfg = next;
    (this.uniforms.uMicro.value as THREE.Vector4).w = next.micro ? 1 : 0;
    (this.uniforms.uBlend.value as THREE.Vector4).z = next.detailFar;
    if (rebuild) {
      this.cdlod.full.dispose(); this.cdlod.half.dispose();
      this.build();
    } else {
      this.cdlod.setRanges(ranges(next.rangeScale));
      for (const m of this.meshes) m.castShadow = next.castShadow;
    }
  }

  async loadAssets(): Promise<void> {
    const ctx = this.ctx;
    const man = ctx.manifest.terrain;
    const u = this.uniforms;
    const jobs: Promise<unknown>[] = [];
    const an = this.aniso;
    jobs.push(loadTexture(man.ortho, true, an).then((t) => { u.uOrtho.value = t; if (u.uGround.value?.image?.width === 1) u.uGround.value = t; }));
    jobs.push(loadTexture('terrain/ground_albedo.jpg', true, an).then((t) => { u.uGround.value = t; }).catch((e) => console.warn('[terrain] ground albedo', e)));
    jobs.push(loadTexture('terrain/ground_shade.jpg', false, Math.min(an, 4)).then((t) => { u.uShade.value = t; }).catch((e) => console.warn('[terrain] shade map', e)));
    jobs.push(loadClassMap('terrain/ground_class.bin.gz', 4096).then(({ data, tex }) => {
      u.uClass.value = tex; u.uClassV.value = tex; u.uClassN.value = 4096; u.uClassNV.value = 4096;
      this.sampler.classData = data; this.sampler.classN = 4096;
    }).catch((e) => console.warn('[terrain] class map', e)));
    jobs.push((async () => {
      const lj: LayersJson = await loadLayersJson();
      const n = Math.min(NLAYERS, lj.layers.length);
      for (let k = 0; k < n; k++) {
        const L = lj.layers[k];
        (u.uLayerP.value[k] as THREE.Vector4).set(1 / L.tile, L.rough, 1.0, 0);
        (u.uLayerMean.value[k] as THREE.Vector3).set(L.mean[0], L.mean[1], L.mean[2]);
      }
      const size = this.cfg.texSize;
      const [alb, nrm] = await Promise.all([loadLayerArray('albedo', NLAYERS, size, true), loadLayerArray('normal', NLAYERS, size, false)]);
      alb.anisotropy = nrm.anisotropy = an;
      u.uAlb.value = alb; u.uNrm.value = nrm;
    })().catch((e) => console.warn('[terrain] detail textures', e)));
    await Promise.all(jobs);
  }

  setOrthoBlend(start: number, end: number): void { this.orthoBlend = [start, end]; }

  update(): void {
    const ctx = this.ctx;
    const cam = ctx.camera;
    const hf = ctx.heightfield;
    // other modules may modify the height field (hf.markDirty) -> refresh bounds
    const tex = hf.texture;
    if (tex.version !== this.hfVersion) {
      if (this.hfVersion >= 0) {
        this.pyramid = new MinMaxPyramid(hf.data, hf.n, LEAF / hf.res, LEVELS, 1.5);
        buildNormalMap(hf, this.uniforms.uNormalMap.value as THREE.DataTexture);
      }
      this.hfVersion = tex.version;
    }
    (this.uniforms.uCamPos.value as THREE.Vector3).copy(cam.position);
    cam.updateMatrixWorld();
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const shadowKeep = this.cfg.castShadow ? Math.min(ctx.settings.profile.shadowFar, 2500) : 0;
    this.cdlod.select(cam.position, this.frustum, shadowKeep);
    const b = this.uniforms.uBlend.value as THREE.Vector4;
    const dd = ctx.settings.profile.drawDistance;
    const [s, e] = this.orthoBlend ?? [dd * 0.35, dd * 0.75];
    b.x = s; b.y = e;
    // de-roofed ground albedo only makes sense when buildings / trees are drawn on top
    b.w = ctx.get('buildings') || ctx.get('vegetation') ? 1 : 0;
    this.far?.update();
  }

  /** Regular triangulated patch of the rendered surface (for the path tracer or physics). */
  pathTraceProxy(center: THREE.Vector3, radius: number, spacing = 5): THREE.Mesh {
    const n = Math.max(2, Math.ceil((2 * radius) / spacing));
    const g = new THREE.PlaneGeometry(2 * radius, 2 * radius, n, n);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position as THREE.BufferAttribute;
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const hf = this.ctx.heightfield;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + center.x, z = p.getZ(i) + center.z;
      p.setXYZ(i, x, this.sampler.heightAt(x, z), z);
      uv.setXY(i, (x + hf.half) / hf.size, 1 - (z + hf.half) / hf.size);
    }
    g.computeVertexNormals();
    const ortho = this.uniforms.uGround.value as THREE.Texture;
    const map = ortho.clone();
    map.flipY = true;
    map.needsUpdate = true;
    const mat = new THREE.MeshPhysicalMaterial({ map, roughness: 0.95 });
    const m = new THREE.Mesh(g, mat);
    m.name = 'terrain-pt-proxy';
    m.receiveShadow = true;
    return m;
  }
}

/** Minimal sun + sky light when the sky module is not loaded (?only=terrain), for testing. */
function standaloneLights(ctx: AppContext): void {
  const sun = new THREE.DirectionalLight(0xfff4e6, 3.2);
  const hemi = new THREE.HemisphereLight(0xa9c6ee, 0x6b5d45, 1.1);
  ctx.scene.add(sun, sun.target, hemi);
  const bsun = new THREE.DirectionalLight(0xfff4e6, 3.2);
  const bhemi = hemi.clone();
  ctx.backdrop.scene.add(bsun, bsun.target, bhemi);
  ctx.backdrop.scene.background = new THREE.Color(0x9fbfe0);
  ctx.scene.fog = new THREE.FogExp2(0xb4c8dc, 0.000045);
  ctx.onUpdate(() => {
    const d = ctx.env.sunDirection;
    sun.position.copy(ctx.camera.position).addScaledVector(d, 2000);
    sun.target.position.copy(ctx.camera.position);
    sun.intensity = 3.2 * Math.max(0, d.y) ** 0.4;
    hemi.intensity = 0.25 + 0.9 * Math.max(0, d.y) ** 0.5;
    bsun.position.copy(sun.position); bsun.target.position.copy(sun.target.position);
    bsun.intensity = sun.intensity; bhemi.intensity = hemi.intensity;
  });
}

const mod: CityModule = {
  id: 'terrain',
  async init(ctx) {
    const terrain = new Terrain(ctx);
    ctx.scene.add(terrain.group);
    const api = {
      heightAt: (x: number, z: number) => terrain.sampler.heightAt(x, z),
      normalAt: (x: number, z: number, out?: THREE.Vector3) => terrain.sampler.normalAt(x, z, out),
      groundTypeAt: (x: number, z: number) => terrain.sampler.groundTypeAt(x, z),
      /** ground class index (see GROUND_CLASSES) */
      classAt: (x: number, z: number) => terrain.sampler.classAt(x, z),
      classes: GROUND_CLASSES,
      mesh: terrain.group as THREE.Object3D,
      material: terrain.material,
      /** distance band (m) over which the near ground albedo (roofs / crowns removed) turns into the full ortho */
      setOrthoBlend: (start: number, end: number) => terrain.setOrthoBlend(start, end),
      pathTraceProxy: (center: THREE.Vector3, radius: number, spacing?: number) => terrain.pathTraceProxy(center, radius, spacing),
      stats: () => ({ patches: terrain.cdlod.patchCount, triangles: terrain.cdlod.triangles, far: terrain.far?.stats() }),
      setDebug: (mode: number) => { (terrain.uniforms.uDebug.value as THREE.Vector4).x = mode; },
      /** GLSL helpers to reproduce the rendered surface on the GPU: bind uHeight = ctx.heightfield.texture,
       *  uHf = (n, half, res); tHeightBicubic(xz, out grad) is the exact terrain surface (micro relief
       *  of up to +-6 cm on natural ground near the camera excluded). */
      glsl: { heightfield: HF_COMMON },
      far: null as FarTerrain | null,
      terrain,
    };
    ctx.provide('terrain', api);
    ctx.need<any>('water').then((w) => {
      if (w && typeof w.isWater === 'function') terrain.sampler.isWater = (x, z) => !!w.isWater(x, z);
    });
    ctx.events.on('settings', () => { try { terrain.setQuality(ctx.settings.quality); } catch (e) { console.error('[terrain] quality', e); } });
    ctx.onUpdate(() => terrain.update(), -10);
    if (!ctx.settings.wants('sky')) standaloneLights(ctx);
    // assets (macro textures, class map, detail arrays) stream in; screenshots wait for them
    ctx.pending(terrain.loadAssets().catch((e) => console.error('[terrain] assets', e)));
    // far terrain in the backdrop scene
    ctx.pending((async () => {
      try {
        const far = new FarTerrain(ctx);
        await far.load();
        terrain.far = far;
        api.far = far;
      } catch (e) {
        console.warn('[terrain] far terrain unavailable', e);
      }
    })());
    void fetchJSON;
  },
};
export default mod;
