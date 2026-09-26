// Parametric industrial structures: chimneys, tanks, columns, prilling towers, isothermal
// ammonia tanks, lattice masts, open-air boilers, pipe racks, transformers, process equipment.
// All functions write into Geo builders in the caller's local frame (y = 0 at the site origin).
import * as THREE from 'three';
import { Geo, P, F, col, mix3, rng, type RGB, type V3 } from './builder';
import type { GlowSpec } from './effects';
import type { StaticCollider } from '../../core/context';

export const C = {
  concrete: col('#9d998f'),
  concreteDark: col('#7d7a72'),
  concreteLight: col('#b9b5aa'),
  red: col('#a3362b'),
  white: col('#dedbd2'),
  soot: col('#2a2826'),
  steel: col('#6d7174'),
  steelDark: col('#43474a'),
  galv: col('#9ea3a3'),
  alu: col('#c3c7c8'),
  green: col('#5d7560'),
  blueGrey: col('#7f8e96'),
  yellow: col('#c9a53a'),
  rust: col('#7a4a2c'),
  lampRed: col('#ff2410'),
  lampWhite: col('#fff4dc'),
  panel: col('#b7b2a5'),
  panelBlue: col('#8fa3ad'),
  brick: col('#9a5a45'),
  tankWhite: col('#d9d9d3'),
  greenPaint: col('#4f6b55'),
  asphalt: col('#3c3c3a'),
};

export interface Frame {
  /** World origin of the local frame. */
  ox: number; oy: number; oz: number;
  /** World ground height. */
  ground(x: number, z: number): number;
  glows: GlowSpec[];
  colliders: StaticCollider[];
  key: string;
}

const SODIUM = new THREE.Color(2.2, 1.15, 0.35);
const LED = new THREE.Color(1.7, 1.8, 1.9);
/** Plant work light (night-only glow + tiny emissive housing in the detail layer). */
export function workLight(fr: Frame, d: Geo | null, x: number, y: number, z: number, warm = true): void {
  if (d) {
    d.paint(warm ? col('#ffb060') : col('#e8f0ff'), P.LAMP, 0.4, 0, 0);
    d.boxC(x, y - 0.12, z, 0.25, 0.12, 0.25);
  }
  fr.glows.push({ x: fr.ox + x, y: fr.oy + y, z: fr.oz + z, color: warm ? SODIUM : LED, size: 1.1, day: 0 });
}

let _ck = 0;
export function colliderKey(prefix: string): string { return `lm:${prefix}:${_ck++}`; }

function addCyl(fr: Frame, x: number, y0: number, z: number, r: number, h: number): void {
  fr.colliders.push({ kind: 'cylinder', key: colliderKey(fr.key), center: [fr.ox + x, fr.oy + y0 + h / 2, fr.oz + z], radius: r, halfHeight: h / 2 });
}
export function addBox(fr: Frame, x: number, y0: number, z: number, sx: number, h: number, sz: number, rot: number): void {
  fr.colliders.push({ kind: 'box', key: colliderKey(fr.key), center: [fr.ox + x, fr.oy + y0 + h / 2, fr.oz + z], halfExtents: [sx / 2, h / 2, sz / 2], rotationY: rot });
}
function lamp(fr: Frame, g: Geo | null, x: number, y: number, z: number, color: RGB, blink = false, size = 1.6, day = 0.0): void {
  if (g) {
    g.paint(color, P.LAMP, 0.4, 0, blink ? F.BLINK : 0);
    g.boxC(x, y - 0.18, z, 0.36, 0.36, 0.36);
  }
  fr.glows.push({ x: fr.ox + x, y: fr.oy + y, z: fr.oz + z, color: new THREE.Color(color[0], color[1], color[2]).multiplyScalar(blink ? 3 : 2.2), size, blink, day, phase: 0 });
}

// ------------------------------------------------------------------------------ chimney
export interface ChimneySpec { x: number; z: number; h: number; r0: number; r1: number; style: string }

