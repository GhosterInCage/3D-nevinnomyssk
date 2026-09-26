// Landmarks module: hand-crafted procedural models of Nevinnomyssk's key landmarks, placed
// from public/data/landmarks/landmarks.json (pipeline/build_landmarks.py):
//   * Nevinnomysskaya GRES: 250 m red/white chimney, 1960 TEC chimney, main buildings (turbine
//     hall / deaerator / boiler bays), six open-air boilers, gas ducts, block transformers, tanks
//   * Nevinnomyssk Azot (EuroChem): ~160 m stack, prilling tower, process columns, isothermal
//     ammonia tanks, storage tanks, process equipment (from DSM/Sentinel-2), pipe racks
//   * Pokrovsky cathedral, St Seraphim of Sarov church and other churches / chapels
//   * Eternal Flame memorial with the obelisk "Вечная слава"
//   * Nevinnomysskaya railway station, Khimik stadium, canal headworks on the Kuban,
//     Kubanskaya GES-4, entrance signs of GRES and EuroChem
//   * Kochubeevskaya wind farm (animated rotors), telecom lattice masts
// Each landmark: main mesh (always) + detail mesh (distance culled), obstruction lights / glows,
// night floodlighting, colliders. Generic building extrusions underneath are hidden through the
// buildings service.
import * as THREE from 'three';
import type { AppContext, CityModule, StaticCollider } from '../../core/context';
import { fetchJSON } from '../../core/data';
import { Geo, P, F, col } from './builder';
import { createLmMaterial, makeLmUniforms, type LmUniforms } from './material';
import { Glows, makeFlame, updateFlame, Plumes, type GlowSpec } from './effects';
import { C, latticeMast, type Frame } from './structures';
import { buildGres, buildAzot, groundMax } from './industry';
import { buildChurch } from './church';
import { buildMemorial, buildStation, buildStand, floodMast, buildPitch, buildWeir, buildRegulator, buildPowerhouse, textTexture, buildFountain, buildArena } from './civic';
import { WindFarm, type Turbine } from './wind';

interface Item {
  name: string;
  x: number; z: number; r: number;      // bounding circle (world)
  main: THREE.Object3D[];
  detail: THREE.Object3D[];
  detailRange: number;                  // extra range for the detail layer
  mainRange?: number;                   // limit for the main layer (default: far)
}

const DETAIL_RANGE: Record<string, number> = { low: 350, medium: 650, high: 1000, ultra: 1500 };

class Landmarks {
  readonly group = new THREE.Group();
  readonly u: LmUniforms = makeLmUniforms();
  mat!: THREE.MeshStandardMaterial;
  items: Item[] = [];
  glowSpecs: GlowSpec[] = [];
  glows: Glows | null = null;
  colliders: StaticCollider[] = [];
  flames: THREE.Group[] = [];
  plumes: Plumes | null = null;
  wind: WindFarm | null = null;
  hideIds: string[] = [];
  hidePolys: number[][] = [];
  clearPolys: number[][] = [];
  data: any = null;
  private grid = new Map<string, StaticCollider[]>();
  private lastCam = new THREE.Vector3(Infinity, 0, 0);

  constructor(private ctx: AppContext) {
    this.group.name = 'landmarks';
  }

  ground = (x: number, z: number): number => {
    const t = this.ctx.get<any>('terrain');
    try {
      if (t && typeof t.heightAt === 'function') {
        const h = t.heightAt(x, z);
        if (Number.isFinite(h)) return h;
      }
    } catch { /* fall back */ }
    return this.ctx.heightfield.sample(x, z);
  };

  frame(key: string, ox: number, oz: number): Frame {
    return { ox, oy: this.ground(ox, oz), oz, ground: this.ground, glows: this.glowSpecs, colliders: this.colliders, key };
  }

