// Railway traffic on the North Caucasus main line (Armavir - Nevinnomysskaya - Mineralnye Vody, 25 kV)
// and the Cherkessk branch: long-distance passenger trains (EP1-type locomotive + RZD coaches),
// ED9M suburban EMUs, freight trains (2ES5K "Ermak" + tank cars / fertilizer hoppers / gondolas /
// box cars / containers) plus wagons standing on the station yard and the Azot works sidings.
// Routes come from pipeline/build_traffic.py (traffic/rail.json.gz). Rail-top heights follow the
// roads module (formation surface + 0.72 m, bridge decks) or the terrain.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { fetchJSON } from '../../core/data';
import { Builder, MAT, col, loft, type Iv, type MatSpec, type Station } from './geom';
import { FleetRenderer, basisMatrix } from './render';
import { Poly, Rng, clamp } from './util';

const RAIL_TOP = 0.72;

// ------------------------------------------------------------------------------------------ models
export interface StockType { name: string; L: number; bogie: number; r: number; lod0: THREE.BufferGeometry; lod1: THREE.BufferGeometry }

function bogies(b: Builder, zs: number[], r: number, lod: number, frame: MatSpec): void {
  const g = 0.7975; // half gauge
  for (const zc of zs) {
    b.box(0, 0.62, zc, 2.3, 0.35, 2.6, frame, 0);
    if (lod === 0) {
      for (const sg of [1, -1]) {
        b.box(sg * 1.12, 0.55, zc, 0.12, 0.5, 2.9, frame);
        b.box(sg * 1.1, 0.85, zc, 0.3, 0.25, 0.5, MAT.steel); // spring pack
      }
    }
    if (lod > 0) continue;
    for (const dz of [-0.925, 0.925]) {
      const z = zc + dz;
      for (const sg of [1, -1]) {
        b.wheel = [r, z];
        b.cylX(sg * (g - 0.07), sg * (g + 0.07), r, z, r, lod ? 6 : 12, MAT.steel, sg < 0 ? col(0x2a2622, 0.8, 0.5) : null, sg > 0 ? col(0x2a2622, 0.8, 0.5) : null);
        b.wheel = null;
      }
    }
  }
}

function ends(b: Builder, L: number, y: number, lod: number): void {
  // SA-3 automatic couplers + end beams
  for (const sg of [1, -1]) {
    b.box(0, y, sg * (L / 2 + 0.25), 0.35, 0.3, 0.55, col(0x202020, 0.6, 0.4));
    if (lod === 0) b.box(0, y, sg * (L / 2 - 0.05), 2.9, 0.35, 0.12, col(0x1d1d1d, 0.7, 0.3));
  }
}

function underframe(b: Builder, L: number, y: number, w: number, m: MatSpec): void {
  b.box(0, y, 0, w, 0.3, L - 0.2, m);
}

/** Coach body stations (constant section) with windows. */
function carBody(L: number, yb: number, yw: number, yt: number, hw: number, crown: number, windows: Array<[number, number]>, nose?: { len: number; yw: number }): { st: Station[]; iv: Iv[] } {
  const st: Station[] = [];
  const iv: Iv[] = [];
  const S = (z: number, k: Iv, f = 1) => { st.push({ z, yb, yw, yt: yt - (1 - f) * 0.1, wb: hw - 0.05, wm: hw, wt: hw - 0.18, cr: crown }); iv.push(k); };
  const z0 = -L / 2, z1 = L / 2 - (nose ? nose.len : 0);
  st.push({ z: z0, yb: yb + 0.02, yw, yt: yt - 0.06, wb: hw - 0.08, wm: hw - 0.04, wt: hw - 0.22, cr: crown * 0.9 });
  iv.push('body');
  S(z0 + 0.06, 'body');
  for (const [a, c] of windows) {
    S(z0 + a, 'win');
    S(z0 + c, 'body');
  }
  S(z1 - 0.06, 'body');
  if (nose) {
    iv[iv.length - 1] = 'body';
    st.push({ z: z1, yb, yw, yt, wb: hw - 0.05, wm: hw, wt: hw - 0.18, cr: crown }); iv.push('ws');
    st.push({ z: z1 + nose.len, yb: yb + 0.05, yw: nose.yw, yt: nose.yw + 0.55, wb: hw - 0.25, wm: hw - 0.2, wt: hw - 0.45, cr: crown * 0.4 });
  } else {
    st.push({ z: z1, yb: yb + 0.02, yw, yt: yt - 0.06, wb: hw - 0.08, wm: hw - 0.04, wt: hw - 0.22, cr: crown * 0.9 });
  }
  return { st, iv };
}

function windowsEvery(L: number, from: number, to: number, w: number, gap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let z = from; z + w <= L - to; z += w + gap) out.push([z, z + w]);
  return out;
}

