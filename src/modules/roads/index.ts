// Roads module: roads, sidewalks, curbs, markings, bridges, railways (+ catenary), street furniture
// and the power grid of Nevinnomyssk. Provides the 'roads' service. See docs/modules/roads.md.
import * as THREE from 'three';
import type { AppContext, CityModule } from '../../core/context';
import { loadRoadsData, type PolyRec, type RoadsData, type TileRec } from './data';
import { Ground, buildSuperTile } from './ground';
import { Bridges, makeRailingTexture } from './bridges';
import { createSurfaceMaterial, loadArrayTexture, makeLampMap, makeNoiseTexture, makeSharedUniforms, type SharedUniforms } from './materials';
import { RoadGraph, signalState } from './service';
import { Furniture } from './furniture';
import { Rail } from './rail';
import { Power } from './power';
import { LAMP_HEAD } from './models';
import { headingToDir } from './geom';

interface SuperTile { key: number; cx: number; cz: number; tiles: TileRec[]; polys: PolyRec[]; ground: THREE.Mesh | null; marks: THREE.Mesh | null; built: boolean }

class Roads {
  u: SharedUniforms = makeSharedUniforms();
  data!: RoadsData;
  ground!: Ground;
  bridges!: Bridges;
  graph!: RoadGraph;
  furniture: Furniture | null = null;
  rail: Rail | null = null;
  power: Power | null = null;
  supers: SuperTile[] = [];
  mats!: { ground: THREE.MeshStandardMaterial; marks: THREE.MeshStandardMaterial; deck: THREE.MeshStandardMaterial; struct: THREE.MeshStandardMaterial; railing: THREE.MeshStandardMaterial };
  group = new THREE.Group();
  wet = 0;
  tris = 0;

