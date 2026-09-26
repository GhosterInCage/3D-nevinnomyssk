// Procedural road-vehicle models typical for Nevinnomyssk: Lada 2107 / 2114 / Priora-Granta /
// Vesta-Solaris-Rio, Kalina-type hatch, Lada Niva, crossovers, UAZ-452 "Bukhanka", GAZelle
// marshrutka + flatbed with tent, PAZ-3205 and LiAZ-5256 buses, KamAZ-65115 dump truck.
// Each type has LOD0 (~1-3k triangles, lights, wheels, mirrors, plates) and LOD1 (~150-300).
// Model frame: +Z forward, +Y up, ground at y = 0, origin at the wheelbase centre.
import * as THREE from 'three';
import { Builder, MAT, col, loft, sideX, shiftZ, simplifyStations, stationAt, type Iv, type LoftMats, type MatSpec, type Station } from './geom';

export type Palette = Array<[number, number, number]>; // [hex sRGB, weight, metallic 0..1]

export interface VehicleType {
  id: number;
  name: string;
  kind: 'car' | 'van' | 'bus' | 'truck';
  L: number; W: number; H: number;
  wb: number; r: number;
  lod0: THREE.BufferGeometry;
  lod1: THREE.BufferGeometry;
  lod2: THREE.BufferGeometry;
  palette: Palette;
  weight: number;       // share of moving traffic
  parkWeight: number;   // share of parked cars
  accel: number;        // m/s^2
  vmax: number;         // m/s (own limit)
  transit: boolean;     // stops at bus stops
  dirt: number;         // typical dirt amount
}

const MODERN: Palette = [
  [0xe9eae8, 20, 0], [0xa9acae, 15, 1], [0x5d6166, 10, 1], [0x101113, 13, 0.6], [0x1c2a48, 5, 1], [0x2f5d9c, 3, 1],
  [0x8e1212, 5, 0], [0x4d0f1c, 3, 1], [0xbfae8c, 3, 1], [0x2c4632, 2, 1], [0x4a3627, 3, 1], [0x7f97b3, 2, 1],
  [0x38233d, 2, 1], [0xc9d0d6, 4, 1], [0xd4a017, 1, 0], [0xb8b2a6, 3, 1],
];
const SOVIET: Palette = [
  [0xe6e3da, 18, 0], [0xcdbb93, 8, 0], [0x5a1320, 10, 1], [0x1d2b4f, 9, 1], [0x2d4a32, 7, 0], [0x3a2440, 7, 1],
  [0x7fa7c4, 5, 0], [0x9a1a14, 6, 0], [0x8c8f92, 8, 1], [0x0f1012, 6, 0], [0xb04a14, 3, 0], [0x6e7a3c, 3, 0],
  [0x4d5d6b, 6, 1], [0xc5c2b2, 4, 0],
];

// ----------------------------------------------------------------------------------- passenger cars
interface CarP {
  L: number; W: number; H: number; wb: number; r: number; ovR: number;
  sill: number; belt: number; nose: number; cowl: number; tail: number;
  zCowl: number;   // cowl (windshield base) distance from the front
  zRoofF: number;  // roof front from the front
  zRoofR: number;  // roof rear from the rear
  zDeck: number;   // rear window base from the rear (sedan)
  style: 'sedan' | 'hatch' | 'box';
  tumble: number; crown: number;
  bumper: 'chrome' | 'black' | 'paint';
  head: [number, number]; tailL: [number, number];
  grille: 'chrome' | 'black' | 'none';
  flare?: boolean; roofRails?: boolean; spare?: boolean;
}

function carStations(p: CarP): { st: Station[]; iv: Iv[] } {
  const hw = p.W / 2, L = p.L, S = p.sill;
  const st: Station[] = [];
  const iv: Iv[] = [];
  const add = (s: Station, k?: Iv) => { st.push(s); if (k) iv.push(k); };
  const tt = p.tumble;
  if (p.style === 'sedan') {
    add({ z: 0, yb: S + 0.1, yw: p.tail - 0.16, yt: p.tail - 0.07, wb: hw - 0.14, wm: hw - 0.08, wt: hw - 0.14 }, 'trunk');
    add({ z: 0.07, yb: S + 0.03, yw: p.tail - 0.09, yt: p.tail - 0.015, wb: hw - 0.07, wm: hw - 0.03, wt: hw - 0.08 }, 'trunk');
    add({ z: 0.42, yb: S, yw: p.tail - 0.05, yt: p.tail, wb: hw - 0.05, wm: hw, wt: hw - 0.06 }, 'trunk');
    add({ z: p.zDeck, yb: S, yw: p.belt + 0.02, yt: p.tail + 0.03, wb: hw - 0.05, wm: hw, wt: hw - 0.07 }, 'rw');
  } else {
    // hatch / box: lower tailgate panel is the rear cap, the rear window rises from the belt
    const top = p.style === 'box' ? p.belt + 0.04 : p.belt + 0.07;
    add({ z: 0, yb: S + 0.08, yw: top - 0.06, yt: top, wb: hw - 0.1, wm: hw - 0.05, wt: hw - 0.09, cr: 0.0 }, 'trunk');
    add({ z: 0.05, yb: S + 0.02, yw: top - 0.03, yt: top + 0.02, wb: hw - 0.05, wm: hw - 0.01, wt: hw - 0.07 }, 'rwq');
  }
  const rr = p.zRoofR;
  add({ z: rr, yb: S, yw: p.belt + 0.03, yt: p.H - 0.02, wb: hw - 0.05, wm: hw, wt: hw * tt, cr: p.crown * 0.7 }, 'roof');
  const mid = (rr + (L - p.zRoofF)) / 2 + 0.05;
  add({ z: mid - 0.045, yb: S, yw: p.belt + 0.01, yt: p.H, wb: hw - 0.05, wm: hw, wt: hw * tt, cr: p.crown }, 'bp');
  add({ z: mid + 0.045, yb: S, yw: p.belt + 0.01, yt: p.H, wb: hw - 0.05, wm: hw, wt: hw * tt, cr: p.crown }, 'roof');
  add({ z: L - p.zRoofF, yb: S, yw: p.belt, yt: p.H - 0.012, wb: hw - 0.05, wm: hw, wt: hw * tt, cr: p.crown * 0.8 }, 'ws');
  add({ z: L - p.zCowl, yb: S, yw: p.belt - 0.01, yt: p.cowl, wb: hw - 0.05, wm: hw, wt: hw - 0.08 }, 'hood');
  const zh = L - Math.max(0.3, p.zCowl * 0.45);
  add({ z: zh, yb: S, yw: (p.cowl + p.nose) / 2 - 0.05, yt: (p.cowl + p.nose) / 2 + 0.015, wb: hw - 0.05, wm: hw - 0.005, wt: hw - 0.07 }, 'hood');
  add({ z: L - 0.07, yb: S + 0.03, yw: p.nose - 0.08, yt: p.nose, wb: hw - 0.07, wm: hw - 0.03, wt: hw - 0.09 }, 'hood');
  add({ z: L, yb: S + 0.1, yw: p.nose - 0.14, yt: p.nose - 0.06, wb: hw - 0.14, wm: hw - 0.08, wt: hw - 0.14 });
  return { st, iv };
}