function buildCoach(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const L = 25.5, hw = 1.56;
  const red = col(0xb3152b, 0.35, 0, { cc: true });
  const roof = col(0x55595e, 0.6, 0.3);
  const { st, iv } = carBody(L, 1.05, 2.0, 4.05, hw, 0.32, windowsEvery(L, 2.3, 2.3, 1.05, 0.28));
  loft(b, st, iv, { paint: MAT.paint, glass: MAT.glass, glassLit: MAT.glassLit, trim: MAT.trim, under: MAT.under, roof, lower: red }, lod, 'paint', 'paint', 1.55);
  // red band under the windows
  for (const sg of [1, -1]) b.quad([sg * (hw + 0.004), 1.78, -L / 2 + 0.3], [sg * (hw + 0.004), 1.78, L / 2 - 0.3], [sg * (hw + 0.004), 1.9, L / 2 - 0.3], [sg * (hw + 0.004), 1.9, -L / 2 + 0.3], red, [sg, 0, 0]);
  // doors (vestibules) at both ends on both sides
  if (lod === 0) {
    for (const sg of [1, -1]) for (const zz of [-L / 2 + 0.6, L / 2 - 1.5]) b.quad([sg * (hw + 0.006), 1.15, zz], [sg * (hw + 0.006), 1.15, zz + 0.9], [sg * (hw + 0.006), 3.1, zz + 0.9], [sg * (hw + 0.006), 3.1, zz], col(0x6e7378, 0.4, 0.3), [sg, 0, 0]);
    underframe(b, L, 0.95, 2.6, MAT.under);
    for (const z of [-5, -1, 3, 6]) b.box(0, 0.75, z, 2.2, 0.45, 1.6, col(0x262626, 0.8, 0.2));
    // gangway bellows
    for (const sg of [1, -1]) b.box(0, 2.5, sg * (L / 2 + 0.2), 1.3, 2.2, 0.4, col(0x1c1c1c, 0.9));
  }
  bogies(b, [-8.5, 8.5], 0.475, lod, col(0x1e1f20, 0.7, 0.3));
  ends(b, L, 1.05, lod);
  return b.build(30);
}

function buildLoco(lod: number, passenger: boolean): THREE.BufferGeometry {
  const b = new Builder();
  const L = passenger ? 21.0 : 17.5, hw = 1.58;
  const grey = col(0x9ea3a8, 0.35, 0.2, { cc: true });
  const roof = col(0x4a4c4f, 0.6, 0.4);
  const { st, iv } = carBody(L, 1.2, 2.55, 4.3, hw, 0.18, [], { len: 1.1, yw: 2.35 });
  loft(b, st, iv, { paint: MAT.paint, glass: MAT.glass, trim: MAT.trim, under: MAT.under, roof, lower: grey }, lod, 'glass', 'paint', 1.75);
  // front: headlights, buffer beam; side louvres; roof equipment + pantograph
  const zf = L / 2;
  b.quad([-0.3, 2.12, zf + 0.004], [0.3, 2.12, zf + 0.004], [0.3, 2.28, zf + 0.004], [-0.3, 2.28, zf + 0.004], MAT.head, [0, 0, 1]);
  for (const sg of [1, -1]) b.quad([sg * 0.8, 1.72, zf + 0.004], [sg * 1.15, 1.72, zf + 0.004], [sg * 1.15, 1.9, zf + 0.004], [sg * 0.8, 1.9, zf + 0.004], MAT.head, [0, 0, 1]);
  for (const sg of [1, -1]) b.quad([sg * 0.8, 1.45, zf + 0.004], [sg * 1.1, 1.45, zf + 0.004], [sg * 1.1, 1.58, zf + 0.004], [sg * 0.8, 1.58, zf + 0.004], MAT.tail, [0, 0, 1]);
  if (lod === 0) {
    const louvre = col(0x2b2d30, 0.7, 0.4);
    for (const sg of [1, -1]) {
      for (let z = -L / 2 + 1.2; z < L / 2 - 3.5; z += 1.6) b.quad([sg * (hw + 0.005), 2.7, z], [sg * (hw + 0.005), 2.7, z + 1.2], [sg * (hw + 0.005), 3.5, z + 1.2], [sg * (hw + 0.005), 3.5, z], louvre, [sg, 0, 0]);
      b.quad([sg * (hw + 0.005), 2.55, L / 2 - 3.2], [sg * (hw + 0.005), 2.55, L / 2 - 2.2], [sg * (hw + 0.005), 3.4, L / 2 - 2.2], [sg * (hw + 0.005), 3.4, L / 2 - 3.2], MAT.glass, [sg, 0, 0]);
    }
    // roof: equipment boxes + pantograph (folded diamond)
    b.box(0, 4.45, -2, 1.8, 0.3, 5, roof);
    const pz = passenger ? 3 : -L / 2 + 3;
    b.box(0, 4.55, pz, 1.4, 0.12, 1.2, col(0x303030, 0.6, 0.6));
    b.box(0, 4.95, pz - 0.5, 0.08, 0.08, 1.4, MAT.steel, 0, 0.55);
    b.box(0, 4.95, pz + 0.5, 0.08, 0.08, 1.4, MAT.steel, 0, -0.55);
    b.box(0, 5.35, pz, 1.8, 0.05, 0.2, MAT.steel);
    underframe(b, L, 1.05, 2.8, MAT.under);
    b.box(0, 0.85, 0, 2.2, 0.6, 3.0, col(0x252525, 0.8, 0.3));
    b.box(0, 0.9, zf + 0.05, 3.0, 0.5, 0.15, col(0x1a1a1a, 0.6, 0.4)); // buffer beam
  }
  const bz = passenger ? 5.8 : 4.4;
  bogies(b, [-bz, bz], 0.625, lod, col(0x1c1d1f, 0.7, 0.3));
  ends(b, L, 1.05, lod);
  return b.build(30);
}

