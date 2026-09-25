// Railways: 3D rails + sleepers streamed in chunks around the camera (the ballast bed is part of the
// draped ground; far away the ground shader draws the track pattern), level crossings (rails flush
// with the road), catenary masts with cantilevers, yard portals, contact + messenger wires with
// droppers on the electrified main line (25 kV AC).
import * as THREE from 'three';
import type { AppContext, StaticCollider } from '../../core/context';
import type { RailTrack } from './data';
import { Polyline, MeshBuilder } from './geom';
import { InstanceSet, PointGrid, rotForHeading, type Item } from './instancing';
import { catenaryMast, latticeBeam, tube, COL } from './models';
import { createPropMaterial, type PropUniforms } from './props';
import { WireBuilder, createWireMaterial } from './wires';

interface RoadsHost {
  data: import('./data').RoadsData;
  ground: import('./ground').Ground;
  surfaceY(x: number, z: number, group: number): number;
}

interface Chunk { track: number; s0: number; s1: number; cx: number; cz: number; r: number; mesh: THREE.Group | null }

const GAUGE_HALF = 0.7975; // rail centre offset (1520 mm gauge + head)
const TOP = 0.72;          // rail top above the formation surface
const BUILD_R = 420, DROP_R = 650;

export class Rail {
  private tracks: Array<{ t: RailTrack; pl: Polyline }> = [];
  private chunks: Chunk[] = [];
  private cross = new PointGrid<{ x: number; z: number; r: number }>(64);
  private steel!: THREE.MeshStandardMaterial;
  private sleeperMat!: THREE.MeshStandardMaterial;
  private sets: InstanceSet[] = [];
  private wireTiles: Array<{ cx: number; cz: number; mesh: THREE.Mesh }> = [];
  private root = new THREE.Group();
  private lastX = Infinity;
  private lastZ = Infinity;
  private colliders = new PointGrid<{ x: number; z: number; col: StaticCollider }>(64);
  readonly u: PropUniforms = { pNight: { value: 0 } };

  constructor(private ctx: AppContext, private roads: RoadsHost) {
    this.root.name = 'roads-rail';
  }