function wheels(b: Builder, st: Station[] | null, zs: number[], r: number, halfTrack: number | null, lod: number, w = 0.2, dual = false, rimM: MatSpec = MAT.rim, archX = 0): void {
  const seg = lod > 0 ? 7 : 16;
  if (lod > 1) {
    for (const z of zs) {
      const s = st ? stationAt(st, z) : null;
      const side0 = halfTrack ?? (s ? Math.max(s.wm, sideX(s, r)) : 1);
      b.box(0, r * 0.95, z, (side0 + 0.014) * 2, r * 1.9, r * 1.7, MAT.rubber, 8);
    }
    return;
  }
  for (const z of zs) {
    const s = st ? stationAt(st, z) : null;
    const side0 = halfTrack ?? (s ? Math.max(s.wm, sideX(s, r)) : 1);
    for (const sg of [1, -1]) {
      const xo = sg * (side0 + 0.014);
      if (lod === 0 && s && archX >= 0) {
        // dark wheel arch behind the wheel (reads as a wheel well)
        b.wheel = null;
        b.discX(sg * (s.wm + 0.006 + archX), r, z, r * 1.14, 12, MAT.trim, sg, -Math.PI / 2, Math.PI / 2);
      }
      const tires = dual ? [xo, xo - sg * (w + 0.03)] : [xo];
      for (const x of tires) {
        b.wheel = [r, z];
        b.cylX(x - sg * w, x, r, z, r, seg, MAT.rubber, null, null);
        if (lod === 0) {
          b.discX(x, r, z, r, seg, MAT.rubber, sg, 0, Math.PI * 2, r * 0.66);
          if (x === tires[0]) {
            b.discX(x - sg * 0.012, r, z, r * 0.66, seg, rimM, sg);
            // lug / spoke openings so the rotation reads
            for (let k = 0; k < 5; k++) {
              const a = (k / 5) * Math.PI * 2;
              const cy = r + Math.cos(a) * r * 0.42, cz = z + Math.sin(a) * r * 0.42;
              b.discX(x - sg * 0.006, cy, cz, r * 0.11, 5, MAT.rimDark, sg);
            }
            b.discX(x - sg * 0.004, r, z, r * 0.14, 6, MAT.steel, sg);
          } else {
            b.discX(x - sg * 0.01, r, z, r * 0.6, seg, MAT.rimDark, sg);
          }
        } else {
          b.discX(x, r, z, r, seg, rimM, sg);
        }
      }
    }
  }
  b.wheel = null;
}

/** thin dark panel seam following the body side at z (door gaps), from the sill to the belt */
function seam(b: Builder, st: Station[], z: number, m: MatSpec): void {
  const s = stationAt(st, z);
  const ys = [s.yb + 0.03, s.yb + (s.yw - s.yb) * 0.32, s.yb + (s.yw - s.yb) * 0.72, s.yw - 0.015];
  const w = 0.007;
  for (const sg of [1, -1]) {
    for (let k = 0; k < ys.length - 1; k++) {
      const x0 = sg * (sideX(s, ys[k]) + 0.0025), x1 = sg * (sideX(s, ys[k + 1]) + 0.0025);
      b.quad([x0, ys[k], z - w], [x0, ys[k], z + w], [x1, ys[k + 1], z + w], [x1, ys[k + 1], z - w], m, [sg, 0, 0]);
    }
  }
}