/** Reinforced-concrete chimney with obstruction marking, light platforms, ladder, lamps. */
export function chimney(fr: Frame, g: Geo, d: Geo, s: ChimneySpec): void {
  const y0 = fr.ground(fr.ox + s.x, fr.oz + s.z) - fr.oy;
  const H = s.h, seg = H > 180 ? 40 : H > 90 ? 32 : 24;
  const rAt = (y: number) => s.r0 + (s.r1 - s.r0) * (y / H);
  // foundation plinth
  g.paint(C.concreteDark, P.CONCRETE, 0.9);
  g.cyl(s.x, y0 - 2, s.z, s.r0 + 1.6, s.r0 + 1.4, 3.2, seg);
  // marking bands: top third red/white (7 bands, red on top) for 'redwhite', last 12% for others
  const bands: Array<[number, number, RGB]> = [];
  const markFrom = s.style === 'redwhite' ? H * 2 / 3 : H * 0.86;
  const nb = s.style === 'redwhite' ? 7 : 3;
  bands.push([0, markFrom, C.concrete]);
  const bh = (H - markFrom) / nb;
  for (let i = 0; i < nb; i++) {
    const top = i === nb - 1;
    bands.push([markFrom + i * bh, markFrom + (i + 1) * bh, (nb - 1 - i) % 2 === 0 ? C.red : C.white]);
    void top;
  }
  for (const [a, b, c] of bands) {
    // slight vertical grime towards the base in the concrete part
    const steps = c === C.concrete ? 3 : 1;
    for (let k = 0; k < steps; k++) {
      const ya = a + ((b - a) * k) / steps, yb = a + ((b - a) * (k + 1)) / steps;
      const tint = c === C.concrete ? mix3(C.concreteDark, C.concrete, 0.4 + 0.3 * k) : c;
      g.paint(tint, P.CONCRETE, 0.88);
      g.lathe(s.x, y0 + 1.2, s.z, [rAt(ya), ya, rAt(yb), yb], seg, true);
    }
  }
  // soot at the top (6 m) + cornice + dark hollow top
  const yTop = y0 + 1.2 + H;
  g.paint(mix3(C.soot, C.red, 0.25), P.CONCRETE, 0.95);
  g.lathe(s.x, yTop - 5, s.z, [rAt(H - 5) + 0.02, 0, rAt(H) + 0.02, 5], seg, true);
  g.paint(C.steelDark, P.METAL, 0.7, 0.3);
  g.lathe(s.x, yTop - 0.6, s.z, [rAt(H) + 0.02, 0, rAt(H) + 0.35, 0.2, rAt(H) + 0.35, 1.0, rAt(H) - 0.1, 1.1], seg, false);
  g.paint(C.soot, P.PLAIN, 1.0, 0, F.NOGRIME);
  g.disc(s.x, yTop + 0.5, s.z, rAt(H) - 0.1, seg, true, rAt(H) - 0.6);
  g.lathe(s.x, yTop + 0.5, s.z, [rAt(H) - 0.6, 0, rAt(H) - 0.6, -8], seg, true);
  g.disc(s.x, yTop - 7.5, s.z, rAt(H) - 0.6, seg, true);
  // flue inlets (two steel ducts on opposite sides)
  g.paint(C.steel, P.METAL, 0.6, 0.35);
  // light platforms
  const levels = H > 180 ? [0.2, 0.4, 0.6, 0.8, 0.985] : H > 100 ? [0.33, 0.66, 0.975] : [0.5, 0.97];
  for (const f of levels) {
    const yl = f * H;
    const r = rAt(yl);
    const Y = y0 + 1.2 + yl;
    g.paint(C.steelDark, P.GRATE, 0.7, 0.4);
    g.disc(s.x, Y, s.z, r + 1.3, seg, true, r);
    g.disc(s.x, Y - 0.15, s.z, r + 1.3, seg, false, r);
    g.lathe(s.x, Y - 0.15, s.z, [r + 1.3, 0, r + 1.3, 0.15], seg, false);
    d.paint(C.steelDark, P.METAL, 0.6, 0.4);
    d.ringRailing(s.x, Y, s.z, r + 1.25, 1.1, seg, 0.06);
    // brackets
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      d.beam([s.x + ca * r, Y - 1.6, s.z + sa * r], [s.x + ca * (r + 1.2), Y - 0.1, s.z + sa * (r + 1.2)], 0.12);
    }
    // obstruction lamps (4 around)
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      lamp(fr, g, s.x + Math.cos(a) * (r + 1.1), Y + 1.4, s.z + Math.sin(a) * (r + 1.1), C.lampRed, false, 2.2, f > 0.9 ? 0.25 : 0.0);
    }
  }
  // caged ladder (rails + rung strip) on the east side
  const la = 0.3;
  const lx = Math.cos(la), lz = Math.sin(la);
  d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
  for (let k = 0; k < 8; k++) {
    const ya = (H * k) / 8, yb = (H * (k + 1)) / 8;
    const ra = rAt(ya) + 0.35, rb = rAt(yb) + 0.35;
    d.beam([s.x + lx * ra, y0 + 1.2 + ya, s.z + lz * ra], [s.x + lx * rb, y0 + 1.2 + yb, s.z + lz * rb], 0.55, 0.06);
  }
  fr.colliders.push({ kind: 'cylinder', key: colliderKey(fr.key), center: [fr.ox + s.x, fr.oy + y0 + H / 2, fr.oz + s.z], radius: (s.r0 + s.r1) / 2, halfHeight: H / 2 + 1 });
}

// ------------------------------------------------------------------------------ tanks
/** Vertical steel storage tank (fuel oil / water / chemicals) with roof, stair, railing, bund. */
export function tank(fr: Frame, g: Geo, d: Geo, x: number, z: number, r: number, h: number, color: RGB, opts: { bund?: boolean; dome?: boolean; seed?: number } = {}): void {
  const y0 = fr.ground(fr.ox + x, fr.oz + z) - fr.oy;
  const seg = r > 12 ? 40 : r > 4 ? 24 : 14;
  const R = rng(opts.seed ?? Math.floor(x * 13 + z * 7));
  g.paint(C.concreteDark, P.CONCRETE, 0.9);
  g.cyl(x, y0 - 1, z, r + 0.5, r + 0.5, 1.5, seg);
  g.paint(color, P.METAL, 0.55, 0.2);
  g.cyl(x, y0 + 0.5, z, r, r, h, seg, false, false);
  // roof: shallow cone or dome
  if (opts.dome) {
    const prof: number[] = [];
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI / 2;
      prof.push(Math.max(0.01, r * Math.cos(a)), h + 0.5 + Math.sin(a) * r * 0.22);
    }
    g.paint(mix3(color, C.white, 0.2), P.METAL, 0.5, 0.2);
    g.lathe(x, y0, z, prof, seg, true);
  } else {
    g.paint(mix3(color, C.steelDark, 0.25), P.METAL, 0.6, 0.2);
    g.lathe(x, y0, z, [r + 0.15, h + 0.5, 0.3, h + 0.5 + r * 0.14], seg, false);
  }
  // stair: straight inclined flight tangent to the shell + top railing
  if (r > 3) {
    const a0 = R() * Math.PI * 2;
    const nSteps = Math.max(2, Math.ceil(h / 4));
    d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
    for (let i = 0; i < nSteps; i++) {
      const aa = a0 + (i / nSteps) * (h / r) * 0.9, ab = a0 + ((i + 1) / nSteps) * (h / r) * 0.9;
      const ya = y0 + 0.5 + (h * i) / nSteps, yb = y0 + 0.5 + (h * (i + 1)) / nSteps;
      const rr = r + 0.6;
      d.beam([x + Math.cos(aa) * rr, ya, z + Math.sin(aa) * rr], [x + Math.cos(ab) * rr, yb, z + Math.sin(ab) * rr], 0.9, 0.08);
      d.paint(C.steelDark, P.METAL, 0.6, 0.4);
      d.beam([x + Math.cos(aa) * (rr + 0.45), ya + 1, z + Math.sin(aa) * (rr + 0.45)], [x + Math.cos(ab) * (rr + 0.45), yb + 1, z + Math.sin(ab) * (rr + 0.45)], 0.05);
      d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
    }
    d.paint(C.steelDark, P.METAL, 0.6, 0.4);
    d.ringRailing(x, y0 + 0.5 + h, z, r - 0.15, 1.0, Math.min(seg, 32), 0.05);
  }
  if (opts.bund) {
    const rb = r + 7;
    g.paint(C.concreteDark, P.CONCRETE, 0.9);
    g.lathe(x, y0 - 0.5, z, [rb, 0, rb, 2.0], 32, false);
    g.lathe(x, y0 - 0.5, z, [rb - 0.4, 2.0, rb - 0.4, 0], 32, false);
    g.disc(x, y0 + 1.5, z, rb, 32, true, rb - 0.4);
  }
  addCyl(fr, x, y0, z, r, h + 0.5);
}

