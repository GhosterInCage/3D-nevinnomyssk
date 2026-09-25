// Street furniture: street lights (+ night glow), distribution poles with overhead SIP cables,
// traffic signals (animated two-phase plans), bus stop shelters, road signs, benches, fences,
// concrete walls and guard rails.
import * as THREE from 'three';
import type { AppContext, StaticCollider } from '../../core/context';
import { InstanceSet, PointGrid, rotForHeading, type Item } from './instancing';
import {
  LAMP_HEAD, POLE_WIRE_Y, bench, distPole, lampBridge, lampHPS, lampLED, makeSignAtlas, shelterFrame, shelterGlass,
  shelterSoviet, signPlate, signPole, trafficSignal,
} from './models';
import { createGlowPoints, createPropMaterial, type PropUniforms } from './props';
import { WireBuilder, createWireMaterial, updateWireUniforms } from './wires';
import { signalState } from './service';
import { MeshBuilder, SurfaceBuilder, densify, headingToDir } from './geom';
import { S } from './materials';
import { box } from './bridges';

interface RoadsHost {
  data: import('./data').RoadsData;
  ground: import('./ground').Ground;
  surfaceY(x: number, z: number, group: number): number;
  mats: { struct: THREE.Material };
  group: THREE.Group;
}

interface ColliderPt { x: number; z: number; col: StaticCollider }

export class Furniture {
  private sets: InstanceSet[] = [];
  private signalSet: InstanceSet | null = null;
  private signalState: THREE.InstancedBufferAttribute | null = null;
  private signalPhase: number[] = [];
  readonly u: PropUniforms = { pNight: { value: 0 } };
  private wireTiles: Array<{ cx: number; cz: number; mesh: THREE.Mesh }> = [];
  private grid = new PointGrid<ColliderPt>(64);
  private root = new THREE.Group();
  private frame = 0;

  constructor(private ctx: AppContext, private roads: RoadsHost) {
    this.root.name = 'roads-furniture';
  }