function buildCar(p: CarP, lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const full = carStations(p);
  const { st, iv } = lod > 1 ? simplifyStations(full.st, full.iv) : full;
  const M: LoftMats = { paint: MAT.paint, glass: MAT.glass, trim: MAT.trim, under: MAT.under };
  loft(b, st, iv, M, lod);
  const L = p.L;
  const f = st[st.length - 1], r0 = st[0];
  const zF = L + 0.004, zR = -0.004;
  // lights (both LODs so the car glows at night)
  const hy = (f.yb + f.yt) / 2 + 0.035;
  const hx = f.wm - 0.05 - p.head[0] / 2;
  for (const sg of [1, -1]) {
    b.quad([sg * (hx - p.head[0] / 2), hy - p.head[1] / 2, zF], [sg * (hx + p.head[0] / 2), hy - p.head[1] / 2, zF], [sg * (hx + p.head[0] / 2), hy + p.head[1] / 2, zF], [sg * (hx - p.head[0] / 2), hy + p.head[1] / 2, zF], MAT.head, [0, 0, 1]);
  }
  const ty = (r0.yb + r0.yt) / 2 + (p.style === 'sedan' ? 0.03 : 0.06);
  const tx = r0.wm - 0.04 - p.tailL[0] / 2;
  for (const sg of [1, -1]) {
    b.quad([sg * (tx - p.tailL[0] / 2), ty - p.tailL[1] / 2, zR], [sg * (tx + p.tailL[0] / 2), ty - p.tailL[1] / 2, zR], [sg * (tx + p.tailL[0] / 2), ty + p.tailL[1] / 2, zR], [sg * (tx - p.tailL[0] / 2), ty + p.tailL[1] / 2, zR], MAT.tail, [0, 0, -1]);
  }
  if (lod === 0) {
    // grille
    if (p.grille !== 'none') {
      const gx = hx - p.head[0] / 2 - 0.03;
      const gm = p.grille === 'chrome' ? MAT.chrome : MAT.grille;
      b.quad([-gx, hy - p.head[1] * 0.45, zF + 0.001], [gx, hy - p.head[1] * 0.45, zF + 0.001], [gx, hy + p.head[1] * 0.45, zF + 0.001], [-gx, hy + p.head[1] * 0.45, zF + 0.001], gm, [0, 0, 1]);
      if (p.grille === 'chrome') b.quad([-gx * 0.9, hy - p.head[1] * 0.3, zF + 0.002], [gx * 0.9, hy - p.head[1] * 0.3, zF + 0.002], [gx * 0.9, hy + p.head[1] * 0.3, zF + 0.002], [-gx * 0.9, hy + p.head[1] * 0.3, zF + 0.002], MAT.grille, [0, 0, 1]);
    } else {
      // modern lower air intake
      const gx = f.wm * 0.55;
      b.quad([-gx, f.yb + 0.05, zF], [gx, f.yb + 0.05, zF], [gx, f.yb + 0.17, zF], [-gx, f.yb + 0.17, zF], MAT.grille, [0, 0, 1]);
    }
    // bumpers
    const bm = p.bumper === 'chrome' ? MAT.chrome : p.bumper === 'black' ? MAT.trim : MAT.paint;
    if (p.bumper !== 'paint') {
      b.box(0, f.yb + 0.1, L + 0.02, (f.wm + 0.02) * 2, 0.14, 0.12, bm, 4);
      b.box(0, r0.yb + 0.1, -0.02, (r0.wm + 0.02) * 2, 0.14, 0.12, bm, 4);
    }
    // number plates (white, Russian format 520x112)
    const pzF = p.bumper !== 'paint' ? L + 0.082 : zF + 0.002;
    const pzR = p.bumper !== 'paint' ? -0.082 : zR - 0.002;
    const pyF = p.bumper !== 'paint' ? f.yb + 0.1 : f.yb + 0.17;
    const pyR = p.bumper !== 'paint' ? r0.yb + 0.22 : ty - 0.12;
    b.quad([-0.26, pyF - 0.056, pzF], [0.26, pyF - 0.056, pzF], [0.26, pyF + 0.056, pzF], [-0.26, pyF + 0.056, pzF], MAT.plate, [0, 0, 1]);
    b.quad([-0.26, pyR - 0.056, pzR], [0.26, pyR - 0.056, pzR], [0.26, pyR + 0.056, pzR], [-0.26, pyR + 0.056, pzR], MAT.plate, [0, 0, -1]);
    // side mirrors
    const cw = st[st.length - 4];
    for (const sg of [1, -1]) b.box(sg * (p.W / 2 + 0.04), p.belt + 0.1, cw.z - 0.15, 0.14, 0.1, 0.07, p.bumper === 'chrome' ? MAT.chrome : MAT.paint);
    // door gaps
    const gap = col(0x0b0b0c, 0.6, 0.0);
    const bpS = st.find((s, i) => iv[i] === 'bp') ?? st[4];
    const cowl = st[st.length - 4];
    seam(b, st, bpS.z + 0.045, gap);
    seam(b, st, cowl.z - 0.12, gap);
    if (p.style === 'sedan' || p.L > 4.05) seam(b, st, st.find((s, i) => iv[i] === 'roof')!.z - 0.05, gap);
    // door handles + sill trim
    for (const sg of [1, -1]) {
      const bp = st.find((s, i) => iv[i] === 'bp') ?? st[4];
      for (const z of [bp.z + 0.75, bp.z - 0.35]) b.box(sg * (sideX(stationAt(st, z), p.belt - 0.08) + 0.004), p.belt - 0.08, z, 0.012, 0.025, 0.12, p.bumper === 'chrome' ? MAT.chrome : MAT.trim);
    }
    if (p.roofRails) {
      const rs = st.filter((_, i) => iv[i] === 'roof' || iv[i] === 'bp');
      const z0 = rs[0].z - 0.1, z1 = st[st.length - 5].z - 0.25;
      for (const sg of [1, -1]) b.box(sg * (p.W / 2 * p.tumble - 0.08), p.H + 0.04, (z0 + z1) / 2, 0.05, 0.05, z1 - z0, MAT.trim);
    }
    if (p.spare) b.cylZ(-0.2, -0.02, 0, r0.yb + 0.45, p.r * 1.05, 12, MAT.rubber, MAT.trim, null);
  }
  wheels(b, st, [p.ovR, p.ovR + p.wb], p.r, null, lod, p.r > 0.33 ? 0.22 : 0.19, false, p.bumper === 'chrome' ? MAT.steel : MAT.rim, p.flare ? 0.03 : 0);
  if (p.flare && lod === 0) {
    for (const z of [p.ovR, p.ovR + p.wb]) {
      const s = stationAt(st, z);
      for (const sg of [1, -1]) b.discX(sg * (sideX(s, p.r) + 0.03), p.r, z, p.r * 1.25, 10, MAT.trim, sg, -Math.PI / 2 - 0.3, Math.PI / 2 + 0.3, p.r * 1.1);
    }
  }
  const g = b.build(34);
  shiftZ(g, -(p.ovR + p.wb / 2));
  return g;
}