/** Isothermal (double-wall) ammonia storage tank: ribbed outer shell, domed roof, stair tower. */
export function ammoniaTank(fr: Frame, g: Geo, d: Geo, x: number, z: number, r: number, h: number, seed: number): void {
  const y0 = fr.ground(fr.ox + x, fr.oz + z) - fr.oy;
  const seg = 56;
  const R = rng(seed);
  g.paint(C.concreteDark, P.CONCRETE, 0.9);
  g.cyl(x, y0 - 1, z, r + 1.2, r + 1.2, 2.2, seg);
  g.paint(col('#d7d6cf'), P.CORR, 0.5, 0.25);
  g.cyl(x, y0 + 1.2, z, r, r, h - 1.2, seg, false, false);
  // stiffener rings
  g.paint(col('#c4c3bb'), P.METAL, 0.5, 0.3);
  for (let k = 1; k < 5; k++) g.lathe(x, y0 + (h * k) / 5, z, [r + 0.01, 0, r + 0.25, 0.1, r + 0.25, 0.5, r + 0.01, 0.6], seg, false);
  // dome roof
  const prof: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI / 2;
    prof.push(Math.max(0.01, (r + 0.2) * Math.cos(a)), h + Math.sin(a) * r * 0.2);
  }
  g.paint(col('#dcdcd6'), P.METAL, 0.45, 0.25);
  g.lathe(x, y0, z, prof, seg, true);
  // roof platform + equipment
  d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
  d.boxC(x, y0 + h + r * 0.2 - 0.3, z, 10, 0.3, 6);
  d.paint(C.alu, P.METAL, 0.4, 0.6);
  for (let i = 0; i < 4; i++) d.pipe([x - 3 + i * 2, y0 + h + r * 0.2, z], [x - 3 + i * 2, y0 + h + r * 0.2 + 2.5, z], 0.25, 8, true);
  d.paint(C.steelDark, P.METAL, 0.6, 0.4);
  d.railing([x - 5, y0 + h + r * 0.2, z - 3, x + 5, y0 + h + r * 0.2, z - 3, x + 5, y0 + h + r * 0.2, z + 3, x - 5, y0 + h + r * 0.2, z + 3, x - 5, y0 + h + r * 0.2, z - 3], 1.1, 1.5, 0.05);
  // stair tower beside the tank + bridge to the roof
  const a = R() * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
  const tx = x + ca * (r + 4), tz = z + sa * (r + 4);
  const th = h + r * 0.12;
  g.paint(C.steel, P.METAL, 0.6, 0.4);
  const w = 3;
  for (const [px, pz] of [[-w, -w], [w, -w], [w, w], [-w, w]] as Array<[number, number]>) g.beam([tx + px / 2, y0, tz + pz / 2], [tx + px / 2, y0 + th, tz + pz / 2], 0.25);
  d.paint(C.steel, P.METAL, 0.6, 0.4);
  for (let yy = 3; yy < th; yy += 3) {
    d.beam([tx - w / 2, y0 + yy, tz - w / 2], [tx + w / 2, y0 + yy, tz + w / 2], 0.1);
    d.beam([tx + w / 2, y0 + yy, tz - w / 2], [tx - w / 2, y0 + yy, tz + w / 2], 0.1);
  }
  g.paint(C.steelDark, P.GRATE, 0.7, 0.4);
  g.beam([tx, y0 + th, tz], [x + ca * (r * 0.7), y0 + th + 0.4, z + sa * (r * 0.7)], 1.2, 0.15);
  // vapour lines down the shell
  d.paint(C.alu, P.METAL, 0.45, 0.6);
  d.pipe([x + ca * (r + 0.7) - sa * 2, y0 + 1, z + sa * (r + 0.7) + ca * 2], [x + ca * (r + 0.7) - sa * 2, y0 + h, z + sa * (r + 0.7) + ca * 2], 0.35, 8);
  addCyl(fr, x, y0, z, r, h + r * 0.2);
}

