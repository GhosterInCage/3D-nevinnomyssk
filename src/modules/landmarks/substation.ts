// Outdoor switchyards (ОРУ) of the substations and power plants: bays of line portals, disconnectors,
// current transformers, circuit breakers and bus portals with busbars, power transformers between the
// sections. Layout comes from build_landmarks.py (plot frame = minimum rotated rectangle of the OSM
// substation outline, local +X along the long axis).
//
// Rendering: every equipment type is modelled once per voltage class ("kit", unit geometry at the
// origin) and drawn as InstancedMeshes per substation: a main layer (portal frames, breaker frames,
// transformers: the silhouette seen from afar) and a detail layer (insulator stacks, blades, lattice
// bracing, busbars) that is distance culled with the landmark.
import * as THREE from 'three';
import { Geo, P, col } from './builder';
import { transformer, addBox, type Frame } from './structures';

export interface SubstationSpec {
  x: number; z: number; rot: number; len: number; wid: number; kv: number;
  hP: number; hB: number; step: number; pitch: number; name?: string | null;
  items: number[][];      // [type, lx, lz]
  buses: number[][];      // [lz, x0, x1]
}

const GALV = col('#8e9393');
const PORC = col('#6b4a3a');       // brown glazed porcelain
const POLY = col('#7f8587');       // grey polymer / glass
const CONC = col('#9d998f');
const CAB = col('#c4c4be');

/** Post insulator (sheds as thin double discs) standing at (x, y, z), height h. */
function insulator(d: Geo, x: number, y: number, z: number, h: number, r: number, porcelain: boolean): void {
  d.paint(porcelain ? PORC : POLY, P.PLAIN, 0.3, 0);
  d.cyl(x, y, z, r, r * 0.9, h, 6, false, true);
  const n = Math.max(2, Math.round(h / 0.55));
  for (let i = 1; i < n; i++) {
    const yy = y + (h * i) / n;
    d.disc(x, yy, z, r * 1.9, 6, true);
    d.disc(x, yy - 0.04, z, r * 1.9, 6, false);
  }
}

interface Kit { main: Array<THREE.BufferGeometry | null>; detail: Array<THREE.BufferGeometry | null>; k: number; ps: number; hv: boolean }