// ----------------------------------------------------------------------------------- vans / buses / trucks
interface BoxP {
  L: number; W: number; H: number; r: number; axles: number[]; // axle z from rear
  sill: number; belt: number; beltFront: number;
  hoodL: number; hoodH: number; wsL: number; // bonnet length/height, windshield slope length
  windows: Array<[number, number, Iv]>;       // [z0, z1, kind] from rear along the side
  roofWhite?: boolean; twoTone?: number;      // two-tone split height (lower = paint)
  rearGlass?: boolean; crown?: number;
  sign?: boolean; doors?: Array<[number, number]>; dual?: boolean; lit?: boolean;
}

function boxStations(p: BoxP): { st: Station[]; iv: Iv[] } {
  const hw = p.W / 2, L = p.L, S = p.sill;
  const st: Station[] = [];
  const iv: Iv[] = [];
  const cr = p.crown ?? 0.04;
  const body = (z: number, k: Iv) => { st.push({ z, yb: S, yw: p.belt, yt: p.H, wb: hw - 0.02, wm: hw, wt: hw - 0.06, cr }); iv.push(k); };
  st.push({ z: 0, yb: S + 0.03, yw: p.belt, yt: p.H - 0.04, wb: hw - 0.05, wm: hw - 0.03, wt: hw - 0.09, cr: cr * 0.6 });
  iv.push('body');
  const zEnd = L - p.hoodL - p.wsL;
  // side windows sequence
  const cuts: Array<[number, Iv]> = [[0.08, 'body']];
  let last = 0.08;
  for (const [z0, z1, k] of p.windows) {
    if (z0 > last + 0.01) cuts.push([z0, k]); else cuts[cuts.length - 1][1] = k;
    cuts.push([z1, 'pp']);
    last = z1;
  }
  for (const [z, k] of cuts) if (z < zEnd - 0.02) body(z, k);
  // roof front
  st.push({ z: zEnd, yb: S, yw: p.belt, yt: p.H, wb: hw - 0.02, wm: hw, wt: hw - 0.07, cr });
  iv.push(p.wsL > 0.3 ? 'ws' : 'body');
  if (p.wsL > 0.3) {
    st.push({ z: zEnd + p.wsL, yb: S, yw: p.beltFront, yt: p.hoodH, wb: hw - 0.03, wm: hw - 0.01, wt: hw - 0.1, cr: 0.02 });
    iv.push('hood');
  }
  if (p.hoodL > 0.1) {
    st.push({ z: L - 0.08, yb: S + 0.02, yw: p.hoodH - 0.12, yt: p.hoodH - 0.04, wb: hw - 0.06, wm: hw - 0.04, wt: hw - 0.12, cr: 0.02 });
    iv.push('hood');
  }
  st.push({ z: L, yb: S + 0.08, yw: p.hoodL > 0.1 ? p.hoodH - 0.2 : p.beltFront, yt: p.hoodL > 0.1 ? p.hoodH - 0.1 : p.H - 0.05, wb: hw - 0.1, wm: hw - 0.06, wt: hw - 0.12, cr: 0.02 });
  return { st, iv };
}

function buildBox(p: BoxP, lod: number, extra?: (b: Builder, st: Station[]) => void): THREE.BufferGeometry {
  const b = new Builder();
  const full = boxStations(p);
  const { st, iv } = lod > 1 ? simplifyStations(full.st, full.iv) : full;
  const white = col(0xe8e8e4, 0.35, 0, { cc: true });
  const M: LoftMats = {
    paint: p.roofWhite ? white : MAT.paint, glass: MAT.glass, glassLit: p.lit ? MAT.glassLit : MAT.glass, trim: MAT.trim, under: MAT.under,
    roof: p.roofWhite ? white : undefined, lower: p.twoTone ? MAT.paint : undefined,
  };
  loft(b, st, iv, M, lod, p.hoodL > 0.1 ? 'paint' : 'glass', p.rearGlass ? 'glass' : 'paint', p.twoTone ?? -1);
  const f = st[st.length - 1], r0 = st[0], L = p.L;
  const zF = L + 0.004;
  // lights
  const hy = p.hoodL > 0.1 ? (f.yb + f.yt) / 2 + 0.02 : f.yb + 0.3;
  const hwid = 0.22, hh = 0.12;
  const hx = f.wm - 0.08 - hwid / 2;
  for (const sg of [1, -1]) {
    b.quad([sg * (hx - hwid / 2), hy - hh / 2, zF], [sg * (hx + hwid / 2), hy - hh / 2, zF], [sg * (hx + hwid / 2), hy + hh / 2, zF], [sg * (hx - hwid / 2), hy + hh / 2, zF], MAT.head, [0, 0, 1]);
    const tx = r0.wm - 0.12, ty = r0.yb + 0.45;
    b.quad([sg * (tx - 0.08), ty - 0.18, -0.004], [sg * (tx + 0.08), ty - 0.18, -0.004], [sg * (tx + 0.08), ty + 0.18, -0.004], [sg * (tx - 0.08), ty + 0.18, -0.004], MAT.tail, [0, 0, -1]);
  }
  if (p.sign) {
    const sy = p.H - 0.28;
    b.quad([-f.wm * 0.6, sy - 0.1, zF + 0.002], [f.wm * 0.6, sy - 0.1, zF + 0.002], [f.wm * 0.6, sy + 0.1, zF + 0.002], [-f.wm * 0.6, sy + 0.1, zF + 0.002], MAT.sign, [0, 0, 1]);
  }
  if (lod === 0) {
    // bumpers, grille, plates, mirrors
    b.box(0, f.yb + 0.08, L + 0.03, (f.wm + 0.02) * 2, 0.18, 0.1, MAT.trim, 4);
    b.box(0, r0.yb + 0.08, -0.03, (r0.wm + 0.02) * 2, 0.18, 0.1, MAT.trim, 4);
    b.quad([-0.26, f.yb + 0.03, L + 0.082], [0.26, f.yb + 0.03, L + 0.082], [0.26, f.yb + 0.14, L + 0.082], [-0.26, f.yb + 0.14, L + 0.082], MAT.plate, [0, 0, 1]);
    b.quad([-0.26, r0.yb + 0.25, -0.006], [0.26, r0.yb + 0.25, -0.006], [0.26, r0.yb + 0.36, -0.006], [-0.26, r0.yb + 0.36, -0.006], MAT.plate, [0, 0, -1]);
    const gx = hx - hwid / 2 - 0.04;
    if (p.hoodL > 0.1) b.quad([-gx, hy - 0.08, zF + 0.001], [gx, hy - 0.08, zF + 0.001], [gx, hy + 0.08, zF + 0.001], [-gx, hy + 0.08, zF + 0.001], MAT.grille, [0, 0, 1]);
    const zm = L - p.hoodL - p.wsL * 0.6;
    for (const sg of [1, -1]) {
      b.box(sg * (p.W / 2 + 0.16), p.belt + 0.35, zm, 0.04, 0.04, 0.04, MAT.trim);
      b.box(sg * (p.W / 2 + 0.2), p.belt + 0.25, zm - 0.02, 0.05, 0.3, 0.14, MAT.trim);
    }
    // doors on the right side (-X): dark glazed leaves over the full height
    for (const [z0, z1] of p.doors ?? []) {
      const s = stationAt(st, (z0 + z1) / 2);
      const x = -(s.wm + 0.006);
      b.quad([x, p.sill + 0.12, z0], [x, p.sill + 0.12, z1], [x, p.H - 0.3, z1], [x, p.H - 0.3, z0], p.lit ? MAT.glassLit : MAT.glass, [-1, 0, 0]);
      b.box(x - 0.002, (p.sill + p.H) / 2 - 0.1, (z0 + z1) / 2, 0.01, p.H - p.sill - 0.42, 0.05, MAT.trim);
    }
  }
  extra?.(b, st);
  wheels(b, st, p.axles, p.r, null, lod, 0.24, !!p.dual, MAT.rim, 0);
  const g = b.build(30);
  shiftZ(g, -(p.axles[0] + p.axles[p.axles.length - 1]) / 2);
  return g;
}