  async init(): Promise<void> {
    const ctx = this.ctx;
    const f = this.roads.data.objects.furniture;
    const g = this.roads.ground;
    ctx.scene.add(this.root);

    const lampLEDMat = createPropMaterial(ctx, this.u, { key: 'lamp-led', metal: 0.5, rough: 0.45, emitColor: new THREE.Color(1.0, 0.93, 0.82), emitNight: 40 });
    const lampHPSMat = createPropMaterial(ctx, this.u, { key: 'lamp-hps', metal: 0.2, rough: 0.6, emitColor: new THREE.Color(1.0, 0.58, 0.22), emitNight: 40 });
    const propMat = createPropMaterial(ctx, this.u, { key: 'prop', metal: 0.3, rough: 0.6 });

    // ------------------------------------------------------------ street lights / poles
    const byType: Item[][] = [[], [], [], [], []];
    const glowP: number[] = [], glowC: number[] = [];
    const L = f.lights;
    const polePos: Array<[number, number, number, number]> = []; // x, y, z, heading
    for (let i = 0; i < L.length; i += 6) {
      const x = L[i], z = L[i + 1], h = L[i + 2], typ = L[i + 3], grp = L[i + 4];
      const y = grp >= 0 ? this.roads.surfaceY(x, z, grp) : g.height(x, z);
      byType[typ]?.push({ x, y, z, rot: rotForHeading(h) });
      polePos.push([x, y, z, h]);
      if (typ !== 4) {
        const hd = LAMP_HEAD[typ] ?? [0, 9, -1.5];
        const [fx, fz] = headingToDir(h);
        glowP.push(x + fx * -hd[2], y + hd[1] - 0.1, z + fz * -hd[2]);
        if (typ === 0 || typ === 3) glowC.push(1.0, 0.92, 0.8); else glowC.push(1.0, 0.55, 0.2);
      }
      this.grid.add({ x, z, col: { kind: 'cylinder', key: `roads-lamp-${i / 6}`, center: [x, y + 4.5, z], radius: 0.16, halfHeight: 4.5 } });
    }
    const geos = [lampLED(), lampHPS(), distPole(true), lampBridge(), distPole(false)];
    const mats = [lampLEDMat, lampHPSMat, lampHPSMat, lampLEDMat, lampHPSMat];
    const ranges = [1100, 1100, 750, 1100, 750];
    for (let t = 0; t < 5; t++) {
      if (!byType[t].length) continue;
      const s = new InstanceSet(geos[t], mats[t], byType[t], ranges[t], 3000);
      s.mesh.castShadow = true;
      s.mesh.receiveShadow = true;
      s.mesh.name = `roads-lamps-${t}`;
      this.sets.push(s);
      this.root.add(s.mesh);
    }
    if (glowP.length) this.root.add(createGlowPoints(new Float32Array(glowP), new Float32Array(glowC), this.u));

    // ------------------------------------------------------------ overhead SIP cables along pole chains
    const wireMat = createWireMaterial(ctx, 0x111213, 0.1, 0.6);
    const wb = new Map<number, { w: WireBuilder; cx: number; cz: number }>();
    const T = 2048, H = this.roads.data.meta.half;
    const tileOf = (x: number, z: number) => {
      const i = Math.floor((x + H) / T), j = Math.floor((z + H) / T);
      const k = j * 64 + i;
      let e = wb.get(k);
      if (!e) { e = { w: new WireBuilder(), cx: -H + (i + 0.5) * T, cz: -H + (j + 0.5) * T }; wb.set(k, e); }
      return e.w;
    };
    for (const ch of f.chains) {
      for (let k = 0; k + 1 < ch.length; k++) {
        const a = polePos[ch[k]], b = polePos[ch[k + 1]];
        if (!a || !b) continue;
        const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
        if (d > 70 || d < 3) continue;
        const w = tileOf((a[0] + b[0]) / 2, (a[2] + b[2]) / 2);
        const [fa, fza] = headingToDir(a[3]);
        const [fb, fzb] = headingToDir(b[3]);
        // SIP bundle (thick) + an older bare neutral above
        w.span(a[0] + fa * 0.15, a[1] + POLE_WIRE_Y - 0.1, a[2] + fza * 0.15, b[0] + fb * 0.15, b[1] + POLE_WIRE_Y - 0.1, b[2] + fzb * 0.15, 0.012 * d + 0.1, 0.016);
        w.span(a[0] - fa * 0.22, a[1] + 9.3, a[2] - fza * 0.22, b[0] - fb * 0.22, b[1] + 9.3, b[2] - fzb * 0.22, 0.01 * d + 0.1, 0.005);
      }
    }
    for (const e of wb.values()) {
      const geo = e.w.build();
      if (!geo) continue;
      const m = new THREE.Mesh(geo, wireMat);
      m.renderOrder = 2;
      m.name = 'roads-sip-wires';
      m.userData.noPathTrace = true;
      this.root.add(m);
      this.wireTiles.push({ cx: e.cx, cz: e.cz, mesh: m });
    }

    // ------------------------------------------------------------ traffic signals
    if (f.signals.length) {
      const items: Item[] = [];
      for (const s of f.signals) {
        const y = g.height(s[0], s[1]);
        items.push({ x: s[0], y, z: s[1], rot: rotForHeading(s[2]), data: s[3] });
        this.signalPhase.push(s[3] + ((s[4] * 7) % 13) * 0);
        this.grid.add({ x: s[0], z: s[1], col: { kind: 'cylinder', key: `roads-sig-${items.length}`, center: [s[0], y + 1.8, s[1]], radius: 0.08, halfHeight: 1.8 } });
      }
      const geo = trafficSignal();
      const state = new THREE.InstancedBufferAttribute(new Float32Array(items.length), 1);
      state.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aState', state);
      const mat = createPropMaterial(ctx, this.u, { key: 'signal', signal: true, metal: 0.3, rough: 0.5, emitDay: 18, emitNight: 10 });
      const set = new InstanceSet(geo, mat, items, 1500);
      set.mesh.castShadow = true;
      set.mesh.name = 'roads-signals';
      this.signalSet = set;
      this.signalState = state;
      this.sets.push(set);
      this.root.add(set.mesh);
    }

    // ------------------------------------------------------------ bus stops
    const shelterItems: Item[] = [], sovietItems: Item[] = [], stopSign: Item[] = [];
    for (const s of f.stops) {
      const [x, z, h, typ] = s;
      const y = g.height(x, z);
      const rot = rotForHeading(h);
      if (typ === 0) shelterItems.push({ x, y, z, rot });
      else if (typ === 1) sovietItems.push({ x, y, z, rot });
      const [fx, fz] = headingToDir(h);
      const rx = -fz, rz = fx;
      const sx = x + fx * 1.8 + rx * 2.9, sz = z + fz * 1.8 + rz * 2.9;
      stopSign.push({ x: sx, y: g.height(sx, sz), z: sz, rot });
      if (typ !== 2) {
        this.grid.add({ x, z, col: { kind: 'box', key: `roads-stop-${x.toFixed(1)}`, center: [x, y + 1.3, z], halfExtents: [2.2, 1.3, 0.9], rotationY: rot } });
      }
    }
    const glassMat = ctx.registerMaterial(new THREE.MeshStandardMaterial({ color: 0xa9c2cc, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
    const addSet = (geo: THREE.BufferGeometry, mat: THREE.Material, items: Item[], range: number, name: string, shadow = true) => {
      if (!items.length) return null;
      const s = new InstanceSet(geo, mat, items, range);
      s.mesh.castShadow = shadow;
      s.mesh.receiveShadow = true;
      s.mesh.name = name;
      this.sets.push(s);
      this.root.add(s.mesh);
      return s;
    };
    addSet(shelterFrame(), propMat, shelterItems, 900, 'roads-shelters');
    const gs = addSet(shelterGlass(), glassMat, shelterItems, 600, 'roads-shelter-glass', false);
    if (gs) gs.mesh.renderOrder = 3;
    addSet(shelterSoviet(), propMat, sovietItems, 900, 'roads-pavilions');

    // ------------------------------------------------------------ signs
    const atlas = makeSignAtlas();
    const plateMat = ctx.registerMaterial(new THREE.MeshStandardMaterial({ map: atlas, metalness: 0.2, roughness: 0.5, side: THREE.FrontSide }));
    const poles: Item[] = [...stopSign];
    const plates: Item[][] = [[], [], [], []];
    for (const s of f.signs) {
      const [x, z, h, typ] = s;
      const y = g.height(x, z);
      const it = { x, y, z, rot: rotForHeading(h) };
      poles.push(it);
      plates[typ]?.push(it);
      this.grid.add({ x, z, col: { kind: 'cylinder', key: `roads-sign-${x.toFixed(1)}-${z.toFixed(1)}`, center: [x, y + 1.4, z], radius: 0.05, halfHeight: 1.4 } });
    }
    plates[3] = stopSign;
    addSet(signPole(), propMat, poles, 500, 'roads-sign-poles');
    const plateGeos = [signPlate(0, 1), signPlate(2, 5), signPlate(3, 5), signPlate(4, 5, 0.6, 2.6)];
    for (let t = 0; t < 4; t++) addSet(plateGeos[t], plateMat, plates[t], 500, `roads-sign-plates-${t}`);

    // ------------------------------------------------------------ benches
    const benchItems: Item[] = f.benches.map((b) => ({ x: b[0], y: g.height(b[0], b[1]), z: b[1], rot: rotForHeading(b[2]) }));
    addSet(bench(), propMat, benchItems, 400, 'roads-benches');

    // ------------------------------------------------------------ fences / walls / guard rails
    this.buildBarriers();

    // colliders
    ctx.registerColliders({
      id: 'roads-furniture',
      query: (x, z, r) => this.grid.query(x, z, r).map((p) => p.col),
    });
  }

  private buildBarriers(): void {
    const polys = this.roads.data.polys;
    const g = this.roads.ground;
    const fence = new MeshBuilder();
    const fenceUv: number[] = [];
    const posts = new MeshBuilder();
    const walls = new SurfaceBuilder();
    const guard = new MeshBuilder();
    for (const p of polys) {
      if (p.kind !== 4 && p.kind !== 5 && p.kind !== 7) continue;
      const pts = densify(p.pts, p.kind === 5 ? 3 : 2.5);
      const n = pts.length >> 1;
      if (n < 2) continue;
      let along = 0;
      let prev: number[] | null = null;
      for (let i = 0; i < n; i++) {
        const x = pts[i * 2], z = pts[i * 2 + 1];
        if (i > 0) along += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
        const y = g.height(x, z);
        if (p.kind === 4) {
          const Hh = p.style === 1 ? 2.2 : 1.8;
          const a = fence.vert(x, y - 0.1, z, 0, 0, 1, 1, 1, 1);
          const b = fence.vert(x, y + Hh, z, 0, 0, 1, 1, 1, 1);
          fenceUv.push(along / 1.0, 0, along / 1.0, 1);
          if (prev) fence.idx.push(prev[0], a, b, prev[0], b, prev[1]);
          prev = [a, b];
          // post
          const pb = posts.count;
          void pb;
          if (i % 1 === 0) {
            posts.vert(x - 0.03, y - 0.2, z, 0, 0, 1, 0.2, 0.21, 0.2);
          }
        } else if (p.kind === 5) {
          if (i > 0) {
            const x0 = pts[i * 2 - 2], z0 = pts[i * 2 - 1];
            const dx = x - x0, dz = z - z0, l = Math.hypot(dx, dz);
            if (l > 0.05) {
              const yc = Math.min(y, g.height(x0, z0));
              box(walls, (x + x0) / 2, yc + 1.05, (z + z0) / 2, dx / l, dz / l, l + 0.02, 2.5, 0.2, S.STRUCT);
            }
          }
        } else {
          // guard rail: W-beam at 0.6..0.9 m
          const a = guard.vert(x, y + 0.55, z, 0, 0, 1, 0.55, 0.57, 0.58);
          const b = guard.vert(x, y + 0.85, z, 0, 0, 1, 0.55, 0.57, 0.58);
          if (prev) guard.idx.push(prev[0], a, b, prev[0], b, prev[1]);
          prev = [a, b];
        }
      }
    }
    // posts as thin boxes every vertex of the fence polylines
    const postGeo = new MeshBuilder();
    for (let i = 0; i < posts.count; i++) {
      const x = posts.pos[i * 3], y = posts.pos[i * 3 + 1], z = posts.pos[i * 3 + 2];
      const b = postGeo.count;
      for (const [dx, dz] of [[-0.03, -0.03], [0.03, -0.03], [0.03, 0.03], [-0.03, 0.03]]) {
        postGeo.vert(x + dx + 0.03, y, z + dz, dx, 0, dz, 0.2, 0.21, 0.2);
        postGeo.vert(x + dx + 0.03, y + 2.1, z + dz, dx, 0, dz, 0.2, 0.21, 0.2);
      }
      for (let k = 0; k < 4; k++) {
        const a0 = b + k * 2, a1 = a0 + 1, c0 = b + ((k + 1) % 4) * 2, c1 = c0 + 1;
        postGeo.idx.push(a0, c0, c1, a0, c1, a1);
      }
    }
    const fg = fence.build(false);
    if (fg) {
      fg.setAttribute('uv', new THREE.Float32BufferAttribute(fenceUv, 2));
      const tex = makeFenceTexture();
      const mat = this.ctx.registerMaterial(new THREE.MeshStandardMaterial({ color: 0x3c4a3e, map: tex, alphaTest: 0.5, metalness: 0.5, roughness: 0.6, side: THREE.DoubleSide }));
      const m = new THREE.Mesh(fg, mat);
      m.castShadow = true; m.receiveShadow = true; m.name = 'roads-fences';
      this.root.add(m);
    }
    const pg = postGeo.build(true);
    const guardMat = createPropMaterial(this.ctx, this.u, { key: 'barrier', metal: 0.7, rough: 0.4 });
    if (pg) {
      pg.setAttribute('aEmit', new THREE.Float32BufferAttribute(new Float32Array(postGeo.count), 1));
      const m = new THREE.Mesh(pg, guardMat);
      m.castShadow = true; m.name = 'roads-fence-posts';
      this.root.add(m);
    }
    const gg = guard.build(true, true);
    if (gg) {
      const m = new THREE.Mesh(gg, guardMat);
      m.castShadow = true; m.name = 'roads-guardrails';
      this.root.add(m);
    }
    const wg = walls.build();
    if (wg) {
      const m = new THREE.Mesh(wg, this.roads.mats.struct);
      m.castShadow = true; m.receiveShadow = true; m.name = 'roads-walls';
      this.root.add(m);
    }
  }

  update(_dt: number): void {
    const ctx = this.ctx;
    this.u.pNight.value = ctx.env.night;
    updateWireUniforms(ctx);
    const cam = ctx.camera.position;
    for (const s of this.sets) s.update(cam, 30);
    // traffic signal phases
    if (this.signalSet && this.signalState && (this.frame++ % 6 === 0)) {
      const t = ctx.env.elapsed;
      const arr = this.signalState.array as Float32Array;
      const cur = this.signalSet.current;
      for (let k = 0; k < cur.length; k++) {
        const st = signalState(this.signalPhase[cur[k]], t);
        arr[k] = st === 'red' ? 0 : st === 'yellow' ? 1 : 2;
      }
      this.signalState.needsUpdate = true;
    }
    const dd = Math.min(ctx.settings.profile.drawDistance, 3500);
    for (const w of this.wireTiles) w.mesh.visible = Math.hypot(w.cx - cam.x, w.cz - cam.z) - 1450 < dd;
  }
}

function makeFenceTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 128);
  g.fillStyle = '#fff';
  g.fillRect(0, 4, 64, 5);
  g.fillRect(0, 108, 64, 5);
  for (let i = 0; i < 6; i++) g.fillRect(i * 10.66 + 3, 0, 3, 128);
  for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(i * 10.66 + 4.5, 0); g.lineTo(i * 10.66 + 1, 6); g.lineTo(i * 10.66 + 8, 6); g.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
