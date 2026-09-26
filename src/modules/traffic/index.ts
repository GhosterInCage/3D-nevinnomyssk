// Traffic module: life in the city - moving cars, marshrutkas, buses and trucks on the road graph,
// parked cars, trains on the railway (+ wagons on sidings), pedestrians and birds.
// Provides the 'traffic' service. See docs/modules/traffic.md.
import * as THREE from 'three';
import type { AppContext, CityModule } from '../../core/context';
import { fetchJSON } from '../../core/data';
import { Net } from './net';
import { vehicleTypes, paletteColor } from './models';
import { FleetRenderer, basisMatrix } from './render';
import { createVehicleMaterial, createBeamMaterial, createPedMaterial, createBirdMaterial, createLightGlow, makeUniforms, type TrafficUniforms } from './materials';
import { Trains } from './trains';
import { Pedestrians } from './peds';
import { Birds } from './birds';
import { Vehicles, beamGeometry } from './vehicles';
import { Parked } from './parked';

class Traffic {
  u: TrafficUniforms = makeUniforms();
  net!: Net;
  vehicles: Vehicles | null = null;
  parked: Parked | null = null;
  trains: Trains | null = null;
  peds: Pedestrians | null = null;
  birds: Birds | null = null;
  root = new THREE.Group();
  meta: any = null;
  enabled = true;