// ------------------------------------------------------------------------------ columns / towers
/** Insulated process column with skirt, platforms, ladders, top head and vapour line. */
export function column(fr: Frame, g: Geo, d: Geo, x: number, z: number, r: number, h: number, seed: number, color: RGB = C.alu): void {
  const y0 = fr.ground(fr.ox + x, fr.oz + z) - fr.oy;
  const R = rng(seed);
  const seg = r > 2 ? 20 : 14;
  g.paint(C.concreteDark, P.CONCRETE, 0.9);
  g.cyl(x, y0 - 1, z, r + 0.9, r + 0.9, 2, seg);
  g.paint(C.steelDark, P.METAL, 0.6, 0.4);
  g.cyl(x, y0 + 1, z, r * 1.02, r, 3, seg, false, false);
  g.paint(color, P.METAL, 0.45, color === C.alu ? 0.6 : 0.2);
  g.lathe(x, y0 + 4, z, [r, 0, r, h - 4 - r * 0.5], seg, true);
  const prof: number[] = [];
  for (let i = 0; i <= 5; i++) { const a = (i / 5) * Math.PI / 2; prof.push(Math.max(0.01, r * Math.cos(a)), h - 4 - r * 0.5 + Math.sin(a) * r * 0.5); }
  g.lathe(x, y0 + 4, z, prof, seg, true);
  // insulation bands
  g.paint(mix3(color, C.steelDark, 0.3), P.METAL, 0.5, 0.5);
  for (let yy = 8; yy < h - 4; yy += 6) g.lathe(x, y0 + yy, z, [r + 0.02, 0, r + 0.06, 0.05, r + 0.06, 0.25, r + 0.02, 0.3], seg, false);
  // platforms (partial rings) + ladder
  const a0 = R() * Math.PI * 2;
  d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
  for (let yy = 10; yy < h - 3; yy += 8 + Math.floor(R() * 4)) {
    const a = a0 + R() * 1.5;
    d.lathe(x, y0 + yy, z, [r + 1.3, 0.001, r + 0.05, 0], seg, false, a, a + Math.PI * 1.1);
    d.paint(col('#c9a53a'), P.METAL, 0.6, 0.3);
    const pts: number[] = [];
    for (let i = 0; i <= 8; i++) { const aa = a + (i / 8) * Math.PI * 1.1; pts.push(x + Math.cos(aa) * (r + 1.25), y0 + yy, z + Math.sin(aa) * (r + 1.25)); }
    d.railing(pts, 1.05, 1.5, 0.05);
    d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
  }
  d.beam([x + Math.cos(a0) * (r + 0.3), y0 + 1, z + Math.sin(a0) * (r + 0.3)], [x + Math.cos(a0) * (r + 0.3), y0 + h - 3, z + Math.sin(a0) * (r + 0.3)], 0.5, 0.06);
  // vapour line
  d.paint(C.alu, P.METAL, 0.4, 0.6);
  const va = a0 + Math.PI * 0.8;
  const vx = x + Math.cos(va) * (r + 0.9), vz = z + Math.sin(va) * (r + 0.9);
  d.pipe([vx, y0 + 2, vz], [vx, y0 + h - 2, vz], Math.max(0.2, r * 0.18), 8);
  d.pipe([vx, y0 + h - 2, vz], [x, y0 + h - 1, z], Math.max(0.2, r * 0.18), 8);
  addCyl(fr, x, y0, z, r, h);
}

/** Cylindrical concrete prilling (granulation) tower with head house and conveyor gallery. */
export function prillingTower(fr: Frame, g: Geo, d: Geo, x: number, z: number, r: number, h: number, seed: number): void {
  const y0 = fr.ground(fr.ox + x, fr.oz + z) - fr.oy;
  const R = rng(seed);
  const seg = 36;
  g.paint(C.concreteDark, P.CONCRETE, 0.9);
  g.cyl(x, y0 - 1, z, r + 1, r + 1, 5, seg, false, true);
  g.paint(mix3(C.concrete, C.white, 0.35), P.CONCRETE, 0.88);
  g.lathe(x, y0 + 4, z, [r, 0, r, h - 12], seg, true);
  // white product dust towards the top
  g.paint(mix3(C.white, C.concreteLight, 0.3), P.CONCRETE, 0.9);
  g.lathe(x, y0 + h - 8, z, [r, -4, r, 0], seg, true);
  // head house (square, profiled sheet)
  const hw = r * 2 + 4;
  g.paint(col('#aab4b8'), P.CORR, 0.55, 0.3);
  g.boxC(x, y0 + h - 8, z, hw, 9, hw);
  g.paint(C.steelDark, P.METAL, 0.7, 0.2);
  g.boxC(x, y0 + h + 1, z, hw + 0.6, 0.4, hw + 0.6);
  g.paint(col('#aab4b8'), P.CORR, 0.55, 0.3);
  g.boxC(x, y0 + h + 1.4, z, 6, 4, 6);
  // air inlet louvres ring near the base
  g.paint(C.steelDark, P.GRATE, 0.8, 0.3);
  g.lathe(x, y0 + 5, z, [r + 0.02, 0, r + 0.02, 3], seg, false);
  // inclined conveyor gallery to a neighbouring building
  const a = R() * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
  const L = 45;
  g.paint(col('#aab4b8'), P.CORR, 0.55, 0.3);
  const p0: V3 = [x + ca * r, y0 + h - 6, z + sa * r], p1: V3 = [x + ca * (r + L), y0 + 14, z + sa * (r + L)];
  g.beam(p0, p1, 3.5, 3.0);
  d.paint(C.steel, P.METAL, 0.6, 0.4);
  for (let t = 0.25; t < 1; t += 0.25) {
    const px = p0[0] + (p1[0] - p0[0]) * t, py = p0[1] + (p1[1] - p0[1]) * t, pz = p0[2] + (p1[2] - p0[2]) * t;
    d.beam([px, y0, pz], [px, py - 1.5, pz], 0.5);
  }
  lamp(fr, g, x + hw / 2, y0 + h + 1.8, z + hw / 2, C.lampRed, false, 1.8);
  lamp(fr, g, x - hw / 2, y0 + h + 1.8, z - hw / 2, C.lampRed, false, 1.8);
  addCyl(fr, x, y0, z, r, h);
}