function buildEmu(lod: number, head: boolean): THREE.BufferGeometry {
  const b = new Builder();
  const L = 21.5, hw = 1.7;
  const red = col(0xc01a2c, 0.35, 0, { cc: true });
  const roof = col(0x7b8086, 0.55, 0.3);
  const win = windowsEvery(L - (head ? 3.2 : 0), 1.8, 1.4, 1.25, 0.35).filter(([a, c]) => !(a < 7.4 && c > 5.9) && !(a < 15.6 && c > 14.1));
  const { st, iv } = carBody(L, 1.12, 2.05, 4.1, hw, 0.28, win, head ? { len: 1.5, yw: 2.05 } : undefined);
  loft(b, st, iv, { paint: MAT.paint, glass: MAT.glass, glassLit: MAT.glassLit, trim: MAT.trim, under: MAT.under, roof, lower: red }, lod, head ? 'glass' : 'paint', 'paint', 1.45);
  // doors: two pairs per side (red leaves)
  for (const sg of [1, -1]) {
    for (const zz of [-L / 2 + 6.0, -L / 2 + 14.2]) {
      b.quad([sg * (hw + 0.006), 1.15, zz], [sg * (hw + 0.006), 1.15, zz + 1.3], [sg * (hw + 0.006), 3.2, zz + 1.3], [sg * (hw + 0.006), 3.2, zz], red, [sg, 0, 0]);
      if (lod === 0) b.quad([sg * (hw + 0.008), 2.2, zz + 0.12], [sg * (hw + 0.008), 2.2, zz + 1.18], [sg * (hw + 0.008), 3.0, zz + 1.18], [sg * (hw + 0.008), 3.0, zz + 0.12], MAT.glassLit, [sg, 0, 0]);
    }
  }
  if (head) {
    const zf = L / 2;
    for (const sg of [1, -1]) b.quad([sg * 0.75, 1.6, zf + 0.004], [sg * 1.15, 1.6, zf + 0.004], [sg * 1.15, 1.78, zf + 0.004], [sg * 0.75, 1.78, zf + 0.004], MAT.head, [0, 0, 1]);
    for (const sg of [1, -1]) b.quad([sg * 0.75, 1.38, zf + 0.004], [sg * 1.05, 1.38, zf + 0.004], [sg * 1.05, 1.5, zf + 0.004], [sg * 0.75, 1.5, zf + 0.004], MAT.tail, [0, 0, 1]);
    b.quad([-0.55, 1.78, zf + 0.004], [0.55, 1.78, zf + 0.004], [0.55, 1.95, zf + 0.004], [-0.55, 1.95, zf + 0.004], MAT.sign, [0, 0, 1]);
  } else if (lod === 0) {
    const pz = 0;
    b.box(0, 4.45, pz, 1.4, 0.12, 1.2, col(0x303030, 0.6, 0.6));
    b.box(0, 4.85, pz - 0.5, 0.08, 0.08, 1.4, MAT.steel, 0, 0.55);
    b.box(0, 4.85, pz + 0.5, 0.08, 0.08, 1.4, MAT.steel, 0, -0.55);
    b.box(0, 5.25, pz, 1.8, 0.05, 0.2, MAT.steel);
  }
  if (lod === 0) {
    underframe(b, L, 0.98, 2.6, MAT.under);
    for (const z of [-4, 0, 4]) b.box(0, 0.78, z, 2.3, 0.5, 2.0, col(0x252525, 0.8, 0.2));
  }
  bogies(b, [-7.5, 7.5], 0.525, lod, col(0x1e1f20, 0.7, 0.3));
  ends(b, L, 1.05, lod);
  return b.build(30);
}