  async init(): Promise<void> {
    const ctx = this.ctx;
    const rail = this.roads.data.objects.rail;
    ctx.scene.add(this.root);
    for (const c of rail.crossings) this.cross.add({ x: c[0], z: c[1], r: c[2] });
    this.steel = ctx.registerMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.75, roughness: 0.38 }));
    this.sleeperMat = ctx.registerMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.0, roughness: 0.85 }));
    for (let i = 0; i < rail.tracks.length; i++) {
      const t = rail.tracks[i];
      const pl = new Polyline(t.p);
      this.tracks.push({ t, pl });
      const L = pl.length;
      const n = Math.max(1, Math.ceil(L / 150));
      for (let k = 0; k < n; k++) {
        const s0 = (L * k) / n, s1 = (L * (k + 1)) / n;
        const c = pl.at((s0 + s1) / 2);
        this.chunks.push({ track: i, s0, s1, cx: c[0], cz: c[1], r: (s1 - s0) / 2 + 5, mesh: null });
      }
    }
    this.buildCatenary();
  }

  /** Formation surface height (terrain or bridge deck). */
  private surf(x: number, z: number, g: number): number {
    return this.roads.surfaceY(x, z, g);
  }

  private crossK(x: number, z: number): number {
    let k = 0;
    for (const c of this.cross.query(x, z, 30)) {
      const d = Math.hypot(c.x - x, c.z - z);
      const t = 1 - Math.min(1, Math.max(0, (d - c.r) / 5));
      k = Math.max(k, t * t * (3 - 2 * t));
    }
    return k;
  }

  /** Height of the rail top at a track point. */
  railTop(x: number, z: number, g: number): number {
    const s = this.surf(x, z, g);
    const k = g >= 0 ? 0 : this.crossK(x, z);
    return s + TOP * (1 - k) + 0.07 * k;
  }

  private buildChunk(c: Chunk): THREE.Group {
    const { t, pl } = this.tracks[c.track];
    const rails = new MeshBuilder();
    const sl = new MeshBuilder();
    const concrete = t.el === 1 || (t.dis === 0 && t.g >= 0);
    const topCol: [number, number, number] = t.dis ? [0.32, 0.2, 0.12] : [0.62, 0.62, 0.64];
    const sideCol: [number, number, number] = [0.26, 0.16, 0.1];
    const step = 2.5;
    const n = Math.max(1, Math.ceil((c.s1 - c.s0) / step));
    const prev: number[][] = [[], []];
    const P = [0, 0], Tn = [0, 0];
    for (let i = 0; i <= n; i++) {
      const s = c.s0 + ((c.s1 - c.s0) * i) / n;
      pl.at(s, P);
      pl.tangent(s, 1.5, Tn);
      const nx = -Tn[1], nz = Tn[0];
      for (let r = 0; r < 2; r++) {
        const off = r === 0 ? -GAUGE_HALF : GAUGE_HALF;
        const x = P[0] + nx * off, z = P[1] + nz * off;
        const y = this.railTop(x, z, t.g);
        const hw = 0.037;
        const ids = [
          rails.vert(x - nx * hw, y - 0.17, z - nz * hw, -nx, 0, -nz, ...sideCol),
          rails.vert(x - nx * hw, y, z - nz * hw, -nx, 0.2, -nz, ...sideCol),
          rails.vert(x - nx * hw, y, z - nz * hw, 0, 1, 0, ...topCol),
          rails.vert(x + nx * hw, y, z + nz * hw, 0, 1, 0, ...topCol),
          rails.vert(x + nx * hw, y, z + nz * hw, nx, 0.2, nz, ...sideCol),
          rails.vert(x + nx * hw, y - 0.17, z + nz * hw, nx, 0, nz, ...sideCol),
        ];
        const pv = prev[r];
        if (pv.length) {
          // faces: left side, top, right side (travel +t, right = +n)
          rails.idx.push(pv[0], pv[1], ids[1], pv[0], ids[1], ids[0]);
          rails.idx.push(pv[2], pv[3], ids[3], pv[2], ids[3], ids[2]);
          rails.idx.push(pv[4], pv[5], ids[5], pv[4], ids[5], ids[4]);
        }
        prev[r] = ids;
      }
    }
    // sleepers every 0.55 m
    const sc: [number, number, number] = concrete ? [0.47, 0.46, 0.44] : [0.2, 0.14, 0.09];
    const first = Math.ceil(c.s0 / 0.55) * 0.55;
    for (let s = first; s < c.s1; s += 0.55) {
      pl.at(s, P);
      pl.tangent(s, 1.5, Tn);
      if (this.crossK(P[0], P[1]) > 0.3 && t.g < 0) continue;
      const nx = -Tn[1], nz = Tn[0];
      const y1 = this.railTop(P[0], P[1], t.g) - 0.17;
      const y0 = y1 - 0.2;
      const hl = 1.375, hwid = concrete ? 0.14 : 0.13;
      const cx = P[0], cz = P[1];
      const corner = (a: number, b: number, y: number) => [cx + nx * a * hl + Tn[0] * b * hwid, y, cz + nz * a * hl + Tn[1] * b * hwid];
      const quads: Array<[number[][], number[]]> = [
        [[corner(-1, -1, y1), corner(1, -1, y1), corner(1, 1, y1), corner(-1, 1, y1)], [0, 1, 0]],
        [[corner(-1, -1, y0), corner(1, -1, y0), corner(1, -1, y1), corner(-1, -1, y1)], [-Tn[0], 0, -Tn[1]]],
        [[corner(1, 1, y0), corner(-1, 1, y0), corner(-1, 1, y1), corner(1, 1, y1)], [Tn[0], 0, Tn[1]]],
        [[corner(-1, 1, y0), corner(-1, -1, y0), corner(-1, -1, y1), corner(-1, 1, y1)], [-nx, 0, -nz]],
        [[corner(1, -1, y0), corner(1, 1, y0), corner(1, 1, y1), corner(1, -1, y1)], [nx, 0, nz]],
      ];
      for (const [q, nn] of quads) {
        const ids = q.map((v) => sl.vert(v[0], v[1], v[2], nn[0], nn[1], nn[2], ...sc));
        sl.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
      }
    }
    const grp = new THREE.Group();
    const rg = rails.build(true);
    if (rg) {
      const m = new THREE.Mesh(rg, this.steel);
      m.castShadow = true; m.receiveShadow = true;
      grp.add(m);
    }
    const sg = sl.build(true);
    if (sg) {
      const m = new THREE.Mesh(sg, this.sleeperMat);
      m.receiveShadow = true;
      grp.add(m);
    }
    grp.name = 'roads-rail-chunk';
    return grp;
  }

  private buildCatenary(): void {
    const ctx = this.ctx;
    const mastItems: Item[] = [];
    const wb = new Map<number, { w: WireBuilder; cx: number; cz: number }>();
    const T = 2048, H = this.roads.data.meta.half;
    const tile = (x: number, z: number) => {
      const i = Math.floor((x + H) / T), j = Math.floor((z + H) / T);
      const k = j * 64 + i;
      let e = wb.get(k);
      if (!e) { e = { w: new WireBuilder(), cx: -H + (i + 0.5) * T, cz: -H + (j + 0.5) * T }; wb.set(k, e); }
      return e.w;
    };
    const P = [0, 0], Tn = [0, 0];
    for (const { t, pl } of this.tracks) {
      if (!t.el || t.sup.length < 1) continue;
      const pts: Array<{ x: number; z: number; y: number }> = [];
      for (let k = 0; k < t.sup.length; k++) {
        const [s, type] = t.sup[k];
        pl.at(s, P);
        pl.tangent(s, 2, Tn);
        const nx = -Tn[1], nz = Tn[0];
        const zig = (k % 2 === 0 ? 1 : -1) * 0.3;
        const yr = this.railTop(P[0], P[1], t.g);
        pts.push({ x: P[0] + nx * zig, z: P[1] + nz * zig, y: yr });
        if (type === 1 || type === -1) {
          const mx = P[0] + nx * type * 3.3, mz = P[1] + nz * type * 3.3;
          // cantilever must point from the mast to the track: direction -type*n
          const hx = -nx * type, hz = -nz * type;
          const heading = (Math.atan2(hx, -hz) * 180) / Math.PI;
          const my = t.g >= 0 ? this.surf(mx, mz, t.g) : this.roads.ground.height(mx, mz);
          mastItems.push({ x: mx, y: my, z: mz, rot: rotForHeading(heading), sy: Math.max(0.9, (yr - my + 9.6) / 9.6) });
          this.colliders.add({ x: mx, z: mz, col: { kind: 'cylinder', key: `roads-mast-${mx.toFixed(1)}-${mz.toFixed(1)}`, center: [mx, my + 4.8, mz], radius: 0.2, halfHeight: 4.8 } });
        }
      }
      // wires between consecutive supports
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        if (d < 5 || d > 90) continue;
        const w = tile((a.x + b.x) / 2, (a.z + b.z) / 2);
        const ca = a.y + 6.25, cb = b.y + 6.25;
        const ma = a.y + 7.85, mb = b.y + 7.85;
        w.span(a.x, ca, a.z, b.x, cb, b.z, 0.04, 0.0065, 8);
        const sag = Math.min(1.25, d * 0.022);
        w.span(a.x, ma, a.z, b.x, mb, b.z, sag, 0.006, 5);
        const nd = Math.max(1, Math.round(d / 9));
        for (let q = 1; q < nd; q++) {
          const u = q / nd;
          const x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u;
          const yc = ca + (cb - ca) * u - 4 * 0.04 * u * (1 - u);
          const ym = ma + (mb - ma) * u - 4 * sag * u * (1 - u);
          w.line(x, yc, z, x, ym, z, 0.002);
        }
      }
    }
    // masts
    if (mastItems.length) {
      const mat = createPropMaterial(ctx, this.u, { key: 'mast', metal: 0.2, rough: 0.7 });
      const set = new InstanceSet(catenaryMast(3.3), mat, mastItems, 1800, 4000);
      set.mesh.castShadow = true; set.mesh.receiveShadow = true; set.mesh.name = 'roads-catenary-masts';
      this.sets.push(set);
      this.root.add(set.mesh);
    }
    // portals (merged)
    const pm = new MeshBuilder();
    for (const p of this.roads.data.objects.rail.portals) {
      const [x0, z0, x1, z1] = p;
      const y0 = this.roads.ground.height(x0, z0), y1 = this.roads.ground.height(x1, z1);
      const top = Math.max(y0, y1) + 10.5;
      tube(pm, [x0, y0 - 0.5, z0], [x0, top + 0.6, z0], 0.3, 0.22, 8, COL.galv);
      tube(pm, [x1, y1 - 0.5, z1], [x1, top + 0.6, z1], 0.3, 0.22, 8, COL.galv);
      latticeBeam(pm, [x0, top, z0], [x1, top, z1], 0.9, 0.9, COL.galv, 1.2);
      this.colliders.add({ x: x0, z: z0, col: { kind: 'cylinder', key: `roads-portal-${x0.toFixed(1)}`, center: [x0, y0 + 5, z0], radius: 0.3, halfHeight: 5.5 } });
      this.colliders.add({ x: x1, z: z1, col: { kind: 'cylinder', key: `roads-portal-${x1.toFixed(1)}`, center: [x1, y1 + 5, z1], radius: 0.3, halfHeight: 5.5 } });
    }
    const pg = pm.build(true, true);
    if (pg) {
      const m = new THREE.Mesh(pg, createPropMaterial(ctx, this.u, { key: 'portal', metal: 0.5, rough: 0.5 }));
      m.castShadow = true; m.name = 'roads-catenary-portals';
      this.root.add(m);
    }
    const wmat = createWireMaterial(ctx, 0x4a3f33, 0.8, 0.45);
    for (const e of wb.values()) {
      const geo = e.w.build();
      if (!geo) continue;
      const m = new THREE.Mesh(geo, wmat);
      m.renderOrder = 2;
      m.name = 'roads-catenary-wires';
      m.userData.noPathTrace = true;
      this.root.add(m);
      this.wireTiles.push({ cx: e.cx, cz: e.cz, mesh: m });
    }
    ctx.registerColliders({ id: 'roads-rail', query: (x, z, r) => this.colliders.query(x, z, r).map((p) => p.col) });
  }

  update(_dt: number): void {
    const ctx = this.ctx;
    const cam = ctx.camera.position;
    this.u.pNight.value = ctx.env.night;
    for (const s of this.sets) s.update(cam, 40);
    const dd = Math.min(ctx.settings.profile.drawDistance, 4000);
    for (const w of this.wireTiles) w.mesh.visible = Math.hypot(w.cx - cam.x, w.cz - cam.z) - 1450 < dd;
    // stream rail chunks
    if (Math.hypot(cam.x - this.lastX, cam.z - this.lastZ) < 20) return;
    this.lastX = cam.x; this.lastZ = cam.z;
    const agl = ctx.cameraAGL;
    const buildR = agl > 600 ? 0 : BUILD_R;
    let built = 0;
    for (const c of this.chunks) {
      const d = Math.hypot(c.cx - cam.x, c.cz - cam.z) - c.r;
      if (!c.mesh && d < buildR && built < (ctx.settings.shot ? 1000 : 12)) {
        try {
          c.mesh = this.buildChunk(c);
          this.root.add(c.mesh);
        } catch (e) { console.warn('[roads] rail chunk', e); }
        built++;
      } else if (c.mesh && d > DROP_R) {
        this.root.remove(c.mesh);
        c.mesh.traverse((o: any) => o.geometry?.dispose?.());
        c.mesh = null;
      }
    }
    if (built >= 12) this.lastX = Infinity; // continue next frame
  }
}