  private mesh(g: Geo, fr: Frame, name: string, shadow = true): THREE.Mesh | null {
    if (g.triangleCount === 0) return null;
    const m = new THREE.Mesh(g.build(), this.mat);
    m.position.set(fr.ox, fr.oy, fr.oz);
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.name = name;
    m.updateMatrix();
    m.matrixAutoUpdate = false;
    this.group.add(m);
    return m;
  }

  private add(name: string, fr: Frame, main: Geo, detail: Geo | null, r: number, cx = fr.ox, cz = fr.oz, detailRange = 0): Item {
    const it: Item = { name, x: cx, z: cz, r, main: [], detail: [], detailRange };
    const a = this.mesh(main, fr, `${name}:main`);
    if (a) it.main.push(a);
    if (detail) {
      const b = this.mesh(detail, fr, `${name}:detail`);
      if (b) it.detail.push(b);
    }
    this.items.push(it);
    return it;
  }

  /** ?only=landmarks: nobody else lights the scene -> a simple sun + sky light following env. */
  private standaloneLights(): void {
    const ctx = this.ctx;
    if (ctx.settings.wants('sky') || ctx.settings.wants('terrain') || ctx.settings.wants('buildings')) return;
    const sun = new THREE.DirectionalLight(0xfff1dd, 3);
    const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x5a5044, 1);
    ctx.scene.add(sun, sun.target, hemi);
    const bg = new THREE.Color(0x9fb9d8), bgNight = new THREE.Color(0x05070c);
    ctx.scene.background = bg.clone();
    ctx.onUpdate(() => {
      (ctx.scene.background as THREE.Color).copy(bg).lerp(bgNight, ctx.env.night);
      const d = ctx.env.sunDirection;
      sun.position.copy(ctx.camera.position).addScaledVector(d, 3000);
      sun.target.position.copy(ctx.camera.position);
      sun.intensity = 3 * Math.max(0, d.y) ** 0.4;
      hemi.intensity = 0.2 + 0.9 * Math.max(0, d.y) ** 0.5;
    });
  }

  async init(): Promise<void> {
    const ctx = this.ctx;
    this.standaloneLights();
    const T0 = performance.now();
    const mark = (w: string) => { if (ctx.settings.debug || ctx.settings.shot) console.info(`[landmarks] ${w} @${Math.round(performance.now() - T0)} ms`); };
    ctx.scene.add(this.group);
    // noise texture (tileable, linear data) and placement data load in parallel; the texture is
    // not needed to build geometry, so only the data is awaited before building
    const white = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1);
    white.needsUpdate = true;
    this.u.lmNoise.value = white;
    const texP = new Promise<void>((res) => {
      new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}textures/landmarks/noise.png`, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.NoColorSpace;
        t.anisotropy = 4;
        t.needsUpdate = true;
        this.u.lmNoise.value = t;
        if (this.plumes) this.plumes.material.uniforms.uNoise.value = t;
        res();
      }, undefined, () => { console.warn('[landmarks] noise texture missing'); res(); });
    });
    ctx.pending(texP);
    this.mat = ctx.registerMaterial(createLmMaterial(this.u, { name: 'landmarks' }));
    this.data = await fetchJSON<any>('landmarks/landmarks.json');
    mark('data');
    const D = this.data;
    const step = async (name: string, fn: () => void) => {
      const t0 = performance.now();
      try { fn(); } catch (e) { console.error(`[landmarks] ${name} failed`, e); }
      const ms = performance.now() - t0;
      if (ms > 200) console.info(`[landmarks] ${name} built in ${Math.round(ms)} ms`);
      // yield between landmarks in interactive mode (in screenshot mode every frame is expensive)
      if (!ctx.settings.shot) await new Promise((r) => setTimeout(r, 0));
    };
    await step('gres', () => this.buildGres(D.gres));
    await step('azot', () => this.buildAzot(D.azot));
    await step('churches', () => this.buildChurches(D.churches));
    await step('memorial', () => this.buildMemorial(D.memorial));
    await step('station', () => this.buildStation(D.station));
    await step('stadium', () => this.buildStadium(D.stadium));
    await step('weir', () => this.buildWeir(D.weir));
    await step('ges4', () => this.buildGes4(D.ges4));
    await step('signs', () => this.buildSigns(D.signs));
    await step('fountains', () => this.buildFountains(D.fountains));
    await step('arena', () => this.buildArena(D.arena));
    await step('masts', () => this.buildMasts(D.masts));
    await step('wind', () => this.buildWind(D.turbines));
    await step('plumes', () => this.buildPlumes());
    mark('built');
    // glows
    if (this.glowSpecs.length) {
      this.glows = new Glows(this.glowSpecs);
      this.group.add(this.glows.points);
    }
    // colliders
    for (const c of this.colliders) {
      const p = c.kind === 'box' || c.kind === 'cylinder' ? c.center : [0, 0, 0];
      const k = `${Math.floor(p[0] / 128)},${Math.floor(p[2] / 128)}`;
      let l = this.grid.get(k);
      if (!l) { l = []; this.grid.set(k, l); }
      l.push(c);
    }
    ctx.registerColliders({ id: 'landmarks', query: (x, z, r) => this.queryColliders(x, z, r) });
    // hide generic extrusions under the landmarks; clear vegetation on paved plots
    this.hideBuildings();
    this.clearVegetation();
    ctx.provide('landmarks', {
      list: () => this.items.map((i) => ({ name: i.name, x: i.x, z: i.z })),
      group: this.group,
    });
    this.updateVisibility(true);
    let tris = 0;
    this.group.traverse((o: any) => { if (o.isMesh && o.geometry?.index) tris += (o.geometry.index.count / 3) * (o.isInstancedMesh ? o.count : 1); });
    console.info(`[landmarks] ${this.items.length} landmarks, ${this.glowSpecs.length} lights, ${this.colliders.length} colliders, ${Math.round(tris / 1000)}k triangles`);
    (window as any).__landmarks = this;
  }

  // ---------------------------------------------------------------------------------- builders
  private buildGres(d: any): void {
    if (!d) return;
    const fr = this.frame('gres', d.main.x, d.main.z);
    const main = new Geo(), det = new Geo();
    buildGres(d, fr, main, det);
    this.add('Невинномысская ГРЭС', fr, main, det, 450, d.main.x, d.main.z - 100, 400);
    this.hideIds.push(...d.hide);
    this.clearPolys.push(d.main.ring, d.tec.ring);
    // the open-air boiler row, ducts and collector stand outside the main-building footprint:
    // remove any generic extrusions there as well
    {
      const M = d.main, side = M.boilerSide, cs = Math.cos(M.rot), sn = Math.sin(M.rot);
      const ring: number[] = [];
      for (const [a, sl] of [[-M.len / 2 - 4, M.wid / 2 + 1], [M.len / 2 + 4, M.wid / 2 + 1], [M.len / 2 + 4, M.wid / 2 + 34], [-M.len / 2 - 4, M.wid / 2 + 34]]) {
        ring.push(M.x + a * cs + sl * side * sn, M.z - a * sn + sl * side * cs);
      }
      this.hidePolys.push(ring);
      this.clearPolys.push(ring);
    }
  }

  private buildAzot(d: any): void {
    if (!d) return;
    // origin: first stack (tall items live in the global main mesh); cells & racks in 400 m tiles
    const s0 = d.stacks[0] ?? { x: 600, z: -2500 };
    const fr = this.frame('azot', s0.x, s0.z);
    const main = new Geo(), det = new Geo();
    const TILE = 400;
    const tiles = new Map<string, { main: Geo; detail: Geo; cx: number; cz: number }>();
    const tileOf = (x: number, z: number) => {
      const i = Math.floor(x / TILE), j = Math.floor(z / TILE);
      const k = `${i},${j}`;
      let t = tiles.get(k);
      if (!t) { t = { main: new Geo(), detail: new Geo(), cx: (i + 0.5) * TILE, cz: (j + 0.5) * TILE }; tiles.set(k, t); }
      return t;
    };
    buildAzot(d, fr, main, det, tileOf);
    this.add('Невинномысский Азот', fr, main, det, 300, s0.x, s0.z, 300);
    for (const [k, t] of tiles) this.add(`Азот ${k}`, fr, t.main, t.detail, TILE * 0.75, t.cx, t.cz, 0).mainRange = 5000;
    this.hideIds.push(...d.hide);
  }

  private buildChurches(list: any[]): void {
    for (const c of list ?? []) {
      const fr = this.frame('church', c.x, c.z);
      const g = new Geo();
      const y0 = groundMax(fr, c.ring) - fr.oy;
      g.at(0, y0 - 0.2, 0, c.rot);
      const boxes = buildChurch(g, c);
      g.pop();
      for (const b of boxes) {
        const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
        this.colliders.push({ kind: 'box', key: `lm:church:${this.colliders.length}`, center: [c.x + b.x * cs, fr.oy + y0 + b.h / 2, c.z - b.x * sn], halfExtents: [b.sx / 2, b.h / 2, b.sz / 2], rotationY: c.rot });
      }
      this.add(c.name, fr, g, null, Math.max(c.len, c.bell || 0) + 10);
      this.hideIds.push(...c.hide);
      // plot around the church: no trees on the building itself
      this.clearPolys.push(c.ring);
    }
  }

  private buildMemorial(m: any): void {
    if (!m) return;
    const fr = this.frame('memorial', m.x, m.z);
    const g = new Geo(), d = new Geo();
    const cs = Math.cos(m.rot), sn = Math.sin(m.rot);
    // local (lx, lz) -> world: x = ox + lx*cos + lz*sin, z = oz - lx*sin + lz*cos
    const groundAt = (lx: number, lz: number) => this.ground(m.x + lx * cs + lz * sn, m.z - lx * sn + lz * cs) - fr.oy;
    g.at(0, 0, 0, m.rot); d.at(0, 0, 0, m.rot);
    const flame = buildMemorial({ ...fr, ox: fr.ox, oy: fr.oy, oz: fr.oz }, g, d, m.obeliskH ?? 17, groundAt);
    g.pop(); d.pop();
    this.add('Вечный огонь', fr, g, d, 30);
    // flame (world)
    const fx = m.x + flame[0] * cs + flame[2] * sn, fz = m.z - flame[0] * sn + flame[2] * cs;
    const fl = makeFlame(1.25, 0.8, 3);
    fl.position.set(fx, fr.oy + flame[1], fz);
    this.group.add(fl);
    this.flames.push(fl);
    this.glowSpecs.push({ x: fx, y: fr.oy + flame[1] + 0.4, z: fz, color: new THREE.Color(2.2, 0.9, 0.25), size: 2.6, day: 0.35 });
    // paved square: no trees, no bushes
    const ring: number[] = [];
    for (const [lx, lz] of [[-16, -10], [16, -10], [16, 10], [-16, 10]]) ring.push(m.x + lx * cs + lz * sn, m.z - lx * sn + lz * cs);
    this.clearPolys.push(ring);
  }

  private buildStation(s: any): void {
    if (!s) return;
    const fr = this.frame('station', s.x, s.z);
    const g = new Geo(), d = new Geo();
    const y0 = groundMax(fr, s.ring) - fr.oy - 0.2;
    g.at(0, 0, 0, s.rot); d.at(0, 0, 0, s.rot);
    buildStation(g, d, s.len, s.wid, s.front, y0);
    g.pop(); d.pop();
    this.add('Вокзал Невинномысская', fr, g, d, 45);
    this.hideIds.push(...s.hide);
    this.colliders.push({ kind: 'box', key: 'lm:station', center: [s.x, fr.oy + y0 + 6, s.z], halfExtents: [s.len / 2, 6, s.wid / 2 + 1], rotationY: s.rot });
    // name on the attic of the central block
    const tex = textTexture('НЕВИННОМЫССК', '#6e1d14', 2048, 256, 'bold 190px serif');
    if (tex) {
      const m = this.ctx.registerMaterial(new THREE.MeshStandardMaterial({ map: tex, transparent: false, alphaTest: 0.4, roughness: 0.5, metalness: 0.3, color: 0xffffff, emissive: new THREE.Color(0.9, 0.85, 0.7), emissiveMap: tex, emissiveIntensity: 0 }));
      (m.userData as any).nightEmissive = 0.6;
      this.nightSignMats.push(m);
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(15, 1.9), m);
      const zf = s.front * (s.wid / 2 + 1.42);
      const cs = Math.cos(s.rot), sn = Math.sin(s.rot);
      pl.position.set(s.x + zf * sn, fr.oy + y0 + 14.5 + 0.8, s.z + zf * cs);
      pl.rotation.y = s.rot + (s.front > 0 ? 0 : Math.PI);
      this.group.add(pl);
      this.items[this.items.length - 1].detail.push(pl);
    }
  }
  nightSignMats: THREE.MeshStandardMaterial[] = [];

  private buildStadium(s: any): void {
    if (!s) return;
    const fr = this.frame('stadium', s.x, s.z);
    const g = new Geo(), d = new Geo();
    const cs = Math.cos(s.rot), sn = Math.sin(s.rot);
    const groundAt = (lx: number, lz: number) => this.ground(s.x + lx * cs + lz * sn, s.z - lx * sn + lz * cs) - fr.oy;
    g.at(0, 0, 0, s.rot);
    buildPitch(g, groundAt);
    g.pop();
    // west stand: seats face the pitch centre
    const st = s.stand;
    const lx = st.x - s.x, lz = st.z - s.z;
    const scs = Math.cos(st.rot), ssn = Math.sin(st.rot);
    // local +Z of the stand in world = (sin, cos); back = side away from the pitch centre
    const back = (-lx * ssn + -lz * scs) > 0 ? -1 : 1;
    const y0 = this.ground(st.x, st.z) - fr.oy;
    g.at(lx, 0, lz, st.rot); d.at(lx, 0, lz, st.rot);
    buildStand(g, d, st.len, st.wid, back, y0);
    g.pop(); d.pop();
    this.colliders.push({ kind: 'box', key: 'lm:stand', center: [st.x, fr.oy + y0 + 4, st.z], halfExtents: [st.len / 2, 4, st.wid / 2], rotationY: st.rot });
    // four floodlight masts at the corners of the track
    for (const [ax, az] of [[-70, -48], [70, -48], [70, 48], [-70, 48]]) {
      const wx = ax * cs + az * sn, wz = -ax * sn + az * cs;
      const dir = Math.atan2(-wz, -wx);
      floodMast(fr, g, d, wx, this.ground(s.x + wx, s.z + wz) - fr.oy, wz, 34, dir);
    }
    this.add('Стадион «Химик»', fr, g, d, 110);
    this.hideIds.push(...s.hide);
    const ring: number[] = [];
    for (const [ax, az] of [[-90, -52], [90, -52], [90, 52], [-90, 52]]) ring.push(s.x + ax * cs + az * sn, s.z - ax * sn + az * cs);
    this.clearPolys.push(ring);
  }

  private buildWeir(w: any): void {
    if (!w || !w.line) return;
    const ox = w.line[0][0], oz = w.line[0][1];
    const fr = this.frame('weir', ox, oz);
    fr.oy = w.down - 1;
    const g = new Geo(), d = new Geo();
    buildWeir(fr, g, d, w.line.map((p: number[]) => [p[0] - ox, p[1] - oz]), w.up, w.down);
    if (w.canal) {
      // regulator ~20 m into the canal
      const cx = w.canal.x - Math.cos(w.canal.dir) * 20 - ox, cz = w.canal.z - Math.sin(w.canal.dir) * 20 - oz;
      buildRegulator(fr, g, d, cx, cz, w.canal.dir, w.up - 0.3, 30);
    }
    this.add('Головное сооружение Невинномысского канала', fr, g, d, 140, ox - 30, oz + 70);
  }

  private buildGes4(s: any): void {
    if (!s) return;
    const fr = this.frame('ges4', s.x, s.z);
    const g = new Geo(), d = new Geo();
    const y0 = groundMax(fr, s.ring) - fr.oy;
    g.at(0, 0, 0, s.rot); d.at(0, 0, 0, s.rot);
    buildPowerhouse(g, d, s.len, s.wid, y0);
    g.pop(); d.pop();
    this.add('Кубанская ГЭС-4', fr, g, d, 60);
    this.hideIds.push(...s.hide);
    this.colliders.push({ kind: 'box', key: 'lm:ges4', center: [s.x, fr.oy + y0 + 8, s.z], halfExtents: [s.len / 2, 9, s.wid / 2], rotationY: s.rot });
  }

  private buildSigns(list: any[]): void {
    for (const s of list ?? []) {
      const fr = this.frame('sign', s.x, s.z);
      const g = new Geo();
      const text = s.text === 'Еврохим' ? 'ЕВРОХИМ' : s.text;
      const L = text.length * 1.9 + 1.6;
      g.at(0, 0, 0, s.rot);
      g.paint(col('#8f8b84'), P.CONCRETE, 0.9);
      g.box(-L / 2, -1, -0.8, L / 2, 1.2, 0.8);
      g.paint(col('#b7b3aa'), P.STONE, 0.8, 0, F.FLOOD);
      g.box(-L / 2 + 0.3, 1.2, -0.4, L / 2 - 0.3, 1.5, 0.4);
      g.pop();
      this.add(`Знак ${s.text}`, fr, g, null, L);
      const color = s.text === 'ГРЭС' ? '#d23b2a' : '#1d5aa8';
      const tex = textTexture(text, color, 1024, 256, 'bold 200px sans-serif', true);
      if (!tex) continue;
      const m = this.ctx.registerMaterial(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.FrontSide, roughness: 0.4, metalness: 0.2, emissive: new THREE.Color(color), emissiveMap: tex, emissiveIntensity: 0 }));
      (m.userData as any).nightEmissive = 1.2;
      this.nightSignMats.push(m);
      const ph = (L - 1) / 4;
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(L - 1, ph), m);
      pl.position.set(s.x, fr.oy + 1.5 + ph * 0.5 - ph * 0.19, s.z);
      pl.rotation.y = s.rot;
      pl.castShadow = true;
      // back face: same letters, readable from behind (not mirrored)
      const back = pl.clone();
      back.rotation.y = s.rot + Math.PI;
      back.position.x -= Math.sin(s.rot) * 0.05;
      back.position.z -= Math.cos(s.rot) * 0.05;
      this.group.add(pl, back);
      this.items[this.items.length - 1].main.push(pl, back);
    }
  }

  private buildFountains(list: number[][]): void {
    for (const [x, z] of list ?? []) {
      const fr = this.frame('fountain', x, z);
      const g = new Geo();
      const r = 6;
      buildFountain(g, 0.1, r);
      this.add('Фонтан', fr, g, null, r + 2);
      this.colliders.push({ kind: 'cylinder', key: `lm:fountain:${x}`, center: [x, fr.oy + 0.4, z], radius: r + 0.5, halfHeight: 0.8 });
      const ring: number[] = [];
      for (let i = 0; i < 12; i++) ring.push(x + Math.cos((i / 12) * Math.PI * 2) * (r + 1), z + Math.sin((i / 12) * Math.PI * 2) * (r + 1));
      this.clearPolys.push(ring);
    }
  }

  private buildArena(a: any): void {
    if (!a) return;
    const fr = this.frame('arena', a.x, a.z);
    const g = new Geo(), d = new Geo();
    const y0 = groundMax(fr, a.ring) - fr.oy - 0.3;
    g.at(0, 0, 0, a.rot); d.at(0, 0, 0, a.rot);
    buildArena(g, d, a.len, a.wid, y0);
    g.pop(); d.pop();
    this.add(a.name, fr, g, d, Math.max(a.len, a.wid));
    this.hideIds.push(...a.hide);
    this.colliders.push({ kind: 'box', key: 'lm:arena', center: [a.x, fr.oy + y0 + 8, a.z], halfExtents: [a.len / 2, 8, a.wid / 2], rotationY: a.rot });
  }

  private buildMasts(list: number[][]): void {
    const lim = this.ctx.heightfield.half - 40;
    list = (list ?? []).filter((m) => Math.abs(m[0]) < lim && Math.abs(m[1]) < lim);
    if (!list.length) return;
    // one frame per mast (masts are far apart)
    list.forEach((m, i) => {
      const fr = this.frame('mast', m[0], m[1]);
      const g = new Geo(), d = new Geo();
      const h = m[2] > 0 ? m[2] : 36 + ((i * 7919) % 5) * 3;
      latticeMast(fr, g, d, 0, 0, h, 77 + i);
      this.add(`Мачта связи ${i + 1}`, fr, g, d, h, m[0], m[1], 200);
    });
  }

  private buildWind(list: number[][]): void {
    const lim = this.ctx.heightfield.half - 60;
    const ts: Turbine[] = (list ?? []).filter((t) => Math.abs(t[0]) < lim && Math.abs(t[1]) < lim).map((t, i) => ({
      x: t[0], z: t[1], y: this.ground(t[0], t[1]) - 0.2, phase: (i * 2.39996) % (Math.PI * 2), speed: 0.92 + ((i * 37) % 17) / 100,
    }));
    if (!ts.length) return;
    this.wind = new WindFarm(ts, this.mat);
    this.group.add(this.wind.group);
    this.glowSpecs.push(...this.wind.glows());
    for (const t of ts) this.colliders.push({ kind: 'cylinder', key: `lm:wt:${t.x}:${t.z}`, center: [t.x, t.y + 50, t.z], radius: 2.1, halfHeight: 50 });
  }

  private buildPlumes(): void {
    const D = this.data;
    const stacks: Array<{ x: number; y: number; z: number; strength: number; size: number }> = [];
    const winter = this.ctx.env.month <= 3 || this.ctx.env.month >= 11;
    // gas-fired GRES: flue gas is nearly invisible in summer, condenses into a white plume in the cold
    const k = winter ? 1.0 : 0.4;
    for (const s of D.gres?.stacks ?? []) stacks.push({ x: s.x, y: this.ground(s.x, s.z) + s.h + 1.5, z: s.z, strength: 0.6 * k, size: s.r1 * 1.3 });
    for (const s of D.azot?.stacks ?? []) stacks.push({ x: s.x, y: this.ground(s.x, s.z) + s.h + 1.5, z: s.z, strength: winter ? 0.9 : 0.65, size: s.r1 * 1.4 });
    for (const p of D.azot?.prill ?? []) stacks.push({ x: p.x, y: this.ground(p.x, p.z) + p.h + 6, z: p.z, strength: winter ? 0.9 : 0.7, size: 6 });
    if (!stacks.length) return;
    this.plumes = new Plumes(stacks, this.u.lmNoise.value, 96);
    this.group.add(this.plumes.mesh);
  }

  // ---------------------------------------------------------------------------------- services
  private hideBuildings(): void {
    const ids = [...new Set(this.hideIds)];
    if ((!ids.length && !this.hidePolys.length) || !this.ctx.settings.wants('buildings')) return;
    const timeout = new Promise<void>((r) => setTimeout(r, 90000));
    const p = this.ctx.need<any>('buildings').then(async (b) => {
      try {
        let m = 0;
        for (const r of this.hidePolys) m += b.hideInPolygon(r) || 0;
        const n = await b.hideById(ids);
        console.info(`[landmarks] hid ${n} generic buildings by id, ${m} in landmark plots`);
      } catch (e) { console.warn('[landmarks] hiding buildings failed', e); }
    });
    this.ctx.pending(Promise.race([p, timeout]));
  }

  private clearVegetation(): void {
    if (!this.clearPolys.length || !this.ctx.settings.wants('vegetation')) return;
    const timeout = new Promise<void>((r) => setTimeout(r, 90000));
    const p = this.ctx.need<any>('vegetation').then((v) => {
      try { for (const r of this.clearPolys) if (r && r.length >= 6) v.clearInPolygon(r); } catch (e) { console.warn('[landmarks] clearInPolygon failed', e); }
    });
    this.ctx.pending(Promise.race([p, timeout]));
  }

  private queryColliders(x: number, z: number, r: number): StaticCollider[] {
    const out: StaticCollider[] = [];
    const R = r + 260;
    const i0 = Math.floor((x - R) / 128), i1 = Math.floor((x + R) / 128);
    const j0 = Math.floor((z - R) / 128), j1 = Math.floor((z + R) / 128);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.grid.get(`${i},${j}`);
      if (!l) continue;
      for (const c of l) {
        const p = (c as any).center as number[];
        const ext = c.kind === 'box' ? Math.hypot(c.halfExtents[0], c.halfExtents[2]) : c.kind === 'cylinder' ? c.radius : 0;
        if (Math.hypot(p[0] - x, p[2] - z) <= r + ext) out.push(c);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------- per frame
  updateVisibility(force = false): void {
    const cam = this.ctx.camera.position;
    if (!force && cam.distanceToSquared(this.lastCam) < 25) return;
    this.lastCam.copy(cam);
    const prof = this.ctx.settings.profile;
    const dr = DETAIL_RANGE[this.ctx.settings.quality] ?? 650;
    const far = Math.max(prof.drawDistance * 1.6, 16000);
    const agl = Math.max(0, this.ctx.cameraAGL);
    for (const it of this.items) {
      const d = Math.hypot(it.x - cam.x, it.z - cam.z);
      const vis = d < (it.mainRange ?? far) + it.r;
      for (const o of it.main) o.visible = vis;
      const dv = d < dr + it.r + it.detailRange + agl * 0.5;
      for (const o of it.detail) o.visible = vis && dv;
    }
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const env = ctx.env;
    this.u.lmNight.value = env.night;
    this.u.lmTime.value = env.elapsed;
    this.u.lmLitFrac.value = 0.25 + 0.2 * env.night;
    this.updateVisibility();
    const sky = ctx.get<any>('sky');
    const exposure = sky && Number.isFinite(sky.exposure) ? sky.exposure : ctx.renderer.toneMappingExposure || 1;
    if (this.glows) this.glows.update(env.night, env.elapsed, ctx.camera, ctx.height * ctx.pixelRatio, exposure);
    for (const f of this.flames) updateFlame(f, env.elapsed, exposure);
    if (this.wind) this.wind.update(dt, env.wind);
    if (this.plumes) this.plumes.update(env.elapsed, env.wind, env.sunDirection, env.sunColor, env.sunIntensity, env.night);
    for (const m of this.nightSignMats) m.emissiveIntensity = env.night * ((m.userData as any).nightEmissive ?? 0.5);
  }
}

const mod: CityModule & { inst?: Landmarks } = {
  id: 'landmarks',
  after: ['terrain'],
  async init(ctx: AppContext) {
    const lm = new Landmarks(ctx);
    mod.inst = lm;
    await ctx.pending(lm.init());
  },
  update(dt) {
    const lm = mod.inst;
    if (!lm || !lm.mat) return;
    try { lm.update(dt); } catch (e) { console.error('[landmarks] update', e); }
  },
};
export default mod;
void C;