function buildTank(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const L = 12.0;
  b.cylZ(-5.2, 5.2, 0, 3.0, 1.5, lod ? 10 : 20, MAT.paint, MAT.paint, MAT.paint, 0.35);
  b.cylY(4.4, 4.85, 0, 0, 0.45, 0.42, lod ? 6 : 12, MAT.paint, null, MAT.paint);
  const frame = col(0x1d1d1d, 0.7, 0.3);
  underframe(b, L, 1.25, 2.4, frame);
  if (lod === 0) {
    for (const sg of [1, -1]) b.box(sg * 1.2, 1.6, 0, 0.25, 0.5, 9.5, frame);
    b.box(0, 4.6, 1.4, 2.2, 0.06, 0.6, frame);
    b.box(1.55, 2.6, 1.4, 0.06, 3.6, 0.5, frame);
    for (const z of [-4.2, 4.2]) b.box(0, 1.55 + 0.4, z, 3.05, 0.1, 0.25, frame);
  }
  bogies(b, [-3.9, 3.9], 0.475, lod, frame);
  ends(b, L, 1.05, lod);
  return b.build(35);
}

function buildHopper(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const L = 14.7, hw = 1.6;
  const st: Station[] = [
    { z: -L / 2 + 0.3, yb: 1.6, yw: 3.6, yt: 4.5, wb: 0.9, wm: hw - 0.02, wt: hw - 0.3, cr: 0.15 },
    { z: -L / 2 + 0.7, yb: 1.1, yw: 3.6, yt: 4.55, wb: 1.2, wm: hw, wt: hw - 0.25, cr: 0.15 },
    { z: L / 2 - 0.7, yb: 1.1, yw: 3.6, yt: 4.55, wb: 1.2, wm: hw, wt: hw - 0.25, cr: 0.15 },
    { z: L / 2 - 0.3, yb: 1.6, yw: 3.6, yt: 4.5, wb: 0.9, wm: hw - 0.02, wt: hw - 0.3, cr: 0.15 },
  ];
  loft(b, st, ['body', 'body', 'body'], { paint: MAT.paint, glass: MAT.glass, trim: MAT.trim, under: MAT.under }, lod);
  const frame = col(0x1d1d1d, 0.7, 0.3);
  if (lod === 0) {
    for (const sg of [1, -1]) for (let z = -L / 2 + 1.5; z < L / 2 - 1; z += 1.35) b.box(sg * (hw + 0.03), 2.4, z, 0.06, 2.4, 0.12, MAT.paint);
    for (let k = -2; k <= 2; k++) b.box(0, 0.95, k * 2.6, 1.6, 0.5, 1.2, frame); // discharge hoppers
    b.box(0, 4.7, 0, 0.6, 0.08, L - 2, frame);
  }
  underframe(b, L, 1.2, 2.0, frame);
  bogies(b, [-5.1, 5.1], 0.475, lod, frame);
  ends(b, L, 1.05, lod);
  return b.build(35);
}

function buildGondola(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const L = 13.9, hw = 1.58, y0 = 1.3, y1 = 3.4;
  const zs = L / 2 - 0.2;
  for (const sg of [1, -1]) {
    b.box(sg * hw, (y0 + y1) / 2, 0, 0.06, y1 - y0, 2 * zs, MAT.paint);
    b.box(0, (y0 + y1) / 2, sg * zs, 2 * hw, y1 - y0, 0.06, MAT.paint);
  }
  b.box(0, y0 + 0.05, 0, 2 * hw, 0.1, 2 * zs, MAT.paint);
  // load: coal / scrap heap in some wagons is added via the fill colour of a low box
  b.box(0, y1 - 0.35, 0, 2 * hw - 0.15, 0.2, 2 * zs - 0.15, col(0x1c1a18, 0.95));
  if (lod === 0) {
    for (const sg of [1, -1]) for (let z = -zs + 0.9; z < zs; z += 1.75) b.box(sg * (hw + 0.05), (y0 + y1) / 2, z, 0.08, y1 - y0, 0.12, MAT.paint);
  }
  const frame = col(0x1d1d1d, 0.7, 0.3);
  underframe(b, L, 1.15, 2.4, frame);
  bogies(b, [-4.3, 4.3], 0.475, lod, frame);
  ends(b, L, 1.05, lod);
  return b.build(35);
}

function buildBoxcar(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const L = 15.7, hw = 1.6;
  const st: Station[] = [
    { z: -L / 2 + 0.2, yb: 1.3, yw: 3.9, yt: 4.6, wb: hw, wm: hw, wt: hw - 0.08, cr: 0.25 },
    { z: L / 2 - 0.2, yb: 1.3, yw: 3.9, yt: 4.6, wb: hw, wm: hw, wt: hw - 0.08, cr: 0.25 },
  ];
  loft(b, st, ['body'], { paint: MAT.paint, glass: MAT.glass, trim: MAT.trim, under: MAT.under }, lod);
  const frame = col(0x1d1d1d, 0.7, 0.3);
  if (lod === 0) {
    for (const sg of [1, -1]) {
      b.box(sg * (hw + 0.03), 2.65, 0, 0.04, 2.6, 3.9, col(0x3b2a22, 0.8));
      for (let z = -L / 2 + 0.8; z < L / 2 - 0.5; z += 1.1) if (Math.abs(z) > 2.1) b.box(sg * (hw + 0.02), 2.95, z, 0.04, 3.2, 0.1, MAT.paint);
    }
  }
  underframe(b, L, 1.15, 2.4, frame);
  bogies(b, [-5.4, 5.4], 0.475, lod, frame);
  ends(b, L, 1.05, lod);
  return b.build(35);
}