  constructor(private ctx: AppContext) {
    this.root.name = 'traffic';
    ctx.scene.add(this.root);
    if (!ctx.settings.wants('sky')) {
      // isolated test (?only=traffic): minimal lighting so the module can be inspected
      const sun = new THREE.DirectionalLight(0xfff4e6, 3.0);
      const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4238, 1.1);
      ctx.scene.add(sun, sun.target, hemi);
      ctx.scene.background = new THREE.Color(0x9fb8d8);
      ctx.onUpdate(() => {
        sun.position.copy(ctx.camera.position).addScaledVector(ctx.env.sunDirection, 1000);
        sun.target.position.copy(ctx.camera.position);
        sun.intensity = 3 * (1 - ctx.env.night) + 0.02;
        hemi.intensity = 1.1 * (1 - ctx.env.night) + 0.04;
      });
    }
  }

  async init(): Promise<void> {
    const ctx = this.ctx;
    const safe = async (name: string, fn: () => Promise<void> | void) => {
      try { await fn(); } catch (e) { console.error(`[traffic] ${name} failed`, e); }
    };
    const t0 = performance.now();
    const laps: string[] = [];
    const lap = (w: string) => laps.push(`${w} ${Math.round(performance.now() - t0)}`);
    this.meta = await fetchJSON<any>('traffic/meta.json').catch(() => null);
    lap('meta');
    this.net = new Net(ctx);
    await this.net.load();
    lap('net');
    if (this.meta?.stops) this.net.attachStops(this.meta.stops.map((s: number[]) => [s[0], s[1]]));
    lap('stops');
    const types = vehicleTypes();
    lap('models');
    const mat = createVehicleMaterial(ctx, this.u, 'road');
    const q = ctx.settings.quality;
    const cap = q === 'low' ? 350 : q === 'medium' ? 900 : q === 'high' ? 1400 : 1800;
    await safe('vehicles', () => {
      const v = new Vehicles(ctx, this.net, types, mat, cap);
      this.root.add(v.renderer.group);
      const beams = new THREE.InstancedMesh(beamGeometry(260), createBeamMaterial(this.u), 260);
      beams.frustumCulled = false;
      beams.count = 0;
      beams.renderOrder = 2;
      beams.userData.noPathTrace = true;
      beams.name = 'traffic-beams';
      this.root.add(beams);
      v.beams = beams;
      v.glow = createLightGlow(this.u, cap * 4);
      this.root.add(v.glow);
      this.vehicles = v;
    });
    await safe('parked', async () => {
      const p = new Parked(ctx, this.net, types, mat);
      await p.load();
      this.root.add(p.renderer.group);
      this.parked = p;
    });
    lap('parked');
    await safe('trains', async () => {
      const t = new Trains(ctx, mat);
      await t.init();
      this.root.add(t.renderer.group, t.static.group);
      this.trains = t;
    });
    lap('trains');
    await safe('pedestrians', async () => {
      const pc = q === 'low' ? 120 : q === 'medium' ? 350 : 700;
      const p = new Pedestrians(ctx, this.net, createPedMaterial(ctx, this.u), pc, this.meta?.stops ?? []);
      await p.load();
      for (const m of p.meshes) this.root.add(m);
      this.peds = p;
    });
    await safe('birds', () => {
      const b = new Birds(ctx, createBirdMaterial(ctx));
      for (const m of b.meshes) this.root.add(m);
      this.birds = b;
    });
    lap('peds+birds');
    this.provide();
    console.info(`[traffic] network from ${this.net.source}: ${this.net.edges.length} edges, ${this.net.signals.size} signal approaches; ${types.length} vehicle types; ms: ${laps.join(', ')}`);
  }

  private provide(): void {
    const self = this;
    this.ctx.provide('traffic', {
      get vehicles() { return self.vehicles?.aliveCount ?? 0; },
      get parked() { return self.parked?.visible ?? 0; },
      get pedestrians() { return self.peds?.count ?? 0; },
      trains: () => self.trains?.summary() ?? '',
      /** debug: advance the road/rail simulation by `sec` seconds (steps of 0.1 s) without rendering */
      simulate: (sec: number) => {
        const t0 = performance.now();
        for (let t = 0; t < sec; t += 0.1) {
          self.ctx.env.elapsed += 0.1;
          self.vehicles?.update(0.1);
          self.trains?.update(0.1);
        }
        return Math.round(performance.now() - t0);
      },
      stuck: (w = 75) => self.vehicles?.stuckList(w) ?? '',
      stats: () => ({ ...(self.vehicles?.stats() ?? {}), parked: self.parked?.visible ?? 0, peds: self.peds?.count ?? 0, trains: self.trains?.trains.length ?? 0 }),
      nearestVehicle: (x: number, z: number) => self.vehicles?.nearest(x, z) ?? null,
      setEnabled: (on: boolean) => { self.enabled = on; self.root.visible = on; },
      /** hide parked cars inside a polygon ring [x0,z0,x1,z1,...] (e.g. a landmark footprint) */
      /** debug: a row of every vehicle type at (x,z) (heading deg), e.g. __city.ctx.get('traffic').showroom(0,0,90) */
      showroom: (x: number, z: number, heading = 90, spacing = 7, lod = 0) => self.showroom(x, z, heading, spacing, lod),
      /** debug: a row of pedestrians walking in place */
      pedShowcase: (x: number, z: number, heading = 180) => self.peds?.showcase(x, z, heading),
      clearInPolygon: (ring: number[]) => {
        const p = self.parked;
        if (!p) return;
        for (let i = 0; i < p.n; i++) if (pointInRing(ring, p.x[i], p.z[i])) p.hidden.add(i);
      },
    });
  }

  private show: FleetRenderer | null = null;
  showroom(x: number, z: number, heading: number, spacing: number, lod: number): string {
    const types = vehicleTypes();
    if (!this.show) {
      this.show = new FleetRenderer('traffic-showroom', { lods: types.map((t) => [t.lod0, t.lod1, t.lod2]) }, createVehicleMaterial(this.ctx, this.u, 'road'), types.map(() => [2, 2, 2]));
      this.root.add(this.show.group);
    }
    const h = (heading * Math.PI) / 180;
    const fx = Math.sin(h), fz = -Math.cos(h);
    const rx = 1, rz = 0;
    const m = new Float32Array(16);
    const c = new THREE.Color();
    this.show.begin();
    let off = -((types.length - 1) * spacing) / 2;
    types.forEach((t, i) => {
      const px = x + rx * off, pz = z + rz * off;
      const y = this.net.surfaceY(px, pz, -1);
      basisMatrix(m, 0, px, y, pz, fx, 0, fz);
      const metal = paletteColor(t.palette, (i * 0.37) % 1, c);
      this.show!.push(i, lod, m, 0, c.r, c.g, c.b, 0.3, i % 3 === 0 ? 1 : 0, metal, t.dirt * 0.5);
      off += spacing;
    });
    this.show.end();
    return types.map((t) => t.name + ':' + [t.lod0, t.lod1, t.lod2].map((g) => g.getAttribute('position').count / 3).join('/')).join(', ');
  }

  update(dt: number): void {
    if (!this.enabled) return;
    const ctx = this.ctx;
    this.u.tNight.value = ctx.env.night;
    this.u.tTime.value = ctx.env.elapsed;
    const safe = (name: string, fn: () => void) => { try { fn(); } catch (e) { console.error(`[traffic] ${name} update failed`, e); } };
    if (this.vehicles) safe('vehicles', () => this.vehicles!.update(dt));
    if (this.parked) safe('parked', () => this.parked!.update());
    if (this.trains) safe('trains', () => this.trains!.update(dt));
    if (this.peds) safe('peds', () => this.peds!.update(dt));
    if (this.birds) safe('birds', () => this.birds!.update(dt));
  }
}

function pointInRing(r: number[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

let inst: Traffic | null = null;

const mod: CityModule = {
  id: 'traffic',
  after: ['roads'],
  async init(ctx) {
    inst = new Traffic(ctx);
    await ctx.pending(inst.init());
  },
  update(dt) {
    inst?.update(dt);
  },
};
export default mod;