// ------------------------------------------------------------------------------ lattice mast
/** Triangular lattice telecom mast with antenna panels, dishes and obstruction lights. */
export function latticeMast(fr: Frame, g: Geo, d: Geo, x: number, z: number, h: number, seed: number): void {
  const y0 = fr.ground(fr.ox + x, fr.oz + z) - fr.oy;
  const R = rng(seed);
  const rot = R() * Math.PI * 2;
  const wAt = (y: number) => 2.6 - 1.6 * (y / h);
  const corners = (y: number): V3[] => {
    const w = wAt(y) / Math.sqrt(3);
    return [0, 1, 2].map((i) => {
      const a = rot + (i / 3) * Math.PI * 2;
      return [x + Math.cos(a) * w, y0 + y, z + Math.sin(a) * w] as V3;
    });
  };
  const white = col('#e8e6e0'), red = col('#b8352a');
  const nSeg = Math.round(h / 2.5);
  for (let k = 0; k < nSeg; k++) {
    const ya = (h * k) / nSeg, yb = (h * (k + 1)) / nSeg;
    const band = Math.floor((ya / h) * 7);
    const c = band % 2 === 0 ? red : white;
    const A = corners(ya), B = corners(yb);
    g.paint(c, P.METAL, 0.5, 0.35);
    for (let i = 0; i < 3; i++) g.beam(A[i], B[i], 0.1);
    d.paint(c, P.METAL, 0.5, 0.35);
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      d.beam(A[i], B[j], 0.05);
      d.beam(B[i], B[j], 0.05);
    }
  }
  // antenna panels and dishes
  d.paint(col('#dcdcd8'), P.PLAIN, 0.5, 0.1);
  for (const yy of [h - 3, h - 8]) {
    for (let i = 0; i < 3; i++) {
      const a = rot + (i / 3) * Math.PI * 2 + Math.PI / 3;
      const r = wAt(yy) / Math.sqrt(3) + 0.5;
      d.boxC(x + Math.cos(a) * r, y0 + yy - 1.3, z + Math.sin(a) * r, 0.35, 2.6, 0.15, -a);
    }
  }
  for (let i = 0; i < 2; i++) {
    const a = rot + R() * 6.28, yy = h * (0.5 + R() * 0.3);
    const r = wAt(yy) / Math.sqrt(3) + 0.4;
    d.at(x + Math.cos(a) * r, y0 + yy, z + Math.sin(a) * r, -a + Math.PI / 2);
    d.push(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    d.lathe(0, 0, 0, [0.02, 0.25, 0.4, 0.12, 0.55, 0], 16, true);
    d.lathe(0, 0, 0, [0.55, 0, 0.4, 0.12, 0.02, 0.25], 16, true);
    d.pop();
    d.pop();
  }
  lamp(fr, g, x, y0 + h + 0.4, z, C.lampRed, true, 1.5);
  lamp(fr, g, x + 0.5, y0 + h * 0.5, z, C.lampRed, false, 1.2);
  g.paint(C.concreteDark, P.CONCRETE, 0.9);
  g.boxC(x, y0 - 0.5, z, 3.4, 0.9, 3.4, rot);
  // equipment cabinet + fence
  d.paint(col('#c8c8c2'), P.METAL, 0.5, 0.3);
  d.boxC(x + 3.5, y0, z + 1, 2.5, 2.2, 1.2, rot);
  addCyl(fr, x, y0, z, 1.3, h);
}