function buildFlatContainer(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const L = 13.6;
  const frame = col(0x2a2a2a, 0.7, 0.3);
  b.box(0, 1.25, 0, 2.9, 0.25, L - 0.2, frame);
  // 40 ft container (per-instance colour)
  b.box(0, 1.4 + 1.3, 0, 2.44, 2.59, 12.19, MAT.paint);
  if (lod === 0) {
    for (const sg of [1, -1]) for (let z = -5.8; z <= 5.8; z += 0.4) b.box(sg * 1.225, 2.7, z, 0.02, 2.5, 0.12, MAT.paint);
    b.box(0, 2.7, 6.1, 2.3, 2.45, 0.02, col(0x404040, 0.6, 0.5));
  }
  bogies(b, [-4.4, 4.4], 0.475, lod, frame);
  ends(b, L, 1.05, lod);
  return b.build(35);
}

export function stockTypes(): StockType[] {
  const mk = (name: string, L: number, bogie: number, r: number, f: (lod: number) => THREE.BufferGeometry): StockType => {
    let lod0: THREE.BufferGeometry, lod1: THREE.BufferGeometry;
    try { lod0 = f(0); lod1 = f(1); } catch (e) {
      console.error('[traffic] rolling stock build failed', name, e);
      lod0 = lod1 = new THREE.BoxGeometry(3, 4, L).translate(0, 2, 0);
    }
    return { name, L, bogie, r, lod0, lod1 };
  };
  return [
    mk('2ES5K section', 17.5 + 0.9, 4.4, 0.625, (l) => buildLoco(l, false)),
    mk('EP1 passenger loco', 21.0 + 0.9, 5.8, 0.625, (l) => buildLoco(l, true)),
    mk('RZD coach', 25.5 + 1.0, 8.5, 0.475, buildCoach),
    mk('ED9M head car', 21.5 + 0.9, 7.5, 0.525, (l) => buildEmu(l, true)),
    mk('ED9M car', 21.5 + 0.9, 7.5, 0.525, (l) => buildEmu(l, false)),
    mk('tank car', 12.0 + 0.4, 3.9, 0.475, buildTank),
    mk('hopper', 14.7 + 0.4, 5.1, 0.475, buildHopper),
    mk('gondola', 13.9 + 0.4, 4.3, 0.475, buildGondola),
    mk('box car', 15.7 + 0.4, 5.4, 0.475, buildBoxcar),
    mk('flat + container', 13.6 + 0.4, 4.4, 0.475, buildFlatContainer),
  ];
}
export const ST = { LOCO: 0, PLOCO: 1, COACH: 2, EMU_HEAD: 3, EMU: 4, TANK: 5, HOPPER: 6, GONDOLA: 7, BOX: 8, FLAT: 9 };
/** siding car type codes (pipeline) -> stock type */
const SIDING_TYPE = [ST.TANK, ST.HOPPER, ST.GONDOLA, ST.BOX, ST.FLAT];

// ------------------------------------------------------------------------------------------ routes
interface Route {
  name: string; kind: string; el: number;
  poly: Poly;
  yTop: Float32Array; // rail top every STEP m
  stops: Array<[number, string]>;
}
const STEP = 4;

interface Car { type: number; flip: boolean; color: [number, number, number]; metal: number; dirt: number }
interface Train {
  route: Route; kind: 'pass' | 'emu' | 'freight';
  cars: Car[]; len: number;
  s: number;          // head position along the route
  v: number; vmax: number;
  dwell: number; nextStop: number; // index into route.stops
  odo: number;
}

const _p = [0, 0, 0, 0];
const _q = [0, 0, 0, 0];

export class Trains {
  types: StockType[] = [];
  routes: Route[] = [];
  trains: Train[] = [];
  renderer!: FleetRenderer;
  static!: FleetRenderer;
  private sidingCars: Array<{ type: number; m: Float32Array; c: [number, number, number]; metal: number; dirt: number; x: number; z: number }> = [];
  private rng = new Rng(4242);
  private mat = new Float32Array(16);
  private timer = 20;
  private lastStaticX = Infinity;
  private lastStaticZ = Infinity;
  private roads: any;
  private bridges: Array<{ id: number; axis: number[] }> = [];

  constructor(private ctx: AppContext, private material: THREE.Material) {}