/** KamAZ-65115 dump truck: cab-over loft + frame + dump body, 3 axles (rear tandem dual). */
function buildKamaz(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const L = 7.6, W = 2.5, hw = W / 2;
  const cabZ0 = L - 2.1;
  const S = 1.05;
  const st: Station[] = [
    { z: cabZ0, yb: S, yw: 1.95, yt: 2.95, wb: hw - 0.05, wm: hw, wt: hw - 0.08, cr: 0.03 },
    { z: cabZ0 + 1.5, yb: S, yw: 1.95, yt: 2.95, wb: hw - 0.05, wm: hw, wt: hw - 0.08, cr: 0.03 },
    { z: L - 0.12, yb: S - 0.05, yw: 1.8, yt: 2.8, wb: hw - 0.05, wm: hw - 0.02, wt: hw - 0.12, cr: 0.02 },
    { z: L, yb: S - 0.02, yw: 1.72, yt: 2.7, wb: hw - 0.09, wm: hw - 0.06, wt: hw - 0.16, cr: 0.02 },
  ];
  const iv: Iv[] = ['roof', 'ws', 'ws'];
  loft(b, st, iv, { paint: MAT.paint, glass: MAT.glass, trim: MAT.trim, under: MAT.under }, lod, 'glass', 'paint');
  const grey = col(0x6f6a60, 0.8, 0.2);
  const frame = col(0x1a1a1a, 0.7, 0.3);
  // frame + fenders + fuel tank + dump body
  b.box(0, 0.95, (L - 0.3) / 2, 0.9, 0.3, L - 0.3, frame);
  b.box(0, 0.62, L - 0.05, W, 0.35, 0.12, frame, 4);
  const dz0 = 0.15, dz1 = cabZ0 - 0.25;
  b.box(0, 1.1 + 0.08, (dz0 + dz1) / 2, W, 0.16, dz1 - dz0, grey);
  // tub with sloping sides
  const yb0 = 1.26, yb1 = 2.45;
  const q = (a: [number, number, number], bb: [number, number, number], c: [number, number, number], d: [number, number, number], n: [number, number, number]) => b.quad(a, bb, c, d, grey, n);
  for (const sg of [1, -1]) q([sg * hw, yb0, dz0], [sg * hw, yb0, dz1], [sg * hw, yb1, dz1 - 0.05], [sg * hw, yb1, dz0 + 0.3], [sg, 0, 0]);
  q([-hw, yb0, dz1], [hw, yb0, dz1], [hw, yb1, dz1 - 0.05], [-hw, yb1, dz1 - 0.05], [0, 0, 1]);
  q([-hw, yb0, dz0], [hw, yb0, dz0], [hw, yb1, dz0 + 0.3], [-hw, yb1, dz0 + 0.3], [0, 0, -1]);
  const inner = col(0x3f3b35, 0.9, 0.1);
  q([-hw + 0.05, yb0 + 0.3, dz0 + 0.1], [hw - 0.05, yb0 + 0.3, dz0 + 0.1], [hw - 0.05, yb0 + 0.3, dz1 - 0.1], [-hw + 0.05, yb0 + 0.3, dz1 - 0.1], [0, 1, 0]);
  for (const sg of [1, -1]) b.quad([sg * (hw - 0.05), yb0 + 0.3, dz0 + 0.1], [sg * (hw - 0.05), yb0 + 0.3, dz1 - 0.1], [sg * (hw - 0.05), yb1, dz1 - 0.1], [sg * (hw - 0.05), yb1, dz0 + 0.35], inner, [-sg, 0, 0]);
  b.quad([-hw + 0.05, yb0 + 0.3, dz1 - 0.1], [hw - 0.05, yb0 + 0.3, dz1 - 0.1], [hw - 0.05, yb1, dz1 - 0.1], [-hw + 0.05, yb1, dz1 - 0.1], inner, [0, 0, -1]);
  b.quad([-hw + 0.05, yb0 + 0.3, dz0 + 0.1], [hw - 0.05, yb0 + 0.3, dz0 + 0.1], [hw - 0.05, yb1, dz0 + 0.35], [-hw + 0.05, yb1, dz0 + 0.35], inner, [0, 0, 1]);
  // canopy over the cab
  b.box(0, yb1 + 0.05, dz1 + 0.35, W - 0.1, 0.06, 0.7, grey);
  // lights
  for (const sg of [1, -1]) {
    b.quad([sg * 0.85, 0.62, L + 0.064], [sg * 1.1, 0.62, L + 0.064], [sg * 1.1, 0.74, L + 0.064], [sg * 0.85, 0.74, L + 0.064], MAT.head, [0, 0, 1]);
    b.quad([sg * 1.0, 1.0, -0.02], [sg * 1.18, 1.0, -0.02], [sg * 1.18, 1.14, -0.02], [sg * 1.0, 1.14, -0.02], MAT.tail, [0, 0, -1]);
  }
  if (lod === 0) {
    b.box(0, 1.35, L + 0.004, 1.5, 0.35, 0.02, MAT.grille);
    b.box(-0.9, 0.75, cabZ0 - 0.6, 0.55, 0.5, 1.0, col(0x2a2a2a, 0.5, 0.6));
    for (const sg of [1, -1]) {
      b.box(sg * (hw - 0.3), 1.12, L - 1.05, 0.62, 0.08, 1.0, MAT.trim); // front fenders
      b.box(sg * (hw + 0.16), 2.15, L - 0.5, 0.05, 0.4, 0.16, MAT.trim); // mirrors
    }
    b.quad([-0.26, 0.55, L + 0.064], [0.26, 0.55, L + 0.064], [0.26, 0.66, L + 0.064], [-0.26, 0.66, L + 0.064], MAT.plate, [0, 0, 1]);
  }
  const r = 0.54;
  wheels(b, null, [L - 1.35], r, hw - 0.28 + 0.14, lod, 0.3, false, MAT.rim);
  wheels(b, null, [1.35, 2.7], r, hw - 0.04, lod, 0.28, true, MAT.rim);
  const g = b.build(30);
  shiftZ(g, -(1.35 + (L - 1.35)) / 2 + 0.0);
  return g;
}