// ------------------------------------------------------------------------------ boiler (open air)
/** Open-air drum boiler: steel frame, casing, top penthouse, stairs; ~52 m. Local frame +X along the row. */
export function openBoiler(g: Geo, d: Geo, x: number, y0: number, z: number, sx: number, sz: number, h: number, rot: number, seed: number): void {
  const R = rng(seed);
  g.at(x, y0, z, rot);
  d.at(x, y0, z, rot);
  // lower part: exposed steel frame
  const colW = 0.8;
  g.paint(C.steelDark, P.METAL, 0.6, 0.4);
  for (const px of [-sx / 2, 0, sx / 2]) for (const pz of [-sz / 2, sz / 2]) g.box(px - colW / 2, 0, pz - colW / 2, px + colW / 2, h, pz + colW / 2);
  // furnace (tall) + convective pass (lower) casings in silver-grey profiled sheet, 2 m gap between
  const cas = mix3(C.alu, C.panelBlue, 0.35 + R() * 0.2);
  const fx1 = -sx / 2 + 1 + (sx - 2) * 0.58;
  g.paint(cas, P.CORR, 0.45, 0.45);
  g.box(-sx / 2 + 1, h * 0.28, -sz / 2 + 1, fx1, h - 3, sz / 2 - 1);
  g.paint(mix3(cas, C.steel, 0.25), P.CORR, 0.5, 0.45);
  g.box(fx1 + 2, h * 0.2, -sz / 2 + 1.5, sx / 2 - 1, h - 3, sz / 2 - 1.5);
  // horizontal gas pass bridging the upper part (the slot between the passes stays open below)
  g.paint(cas, P.CORR, 0.45, 0.45);
  g.box(fx1, h * 0.62, -sz / 2 + 1.5, fx1 + 2, h - 3, sz / 2 - 1.5, 63 - 1 - 2);
  // penthouse and drum housing
  g.paint(mix3(cas, C.white, 0.2), P.CORR, 0.5, 0.35);
  g.box(-sx / 2 + 2, h - 3, -sz / 2 + 2, sx / 2 - 2, h + 2.5, sz / 2 - 2);
  g.paint(C.steelDark, P.METAL, 0.6, 0.3);
  g.box(-sx / 2 + 1.8, h + 2.5, -sz / 2 + 1.8, sx / 2 - 1.8, h + 2.9, sz / 2 - 1.8);
  // service walkways with yellow railings every 7 m around the casing
  for (let yy = h * 0.3 + 3; yy < h - 4; yy += 7) {
    d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
    d.box(-sx / 2 - 0.2, yy - 0.12, -sz / 2 - 0.2, sx / 2 + 0.2, yy, -sz / 2 + 1);
    d.box(-sx / 2 - 0.2, yy - 0.12, sz / 2 - 1, sx / 2 + 0.2, yy, sz / 2 + 0.2);
    d.paint(col('#c9a53a'), P.METAL, 0.6, 0.3);
    d.railing([-sx / 2 - 0.2, yy, -sz / 2 - 0.2, sx / 2 + 0.2, yy, -sz / 2 - 0.2], 1.05, 2, 0.05);
    d.railing([sx / 2 + 0.2, yy, sz / 2 + 0.2, -sx / 2 - 0.2, yy, sz / 2 + 0.2], 1.05, 2, 0.05);
  }
  // risers / downcomers on the furnace walls
  d.paint(C.alu, P.METAL, 0.4, 0.6);
  for (let i = 0; i < 4; i++) {
    const px = -sx / 2 + 3 + i * ((fx1 - (-sx / 2) - 4) / 3);
    d.pipe([px, h * 0.28, -sz / 2 + 0.6], [px, h - 1, -sz / 2 + 0.6], 0.28, 8);
    d.pipe([px, h * 0.28, sz / 2 - 0.6], [px, h - 1, sz / 2 - 0.6], 0.28, 8);
  }
  // bottom: burners level, ash hopper, pipework
  g.paint(C.steel, P.METAL, 0.6, 0.35);
  g.box(-sx / 2 + 3, 6, -sz / 2 + 3, sx / 2 - 3, h * 0.28, sz / 2 - 3);
  // floors with gratings every 8 m in the lower frame + braces
  d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
  for (let yy = 8; yy < h * 0.3; yy += 8) {
    d.box(-sx / 2, yy - 0.15, -sz / 2 - 1.5, sx / 2, yy, -sz / 2 + 1);
    d.box(-sx / 2, yy - 0.15, sz / 2 - 1, sx / 2, yy, sz / 2 + 1.5);
  }
  d.paint(C.steelDark, P.METAL, 0.6, 0.4);
  for (const pz of [-sz / 2, sz / 2]) {
    d.beam([-sx / 2, 0, pz], [0, h * 0.28, pz], 0.3);
    d.beam([sx / 2, 0, pz], [0, h * 0.28, pz], 0.3);
  }
  // external stair tower at one corner
  const stx = sx / 2 + 2.5;
  d.paint(col('#b79b3b'), P.METAL, 0.6, 0.3);
  for (let yy = 0; yy < h; yy += 4) {
    d.beam([stx - 1.5, yy, -sz / 2], [stx + 1.5, yy + 2, -sz / 2 + 1.2], 1.0, 0.1);
    d.beam([stx + 1.5, yy + 2, -sz / 2 + 1.2], [stx - 1.5, yy + 4, -sz / 2 + 2.4], 1.0, 0.1);
  }
  d.paint(C.steelDark, P.METAL, 0.6, 0.4);
  for (const [px, pz] of [[stx - 1.6, -sz / 2 - 0.4], [stx + 1.6, -sz / 2 - 0.4], [stx - 1.6, -sz / 2 + 2.8], [stx + 1.6, -sz / 2 + 2.8]] as Array<[number, number]>) d.beam([px, 0, pz], [px, h, pz], 0.18);
  // steam pipes to the turbine hall (towards -Z) and safety-valve silencers on the roof
  d.paint(C.alu, P.METAL, 0.4, 0.6);
  d.pipe([-2, h * 0.75, -sz / 2], [-2, h * 0.75, -sz / 2 - 6], 0.5, 10);
  d.pipe([2, h * 0.75, -sz / 2], [2, h * 0.75, -sz / 2 - 6], 0.5, 10);
  for (let i = 0; i < 3; i++) d.pipe([-4 + i * 4, h + 2.9, 0], [-4 + i * 4, h + 7, 0], 0.35, 8, true);
  d.pop();
  g.pop();
}

// ------------------------------------------------------------------------------ pipe racks
const PIPE_COLS: RGB[] = [C.alu, C.alu, C.alu, col('#8a8d8e'), col('#b89a36'), col('#5f7a5f'), col('#8d5a3c'), col('#9aa0a2')];