  async init(): Promise<void> {
    const data = await fetchJSON<any>('traffic/rail.json.gz');
    this.types = stockTypes();
    this.roads = this.ctx.get<any>('roads');
    try {
      this.bridges = (this.roads?.bridges?.() ?? []).filter((b: any) => b.kind === 'rail' && b.axis?.length >= 4);
    } catch { this.bridges = []; }
    for (const r of data.routes) this.routes.push(this.makeRoute(r));
    const caps = this.types.map((_, i) => (i === ST.TANK || i === ST.HOPPER ? [120, 400] : i === ST.COACH || i === ST.GONDOLA ? [80, 200] : [40, 120]));
    this.renderer = new FleetRenderer('traffic-trains', { lods: this.types.map((t) => [t.lod0, t.lod1]) }, this.material, caps);
    const scaps = this.types.map((_, i) => (i === ST.TANK || i === ST.HOPPER || i === ST.GONDOLA || i === ST.BOX || i === ST.FLAT ? [150, 1200] : [1, 1]));
    this.static = new FleetRenderer('traffic-wagons', { lods: this.types.map((t) => [t.lod0, t.lod1]) }, this.material, scaps);
    this.static.castShadowLod = 0;
    this.static.setShadows(true);
    this.buildSidings(data.sidings ?? []);
    this.initialTrains();
  }

  private makeRoute(r: any): Route {
    const poly = new Poly(r.p);
    const n = Math.max(2, Math.ceil(poly.length / STEP) + 1);
    const yTop = new Float32Array(n);
    // bridge ranges -> roads bridge groups (or linear interpolation between the abutments)
    const ranges: Array<{ s0: number; s1: number; g: number }> = (r.br ?? []).map((b: number[]) => {
      poly.at((b[0] + b[1]) / 2, _p);
      let g = -1, bd = 12;
      for (const br of this.bridges) {
        const d = distToPolyline(br.axis, _p[0], _p[1]);
        if (d < bd) { bd = d; g = br.id; }
      }
      return { s0: b[0] - 2, s1: b[1] + 2, g };
    });
    for (let i = 0; i < n; i++) {
      const s = Math.min(poly.length, i * STEP);
      poly.at(s, _p);
      const rg = ranges.find((q) => s >= q.s0 && s <= q.s1);
      yTop[i] = this.formation(_p[0], _p[1], rg ? rg.g : -1) + RAIL_TOP;
    }
    for (const rg of ranges) {
      if (rg.g >= 0) continue;
      const i0 = Math.max(0, Math.floor(rg.s0 / STEP) - 1), i1 = Math.min(n - 1, Math.ceil(rg.s1 / STEP) + 1);
      for (let i = i0 + 1; i < i1; i++) yTop[i] = yTop[i0] + ((yTop[i1] - yTop[i0]) * (i - i0)) / (i1 - i0);
    }
    return { name: r.name, kind: r.kind, el: r.el, poly, yTop, stops: r.stops ?? [] };
  }

  private formation(x: number, z: number, g: number): number {
    const rd = this.roads;
    if (rd?.heightAt) {
      try { return rd.heightAt(x, z, g); } catch { /* fall back */ }
    }
    return this.ctx.heightfield.sample(x, z);
  }

  private yAt(r: Route, s: number): number {
    const f = clamp(s / STEP, 0, r.yTop.length - 1.001);
    const i = Math.floor(f), t = f - i;
    return r.yTop[i] * (1 - t) + r.yTop[i + 1] * t;
  }

  // ---------------------------------------------------------------- consists
  private carColor(type: number): [number, number, number, number] {
    const c = new THREE.Color();
    const r = this.rng.next();
    let metal = 0;
    switch (type) {
      case ST.LOCO: case ST.PLOCO: c.setHex(0xc8182c); break;
      case ST.COACH: c.setHex(r < 0.8 ? 0xa7abb0 : 0x8f959b); break;
      case ST.EMU_HEAD: case ST.EMU: c.setHex(0xd9dbdc); break;
      case ST.TANK: c.setHex(r < 0.45 ? 0x151515 : r < 0.8 ? 0xb9b7ad : 0x5d6168); metal = 0.3; break;
      case ST.HOPPER: c.setHex(r < 0.5 ? 0x8d9296 : r < 0.8 ? 0x5f7f97 : 0x9c7b52); break;
      case ST.GONDOLA: c.setHex(r < 0.5 ? 0x5a3326 : r < 0.8 ? 0x3f4a3c : 0x6b6259); break;
      case ST.BOX: c.setHex(r < 0.6 ? 0x6b3022 : 0x4c5a66); break;
      case ST.FLAT: c.setHex([0x1f4f8f, 0xa2261f, 0x2f6b3a, 0x8a8f94, 0xd07a1a, 0x5b2f63][Math.floor(r * 6)]); break;
    }
    return [c.r, c.g, c.b, metal];
  }

  private car(type: number, flip = false): Car {
    const [r, g, b, metal] = this.carColor(type);
    return { type, flip, color: [r, g, b], metal, dirt: type >= ST.TANK ? 0.5 + this.rng.next() * 0.5 : 0.25 };
  }