/** GAZelle flatbed with a tent (GAZ-3302 / Next): short-bonnet cab + tent box. */
function buildGazelleTent(lod: number): THREE.BufferGeometry {
  const L = 5.6, W = 2.08;
  const p: BoxP = {
    L: 2.25, W: 2.0, H: 2.12, r: 0.36, axles: [0.9], sill: 0.55, belt: 1.25, beltFront: 1.05,
    hoodL: 0.55, hoodH: 1.12, wsL: 0.55, windows: [[0.25, 1.05, 'roof']], crown: 0.03,
  };
  const b = new Builder();
  const { st, iv } = boxStations(p);
  const off = L - p.L;
  for (const s of st) s.z += off;
  loft(b, st, iv, { paint: MAT.paint, glass: MAT.glass, trim: MAT.trim, under: MAT.under }, lod, 'paint', 'paint');
  // tent box + flatbed
  const tent = col(0x3d5a78, 0.85, 0.0);
  const hw = W / 2;
  b.box(0, 0.95, (off - 0.1) / 2, W, 0.12, off - 0.1, col(0x2a2a2a, 0.7, 0.3));
  b.box(0, 1.07 + 0.64, (off - 0.1) / 2, W, 1.28, off - 0.1, tent, 4);
  if (lod === 0) {
    for (const sg of [1, -1]) for (let k = 1; k < 4; k++) b.box(sg * (hw + 0.004), 1.71, (off - 0.1) * (k / 4), 0.01, 1.26, 0.04, col(0x2d465e, 0.9));
    b.box(0, 0.6, off / 2, 0.8, 0.2, off, MAT.under);
    b.quad([-0.26, 0.55, L + 0.07], [0.26, 0.55, L + 0.07], [0.26, 0.66, L + 0.07], [-0.26, 0.66, L + 0.07], MAT.plate, [0, 0, 1]);
    b.box(0, 0.5, L + 0.02, W - 0.1, 0.16, 0.1, MAT.trim, 4);
    for (const sg of [1, -1]) b.box(sg * (1.1), 1.55, L - 1.1, 0.04, 0.26, 0.12, MAT.trim);
  }
  for (const sg of [1, -1]) {
    b.quad([sg * 0.62, 0.8, L + 0.004], [sg * 0.9, 0.8, L + 0.004], [sg * 0.9, 0.92, L + 0.004], [sg * 0.62, 0.92, L + 0.004], MAT.head, [0, 0, 1]);
    b.quad([sg * 0.85, 0.75, -0.06], [sg * 1.0, 0.75, -0.06], [sg * 1.0, 0.88, -0.06], [sg * 0.85, 0.88, -0.06], MAT.tail, [0, 0, -1]);
  }
  wheels(b, st, [off + 0.9], 0.36, null, lod, 0.2, false, MAT.rim, 0);
  wheels(b, null, [1.05], 0.36, hw - 0.1, lod, 0.2, true, MAT.rim, -1);
  const g = b.build(30);
  shiftZ(g, -((off + 0.9) + 1.05) / 2);
  return g;
}