/** Pipe rack along a polyline (world x,z pairs relative to the frame origin). */
export function pipeRack(fr: Frame, g: Geo, d: Geo, pts: number[], seed: number): void {
  const R = rng(seed);
  const tiers = R() < 0.4 ? 2 : 1;
  const hTop = 5.5 + Math.floor(R() * 3);
  const w = 4 + Math.floor(R() * 3);
  const np = 4 + Math.floor(R() * 6);
  const pipes: Array<{ o: number; r: number; c: RGB; y: number }> = [];
  for (let t = 0; t < tiers; t++) {
    const yT = hTop - t * 2.2;
    const n = t === 0 ? np : 2 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const r = [0.1, 0.15, 0.2, 0.25, 0.32, 0.45, 0.6][Math.floor(R() * 7)];
      pipes.push({ o: -w / 2 + 0.4 + ((w - 0.8) * (i + 0.5)) / n, r: Math.min(r, (w - 0.8) / n / 2 - 0.05), c: PIPE_COLS[Math.floor(R() * PIPE_COLS.length)], y: yT + r + 0.25 });
    }
  }
  // racks are level: common base = highest ground along the rack
  let base = -Infinity;
  for (let k = 0; k + 1 < pts.length; k += 2) base = Math.max(base, fr.ground(fr.ox + pts[k], fr.oz + pts[k + 1]) - fr.oy);
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    const nx = -dz, nz = dx;
    for (const p of pipes) {
      g.paint(p.c, P.METAL, p.c === C.alu ? 0.4 : 0.55, p.c === C.alu ? 0.6 : 0.25);
      g.pipe([ax + nx * p.o, base + p.y, az + nz * p.o], [bx + nx * p.o, base + p.y, bz + nz * p.o], p.r, p.r > 0.25 ? 8 : 5);
    }
    // bents every 6 m
    const nb = Math.max(1, Math.round(L / 7.5));
    for (let i = 0; i <= nb; i++) {
      if (i === nb && k + 4 < pts.length) continue;
      const t = i / nb;
      const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
      const gy = fr.ground(fr.ox + cx, fr.oz + cz) - fr.oy;
      const tgt = d;
      tgt.paint(C.steel, P.METAL, 0.65, 0.35);
      for (const s of [-1, 1]) {
        const px = cx + nx * s * w / 2, pz = cz + nz * s * w / 2;
        tgt.beam([px, gy - 0.3, pz], [px, base + hTop + 0.2, pz], 0.3, 0.3);
      }
      for (let tt = 0; tt < tiers; tt++) {
        const yT = base + hTop - tt * 2.2;
        tgt.beam([cx - nx * w / 2, yT, cz - nz * w / 2], [cx + nx * w / 2, yT, cz + nz * w / 2], 0.25, 0.3);
      }
      // longitudinal stringer
    }
    d.paint(C.steel, P.METAL, 0.65, 0.35);
    for (const s of [-1, 1]) {
      d.beam([ax + nx * s * w / 2, base + hTop, az + nz * s * w / 2], [bx + nx * s * w / 2, base + hTop, bz + nz * s * w / 2], 0.2, 0.25);
    }
    // lamps under the rack every ~40 m (road lighting inside the plant)
    for (let t = 0.5 / Math.max(1, Math.round(L / 40)); t < 1; t += 1 / Math.max(1, Math.round(L / 40))) {
      workLight(fr, d, ax + (bx - ax) * t - nx * (w / 2 + 0.3), base + hTop - 0.4, az + (bz - az) * t - nz * (w / 2 + 0.3), true);
    }
  }
}

// ------------------------------------------------------------------------------ transformers
/** Large power transformer with radiator banks, conservator and bushings. */
export function transformer(g: Geo, d: Geo, x: number, y0: number, z: number, rot: number): void {
  g.at(x, y0, z, rot);
  d.at(x, y0, z, rot);
  g.paint(C.concreteDark, P.CONCRETE, 0.9);
  g.box(-6, -0.5, -4, 6, 0.4, 4);
  g.paint(col('#5c6b5e'), P.METAL, 0.55, 0.3);
  g.box(-3.5, 0.4, -2.2, 3.5, 5.2, 2.2);
  g.paint(col('#51605a'), P.CORR, 0.55, 0.3);
  g.box(-3.3, 1.2, -3.8, 3.3, 5.0, -2.3);
  g.box(-3.3, 1.2, 2.3, 3.3, 5.0, 3.8);
  g.paint(col('#5c6b5e'), P.METAL, 0.55, 0.3);
  g.hcyl(-3, 3, 6.6, 0, 0.7, 12, true);
  d.paint(col('#8c5a3a'), P.PLAIN, 0.5, 0.1);
  for (let i = -1; i <= 1; i++) d.pipe([i * 1.6, 5.2, -0.8], [i * 1.6 + 0.3, 8.8, -1.2], 0.2, 8, true);
  d.paint(col('#d8d4c8'), P.PLAIN, 0.4, 0.05);
  for (let i = -1; i <= 1; i++) d.pipe([i * 1.4, 5.2, 1.0], [i * 1.4, 7.4, 1.4], 0.16, 8, true);
  d.pop();
  g.pop();
}

