// Power grid: lattice pylons (500/330 kV wine-glass, 110 kV double/single circuit, 35 kV), 10 kV
// concrete poles and substation portals from Overture infrastructure, with conductors and ground
// wires hanging in catenary sag between the insulator strings.
import * as THREE from 'three';
import type { AppContext, StaticCollider } from '../../core/context';
import { InstanceSet, PointGrid, rotForHeading, type Item } from './instancing';
import { makePylons, type PylonDef } from './models';
import { createPropMaterial, type PropUniforms } from './props';
import { WireBuilder, createWireMaterial } from './wires';

interface RoadsHost {
  data: import('./data').RoadsData;
  ground: import('./ground').Ground;
}

export class Power {
  private sets: InstanceSet[] = [];
  private wireTiles: Array<{ cx: number; cz: number; mesh: THREE.Mesh }> = [];
  private root = new THREE.Group();
  private grid = new PointGrid<{ x: number; z: number; col: StaticCollider }>(96);
  readonly u: PropUniforms = { pNight: { value: 0 } };

  constructor(private ctx: AppContext, private roads: RoadsHost) {
    this.root.name = 'roads-power';
  }

  async init(): Promise<void> {
    const ctx = this.ctx;
    const pw = this.roads.data.objects.power;
    const g = this.roads.ground;
    ctx.scene.add(this.root);
    const defs: PylonDef[] = makePylons();
    const n = pw.towers.length / 4;
    const tw: Array<{ x: number; y: number; z: number; h: number; type: number }> = [];
    const byType: Item[][] = defs.map(() => []);
    for (let i = 0; i < n; i++) {
      const x = pw.towers[i * 4], z = pw.towers[i * 4 + 1], h = pw.towers[i * 4 + 2], type = pw.towers[i * 4 + 3];
      const y = g.height(x, z);
      tw.push({ x, y, z, h, type });
      byType[type]?.push({ x, y, z, rot: rotForHeading(h) });
      const r = type <= 1 ? 3.5 : type <= 4 ? 2.2 : 0.2;
      this.grid.add({ x, z, col: { kind: 'box', key: `roads-tower-${i}`, center: [x, y + 2, z], halfExtents: [r, 2, r], rotationY: rotForHeading(h) } });
    }
    const mat = createPropMaterial(ctx, this.u, { key: 'pylon', metal: 0.55, rough: 0.55 });
    const dd = ctx.settings.profile.drawDistance;
    for (let t = 0; t < defs.length; t++) {
      if (!byType[t].length) continue;
      const near = new InstanceSet(defs[t].geo, mat, byType[t], t === 5 ? 900 : 2200);
      near.mesh.castShadow = true; near.mesh.receiveShadow = true; near.mesh.name = `roads-pylons-${t}`;
      const far = new InstanceSet(defs[t].far, mat, byType[t], Math.min(dd, 9000));
      far.minRange = t === 5 ? 900 : 2200;
      far.mesh.castShadow = false; far.mesh.name = `roads-pylons-far-${t}`;
      this.sets.push(near, far);
      this.root.add(near.mesh, far.mesh);
    }
    // ---------------------------------------------------------------- conductors
    const wb = new Map<number, { w: WireBuilder; cx: number; cz: number }>();
    const T = 2048, H = this.roads.data.meta.half;
    const tile = (x: number, z: number) => {
      const i = Math.floor((x + H) / T), j = Math.floor((z + H) / T);
      const k = j * 64 + i;
      let e = wb.get(k);
      if (!e) { e = { w: new WireBuilder(), cx: -H + (i + 0.5) * T, cz: -H + (j + 0.5) * T }; wb.set(k, e); }
      return e.w;
    };
    const world = (t: { x: number; y: number; z: number; h: number }, p: [number, number, number]): [number, number, number] => {
      const r = (t.h * Math.PI) / 180;
      const rx = Math.cos(r), rz = Math.sin(r);    // right (local +x)
      const fx = Math.sin(r), fz = -Math.cos(r);   // forward (local -z)
      return [t.x + rx * p[0] - fx * p[2], t.y + p[1], t.z + rz * p[0] - fz * p[2]];
    };
    let spans = 0;
    for (const ln of pw.lines) {
      const radius = ln.v >= 300 ? 0.028 * Math.sqrt(ln.b) : ln.v >= 100 ? 0.02 : ln.v >= 30 ? 0.015 : 0.01;
      for (let k = 0; k + 1 < ln.t.length; k++) {
        const a = tw[ln.t[k]], b = tw[ln.t[k + 1]];
        if (!a || !b) continue;
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        if (L < 5 || L > 900) continue;
        const da = defs[a.type], db = defs[b.type];
        if (!da || !db) continue;
        // phases of every circuit present on both towers
        const circuits = Math.min(ln.c, da.phases.length, db.phases.length) || 1;
        const sag = L * (ln.v >= 300 ? 0.03 : 0.026) + 0.3;
        // keep phases on the same side: flip b's frame if the towers face opposite ways
        const dh = Math.abs(((a.h - b.h + 540) % 360) - 180);
        const flip = dh < 90 ? 1 : -1;
        const w = tile((a.x + b.x) / 2, (a.z + b.z) / 2);
        for (let c = 0; c < circuits; c++) {
          const pa = da.phases[c] ?? da.phases[0], pb = db.phases[c] ?? db.phases[0];
          const np = Math.min(pa.length, pb.length);
          for (let i = 0; i < np; i++) {
            const A = world(a, pa[i]);
            const pbi = pb[flip > 0 ? i : np - 1 - i];
            const B = world(b, [pbi[0] * (flip > 0 ? 1 : 1), pbi[1], pbi[2]]);
            w.span(A[0], A[1], A[2], B[0], B[1], B[2], sag, radius, 8);
          }
        }
        const ga = da.ground, gb = db.ground;
        const ng = Math.min(ga.length, gb.length);
        for (let i = 0; i < ng; i++) {
          const A = world(a, ga[i]);
          const B = world(b, gb[flip > 0 ? i : ng - 1 - i]);
          w.span(A[0], A[1], A[2], B[0], B[1], B[2], sag * 0.8, 0.0065, 10);
        }
        spans++;
      }
    }
    const wmat = createWireMaterial(ctx, 0x9aa0a4, 0.85, 0.35, 0.8);
    for (const e of wb.values()) {
      const geo = e.w.build();
      if (!geo) continue;
      const m = new THREE.Mesh(geo, wmat);
      m.renderOrder = 2;
      m.name = 'roads-power-wires';
      m.userData.noPathTrace = true;
      this.root.add(m);
      this.wireTiles.push({ cx: e.cx, cz: e.cz, mesh: m });
    }
    console.info(`[roads] power: ${n} towers, ${spans} spans`);
    ctx.registerColliders({ id: 'roads-power', query: (x, z, r) => this.grid.query(x, z, r).map((p) => p.col) });
  }

  update(_dt: number): void {
    const cam = this.ctx.camera.position;
    this.u.pNight.value = this.ctx.env.night;
    for (const s of this.sets) s.update(cam, 60);
    const dd = Math.min(this.ctx.settings.profile.drawDistance, 9000);
    for (const w of this.wireTiles) w.mesh.visible = Math.hypot(w.cx - cam.x, w.cz - cam.z) - 1450 < dd;
  }
}
