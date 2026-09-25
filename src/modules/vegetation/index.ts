// Vegetation module: ~0.9 M trees, ~0.4 M shrubs and hedges placed by the pipeline
// (pipeline/build_vegetation.py), procedural species models (worker), mesh LODs near the camera,
// baked octahedral impostors for the far field, GPU grass / crops around the camera,
// trunk colliders and the 'vegetation' service { clearInPolygon }.
import * as THREE from 'three';
import type { AppContext, CityModule, StaticCollider } from '../../core/context';
import { dataUrl, fetchBuffer } from '../../core/data';
import { VegData, pointInRing } from './data';
import { SPECIES } from './species';
import { generateTree, type GenParams, type TreeModel } from './treegen';
import { Forest, forestParams, type Textures } from './forest';
import { Grass } from './grass';
import { VU } from './materials';
import { QUALITY, type Quality } from '../../core/settings';

const TEX_BASE = `${import.meta.env.BASE_URL}textures/vegetation/`;

async function loadTexture(url: string, o: { srgb: boolean; repeat?: boolean; flipY?: boolean; mips?: boolean; nearest?: boolean; aniso?: number }): Promise<THREE.Texture> {
  const t = await new THREE.TextureLoader().loadAsync(url);
  t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (o.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  else t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = o.flipY ?? true;
  if (o.nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  else if (o.mips === false) { t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; }
  t.anisotropy = o.aniso ?? 1;
  t.needsUpdate = true;
  return t;
}

async function loadTextures(ctx: AppContext): Promise<Textures> {
  const aniso = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy());
  const leaves = loadTexture(TEX_BASE + 'leaves.webp', { srgb: true, aniso });
  const bark: Textures['bark'] = {};
  const jobs: Promise<void>[] = [];
  for (const k of ['oak', 'willow', 'pine', 'birch']) {
    jobs.push((async () => {
      const [map, normal] = await Promise.all([
        loadTexture(`${TEX_BASE}bark_${k}_color.jpg`, { srgb: true, repeat: true, aniso }),
        loadTexture(`${TEX_BASE}bark_${k}_normal.jpg`, { srgb: false, repeat: true, aniso }),
      ]);
      bark[k] = { map, normal };
    })());
  }
  const [lv] = await Promise.all([leaves, ...jobs]);
  return { leaves: lv as THREE.Texture, bark };
}

/** Generate all species models in parallel web workers (main-thread fallback). */
async function generateModels(): Promise<Map<number, TreeModel>> {
  const out = new Map<number, TreeModel>();
  const nW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  const buckets: Array<Array<{ id: number; gen: GenParams }>> = Array.from({ length: nW }, () => []);
  // heaviest species first, round robin
  const jobs: Array<{ id: number; gen: GenParams }> = [];
  for (const d of SPECIES) for (let v = 0; v < (d.variants ?? 1); v++) jobs.push({ id: d.id * 8 + v, gen: { ...d.gen, seed: d.gen.seed + v * 7919 } });
  jobs.sort((a, b) => (b.gen.points ?? 400) * b.gen.height - (a.gen.points ?? 400) * a.gen.height);
  jobs.forEach((j, i) => buckets[i % nW].push(j));
  await Promise.all(buckets.map((jobs) => new Promise<void>((resolve) => {
    if (!jobs.length) return resolve();
    let w: Worker;
    try {
      w = new Worker(new URL('../../workers/vegetation-treegen.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      console.warn('[vegetation] worker unavailable, generating on main thread', e);
      return resolve();
    }
    let left = jobs.length;
    const timer = setTimeout(() => { w.terminate(); resolve(); }, 60000);
    w.onmessage = (e: MessageEvent) => {
      if (e.data.model) out.set(e.data.id, e.data.model as TreeModel);
      else console.warn('[vegetation] tree generation failed', e.data.id, e.data.error);
      if (--left === 0) { clearTimeout(timer); w.terminate(); resolve(); }
    };
    w.onerror = (e) => { console.warn('[vegetation] worker error', e.message); clearTimeout(timer); w.terminate(); resolve(); };
    w.postMessage({ jobs });
  })));
  for (const j of jobs) {
    if (out.has(j.id)) continue;
    try { out.set(j.id, generateTree(j.gen)); } catch (e) { console.warn('[vegetation] generate', j.id, e); }
  }
  return out;
}

const idle = () => new Promise<void>((r) => setTimeout(r, 0));

let forest: Forest | null = null;
let grassOn = true;
let grass: Grass | null = null;
let data: VegData | null = null;
const pendingClears: number[][] = [];

function applyClear(ring: number[]): number {
  if (!data || !forest) { pendingClears.push(ring); return 0; }
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (let i = 0; i < ring.length; i += 2) { minx = Math.min(minx, ring[i]); maxx = Math.max(maxx, ring[i]); minz = Math.min(minz, ring[i + 1]); maxz = Math.max(maxz, ring[i + 1]); }
  let n = 0;
  const d = data;
  d.forCells(minx, minz, maxx, maxz, (c) => {
    for (let k = d.cellStart[c]; k < d.cellStart[c + 1]; k++) {
      if (d.removed[k]) continue;
      const x = d.x[k], z = d.z[k];
      if (x < minx || x > maxx || z < minz || z > maxz) continue;
      if (pointInRing(x, z, ring)) { d.removed[k] = 1; n++; }
    }
  });
  if (n) forest.markDirtyAround(minx, minz, maxx, maxz);
  grass?.addClear(ring);
  return n;
}

const mod: CityModule = {
  id: 'vegetation',
  after: ['terrain'],
  async init(ctx: AppContext) {
    const api = {
      /** Remove trees, shrubs and grass inside a polygon ring [x0,z0,x1,z1,...] (world xz). */
      clearInPolygon(ringXZ: number[]): number { return applyClear(Array.from(ringXZ)); },
      get forest() { return forest; },
      get grass() { return grass; },
      get data() { return data; },
      stats() { return forest ? { ...forest.stats, instances: data?.n ?? 0 } : null; },
      /** Debug: impostor atlas (0 = albedo, 1 = normals) as a PNG data URL. */
      debugAtlas(which = 0): string | null {
        const rt = forest?.atlasTarget;
        if (!rt) return null;
        const w = rt.width, h = rt.height;
        const buf = new Uint8Array(w * h * 4);
        (ctx.renderer as any).readRenderTargetPixels(rt, 0, 0, w, h, buf, undefined, which);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d')!;
        const img = g.createImageData(w, h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const si = ((h - 1 - y) * w + x) * 4, di = (y * w + x) * 4;
          img.data[di] = buf[si]; img.data[di + 1] = buf[si + 1]; img.data[di + 2] = buf[si + 2]; img.data[di + 3] = 255;
          if (buf[si + 3] < 128) { img.data[di] = img.data[di] * 0.3 + 60; img.data[di + 1] = img.data[di + 1] * 0.3; img.data[di + 2] = img.data[di + 2] * 0.3 + 60; }
        }
        g.putImageData(img, 0, 0);
        return c.toDataURL('image/png');
      },
    };
    ctx.provide('vegetation', api);

    ctx.registerColliders({
      id: 'vegetation',
      query(x: number, z: number, r: number): StaticCollider[] {
        if (!forest) return [];
        return forest.colliders(x, z, r).map((c) => ({ kind: 'cylinder', key: c.key, center: [c.x, c.y, c.z], radius: c.radius, halfHeight: c.half }));
      },
    });

    const dbg = new Set((ctx.settings.params.get('vegdbg') || '').split(',').filter(Boolean));
    (globalThis as any).__vegdbg = dbg;
    // ?vegq=<tier> overrides the vegetation tier only (testing on slow software renderers)
    const vq = ctx.settings.params.get('vegq');
    const quality = vq && QUALITY[vq as Quality] ? (vq as Quality) : ctx.settings.quality;
    const prof = QUALITY[quality];
    const t0 = performance.now();

    const build = (async () => {
      const tm = (label: string) => console.info(`[vegetation] ${label} at ${Math.round(performance.now() - t0)} ms`);
      const [d, tex, models] = await Promise.all([
        VegData.load().then((r) => { tm('data'); return r; }),
        loadTextures(ctx).then((r) => { tm('textures'); return r; }),
        generateModels().then((r) => { tm('models'); return r; }),
      ]);
      data = d;
      const fp = forestParams(quality, prof.drawDistance, prof.shadowFar);
      const f = new Forest(ctx, d, fp);
      let slot = 0;
      for (const def of SPECIES) {
        for (let v = 0; v < (def.variants ?? 1); v++) {
          const m = models.get(def.id * 8 + v);
          if (!m) continue;
          f.addSpecies(def, m, tex, def.kind === 'tree' ? slot++ : -1, v);
        }
      }
      tm('species meshes');
      f.bakeImpostors(tex);
      tm('impostors baked');
      f.initChunks();
      forest = f;
      for (const r of pendingClears.splice(0)) applyClear(r);
      // far field: build everything in view distance before signalling ready (time-sliced)
      if (!dbg.has('nofar')) while (!f.buildChunks(ctx.settings.shot ? 400 : 60, fp.drawDistance)) await idle();
      console.info(`[vegetation] ${d.n} instances, ${models.size} species models, ready in ${Math.round(performance.now() - t0)} ms`);
    })();

    let grassLoading: Promise<void> | null = null;
    const makeGrass = (q: Quality): Promise<void> => grassLoading ??= (async () => {
      const [bitsBuf, cover, ctype, ortho] = await Promise.all([
        fetchBuffer('vegetation/nogrow.bin.gz'),
        loadTexture(dataUrl('vegetation/cover.jpg'), { srgb: false, flipY: false, mips: false }),
        loadTexture(dataUrl('vegetation/covertype.png'), { srgb: false, flipY: false, nearest: true }),
        loadTexture(dataUrl(ctx.manifest.terrain.ortho), { srgb: true, flipY: false, mips: false }),
      ]);
      grass = new Grass(ctx, new Uint8Array(bitsBuf), cover, ctype, ortho, q, QUALITY[q].vegetationDensity);
      for (const r of pendingClears) grass.addClear(r);
    })();
    grassOn = prof.grass && !dbg.has('nograss');
    const grassBuild = grassOn ? makeGrass(quality) : Promise.resolve();

    ctx.pending(build.catch((e) => console.error('[vegetation] build failed', e)));
    ctx.pending(grassBuild.catch((e) => console.error('[vegetation] grass failed', e)));

    ctx.events.on('settings', () => {
      if (!forest) return;
      const p = forestParams(ctx.settings.quality, ctx.settings.profile.drawDistance, ctx.settings.profile.shadowFar);
      // impostor atlas resolution is fixed at startup; LOD distances follow the new tier
      forest.p = { ...p, impFrames: forest.p.impFrames, impFramePx: forest.p.impFramePx, impBlend: forest.p.impBlend };
      grassOn = ctx.settings.profile.grass && !dbg.has('nograss');
      if (grass) grass.group.visible = grassOn;
      else if (grassOn) makeGrass(ctx.settings.quality).catch((e) => console.error('[vegetation] grass failed', e));
    });
  },

  update(dt: number, ctx: AppContext) {
    VU.uTime.value = ctx.env.elapsed;
    VU.uWind.value.copy(ctx.env.wind);
    if (!forest) return;
    try {
      forest.update();
      if (forest.pendingChunks && !((globalThis as any).__vegdbg as Set<string>)?.has('nofar')) forest.buildChunks(4);
      if (grass && grassOn) grass.update();
    } catch (e) {
      console.error('[vegetation] update', e);
    }
    void dt;
  },
};
export default mod;