// ----------------------------------------------------------------------------------- catalogue
function carTypes(): Array<Omit<VehicleType, 'id' | 'lod0' | 'lod1' | 'lod2'> & { build: (lod: number) => THREE.BufferGeometry }> {
  return [
    {
      name: 'VAZ-2107', kind: 'car', L: 4.13, W: 1.62, H: 1.44, wb: 2.42, r: 0.29, palette: SOVIET, weight: 11, parkWeight: 12, accel: 1.4, vmax: 26, transit: false, dirt: 0.5,
      build: (lod) => buildCar({ L: 4.13, W: 1.62, H: 1.44, wb: 2.42, r: 0.29, ovR: 0.93, sill: 0.25, belt: 0.9, nose: 0.78, cowl: 0.95, tail: 0.9, zCowl: 1.25, zRoofF: 1.72, zRoofR: 1.4, zDeck: 0.92, style: 'sedan', tumble: 0.8, crown: 0.02, bumper: 'chrome', head: [0.34, 0.15], tailL: [0.34, 0.15], grille: 'chrome' }, lod),
    },
    {
      name: 'VAZ-2114', kind: 'car', L: 4.12, W: 1.65, H: 1.4, wb: 2.46, r: 0.29, palette: SOVIET, weight: 8, parkWeight: 10, accel: 1.5, vmax: 28, transit: false, dirt: 0.45,
      build: (lod) => buildCar({ L: 4.12, W: 1.65, H: 1.4, wb: 2.46, r: 0.29, ovR: 0.75, sill: 0.25, belt: 0.92, nose: 0.76, cowl: 0.94, tail: 0.95, zCowl: 1.2, zRoofF: 1.8, zRoofR: 0.62, zDeck: 0.2, style: 'hatch', tumble: 0.82, crown: 0.025, bumper: 'black', head: [0.36, 0.13], tailL: [0.3, 0.16], grille: 'black' }, lod),
    },
    {
      name: 'Lada Granta', kind: 'car', L: 4.27, W: 1.7, H: 1.5, wb: 2.48, r: 0.3, palette: MODERN, weight: 17, parkWeight: 16, accel: 1.6, vmax: 30, transit: false, dirt: 0.35,
      build: (lod) => buildCar({ L: 4.27, W: 1.7, H: 1.5, wb: 2.48, r: 0.3, ovR: 0.95, sill: 0.26, belt: 0.98, nose: 0.8, cowl: 1.0, tail: 1.02, zCowl: 1.2, zRoofF: 1.85, zRoofR: 1.35, zDeck: 0.82, style: 'sedan', tumble: 0.82, crown: 0.035, bumper: 'paint', head: [0.38, 0.14], tailL: [0.32, 0.15], grille: 'black' }, lod),
    },
    {
      name: 'Vesta / Solaris / Rio', kind: 'car', L: 4.41, W: 1.76, H: 1.48, wb: 2.63, r: 0.315, palette: MODERN, weight: 22, parkWeight: 20, accel: 1.9, vmax: 32, transit: false, dirt: 0.25,
      build: (lod) => buildCar({ L: 4.41, W: 1.76, H: 1.48, wb: 2.63, r: 0.315, ovR: 0.92, sill: 0.25, belt: 0.99, nose: 0.78, cowl: 0.98, tail: 1.04, zCowl: 1.25, zRoofF: 2.02, zRoofR: 1.2, zDeck: 0.72, style: 'sedan', tumble: 0.8, crown: 0.04, bumper: 'paint', head: [0.42, 0.12], tailL: [0.38, 0.13], grille: 'none' }, lod),
    },
    {
      name: 'Kalina / Rio X hatch', kind: 'car', L: 4.0, W: 1.72, H: 1.52, wb: 2.5, r: 0.3, palette: MODERN, weight: 9, parkWeight: 9, accel: 1.7, vmax: 30, transit: false, dirt: 0.3,
      build: (lod) => buildCar({ L: 4.0, W: 1.72, H: 1.52, wb: 2.5, r: 0.3, ovR: 0.68, sill: 0.26, belt: 0.99, nose: 0.8, cowl: 1.0, tail: 1.05, zCowl: 1.15, zRoofF: 1.9, zRoofR: 0.45, zDeck: 0.2, style: 'hatch', tumble: 0.83, crown: 0.035, bumper: 'paint', head: [0.4, 0.14], tailL: [0.18, 0.28], grille: 'black' }, lod),
    },
    {
      name: 'Lada Niva 4x4', kind: 'car', L: 3.74, W: 1.68, H: 1.64, wb: 2.2, r: 0.34, palette: SOVIET, weight: 7, parkWeight: 7, accel: 1.3, vmax: 26, transit: false, dirt: 0.75,
      build: (lod) => buildCar({ L: 3.74, W: 1.68, H: 1.64, wb: 2.2, r: 0.34, ovR: 0.78, sill: 0.36, belt: 1.08, nose: 0.98, cowl: 1.1, tail: 1.1, zCowl: 0.95, zRoofF: 1.4, zRoofR: 0.14, zDeck: 0.1, style: 'box', tumble: 0.86, crown: 0.02, bumper: 'black', head: [0.26, 0.2], tailL: [0.16, 0.26], grille: 'black', flare: true, spare: false }, lod),
    },
    {
      name: 'Crossover (Creta / Duster)', kind: 'car', L: 4.33, W: 1.8, H: 1.66, wb: 2.64, r: 0.345, palette: MODERN, weight: 13, parkWeight: 12, accel: 1.9, vmax: 32, transit: false, dirt: 0.35,
      build: (lod) => buildCar({ L: 4.33, W: 1.8, H: 1.66, wb: 2.64, r: 0.345, ovR: 0.82, sill: 0.33, belt: 1.1, nose: 0.95, cowl: 1.1, tail: 1.12, zCowl: 1.2, zRoofF: 1.95, zRoofR: 0.42, zDeck: 0.14, style: 'hatch', tumble: 0.84, crown: 0.03, bumper: 'paint', head: [0.38, 0.13], tailL: [0.2, 0.22], grille: 'black', flare: true, roofRails: true }, lod),
    },
    {
      name: 'UAZ-452', kind: 'van', L: 4.36, W: 1.94, H: 2.08, wb: 2.3, r: 0.38, palette: [[0x5b6a3e, 5, 0], [0x6e7c86, 3, 0], [0xd8d4c4, 2, 0], [0x2e4d6e, 1, 0]], weight: 1.5, parkWeight: 1.5, accel: 1.0, vmax: 22, transit: false, dirt: 0.8,
      build: (lod) => buildBox({ L: 4.36, W: 1.94, H: 2.08, r: 0.38, axles: [1.0, 3.3], sill: 0.55, belt: 1.35, beltFront: 1.2, hoodL: 0.25, hoodH: 1.15, wsL: 0.5, windows: [[0.4, 1.3, 'roof'], [1.45, 2.35, 'roof'], [2.5, 3.3, 'roof']], crown: 0.07, rearGlass: true }, lod),
    },
    {
      name: 'GAZelle marshrutka', kind: 'bus', L: 5.8, W: 2.07, H: 2.3, wb: 3.0, r: 0.36, palette: [[0xf0c20a, 6, 0], [0xecebe6, 5, 0], [0xe0a010, 1, 0]], weight: 5, parkWeight: 0.3, accel: 1.3, vmax: 25, transit: true, dirt: 0.4,
      build: (lod) => buildBox({ L: 5.8, W: 2.07, H: 2.32, r: 0.36, axles: [1.55, 4.55], sill: 0.5, belt: 1.3, beltFront: 1.05, hoodL: 0.6, hoodH: 1.1, wsL: 0.7, windows: [[0.2, 0.95, 'win'], [1.05, 1.95, 'win'], [2.05, 2.95, 'win'], [3.05, 4.3, 'win']], crown: 0.05, rearGlass: true, sign: true, doors: [[2.9, 4.1]], lit: true }, lod),
    },
    {
      name: 'GAZelle tent', kind: 'truck', L: 5.6, W: 2.08, H: 2.35, wb: 3.2, r: 0.36, palette: [[0xecebe6, 6, 0], [0x2f4f8a, 2, 0], [0x6f7478, 1, 1]], weight: 3, parkWeight: 1, accel: 1.1, vmax: 24, transit: false, dirt: 0.5,
      build: buildGazelleTent,
    },
    {
      name: 'PAZ-3205', kind: 'bus', L: 7.0, W: 2.5, H: 2.95, wb: 3.6, r: 0.46, palette: [[0xf0b400, 5, 0], [0xe27a12, 2, 0], [0x2d6fb5, 1, 0], [0x3f8a3a, 1, 0]], weight: 2.4, parkWeight: 0.1, accel: 1.0, vmax: 22, transit: true, dirt: 0.5,
      build: (lod) => buildBox({ L: 7.0, W: 2.5, H: 2.95, r: 0.46, axles: [1.9, 5.5], sill: 0.55, belt: 1.45, beltFront: 1.0, hoodL: 0.0, hoodH: 1.0, wsL: 0.25, windows: [[0.35, 1.3, 'win'], [1.4, 2.35, 'win'], [2.45, 3.4, 'win'], [3.5, 4.45, 'win'], [4.55, 5.5, 'win'], [5.6, 6.5, 'win']], crown: 0.1, rearGlass: true, sign: true, roofWhite: true, twoTone: 1.4, doors: [[3.2, 4.1], [5.95, 6.8]], lit: true }, lod),
    },
    {
      name: 'LiAZ-5256', kind: 'bus', L: 11.4, W: 2.5, H: 3.0, wb: 5.84, r: 0.5, palette: [[0x2a6db0, 3, 0], [0x3f8a3a, 2, 0], [0xf0b400, 2, 0], [0xd23a2a, 1, 0]], weight: 1.0, parkWeight: 0, accel: 0.9, vmax: 20, transit: true, dirt: 0.4,
      build: (lod) => buildBox({ L: 11.4, W: 2.5, H: 3.0, r: 0.5, axles: [3.1, 8.94], sill: 0.45, belt: 1.35, beltFront: 0.95, hoodL: 0.0, hoodH: 1.0, wsL: 0.2, windows: [[0.3, 1.5, 'win'], [1.6, 2.8, 'win'], [2.9, 4.1, 'win'], [4.2, 5.4, 'win'], [5.5, 6.7, 'win'], [6.8, 8.0, 'win'], [8.1, 9.3, 'win'], [9.4, 10.8, 'win']], crown: 0.1, rearGlass: true, sign: true, roofWhite: true, twoTone: 1.3, doors: [[1.0, 2.2], [5.6, 6.8], [9.9, 11.0]], lit: true }, lod),
    },
    {
      name: 'KamAZ-65115', kind: 'truck', L: 7.6, W: 2.5, H: 3.0, wb: 4.9, r: 0.54, palette: [[0xd8701a, 5, 0], [0x2a4f8a, 3, 0], [0xe8e6de, 2, 0], [0x3f6d3a, 1, 0]], weight: 1.6, parkWeight: 0.2, accel: 0.8, vmax: 22, transit: false, dirt: 0.9,
      build: buildKamaz,
    },
  ];
}

let _types: VehicleType[] | null = null;

/** Build (once) all road-vehicle types. */
export function vehicleTypes(): VehicleType[] {
  if (_types) return _types;
  _types = carTypes().map((t, id) => {
    const { build, ...rest } = t;
    let lod0: THREE.BufferGeometry, lod1: THREE.BufferGeometry, lod2: THREE.BufferGeometry;
    try {
      lod0 = build(0);
      lod1 = build(1);
      lod2 = build(2);
    } catch (e) {
      console.error('[traffic] model build failed', t.name, e);
      lod0 = lod1 = lod2 = new THREE.BoxGeometry(t.W, t.H, t.L).translate(0, t.H / 2, 0);
    }
    return { ...rest, id, lod0, lod1, lod2 };
  });
  return _types;
}

/** Linear colour + metallic flag from a palette using a random value. */
export function paletteColor(p: Palette, u: number, out: THREE.Color): number {
  let tot = 0;
  for (const e of p) tot += e[1];
  let r = u * tot;
  for (const e of p) {
    r -= e[1];
    if (r <= 0) { out.setHex(e[0]); return e[2]; }
  }
  out.setHex(p[p.length - 1][0]);
  return p[p.length - 1][2];
}