  constructor(private ctx: AppContext) {
    this.group.name = 'roads';
    ctx.scene.add(this.group);
    if (!ctx.settings.wants('sky')) {
      // isolated test (?only=roads): minimal lighting so the module can be inspected
      const sun = new THREE.DirectionalLight(0xfff4e6, 3.0);
      sun.position.copy(ctx.env.sunDirection).multiplyScalar(1000);
      const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4238, 1.0);
      ctx.scene.add(sun, sun.target, hemi);
      ctx.scene.background = new THREE.Color(0x9fb8d8);
      ctx.onUpdate(() => {
        sun.position.copy(ctx.camera.position).addScaledVector(ctx.env.sunDirection, 1000);
        sun.target.position.copy(ctx.camera.position);
        sun.intensity = 3 * (1 - ctx.env.night) + 0.02;
        hemi.intensity = 1.0 * (1 - ctx.env.night) + 0.03;
      });
    }
  }

  async init(): Promise<void> {
    const ctx = this.ctx;
    const q = ctx.settings.quality;
    const T0 = performance.now();
    const lap = (what: string) => console.info(`[roads] ${what} ${Math.round(performance.now() - T0)}ms`);
    const texSize = q === 'low' ? 512 : 1024;
    const [data, alb, nrm] = await Promise.all([
      loadRoadsData(),
      loadArrayTexture('textures/roads/surf_albedo.jpg', 8, true, texSize),
      loadArrayTexture('textures/roads/surf_nrm.jpg', 8, false, texSize),
    ]);
    this.data = data;
    lap('loaded');
    this.u.rsAlb.value = alb;
    this.u.rsNrm.value = nrm;
    this.u.rsNoise.value = makeNoiseTexture(256);
    this.ground = new Ground(ctx.heightfield);
    lap('noise');

    // materials
    this.mats = {
      ground: createSurfaceMaterial(ctx, this.u, 'ground', { pull: [0.02, 0.0005, 1.5e-7] }),
      marks: createSurfaceMaterial(ctx, this.u, 'marks', { transparent: true, pull: [0.03, 0.0006, 2.0e-7] }),
      deck: createSurfaceMaterial(ctx, this.u, 'deck', { pull: [0.0, 0.0, 0.0] }),
      struct: createSurfaceMaterial(ctx, this.u, 'struct', { pull: [0.0, 0.0, 0.0], lamps: true }),
      railing: ctx.registerMaterial(new THREE.MeshStandardMaterial({
        color: 0x5d6461, metalness: 0.6, roughness: 0.55, map: makeRailingTexture(), alphaTest: 0.5, side: THREE.DoubleSide,
      })),
    };
    this.mats.deck.polygonOffset = false;
    this.mats.struct.polygonOffset = false;

    // bridges need water levels when available (wait briefly for the water module)
    this.bridges = new Bridges(ctx, data, this.ground);
    let water = ctx.get<any>('water');
    if (!water && ctx.settings.wants('water')) {
      water = await Promise.race([ctx.need<any>('water'), new Promise<undefined>((r) => setTimeout(() => r(undefined), 6000))]);
    }
    const levelAt = (x: number, z: number): number | null => {
      try {
        const v = water?.levelAt?.(x, z);
        return typeof v === 'number' && isFinite(v) ? v : null;
      } catch { return null; }
    };
    this.bridges.computeProfiles(levelAt);
    const br = this.bridges.build({ deck: this.mats.deck, struct: this.mats.struct, railing: this.mats.railing });
    this.tris += br.tris;
    lap('bridges');

    // graph + service
    this.graph = new RoadGraph(data, (x, z, b) => this.surfaceY(x, z, b));
    this.provideService();
    lap('graph');

    // super tiles (2 x 2 pipeline tiles)
    const T = data.meta.tile, H = data.meta.half, NT = data.meta.nt;
    const byKey = new Map<number, SuperTile>();
    const getST = (ti: number, tj: number): SuperTile => {
      const si = ti >> 1, sj = tj >> 1, key = sj * 64 + si;
      let st = byKey.get(key);
      if (!st) {
        st = { key, cx: -H + (si + 0.5) * 2 * T, cz: -H + (sj + 0.5) * 2 * T, tiles: [], polys: [], ground: null, marks: null, built: false };
        byKey.set(key, st);
      }
      return st;
    };
    for (const t of data.meta.tiles) getST(t.i, t.j).tiles.push(t);
    for (const p of data.polys) {
      if (p.kind > 2) continue; // skirts, curbs, markings are drawn with the ground
      getST(p.tile % NT, Math.floor(p.tile / NT)).polys.push(p);
    }
    this.supers = [...byKey.values()];
    const cam = ctx.camera.position;
    this.supers.sort((a, b) => Math.hypot(a.cx - cam.x, a.cz - cam.z) - Math.hypot(b.cx - cam.x, b.cz - cam.z));

    // lamp map for night lighting of the ground
    const fr = data.objects.furniture;
    const lamps: Array<{ x: number; z: number; typ: number }> = [];
    for (let i = 0; i < fr.lights.length; i += 6) {
      const typ = fr.lights[i + 3];
      if (typ === 4) continue;
      // light source = luminaire head, overhanging the road
      const hd = LAMP_HEAD[typ] ?? [0, 9, -1.5];
      const [fx, fz] = headingToDir(fr.lights[i + 2]);
      lamps.push({ x: fr.lights[i] - fx * hd[2], z: fr.lights[i + 1] - fz * hd[2], typ: typ === 0 || typ === 3 ? 0 : 1 });
    }
    const lm = makeLampMap(lamps, H, 16);
    this.u.rsLamp.value = lm.tex;
    this.u.rsLampP.value.copy(lm.params);

    // build ground tiles progressively (nearest first); screenshots wait for all of them
    lap('lampmap');
    await this.buildTiles();
    lap('tiles');

    // secondary layers (each isolated so one failure never breaks the others)
    const safe = async (name: string, fn: () => Promise<void> | void) => {
      try { await fn(); } catch (e) { console.error(`[roads] ${name} failed`, e); }
    };
    await safe('rail', async () => { this.rail = new Rail(ctx, this); await this.rail.init(); });
    await safe('furniture', async () => { this.furniture = new Furniture(ctx, this); await this.furniture.init(); });
    await safe('power', async () => { this.power = new Power(ctx, this); await this.power.init(); });
    console.info(`[roads] ${this.supers.length} ground super-tiles, ~${Math.round(this.tris / 1000)}k triangles`);
  }

  /** Surface height at a polyline point: bridge deck of `group`, or the terrain. */
  surfaceY(x: number, z: number, group: number): number {
    if (group >= 0) return this.bridges.heightAt(group, x, z);
    return this.ground.height(x, z);
  }

  private async buildTiles(): Promise<void> {
    let t0 = performance.now();
    for (const st of this.supers) {
      try {
        const r = buildSuperTile(this.ctx, this.data, st.tiles, st.polys, this.ground, (x, z, g) => this.surfaceY(x, z, g), this.mats);
        st.ground = r.ground;
        st.marks = r.marks;
        this.tris += r.tris;
        if (st.ground) { st.ground.updateMatrix(); this.group.add(st.ground); }
        if (st.marks) { st.marks.updateMatrix(); this.group.add(st.marks); }
      } catch (e) {
        console.error('[roads] tile build failed', e);
      }
      st.built = true;
      // interactive: keep frames flowing; screenshot mode (SwiftShader): frames are very slow, build in bulk
      if (performance.now() - t0 > (this.ctx.settings.shot ? 4000 : 40)) {
        await new Promise((r) => setTimeout(r, 0));
        t0 = performance.now();
      }
    }
  }

  private provideService(): void {
    const g = this.graph;
    const self = this;
    const api = {
      graph: { nodes: g.nodes, edges: g.edges },
      nearest: (x: number, z: number, maxDist = 200) => g.nearest(x, z, maxDist),
      streetNames: () => g.names.slice(),
      isRoad: (x: number, z: number, margin = 0, includeFoot = true, includeRail = true) => g.isRoad(x, z, margin, includeFoot, includeRail),
      distanceToRoad: (x: number, z: number, maxDist = 50) => g.distanceToRoad(x, z, maxDist),
      /** Terrain (bicubic, as rendered) or deck height when (x,z) lies on bridge group `bridge`. */
      heightAt: (x: number, z: number, bridge = -1) => self.surfaceY(x, z, bridge),
      groundHeight: (x: number, z: number) => self.ground.height(x, z),
      bridges: () => self.bridges.list.filter(Boolean).map((b) => ({ id: b!.rec.id, name: b!.rec.name, kind: b!.rec.kind, axis: b!.rec.axis })),
      signals: this.data.objects.furniture.signals.map((s) => ({ x: s[0], z: s[1], heading: s[2], phase: s[3], node: s[4] })),
      /** 'green' | 'yellow' | 'red' for a signal phase group at time t (s, e.g. ctx.env.elapsed) */
      signalState: (phase: number, t: number) => signalState(phase, t),
      /** street lamps: flat [x, z, type] (type 0 LED, 1 sodium) for other modules' night lighting */
      lamps: () => { const f = this.data.objects.furniture.lights; const out: number[] = []; for (let i = 0; i < f.length; i += 6) if (f[i + 3] !== 4) out.push(f[i], f[i + 1], f[i + 3] === 0 || f[i + 3] === 3 ? 0 : 1); return out; },
      /** lamp grid texture (see materials.ts rsLamps) usable by other shaders */
      lampMap: { texture: this.u.rsLamp, params: this.u.rsLampP },
      uniforms: this.u,
    };
    this.ctx.provide('roads', api);
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const u = this.u;
    u.rsNight.value = ctx.env.night;
    u.rsTime.value = ctx.env.elapsed;
    u.rsCam.value.copy(ctx.camera.position);
    // wetness follows rain with a slow drying time
    const target = Math.min(1, ctx.env.rain * 1.5);
    const k = target > this.wet ? 0.5 : 0.03;
    this.wet += (target - this.wet) * Math.min(1, dt * k);
    if (ctx.settings.shot) this.wet = target;
    u.rsWet.value = this.wet;
    // distance culling of ground super-tiles
    const dd = ctx.settings.profile.drawDistance;
    const cam = ctx.camera.position;
    const agl = ctx.cameraAGL;
    const markFar = Math.min(dd, 1200 + agl * 2);
    for (const st of this.supers) {
      const d = Math.max(0, Math.hypot(st.cx - cam.x, st.cz - cam.z) - 1450);
      if (st.ground) st.ground.visible = d < dd;
      if (st.marks) st.marks.visible = d < markFar;
    }
    this.rail?.update(dt);
    this.furniture?.update(dt);
    this.power?.update(dt);
  }
}

let inst: Roads | null = null;

const mod: CityModule = {
  id: 'roads',
  async init(ctx) {
    inst = new Roads(ctx);
    await ctx.pending(inst.init());
  },
  update(dt) {
    inst?.update(dt);
  },
};
export default mod;