  private consist(kind: Train['kind']): Car[] {
    const r = this.rng;
    const cars: Car[] = [];
    if (kind === 'pass') {
      cars.push(this.car(ST.PLOCO));
      const n = 11 + r.int(7);
      const c = this.car(ST.COACH);
      for (let i = 0; i < n; i++) cars.push({ ...c, color: c.color });
    } else if (kind === 'emu') {
      const n = 4 + 2 * r.int(3);
      cars.push(this.car(ST.EMU_HEAD));
      for (let i = 0; i < n; i++) cars.push(this.car(ST.EMU));
      cars.push(this.car(ST.EMU_HEAD, true));
    } else {
      cars.push(this.car(ST.LOCO), this.car(ST.LOCO, true));
      const n = 35 + r.int(25);
      const mix = r.next();
      let blk = -1, left = 0;
      for (let i = 0; i < n; i++) {
        if (left <= 0) {
          const u = r.next();
          blk = mix < 0.4 ? (u < 0.6 ? ST.TANK : ST.HOPPER) : u < 0.3 ? ST.TANK : u < 0.55 ? ST.HOPPER : u < 0.75 ? ST.GONDOLA : u < 0.9 ? ST.BOX : ST.FLAT;
          left = 4 + r.int(14);
        }
        cars.push(this.car(blk));
        left--;
      }
    }
    return cars;
  }

  private spawn(route: Route, kind: Train['kind'], s: number, v?: number): Train {
    const cars = this.consist(kind);
    let len = 0;
    for (const c of cars) len += this.types[c.type].L;
    const vmax = kind === 'pass' ? 90 / 3.6 : kind === 'emu' ? 80 / 3.6 : 65 / 3.6;
    const t: Train = { route, kind, cars, len, s, v: v ?? vmax, vmax, dwell: 0, nextStop: 0, odo: 0 };
    t.nextStop = route.stops.findIndex(([ss]) => ss > s - 2);
    if (t.nextStop < 0) t.nextStop = route.stops.length;
    this.trains.push(t);
    return t;
  }

  /** stops served by a train kind */
  private serves(t: Train, name: string): boolean {
    if (t.kind === 'freight') return false;
    if (t.kind === 'pass') return name === 'Невинномысская';
    return true;
  }

  private initialTrains(): void {
    const main = this.routes.filter((r) => r.kind === 'main');
    const branch = this.routes.filter((r) => r.kind === 'branch');
    if (main[0]) {
      // a long-distance train standing at Nevinnomysskaya (station view), a freight on the other track
      const st = main[0].stops.find(([, n]) => n === 'Невинномысская');
      if (st) {
        const t = this.spawn(main[0], 'pass', 0, 0);
        t.s = st[0] + t.len * 0.45;
        t.dwell = 150 + this.rng.next() * 60;
        t.nextStop = main[0].stops.indexOf(st) + 1;
      }
      this.spawn(main[0], 'freight', main[0].poly.length * 0.25, 60 / 3.6);
    }
    if (main[1]) {
      const st = main[1].stops.find(([, n]) => n === 'Невинномысская');
      if (st) this.spawn(main[1], 'freight', st[0] - 900, 45 / 3.6);
      this.spawn(main[1], 'emu', main[1].poly.length * 0.2, 70 / 3.6);
    }
    if (branch[0]) this.spawn(branch[0], 'freight', branch[0].poly.length * 0.3, 50 / 3.6);
  }

  // ---------------------------------------------------------------- sidings
  private buildSidings(sidings: Array<{ p: number[]; cars: number[][] }>): void {
    for (const sd of sidings) {
      const poly = new Poly(sd.p);
      for (const [s, code] of sd.cars) {
        const type = SIDING_TYPE[code] ?? ST.TANK;
        const ty = this.types[type];
        const half = ty.bogie;
        poly.at(Math.max(0, s - half), _p);
        poly.at(Math.min(poly.length, s + half), _q);
        const yr = this.formation(_p[0], _p[1], -1) + RAIL_TOP, yf = this.formation(_q[0], _q[1], -1) + RAIL_TOP;
        const m = new Float32Array(16);
        const x = (_p[0] + _q[0]) / 2, z = (_p[1] + _q[1]) / 2;
        basisMatrix(m, 0, x, (yr + yf) / 2, z, _q[0] - _p[0], yf - yr, _q[1] - _p[1]);
        const [r, g, b, metal] = this.carColor(type);
        this.sidingCars.push({ type, m, c: [r, g, b], metal, dirt: 0.6 + this.rng.next() * 0.4, x, z });
      }
    }
  }