// ------------------------------------------------------------------------------ process equipment cell
/** A 10 x 10 m cell of process equipment (chosen from the DSM excess height and a seed). */
export function processCell(fr: Frame, g: Geo, d: Geo, x: number, z: number, seed: number, hint: number): void {
  const R = rng(seed);
  const y0 = fr.ground(fr.ox + x, fr.oz + z) - fr.oy;
  const t = R();
  const H = THREE.MathUtils.clamp(hint * (1.3 + R() * 0.8), 6, 38);
  const paintC = [C.alu, C.alu, C.galv, col('#8c9293'), col('#d2d0c8'), col('#6f8a88')][Math.floor(R() * 6)];
  const jx = (R() - 0.5) * 3, jz = (R() - 0.5) * 3;
  if (t < 0.34) {
    // vertical vessel(s)
    const n = R() < 0.35 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const r = 0.9 + R() * 1.4;
      const h = H * (0.6 + R() * 0.5);
      const px = x + jx + (n > 1 ? (i - 0.5) * 4.5 : 0), pz = z + jz;
      g.paint(C.concreteDark, P.CONCRETE, 0.9);
      g.cyl(px, y0 - 0.5, pz, r + 0.6, r + 0.6, 1.2, 12);
      g.paint(paintC, P.METAL, 0.45, 0.5);
      g.cyl(px, y0 + 0.7, pz, r, r, h - r * 0.5, 16, false, false);
      g.sphere(px, y0 + 0.7 + h - r * 0.5, pz, r, 16, 8, true);
      d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
      d.lathe(px, y0 + h * 0.6, pz, [r + 1.1, 0.001, r, 0], 14, false, 0, Math.PI);
      d.paint(C.steelDark, P.GRATE, 0.7, 0.4);
      d.beam([px + r + 0.3, y0 + 0.7, pz], [px + r + 0.3, y0 + h * 0.6, pz], 0.45, 0.05);
      addCyl(fr, px, y0, pz, r, h);
    }
  } else if (t < 0.58) {
    // open steel structure with floors and equipment
    const w = 7 + R() * 3, dd = 6 + R() * 3, rot = Math.round(R() * 4) * Math.PI / 2 + 0.02;
    const levels = Math.max(2, Math.min(5, Math.round(H / 5)));
    g.at(x + jx * 0.3, y0, z + jz * 0.3, rot);
    d.at(x + jx * 0.3, y0, z + jz * 0.3, rot);
    g.paint(col('#6f7b80'), P.METAL, 0.6, 0.35);
    for (const px of [-w / 2, w / 2]) for (const pz of [-dd / 2, dd / 2]) g.box(px - 0.2, 0, pz - 0.2, px + 0.2, levels * 5, pz + 0.2);
    for (let l = 1; l <= levels; l++) {
      g.paint(C.steelDark, P.GRATE, 0.7, 0.4);
      g.box(-w / 2, l * 5 - 0.2, -dd / 2, w / 2, l * 5, dd / 2);
      d.paint(col('#c9a53a'), P.METAL, 0.6, 0.3);
      d.railing([-w / 2, l * 5, -dd / 2, w / 2, l * 5, -dd / 2, w / 2, l * 5, dd / 2, -w / 2, l * 5, dd / 2, -w / 2, l * 5, -dd / 2], 1.05, 1.8, 0.05);
      if (R() < 0.6) {
        d.paint(paintC, P.METAL, 0.45, 0.5);
        d.hcyl(-w / 2 + 1, w / 2 - 1, l * 5 + 1.1, (R() - 0.5) * 2, 0.8 + R() * 0.4, 14, true);
      }
    }
    d.paint(col('#6f7b80'), P.METAL, 0.6, 0.35);
    d.beam([-w / 2, 0, -dd / 2], [w / 2, 5, -dd / 2], 0.2);
    d.beam([w / 2, 0, dd / 2], [-w / 2, 5, dd / 2], 0.2);
    g.pop();
    d.pop();
    addBox(fr, x, y0, z, w, levels * 5, dd, rot);
  } else if (t < 0.74) {
    // horizontal drums / heat exchangers on saddles
    const n = 1 + Math.floor(R() * 3);
    const rot = Math.round(R() * 2) * Math.PI / 2 + 0.02;
    g.at(x + jx, y0, z + jz, rot);
    for (let i = 0; i < n; i++) {
      const r = 0.6 + R() * 0.9, L = 5 + R() * 4, zz = (i - (n - 1) / 2) * (2 * r + 1.2);
      g.paint(C.concreteDark, P.CONCRETE, 0.9);
      g.box(-L / 2 + 0.5, 0, zz - r, -L / 2 + 1.1, 1.2, zz + r);
      g.box(L / 2 - 1.1, 0, zz - r, L / 2 - 0.5, 1.2, zz + r);
      g.paint(paintC, P.METAL, 0.45, 0.5);
      g.hcyl(-L / 2, L / 2, 1.2 + r, zz, r, 14, true);
    }
    g.pop();
  } else if (t < 0.87) {
    // air cooler (fin-fan) on legs
    const w = 9, dd = 6, rot = Math.round(R() * 2) * Math.PI / 2 + 0.02, hh = 7 + R() * 4;
    g.at(x, y0, z, rot);
    g.paint(C.steel, P.METAL, 0.6, 0.35);
    for (const px of [-w / 2, 0, w / 2]) for (const pz of [-dd / 2, dd / 2]) g.box(px - 0.18, 0, pz - 0.18, px + 0.18, hh, pz + 0.18);
    g.paint(C.galv, P.GRATE, 0.5, 0.6);
    g.box(-w / 2, hh, -dd / 2, w / 2, hh + 1.2, dd / 2);
    g.paint(C.steelDark, P.METAL, 0.5, 0.4);
    for (const px of [-w / 4, w / 4]) g.cyl(px, hh + 1.2, 0, 2.2, 2.2, 0.8, 16, false, false);
    g.paint(C.steelDark, P.GRATE, 0.6, 0.4);
    for (const px of [-w / 4, w / 4]) g.disc(px, hh + 1.9, 0, 2.2, 16, true);
    g.pop();
    addBox(fr, x, y0, z, w, hh + 2, dd, rot);
  } else {
    // small tanks
    const n = 1 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const r = 1.5 + R() * 2.2;
      tank(fr, g, d, x + (i - (n - 1) / 2) * (2 * r + 1.5), z + jz, r, Math.min(H, r * 2.2 + 2), paintC, { seed: seed + i, dome: R() < 0.5 });
    }
  }
  // connecting small-bore pipes to grade
  d.paint(C.alu, P.METAL, 0.45, 0.5);
  if (R() < 0.7) d.pipe([x - 4, y0 + 3 + R() * 3, z + jz], [x + 4, y0 + 3 + R() * 3, z + jz], 0.12, 6);
  // work lights on platforms / structures
  const nl = R() < 0.35 ? 2 : 1;
  for (let i = 0; i < nl; i++) workLight(fr, d, x + (R() - 0.5) * 7, y0 + 3 + R() * H * 0.7, z + (R() - 0.5) * 7, R() < 0.75);
}