/** Unit models of one voltage class (local X along the bay row, y = 0 at the ground). */
function makeKit(s: SubstationSpec): Kit {
  const k = s.step / 5;                              // scale relative to a 110 kV yard
  const ps = Math.min(s.pitch / 3.3, 3.2 * k);       // phase spacing along the row
  const hv = s.kv >= 300;
  const porcelain = s.kv < 300;
  const main: Array<THREE.BufferGeometry | null> = [];
  const detail: Array<THREE.BufferGeometry | null> = [];
  for (let t = 0; t <= 5; t++) {
    const g = new Geo(), d = new Geo();
    if (t === 0 || t === 4) {
      // portal spanning the bay along X: two columns + a truss beam
      const H = t === 0 ? s.hP : s.hB;
      const w = s.pitch / 2;
      const b = (hv ? 0.9 : 0.5) * k, th = (hv ? 1.4 : 0.8) * k;
      for (const px of [-w, w]) {
        if (hv) {
          g.paint(GALV, P.METAL, 0.55, 0.5);
          for (const [ax, az] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.beam([px + ax * b, 0, az * b], [px + ax * b * 0.45, H, az * b * 0.45], 0.13 * k);
          d.paint(GALV, P.METAL, 0.55, 0.5);
          for (let yy = 0; yy < H - 1; yy += 2.4 * k) {
            const f0 = 1 - 0.55 * (yy / H), f1 = 1 - 0.55 * ((yy + 2.4 * k) / H);
            d.beam([px - b * f0, yy, -b * f0], [px + b * f1, yy + 2.4 * k, -b * f1], 0.05 * k);
            d.beam([px - b * f0, yy, b * f0], [px + b * f1, yy + 2.4 * k, b * f1], 0.05 * k);
          }
        } else {
          g.paint(CONC, P.CONCRETE, 0.85);
          g.cyl(px, -0.5, -b, 0.2, 0.13, H + 0.5, 6, false, true);
          g.cyl(px, -0.5, b, 0.2, 0.13, H + 0.5, 6, false, true);
        }
      }
      // truss beam: two chords (main), verticals + diagonals (detail)
      g.paint(GALV, P.METAL, 0.55, 0.5);
      g.beam([-w, H, 0], [w, H, 0], 0.16 * k, 0.5 * k);
      g.beam([-w, H - th, 0], [w, H - th, 0], 0.16 * k, 0.5 * k);
      d.paint(GALV, P.METAL, 0.55, 0.5);
      const nd = Math.max(2, Math.round((2 * w) / (th * 1.4)));
      for (let i = 0; i < nd; i++) {
        const xa = -w + (2 * w * i) / nd, xb = -w + (2 * w * (i + 1)) / nd;
        d.beam([xa, H - th, 0], [xb, H, 0], 0.06 * k, 0.06 * k);
        d.beam([xb, H - th, 0], [xb, H, 0], 0.06 * k, 0.06 * k);
      }
      // insulator strings hanging from the beam
      d.paint(porcelain ? col('#6f8079') : POLY, P.PLAIN, 0.3, 0.1);
      const sl = (hv ? 3.7 : 1.4) * k;
      for (let i = -1; i <= 1; i++) d.cyl(i * ps, H - th - sl, 0, 0.12 * k, 0.12 * k, sl, 6, true, true);
      // ground-wire peaks on line portals
      if (t === 0) {
        g.paint(GALV, P.METAL, 0.55, 0.5);
        for (const px of [-w, w]) g.beam([px, H, 0], [px, H + 3.5 * k, 0], 0.16 * k);
      }
    } else if (t === 1) {
      // three-phase disconnector: phase frames with two post insulators and a blade
      for (let i = -1; i <= 1; i++) {
        const px = i * ps, hs = 2.4 * k;
        g.paint(CONC, P.CONCRETE, 0.85);
        g.box(px - 0.14 * k, 0, -0.14 * k, px + 0.14 * k, hs, 0.14 * k);
        g.paint(GALV, P.METAL, 0.55, 0.5);
        g.box(px - 0.15 * k, hs, -1.2 * k, px + 0.15 * k, hs + 0.25 * k, 1.2 * k);
        insulator(d, px, hs + 0.25 * k, -1.0 * k, 1.3 * k, 0.1 * k, porcelain);
        insulator(d, px, hs + 0.25 * k, 1.0 * k, 1.3 * k, 0.1 * k, porcelain);
        d.paint(col('#b0b3b0'), P.METAL, 0.35, 0.8);
        d.box(px - 0.05 * k, hs + 1.58 * k, -1.05 * k, px + 0.05 * k, hs + 1.68 * k, 1.05 * k);
      }
    } else if (t === 2) {
      // current transformers: tall single columns with a head tank
      for (let i = -1; i <= 1; i++) {
        const px = i * ps, hs = 2.0 * k;
        g.paint(CONC, P.CONCRETE, 0.85);
        g.box(px - 0.15 * k, 0, -0.15 * k, px + 0.15 * k, hs, 0.15 * k);
        g.paint(col('#6f7a74'), P.METAL, 0.5, 0.4);
        g.cyl(px, hs, 0, 0.32 * k, 0.32 * k, 0.6 * k, 8, false, true);
        g.cyl(px, hs + 2.5 * k, 0, 0.3 * k, 0.36 * k, 0.55 * k, 8, false, true);
        insulator(d, px, hs + 0.6 * k, 0, 1.9 * k, 0.16 * k, porcelain);
      }
    } else if (t === 3) {
      // circuit breaker: SF6 live-tank poles on a common frame (EHV: T-head with two interrupters), cabinet
      const hs = 2.2 * k;
      g.paint(GALV, P.METAL, 0.55, 0.5);
      g.box(-ps - 0.4 * k, 0, -0.35 * k, ps + 0.4 * k, 0.25, 0.35 * k);
      for (let i = -1; i <= 1; i++) {
        const px = i * ps;
        g.paint(GALV, P.METAL, 0.55, 0.5);
        g.box(px - 0.18 * k, 0, -0.18 * k, px + 0.18 * k, hs, 0.18 * k);
        g.paint(col('#858e91'), P.METAL, 0.45, 0.5);
        g.box(px - 0.3 * k, hs, -0.3 * k, px + 0.3 * k, hs + 0.5 * k, 0.3 * k);
        insulator(d, px, hs + 0.5 * k, 0, 1.6 * k, 0.17 * k, porcelain);
        g.paint(col('#aeb4b6'), P.METAL, 0.4, 0.6);
        if (hv) g.hcyl(px - 1.1 * k, px + 1.1 * k, hs + 2.35 * k, 0, 0.26 * k, 8, true);
        else g.cyl(px, hs + 2.1 * k, 0, 0.24 * k, 0.24 * k, 0.9 * k, 8, false, true);
      }
      g.paint(CAB, P.METAL, 0.5, 0.3);
      g.box(ps + 0.7 * k, 0, -0.5, ps + 1.6 * k, 1.9, 0.5);
    } else if (t === 5) {
      // power transformer (rotated across the row) on a gravel oil pit
      g.paint(col('#6d6a63'), P.ASPHALT, 0.95);
      g.box(-5 * k, -0.4, -7 * k, 5 * k, 0.12, 7 * k, 8 | 1 | 2 | 16 | 32);
      const sc = Math.max(0.6, k);
      g.at(0, 0, 0, Math.PI / 2, sc); d.at(0, 0, 0, Math.PI / 2, sc);
      transformer(g, d, 0, 0.3 / sc, 0, 0);
      g.pop(); d.pop();
    }
    main.push(g.triangleCount ? g.build() : null);
    detail.push(d.triangleCount ? d.build() : null);
  }
  return { main, detail, k, ps, hv };
}

const kits = new Map<string, Kit>();

/** Build one switchyard: returns instanced meshes (world space) for the main and the detail layer. */
export function buildSubstation(fr: Frame, mat: THREE.Material, s: SubstationSpec): { main: THREE.Object3D[]; detail: THREE.Object3D[] } {
  const key = `${s.kv}|${s.pitch}|${s.step}|${s.hP}|${s.hB}`;
  let kit = kits.get(key);
  if (!kit) { kit = makeKit(s); kits.set(key, kit); }
  const cs = Math.cos(s.rot), sn = Math.sin(s.rot);
  const W = (lx: number, lz: number): [number, number] => [s.x + lx * cs + lz * sn, s.z - lx * sn + lz * cs];
  const byType: number[][][] = [[], [], [], [], [], []];
  for (const it of s.items) if (it[0] >= 0 && it[0] <= 5) byType[it[0]].push(it);
  const out = { main: [] as THREE.Object3D[], detail: [] as THREE.Object3D[] };
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rot), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  for (let t = 0; t <= 5; t++) {
    const list = byType[t];
    if (!list.length) continue;
    const mats: THREE.Matrix4[] = list.map(([, lx, lz]) => {
      const [x, z] = W(lx, lz);
      return new THREE.Matrix4().compose(v.set(x, fr.ground(x, z), z), q, one);
    });
    for (const [geo, dst, shadow] of [[kit.main[t], out.main, true], [kit.detail[t], out.detail, false]] as Array<[THREE.BufferGeometry | null, THREE.Object3D[], boolean]>) {
      if (!geo) continue;
      const im = new THREE.InstancedMesh(geo, mat, mats.length);
      mats.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = shadow;
      im.receiveShadow = true;
      im.name = `substation-${t}`;
      dst.push(im);
    }
    if (t === 5) for (const [, lx, lz] of list) { const [x, z] = W(lx, lz); addBox(fr, x - fr.ox, fr.ground(x, z) - fr.oy, z - fr.oz, 10 * kit.k, 7 * kit.k, 14 * kit.k, s.rot); }
  }
  // busbars: three conductors per bus row between the outermost bus portals (slight sag)
  const d = new Geo();
  d.paint(col('#9c9486'), P.METAL, 0.4, 0.8);
  const k = kit.k, drop = (kit.hv ? 4.6 : 2.1) * k + (kit.hv ? 1.4 : 0.8) * k;
  for (const [lz, x0, x1] of s.buses) {
    const n = Math.max(2, Math.round((x1 - x0) / s.pitch));
    for (let i = -1; i <= 1; i++) {
      for (let j = 0; j < n; j++) {
        const xa = x0 + ((x1 - x0) * j) / n, xb = x0 + ((x1 - x0) * (j + 1)) / n;
        const [ax, az] = W(xa, lz), [bx, bz] = W(xb, lz);
        const ox = sn * i * kit.ps * 0.9, oz = cs * i * kit.ps * 0.9;
        const ya = fr.ground(ax, az) + s.hB - drop, yb = fr.ground(bx, bz) + s.hB - drop;
        const sag = Math.min(1.2, (xb - xa) * 0.03);
        const mid: [number, number, number] = [(ax + bx) / 2 + ox - fr.ox, (ya + yb) / 2 - sag - fr.oy, (az + bz) / 2 + oz - fr.oz];
        d.pipe([ax + ox - fr.ox, ya - fr.oy, az + oz - fr.oz], mid, 0.035 * k + 0.02, 4);
        d.pipe(mid, [bx + ox - fr.ox, yb - fr.oy, bz + oz - fr.oz], 0.035 * k + 0.02, 4);
      }
    }
  }
  if (d.triangleCount) {
    const bm = new THREE.Mesh(d.build(), mat);
    bm.position.set(fr.ox, fr.oy, fr.oz);
    bm.receiveShadow = true;
    bm.name = 'substation-busbars';
    out.detail.push(bm);
  }
  return out;
}