  private drawStatic(): void {
    const cam = this.ctx.camera.position;
    if (Math.hypot(cam.x - this.lastStaticX, cam.z - this.lastStaticZ) < 30) return;
    this.lastStaticX = cam.x; this.lastStaticZ = cam.z;
    const agl = Math.max(0, this.ctx.cameraAGL);
    const R = clamp(1500 + agl * 3, 1500, 5000), R2 = R * R;
    const S = this.static;
    S.begin();
    for (const c of this.sidingCars) {
      const d2 = (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2;
      if (d2 > R2) continue;
      S.push(c.type, d2 < 160 * 160 ? 0 : 1, c.m, 0, c.c[0], c.c[1], c.c[2], 0, -1, c.metal, c.dirt);
    }
    S.end();
  }

  // ---------------------------------------------------------------- simulation
  update(dt: number): void {
    const h = Math.min(dt, 0.1);
    // schedule new trains
    this.timer -= h;
    if (this.timer <= 0 && this.routes.length) {
      this.timer = 90 + this.rng.next() * 150;
      if (this.trains.length < 5) {
        const r = this.rng.pick(this.routes);
        const u = this.rng.next();
        const kind: Train['kind'] = r.kind === 'branch' ? (u < 0.75 ? 'freight' : 'pass') : u < 0.45 ? 'freight' : u < 0.75 ? 'emu' : 'pass';
        this.spawn(r, kind, 0);
      }
    }
    for (const t of this.trains) this.step(t, h);
    this.trains = this.trains.filter((t) => t.s - t.len < t.route.poly.length);
    this.draw();
    this.drawStatic();
  }

  private step(t: Train, dt: number): void {
    const r = t.route;
    if (t.dwell > 0) {
      t.dwell -= dt;
      t.v = 0;
      return;
    }
    // target speed: stops ahead, station speed limit around Nevinnomysskaya
    let vT = t.vmax;
    const accel = t.kind === 'freight' ? 0.12 : t.kind === 'emu' ? 0.6 : 0.3;
    const brake = t.kind === 'freight' ? 0.25 : 0.5;
    for (let k = t.nextStop; k < r.stops.length; k++) {
      const [ss, name] = r.stops[k];
      const stopHead = ss + (t.kind === 'emu' ? t.len * 0.5 : t.len * 0.45);
      if (!this.serves(t, name)) {
        if (name === 'Невинномысская') {
          const d = ss - 1500 - t.s;
          vT = Math.min(vT, Math.max(40 / 3.6, Math.sqrt(Math.max(0, (40 / 3.6) ** 2 + 2 * brake * Math.max(0, d)))));
          if (t.s > ss - 1500 && t.s - t.len < ss + 1500) vT = Math.min(vT, 40 / 3.6);
        }
        continue;
      }
      const d = stopHead - t.s;
      if (d < -5) { t.nextStop = k + 1; continue; }
      vT = Math.min(vT, Math.sqrt(2 * brake * Math.max(0, d)));
      if (d < 1.5 && t.v < 0.5) {
        t.dwell = t.kind === 'emu' ? 25 + this.rng.next() * 15 : 120 + this.rng.next() * 120;
        t.nextStop = k + 1;
        t.v = 0;
        return;
      }
      break;
    }
    if (t.v < vT) t.v = Math.min(vT, t.v + accel * dt);
    else t.v = Math.max(vT, t.v - brake * 1.5 * dt);
    t.s += t.v * dt;
    t.odo += t.v * dt;
  }

  private draw(): void {
    const cam = this.ctx.camera.position;
    const R = this.renderer;
    const m = this.mat;
    R.begin();
    for (const t of this.trains) {
      const r = t.route;
      let s = t.s;
      for (const c of t.cars) {
        const ty = this.types[c.type];
        const sc = s - ty.L / 2;
        s -= ty.L;
        if (sc + ty.L < 0 || sc - ty.L > r.poly.length) continue;
        const sr = clamp(sc - ty.bogie, 0, r.poly.length), sf = clamp(sc + ty.bogie, 0, r.poly.length);
        r.poly.at(sr, _p);
        r.poly.at(sf, _q);
        const x = (_p[0] + _q[0]) / 2, z = (_p[1] + _q[1]) / 2;
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d > 6000) continue;
        const yr = this.yAt(r, sr), yf = this.yAt(r, sf);
        let fx = _q[0] - _p[0], fy = yf - yr, fz = _q[1] - _p[1];
        if (c.flip) { fx = -fx; fy = -fy; fz = -fz; }
        basisMatrix(m, 0, x, (yr + yf) / 2, z, fx, fy, fz);
        // head/tail lamps: the leading car shows headlights, trailing cab car tail lamps (brake channel)
        // lamp state: 0 leading (headlights), 2 trailing cab (tail lamps only), -1 all off
        const cab = c.type === ST.LOCO || c.type === ST.PLOCO || c.type === ST.EMU_HEAD;
        const lampState = cab && c.flip ? (t.kind === 'emu' ? 2 : -1) : 0;
        R.push(c.type, d < 180 ? 0 : 1, m, 0, c.color[0], c.color[1], c.color[2], (t.odo / ty.r) % (Math.PI * 2), lampState, c.metal, c.dirt);
      }
    }
    R.end();
  }

  /** debug: summary of running trains */
  summary(): string {
    return this.trains.map((t) => `${t.kind}@${t.route.name}:${Math.round(t.s)}m ${Math.round(t.v * 3.6)}km/h${t.dwell > 0 ? ' dwell' : ''}`).join('; ');
  }
}

function distToPolyline(p: number[], x: number, z: number): number {
  let best = Infinity;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const ax = p[k], az = p[k + 1], bx = p[k + 2], bz = p[k + 3];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

