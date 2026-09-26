// Civic landmarks: Eternal Flame memorial with the obelisk "Вечная слава" (1967) on bulvar Mira,
// Nevinnomysskaya railway station (1903, rebuilt 1953, neoclassical with a glazed arched portal),
// Khimik stadium (west stand, floodlight masts, pitch + running track), the Nevinnomyssk canal
// headworks on the Kuban (gated weir + canal head regulator), Kubanskaya GES-4 powerhouse and
// the entrance signs of the GRES and EuroChem.
import * as THREE from 'three';
import { Geo, P, F, col, mix3, rng, type RGB, type V3 } from './builder';
import { C, addBox, type Frame } from './structures';

const STONE_L = col('#cfccc3');
const GRANITE_D = col('#3d3533');
const GRANITE_R = col('#6b4a42');

// ------------------------------------------------------------------------------ memorial
/** Star-shaped ring (x,z) with 5 points. */
function starRing(R: number, r: number, rot = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = rot + (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? R : r;
    out.push(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  return out;
}

/** Memorial square in its local frame (+X along the boulevard, origin at the flame POI). Returns flame position (local). */
export function buildMemorial(fr: Frame, g: Geo, d: Geo, hObelisk: number, groundAt: (lx: number, lz: number) => number): V3 {
  // paved square: granite slabs draped on the (sloping) boulevard, the inner square raised 15 cm with
  // a granite kerb; the obelisk pedestal is level and steps out of the slope on its low side
  const drape = (x0: number, x1: number, z0: number, z1: number, lift: number, cell: number) => {
    const nx = Math.max(1, Math.round((x1 - x0) / cell)), nz = Math.max(1, Math.round((z1 - z0) / cell));
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const xa = x0 + ((x1 - x0) * i) / nx, xb = x0 + ((x1 - x0) * (i + 1)) / nx;
      const za = z0 + ((z1 - z0) * j) / nz, zb = z0 + ((z1 - z0) * (j + 1)) / nz;
      const P3 = (x: number, z: number): V3 => [x, groundAt(x, z) + lift, z];
      g.quad(P3(xa, zb), P3(xb, zb), P3(xb, za), P3(xa, za), xa, za);
    }
  };
  g.paint(col('#8e8a84'), P.TILES, 0.75, 0, 0);
  drape(-16, 16, -10, 10, 0.05, 2);
  g.paint(col('#9c978f'), P.TILES, 0.7, 0, 0);
  drape(-13, 13, -7.5, 7.5, 0.2, 1.6);
  // kerb around the inner square
  g.paint(GRANITE_R, P.GRANITE, 0.35, 0, 0);
  const kerb = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 2));
    for (let i = 0; i < n; i++) {
      const xa = ax + ((bx - ax) * i) / n, za = az + ((bz - az) * i) / n, xb = ax + ((bx - ax) * (i + 1)) / n, zb = az + ((bz - az) * (i + 1)) / n;
      g.quad([xa, groundAt(xa, za) - 0.1, za], [xb, groundAt(xb, zb) - 0.1, zb], [xb, groundAt(xb, zb) + 0.22, zb], [xa, groundAt(xa, za) + 0.22, za]);
    }
  };
  kerb(13, -7.5, -13, -7.5); kerb(-13, 7.5, 13, 7.5); kerb(-13, -7.5, -13, 7.5); kerb(13, 7.5, 13, -7.5);
  const topAt = (lx: number, lz: number) => groundAt(lx, lz) + 0.2;
  // obelisk on a pedestal (east of the flame): level, founded on the highest corner
  const ox = 6;
  let y0 = -Infinity;
  for (const [a, b] of [[-3.4, -3.4], [3.4, -3.4], [3.4, 3.4], [-3.4, 3.4], [0, 0]]) y0 = Math.max(y0, topAt(ox + a, b) - 0.6);
  let yLow = Infinity;
  for (const [a, b] of [[-3.4, -3.4], [3.4, -3.4], [3.4, 3.4], [-3.4, 3.4]]) yLow = Math.min(yLow, topAt(ox + a, b) - 0.6);
  // stepped base down to the lowest corner
  g.paint(GRANITE_R, P.GRANITE, 0.35, 0, F.FLOOD);
  for (let k = 0, y = y0 + 0.6; y > yLow + 0.45 && k < 12; k++, y -= 0.16) {
    const e = 3.4 + k * 0.34;
    g.box(ox - e, y - 0.16 - (y - 0.16 > yLow + 0.45 ? 0 : 0.6), -e, ox + e, y, e, 63 - 4);
  }
  g.box(ox - 3.4, yLow - 0.2, -3.4, ox + 3.4, y0 + 0.6, 3.4, 63 - 4);
  g.paint(GRANITE_R, P.GRANITE, 0.3, 0, F.FLOOD);
  g.box(ox - 2.6, y0 + 0.6, -2.6, ox + 2.6, y0 + 2.2, 2.6);
  g.paint(STONE_L, P.STONE, 0.6, 0, F.FLOOD);
  const hb = 2.0, ht = 0.95;
  const Y = y0 + 2.2, H = hObelisk - 2.2;
  // tapered square shaft (4 trapezoid faces) + pyramidion
  const q = (sx: number, sz: number) => [ox + sx, sz] as [number, number];
  const faces: Array<[[number, number], [number, number]]> = [
    [q(-1, -1), q(1, -1)], [q(1, -1), q(1, 1)], [q(1, 1), q(-1, 1)], [q(-1, 1), q(-1, -1)],
  ];
  for (const [[ax, az], [bx, bz]] of faces) {
    const mx = ox, dx0 = ax - mx, dx1 = bx - mx;
    const A: V3 = [mx + dx0 * hb, Y, az * hb], B: V3 = [mx + dx1 * hb, Y, bz * hb];
    const Cc: V3 = [mx + dx1 * ht, Y + H, bz * ht], D: V3 = [mx + dx0 * ht, Y + H, az * ht];
    g.quad(B, A, D, Cc);
  }
  g.tri3([ox + ht, Y + H, ht], [ox, Y + H + 1.6, 0], [ox + ht, Y + H, -ht]);
  g.tri3([ox - ht, Y + H, -ht], [ox, Y + H + 1.6, 0], [ox - ht, Y + H, ht]);
  g.tri3([ox + ht, Y + H, -ht], [ox, Y + H + 1.6, 0], [ox - ht, Y + H, -ht]);
  g.tri3([ox - ht, Y + H, ht], [ox, Y + H + 1.6, 0], [ox + ht, Y + H, ht]);
  // gilded star relief on the west face and bronze inscription band
  g.paint(col('#d9a441'), P.GOLD, 0.25, 1, F.NOGRIME | F.FLOOD);
  const sy = Y + H * 0.72;
  const tHalf = hb + (ht - hb) * 0.72;
  g.at(ox - tHalf - 0.02, sy, 0, 0);
  g.push(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  g.prism(starRing(1.0, 0.42), 0, 0.12, true, false);
  g.pop();
  g.pop();
  g.paint(col('#6d5534'), P.METAL, 0.4, 0.8, F.NOGRIME);
  g.box(ox - hb - 0.04, Y + 1.2, -1.2, ox - hb + 0.02, Y + 2.0, 1.2, 1);
  // Book of Memory (2000): open granite book behind the obelisk
  g.paint(GRANITE_D, P.GRANITE, 0.25, 0, F.FLOOD);
  const bx = ox + 7.5;
  y0 = topAt(bx, 0) - 0.6;
  g.box(bx - 0.6, y0 + 0.3, -3.2, bx + 0.6, y0 + 0.6, 3.2);
  g.box(bx - 0.6, y0 + 0.6, -3.2, bx + 0.6, y0 + 1.0, 3.2);
  g.at(bx, y0 + 1.0, -1.55, 0);
  g.push(new THREE.Matrix4().makeRotationX(-0.28));
  g.box(-0.2, 0, -1.4, 0.2, 2.75, 1.4);
  g.pop(); g.pop();
  g.at(bx, y0 + 1.0, 1.55, 0);
  g.push(new THREE.Matrix4().makeRotationX(0.28));
  g.box(-0.2, 0, -1.4, 0.2, 2.75, 1.4);
  g.pop(); g.pop();
  // Eternal flame: five-pointed star bowl of dark granite with a bronze burner
  const fx = -1.5;
  y0 = topAt(fx, 0) - 0.6;
  g.paint(GRANITE_D, P.GRANITE, 0.2, 0, 0);
  g.at(fx, y0 + 0.2, 0, 0);
  g.prism(starRing(2.35, 1.0), 0, 0.4, false, false);
  g.pop();
  g.paint(GRANITE_D, P.GRANITE, 0.2, 0, 0);
  g.at(fx, y0 + 0.6, 0, 0);
  g.prism(starRing(2.2, 0.9), 0, 0.35, true, false);
  g.pop();
  g.paint(col('#4a3b2a'), P.METAL, 0.35, 0.9, F.NOGRIME);
  g.cyl(fx, y0 + 0.95, 0, 0.45, 0.32, 0.25, 16, false, true);
  // flowers laid around the star: bouquets of red carnations (stems + blossoms), a few yellow
  const R = rng(1967);
  for (let i = 0; i < 22; i++) {
    const a = R() * Math.PI * 2, rr = 2.3 + R() * 0.7;
    const bx0 = fx + Math.cos(a) * rr, bz0 = Math.sin(a) * rr;
    const dir = a + Math.PI + (R() - 0.5) * 0.8;     // stems point roughly away from the flame
    d.at(bx0, y0 + 0.66, bz0, -dir);
    d.push(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
    d.paint(col('#3e6b2c'), P.PLAIN, 0.8, 0, F.NOGRIME);
    d.lathe(0, 0, 0, [0.02, 0, 0.09, 0.42], 6, true);
    d.pop();
    const fc = R() < 0.82 ? col('#b3151b') : col('#e0c23c');
    d.paint(fc, P.PLAIN, 0.7, 0, F.NOGRIME);
    for (let k = 0; k < 4; k++) d.sphere(0.45 + R() * 0.08, (R() - 0.5) * 0.08, (R() - 0.5) * 0.16, 0.055, 6, 4);
    d.pop();
  }
  // two wreaths leaning against the pedestal, with St George ribbons
  for (const zz of [-2.2, 2.2]) {
    d.at(ox - 2.75, y0 + 1.3, zz, 0);
    d.push(new THREE.Matrix4().makeRotationZ(Math.PI / 2 - 0.22));
    d.paint(col('#2c5226'), P.PLAIN, 0.85, 0, F.NOGRIME);
    d.lathe(0, 0, 0, [0.5, 0, 0.62, -0.09, 0.8, -0.05, 0.86, 0.02, 0.78, 0.1, 0.6, 0.09, 0.5, 0], 20, true);
    d.paint(col('#b3151b'), P.PLAIN, 0.7, 0, F.NOGRIME);
    for (let k = 0; k < 10; k++) { const b = (k / 10) * Math.PI * 2; d.sphere(Math.cos(b) * 0.68, 0.09, Math.sin(b) * 0.68, 0.06, 6, 4); }
    d.pop();
    // ribbon (orange / black stripes) hanging from the bottom of the wreath
    for (let k = 0; k < 5; k++) {
      d.paint(k % 2 === 0 ? col('#e07b14') : col('#141414'), P.PLAIN, 0.5, 0, F.NOGRIME);
      d.box(-0.16, -0.75, -0.2 + k * 0.08, -0.12, 0.05, -0.12 + k * 0.08);
    }
    d.pop();
  }
  // low granite border blocks at the corners of the inner square
  g.paint(GRANITE_R, P.GRANITE, 0.3, 0, 0);
  for (const [x, z] of [[-12.5, -7], [12.5, -7], [-12.5, 7], [12.5, 7]]) g.boxC(x, topAt(x, z) - 0.2, z, 0.9, 0.9, 0.9);
  const yO = topAt(ox, 0) - 0.6;
  addBox(fr, ox, yO, 0, 5.2, hObelisk, 5.2, 0);
  const yF = topAt(fx, 0) - 0.6;
  return [fx, yF + 1.15, 0];
}

// ------------------------------------------------------------------------------ station
/** Neoclassical station building. Local +X along the long axis; front (town side) towards local front*Z. */
export function buildStation(g: Geo, d: Geo, L: number, Wd: number, front: number, y0: number): void {
  const wallC = col('#e2cd9c'), trim = col('#f3efe4'), roof = col('#6c7471'), plinth = col('#9d9588');
  const cw = 18, ch = 14.5, wh = 8.8;
  const zf = front * (Wd / 2);            // front facade z
  const zb = -zf;
  const zmin = -Wd / 2, zmax = Wd / 2;
  const fl = F.FLOOD;
  // plinth
  g.paint(plinth, P.STONE, 0.85, 0, 0);
  g.box(-L / 2 - 0.3, y0 - 2, zmin - 0.3, L / 2 + 0.3, y0 + 0.7, zmax + 0.3);
  // wings
  for (const sgn of [-1, 1]) {
    const xa = sgn < 0 ? -L / 2 : cw / 2, xb = sgn < 0 ? -cw / 2 : L / 2;
    g.paint(wallC, P.STONE, 0.85, 0, fl);
    g.box(xa, y0 + 0.7, zmin, xb, y0 + wh, zmax, 63 - 4 - 8);
    g.paint(trim, P.STONE, 0.7, 0, fl);
    g.box(xa - 0.1, y0 + wh - 0.9, zmin - 0.35, xb + 0.1, y0 + wh, zmax + 0.35, 63 - 4);
    g.box(xa, y0 + wh, zmin + 0.1, xb, y0 + wh + 1.1, zmax - 0.1, 63 - 4);   // attic parapet
    // hipped roof behind parapet
    g.paint(roof, P.ROOFSEAM, 0.6, 0.3);
    g.gable(xa + 0.5, xb - 0.5, zmin + 0.6, zmax - 0.6, y0 + wh + 0.4, y0 + wh + 3.2, 0.1);
    // tall windows with pilasters, both facades
    const nW = Math.max(3, Math.round((xb - xa) / 3.2));
    for (let i = 0; i < nW; i++) {
      const wx = xa + ((xb - xa) * (i + 0.5)) / nW;
      for (const zz of [zmin, zmax]) {
        const s = zz > 0 ? 1 : -1;
        g.paint(col('#1f2429'), P.WINDOW, 0.1, 0, F.WINLIT);
        g.boxC(wx, y0 + 1.6, zz + s * 0.03, 1.6, 4.6, 0.1);
        g.paint(trim, P.STONE, 0.7, 0, fl);
        g.boxC(wx, y0 + 6.2, zz + s * 0.08, 2.1, 0.45, 0.2);
        g.boxC(wx, y0 + 1.35, zz + s * 0.08, 2.0, 0.25, 0.25);
        const px = xa + ((xb - xa) * i) / nW;
        if (i > 0) g.boxC(px, y0 + 0.7, zz + s * 0.12, 0.6, wh - 1.6, 0.25);
      }
    }
    // end facade
    const xe = sgn < 0 ? xa : xb;
    g.paint(col('#1f2429'), P.WINDOW, 0.1, 0, F.WINLIT);
    for (const zz of [-Wd / 4, Wd / 4]) g.boxC(xe + sgn * 0.03, y0 + 1.6, zz, 0.1, 4.6, 1.6);
  }
  // central block with the glazed arched portal and columns (front), towards the tracks a lower hall
  g.paint(wallC, P.STONE, 0.85, 0, fl);
  g.box(-cw / 2, y0 + 0.7, zmin - 1, cw / 2, y0 + ch, zmax + 1, 63 - 4 - 8);
  g.paint(trim, P.STONE, 0.7, 0, fl);
  g.box(-cw / 2 - 0.2, y0 + ch - 1.2, zmin - 1.4, cw / 2 + 0.2, y0 + ch, zmax + 1.4, 63 - 4);
  g.box(-cw / 2 + 0.2, y0 + ch, zmin - 0.8, cw / 2 - 0.2, y0 + ch + 1.6, zmax + 0.8, 63 - 4);
  g.paint(roof, P.ROOFSEAM, 0.6, 0.3);
  g.gable(-cw / 2 + 0.6, cw / 2 - 0.6, zmin - 0.4, zmax + 0.4, y0 + ch + 0.4, y0 + ch + 4.2, 0.1);
  // arch portal: glazing panel inside a semicircular arch
  const s = front;
  const zF = s > 0 ? zmax + 1 : zmin - 1;
  g.paint(col('#56625f'), P.GLAZING, 0.2, 0, F.WINLIT);
  const aw = 5.2, ay = y0 + 1.0, spring = 7.2;
  g.boxC(0, ay, zF + s * 0.02, aw * 2, spring - 1.0, 0.1);
  const arch: number[] = [];
  for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI; arch.push(Math.cos(a) * aw, -Math.sin(a) * aw); }
  g.at(0, y0 + spring, zF + s * 0.07, 0);
  g.push(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  g.prism(arch, -0.05, 0.05, true, true);
  g.pop(); g.pop();
  // arch frame
  g.paint(trim, P.STONE, 0.7, 0, fl);
  for (let i = 0; i < 12; i++) {
    const a0 = (i / 12) * Math.PI, a1 = ((i + 1) / 12) * Math.PI;
    g.beam([Math.cos(a0) * (aw + 0.3), y0 + spring + Math.sin(a0) * (aw + 0.3), zF + s * 0.2], [Math.cos(a1) * (aw + 0.3), y0 + spring + Math.sin(a1) * (aw + 0.3), zF + s * 0.2], 0.6, 0.35);
  }
  // columns (two pairs) and entablature
  for (const cx of [-aw - 1.6, -aw - 0.4 - 2.6, aw + 1.6, aw + 0.4 + 2.6]) {
    g.paint(trim, P.STONE, 0.65, 0, fl);
    g.cyl(cx, y0 + 0.7, zF + s * 0.9, 0.42, 0.36, ch - 2.4, 14, false, false);
    g.boxC(cx, y0 + ch - 1.8, zF + s * 0.9, 1.1, 0.5, 1.1);
    g.boxC(cx, y0 + 0.6, zF + s * 0.9, 1.1, 0.4, 1.1);
  }
  // station name on the attic
  // (text is added as a separate canvas sign in index.ts)
  // doors under the arch
  g.paint(col('#3b2e22'), P.PLAIN, 0.6, 0.1, 0);
  for (const dx of [-2.4, 0, 2.4]) g.boxC(dx, y0 + 0.7, zF + s * 0.06, 1.8, 2.8, 0.1);
  // steps in front
  g.paint(col('#9b958c'), P.STONE, 0.85, 0, 0);
  for (let i = 0; i < 3; i++) g.box(-cw / 2, y0 - 1 + i * 0.23, Math.min(zF + s * (4 - i * 0.6), zF), cw / 2, y0 - 0.77 + i * 0.23 + 0.23, Math.max(zF + s * (4 - i * 0.6), zF));
  // track-side canopy on cast-iron columns
  const zc = s > 0 ? zmin : zmax, sc = -s;
  g.paint(col('#5d6a66'), P.ROOFSEAM, 0.6, 0.3);
  g.box(-L / 2 + 2, y0 + 4.6, Math.min(zc, zc + sc * 4.5), L / 2 - 2, y0 + 4.9, Math.max(zc, zc + sc * 4.5));
  d.paint(col('#3f4a47'), P.METAL, 0.5, 0.5);
  for (let x = -L / 2 + 4; x < L / 2 - 3; x += 6) d.cyl(x, y0 + 0.7, zc + sc * 4.0, 0.14, 0.14, 3.9, 8, false, false);
  void zb; void mix3;
}

// ------------------------------------------------------------------------------ stadium
/** Stadium west stand (local: +X along the stand, seats rise towards +Z*back). */
export function buildStand(g: Geo, d: Geo, L: number, D: number, back: number, y0: number): void {
  const rows = 14, rowD = (D - 3) / rows, rise = 0.42;
  const seatCols: RGB[] = [col('#1f4e9a'), col('#1f4e9a'), col('#d0a826'), col('#c23a2c')];
  for (let r = 0; r < rows; r++) {
    const za = (-D / 2 + 1 + r * rowD) * back, zb = (-D / 2 + 1 + (r + 1) * rowD) * back;
    const y = y0 + 0.8 + r * rise;
    g.paint(col('#a9a69e'), P.CONCRETE, 0.9);
    g.box(-L / 2, y0 - 1, Math.min(za, zb), L / 2, y, Math.max(za, zb));
    // seats row
    d.paint(seatCols[Math.floor(r / 4) % seatCols.length], P.PLAIN, 0.5, 0, 0);
    const zs = za + (zb - za) * 0.55;
    d.box(-L / 2 + 1, y, Math.min(zs, zs + back * 0.45), L / 2 - 1, y + 0.42, Math.max(zs, zs + back * 0.45));
  }
  // back wall / facade
  const zBack = (D / 2) * back;
  const top = y0 + 0.8 + rows * rise;
  g.paint(col('#bdb8ab'), P.PANEL, 0.85);
  g.box(-L / 2, y0 - 1, Math.min(zBack, zBack - back * 1.5), L / 2, top + 1.2, Math.max(zBack, zBack - back * 1.5));
  // stairs (aisles)
  g.paint(col('#8f8c85'), P.CONCRETE, 0.9);
  for (let i = 1; i < 6; i++) {
    const x = -L / 2 + (L * i) / 6;
    d.paint(col('#8f8c85'), P.CONCRETE, 0.9);
    d.beam([x, y0 + 0.8, (-D / 2 + 1) * back], [x, top, (D / 2 - 1.5) * back], 1.2, 0.2);
  }
  // cantilever roof over the upper rows
  const roofY = top + 6;
  g.paint(col('#cfd3d4'), P.CORR, 0.4, 0.5);
  g.box(-L / 2 + 6, roofY, Math.min(zBack, zBack - back * (D * 0.75)), L / 2 - 6, roofY + 0.4, Math.max(zBack, zBack - back * (D * 0.75)));
  d.paint(col('#5e6568'), P.METAL, 0.5, 0.6);
  for (let x = -L / 2 + 8; x <= L / 2 - 8; x += 12) {
    d.beam([x, top, zBack - back * 0.8], [x, roofY, zBack - back * 0.8], 0.4);
    d.beam([x, roofY - 0.3, zBack - back * 0.8], [x, roofY, zBack - back * (D * 0.75)], 0.35, 0.8);
  }
}

/** Floodlight mast with a lamp head facing the pitch centre (dir = angle towards the centre). */
export function floodMast(fr: Frame, g: Geo, d: Geo, x: number, y0: number, z: number, h: number, dir: number): void {
  g.paint(col('#8d9396'), P.METAL, 0.5, 0.6);
  g.cyl(x, y0 - 1, z, 0.55, 0.28, h + 1, 12, false, true);
  const ca = Math.cos(dir), sa = Math.sin(dir);
  g.at(x + ca * 0.8, y0 + h, z + sa * 0.8, -dir);
  g.push(new THREE.Matrix4().makeRotationZ(-0.35));
  g.paint(col('#5b6164'), P.METAL, 0.6, 0.5);
  g.box(-0.3, -1.8, -3.2, 0.1, 1.8, 3.2);
  g.paint(col('#fffbe8'), P.LAMP, 0.3, 0, 0);
  g.box(0.1, -1.6, -3.0, 0.16, 1.6, 3.0, 2);
  g.pop();
  g.pop();
  for (let i = -1; i <= 1; i++) {
    fr.glows.push({ x: fr.ox + x + ca * 1.2 - sa * i * 2, y: fr.oy + y0 + h, z: fr.oz + z + sa * 1.2 + ca * i * 2, color: new THREE.Color(1.6, 1.55, 1.4), size: 3.5, day: 0 });
  }
  d.paint(C.steelDark, P.METAL, 0.6, 0.4);
  d.beam([x - sa * 0.4, y0, z + ca * 0.4], [x - sa * 0.4, y0 + h, z + ca * 0.4], 0.35, 0.05);
  addBox(fr, x, y0, z, 1.1, h, 1.1, 0);
}

/** Pitch + running track draped on the ground (local frame, +X = pitch long axis). */
export function buildPitch(g: Geo, groundAt: (lx: number, lz: number) => number): void {
  const lift = 0.06;
  const grass = col('#3f6a2f'), grass2 = col('#4b7a37'), track = col('#9a3b2b'), white = col('#e8e8e2');
  const rIn = 36.5, rOut = 36.5 + 8 * 1.22, half = 84.39 / 2;
  const P3 = (x: number, z: number, dy = 0): V3 => [x, groundAt(x, z) + lift + dy, z];
  // point on the stadium-shaped curve (straights along X, semicircles at the ends), t in [0,1)
  const perim = (r: number) => 4 * half + 2 * Math.PI * r;
  const shape = (t: number, r: number): [number, number] => {
    let s = (((t % 1) + 1) % 1) * perim(r);
    if (s < 2 * half) return [-half + s, -r];
    s -= 2 * half;
    if (s < Math.PI * r) { const a = -Math.PI / 2 + s / r; return [half + Math.cos(a) * r, Math.sin(a) * r]; }
    s -= Math.PI * r;
    if (s < 2 * half) return [half - s, r];
    s -= 2 * half;
    const a = Math.PI / 2 + s / r;
    return [-half + Math.cos(a) * r, Math.sin(a) * r];
  };
  // running track: ring between rIn and rOut, 3 radial rows, ~2.5 m along the perimeter
  const N = Math.ceil(perim(rOut) / 2.5);
  const rows = [rIn, rIn + (rOut - rIn) / 3, rIn + (2 * (rOut - rIn)) / 3, rOut];
  g.paint(track, P.ASPHALT, 0.9, 0, F.NOGRIME);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < 3; k++) {
      const a0 = shape(i / N, rows[k]), a1 = shape((i + 1) / N, rows[k]);
      const b0 = shape(i / N, rows[k + 1]), b1 = shape((i + 1) / N, rows[k + 1]);
      g.quad(P3(a0[0], a0[1]), P3(a1[0], a1[1]), P3(b1[0], b1[1]), P3(b0[0], b0[1]));
    }
  }
  // lane lines
  g.paint(white, P.PLAIN, 0.9, 0, F.NOGRIME);
  for (let l = 0; l <= 8; l++) {
    const r = rIn + l * 1.22;
    for (let i = 0; i < N; i++) {
      const a0 = shape(i / N, r - 0.03), a1 = shape((i + 1) / N, r - 0.03);
      const b0 = shape(i / N, r + 0.03), b1 = shape((i + 1) / N, r + 0.03);
      g.quad(P3(a0[0], a0[1], 0.035), P3(a1[0], a1[1], 0.035), P3(b1[0], b1[1], 0.035), P3(b0[0], b0[1], 0.035));
    }
  }
  // concrete curb outside the track
  g.paint(col('#a19e96'), P.CONCRETE, 0.9);
  for (let i = 0; i < N; i++) {
    const a0 = shape(i / N, rOut), a1 = shape((i + 1) / N, rOut);
    const b0 = shape(i / N, rOut + 0.3), b1 = shape((i + 1) / N, rOut + 0.3);
    g.quad(P3(a0[0], a0[1], 0.08), P3(a1[0], a1[1], 0.08), P3(b1[0], b1[1], 0.08), P3(b0[0], b0[1], 0.08));
  }
  // infield: columns across X, rows normalised to the shape width -> smooth edges; mowing stripes 6 m
  const xm = half + rIn;
  const zmax = (x: number) => (Math.abs(x) <= half ? rIn : Math.sqrt(Math.max(0, rIn * rIn - (Math.abs(x) - half) ** 2)));
  const nx = Math.ceil((2 * xm) / 3), nz = 24;
  for (let i = 0; i < nx; i++) {
    const x0 = -xm + (2 * xm * i) / nx, x1 = -xm + (2 * xm * (i + 1)) / nx;
    const c = Math.floor((x0 + xm) / 6) % 2 === 0 ? grass : grass2;
    g.paint(c, P.PLAIN, 0.95, 0, F.NOGRIME);
    const z0m = zmax(x0), z1m = zmax(x1);
    for (let k = 0; k < nz; k++) {
      const v0 = -1 + (2 * k) / nz, v1 = -1 + (2 * (k + 1)) / nz;
      g.quad(P3(x0, v1 * z0m), P3(x1, v1 * z1m), P3(x1, v0 * z1m), P3(x0, v0 * z0m));
    }
  }
  // pitch lines (105 x 68)
  const line = (ax: number, az: number, bx: number, bz: number) => {
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 3));
    const nx = -(bz - az) / L * 0.06, nz = (bx - ax) / L * 0.06;
    g.paint(white, P.PLAIN, 0.9, 0, F.NOGRIME);
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      const pp = (x: number, z: number): V3 => [x, groundAt(x, z) + lift + 0.035, z];
      g.quad(pp(x0 - nx, z0 - nz), pp(x0 + nx, z0 + nz), pp(x1 + nx, z1 + nz), pp(x1 - nx, z1 - nz));
    }
  };
  const hx = 52.5, hz = 34;
  line(-hx, -hz, hx, -hz); line(hx, -hz, hx, hz); line(hx, hz, -hx, hz); line(-hx, hz, -hx, -hz); line(0, -hz, 0, hz);
  for (const s of [-1, 1]) {
    line(s * hx, -20.16, s * (hx - 16.5), -20.16); line(s * (hx - 16.5), -20.16, s * (hx - 16.5), 20.16); line(s * (hx - 16.5), 20.16, s * hx, 20.16);
    line(s * hx, -9.16, s * (hx - 5.5), -9.16); line(s * (hx - 5.5), -9.16, s * (hx - 5.5), 9.16); line(s * (hx - 5.5), 9.16, s * hx, 9.16);
  }
  for (let i = 0; i < 24; i++) {
    const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2;
    line(Math.cos(a0) * 9.15, Math.sin(a0) * 9.15, Math.cos(a1) * 9.15, Math.sin(a1) * 9.15);
  }
}

// ------------------------------------------------------------------------------ weir
export interface WeirOpts {
  /** Deck top (local y) of an external road bridge along the weir axis (roads module); null = own deck. */
  deckTop?: ((lx: number, lz: number) => number) | null;
  /** Half width of that road deck (m). */
  roadHalf?: number;
  /** Stations (m along the weir line) of the road bridge piers: ours are aligned so theirs stand inside. */
  piersS?: number[];
}

/**
 * Gated barrage along a polyline (local coords): piers with rounded cutwaters, vertical-lift gates on the
 * upstream side with a hoist gallery beside the road deck, spillway glacis under the tail water,
 * abutments. When the roads module draws the road bridge on top (opts.deckTop) our deck is skipped and
 * the piers rise into its girders. up/down = pool / tail water levels (world).
 */
export function buildWeir(fr: Frame, g: Geo, d: Geo, line: number[][], up: number, down: number, opts: WeirOpts = {}): void {
  const segs: Array<{ a: number[]; b: number[]; L: number; s0: number }> = [];
  let total = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const L = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    if (L < 0.01) continue;
    segs.push({ a: line[i], b: line[i + 1], L, s0: total });
    total += L;
  }
  if (!segs.length) return;
  const pointAt = (s: number): { x: number; z: number; dx: number; dz: number } => {
    for (const sg of segs) {
      if (s <= sg.s0 + sg.L || sg === segs[segs.length - 1]) {
        const t = THREE.MathUtils.clamp((s - sg.s0) / sg.L, 0, 1);
        const dx = (sg.b[0] - sg.a[0]) / sg.L, dz = (sg.b[1] - sg.a[1]) / sg.L;
        return { x: sg.a[0] + (sg.b[0] - sg.a[0]) * t, z: sg.a[1] + (sg.b[1] - sg.a[1]) * t, dx, dz };
      }
    }
    return { x: 0, z: 0, dx: 1, dz: 0 };
  };
  // pier stations: the road-bridge piers plus subdivisions (~14 m bays) and both ends
  const fixed = [0, ...(opts.piersS ?? []).filter((s) => s > 4 && s < total - 4), total].sort((a, b) => a - b);
  const st: number[] = [];
  for (let i = 0; i + 1 < fixed.length; i++) {
    const n = Math.max(1, Math.round((fixed[i + 1] - fixed[i]) / 14));
    for (let k = 0; k < n; k++) st.push(fixed[i] + ((fixed[i + 1] - fixed[i]) * k) / n);
  }
  st.push(total);
  const oy = fr.oy;
  const Y = (w: number) => w - oy;                  // world level -> local
  const own = !opts.deckTop;
  const half = opts.roadHalf ?? 5.1;
  const flatTop = Y(up + 4.6);
  // road deck top at a station (local y); ours is flat
  const deckAt = (x: number, z: number) => (opts.deckTop ? opts.deckTop(x, z) : flatTop);
  const bedY = Y(down - 4.5), crest = Y(up - 2.8);
  const zG = -(half + 2.6);                          // gate line (upstream of the road deck)
  const zNose = -(half + 7.5), zTail = half + 6;     // pier extent along the flow (local -Z = upstream)
  const conc = col('#a19d93'), concD = col('#8a867d'), gate = col('#4b5a66'), hoist = col('#d3cdbb');
  for (let i = 0; i < st.length; i++) {
    const p = pointAt(st[i]);
    const rot = Math.atan2(-p.dz, p.dx);            // local X along the weir axis, +Z downstream
    const top = deckAt(p.x, p.z);
    const end = i === 0 || i === st.length - 1;
    const pw = end ? 3.2 : 2.4;
    g.at(p.x, 0, p.z, rot);
    g.paint(conc, P.CONCRETE, 0.9);
    // under the road deck: up into the girders; upstream part carries the hoist gallery; tail part lower
    g.box(-pw / 2, bedY, -half, pw / 2, top - (own ? 0.9 : 1.1), half);
    g.box(-pw / 2, bedY, zNose + pw / 2, pw / 2, top - 1.2, -half, 63 - 32);
    g.box(-pw / 2, bedY, half, pw / 2, Y(down + 1.6), zTail, 63 - 16);
    // rounded cutwater (upstream) and gate slots
    g.cyl(0, bedY, zNose + pw / 2, pw / 2, pw / 2, top - 1.2 - bedY, 12, false, true);
    g.paint(concD, P.CONCRETE, 0.95);
    g.box(-pw / 2 - 0.02, crest, zG - 0.5, pw / 2 + 0.02, top - 1.2, zG + 0.5, 1 | 2);
    g.pop();
    addBox(fr, p.x, bedY, p.z, pw, top - bedY, zTail - zNose, rot);
  }
  for (let i = 0; i + 1 < st.length; i++) {
    const pa = pointAt(st[i]), pb = pointAt(st[i + 1]);
    const mx = (pa.x + pb.x) / 2, mz = (pa.z + pb.z) / 2;
    const L = Math.hypot(pb.x - pa.x, pb.z - pa.z) - 2.4;
    const rot = Math.atan2(-(pb.z - pa.z), pb.x - pa.x);
    const top = deckAt(mx, mz);
    const gy = top - 1.2;                            // hoist gallery floor top
    g.at(mx, 0, mz, rot);
    d.at(mx, 0, mz, rot);
    // crest sill + upstream apron, glacis down to the tail water, stilling basin end sill
    g.paint(conc, P.CONCRETE, 0.9);
    g.box(-L / 2 - 1.2, bedY, zNose, L / 2 + 1.2, crest, zG + 1.5);
    g.quad([L / 2 + 1.2, crest, zG + 1.5], [-L / 2 - 1.2, crest, zG + 1.5], [-L / 2 - 1.2, Y(down - 1.2), zTail], [L / 2 + 1.2, Y(down - 1.2), zTail]);
    g.paint(concD, P.CONCRETE, 0.95);
    g.box(-L / 2 - 1.2, bedY, zTail, L / 2 + 1.2, Y(down - 0.9), zTail + 14);
    g.box(-L / 2 - 1.2, Y(down - 0.9), zTail + 12.5, L / 2 + 1.2, Y(down - 0.35), zTail + 14);
    // lift gate (every third one raised further: that is where the white water pours out)
    const open = (i % 3) === 1 ? 1.1 : 0.3;
    g.paint(gate, P.METAL, 0.55, 0.4);
    g.box(-L / 2 - 0.3, crest + open, zG - 0.3, L / 2 + 0.3, Y(up + 0.7) + open, zG + 0.3);
    d.paint(col('#3c4852'), P.METAL, 0.6, 0.45);
    for (let k = 1; k < 4; k++) d.box(-L / 2, crest + open + k * 0.85, zG - 0.45, L / 2, crest + open + k * 0.85 + 0.18, zG - 0.3);
    // hoist gallery (service deck beside the road deck) with a hoist house over each gate
    g.paint(col('#8e8b84'), P.CONCRETE, 0.9);
    g.box(-L / 2 - 1.2, gy - 0.9, zNose + 1.5, L / 2 + 1.2, gy, -half);
    g.paint(hoist, P.PANEL, 0.85);
    g.box(-L * 0.32, gy, zG - 2.0, L * 0.32, gy + 3.4, zG + 1.6);
    g.paint(col('#5a6a70'), P.ROOFSEAM, 0.6, 0.3);
    g.box(-L * 0.32 - 0.25, gy + 3.4, zG - 2.25, L * 0.32 + 0.25, gy + 3.65, zG + 1.85, 63 - 4);
    g.paint(col('#23282c'), P.WINDOW, 0.1, 0, F.WINLIT);
    g.box(-0.9, gy + 1.2, zG - 2.03, 0.9, gy + 2.4, zG - 2.0, 16);
    d.paint(C.steelDark, P.METAL, 0.6, 0.4);
    d.railing([-L / 2 - 1.2, gy, zNose + 1.6, L / 2 + 1.2, gy, zNose + 1.6], 1.1, 2, 0.05);
    if (own) {
      // own road deck (only without the roads module)
      g.paint(col('#8e8b84'), P.CONCRETE, 0.9);
      g.box(-L / 2 - 1.2, top - 0.9, -half, L / 2 + 1.2, top - 0.08, half);
      g.paint(C.asphalt, P.ASPHALT, 0.95);
      g.box(-L / 2 - 1.2, top - 0.08, -half + 0.4, L / 2 + 1.2, top, half - 0.4, 8);
      d.paint(C.steelDark, P.METAL, 0.6, 0.4);
      d.railing([-L / 2 - 1.2, top, -half + 0.2, L / 2 + 1.2, top, -half + 0.2], 1.1, 2, 0.05);
      d.railing([L / 2 + 1.2, top, half - 0.2, -L / 2 - 1.2, top, half - 0.2], 1.1, 2, 0.05);
    }
    g.pop();
    d.pop();
    // night: lamp on each hoist house
    const lx = mx + Math.sin(rot) * (zG - 2.1), lz = mz + Math.cos(rot) * (zG - 2.1);
    d.paint(col('#ffb060'), P.LAMP, 0.4, 0, 0);
    d.boxC(lx, gy + 2.9, lz, 0.25, 0.14, 0.25);
    fr.glows.push({ x: fr.ox + lx, y: fr.oy + gy + 2.85, z: fr.oz + lz, color: new THREE.Color(2.2, 1.15, 0.35), size: 1.1, day: 0 });
  }
  // bank abutments / wing walls up to the deck
  for (const s of [0, total]) {
    const p = pointAt(s);
    const rot = Math.atan2(-p.dz, p.dx);
    const top = deckAt(p.x, p.z);
    g.paint(conc, P.CONCRETE, 0.9);
    g.at(p.x, 0, p.z, rot);
    const sgn = s === 0 ? -1 : 1;
    g.box(sgn > 0 ? 1.6 : -9, bedY, zNose, sgn > 0 ? 9 : -1.6, top - 1.2, zTail + 14);
    g.pop();
  }
}

/** Canal head regulator: gate bays across the canal at (x,z) with flow direction dir (radians, atan2(dz,dx)). */
export function buildRegulator(fr: Frame, g: Geo, d: Geo, x: number, z: number, dir: number, level: number, width = 32): void {
  const rot = Math.atan2(-Math.cos(dir), -Math.sin(dir)); // local X across the canal
  const deckY = level + 3.5 - fr.oy, bedY = level - 5 - fr.oy;
  g.at(x, 0, z, rot);
  d.at(x, 0, z, rot);
  const nb = 4, bw = width / nb;
  for (let i = 0; i <= nb; i++) {
    const px = -width / 2 + i * bw;
    g.paint(col('#a39f96'), P.CONCRETE, 0.9);
    g.box(px - 1, bedY, -6, px + 1, deckY, 6);
  }
  for (let i = 0; i < nb; i++) {
    const px = -width / 2 + (i + 0.5) * bw;
    g.paint(col('#4b5a66'), P.METAL, 0.55, 0.4);
    g.box(px - bw / 2 + 1, level - 2 - fr.oy, -0.35, px + bw / 2 - 1, level + 0.9 - fr.oy, 0.35);
  }
  g.paint(col('#8e8b84'), P.CONCRETE, 0.9);
  g.box(-width / 2 - 1, deckY, -3, width / 2 + 1, deckY + 0.7, 3);
  g.paint(col('#d6d0bd'), P.PANEL, 0.85);
  g.box(-width / 2 + 2, deckY + 0.7, -2.4, width / 2 - 2, deckY + 4.5, 2.4);
  g.paint(col('#5a6a70'), P.ROOFSEAM, 0.6, 0.3);
  g.gable(-width / 2 + 2, width / 2 - 2, -2.4, 2.4, deckY + 4.5, deckY + 5.6, 0.4);
  d.paint(C.steelDark, P.METAL, 0.6, 0.4);
  d.railing([-width / 2 - 1, deckY + 0.7, -3, width / 2 + 1, deckY + 0.7, -3], 1.1, 2, 0.05);
  d.railing([width / 2 + 1, deckY + 0.7, 3, -width / 2 - 1, deckY + 0.7, 3], 1.1, 2, 0.05);
  g.pop();
  d.pop();
  addBox(fr, x, bedY, z, width + 2, deckY - bedY + 5, 12, rot);
}

// ------------------------------------------------------------------------------ GES-4
/** Hydro powerhouse (local +X along the unit row, water flows along local Z). */
export function buildPowerhouse(g: Geo, d: Geo, L: number, W: number, y0: number): void {
  const conc = col('#a8a397');
  // substructure / intake block
  g.paint(conc, P.CONCRETE, 0.9);
  g.box(-L / 2, y0 - 12, -W / 2 - 6, L / 2, y0 + 1, W / 2 + 4);
  // machine hall
  const wallC = col('#d9d4c6');
  g.paint(wallC, P.PANEL, 0.85);
  g.box(-L / 2, y0 + 1, -W / 2, L / 2, y0 + 16, W / 2, 63 - 4 - 8);
  const bands: Array<[number, number]> = [[3, 12]];
  for (const [a, b] of bands) {
    g.paint(col('#56625f'), P.GLAZING, 0.2, 0, F.WINLIT);
    g.quad([L / 2 + 0.03, y0 + a, W / 2 - 2], [L / 2 + 0.03, y0 + a, -W / 2 + 2], [L / 2 + 0.03, y0 + b, -W / 2 + 2], [L / 2 + 0.03, y0 + b, W / 2 - 2]);
    g.quad([-L / 2 + 2, y0 + a, W / 2 + 0.03], [L / 2 - 2, y0 + a, W / 2 + 0.03], [L / 2 - 2, y0 + b, W / 2 + 0.03], [-L / 2 + 2, y0 + b, W / 2 + 0.03]);
  }
  g.paint(col('#5c6462'), P.ROOFSEAM, 0.6, 0.3);
  g.gable(-L / 2, L / 2, -W / 2, W / 2, y0 + 16, y0 + 18.5, 0.4);
  // intake gantry crane on the upstream deck
  g.paint(col('#c89a32'), P.METAL, 0.55, 0.4);
  for (const x of [-L / 2 + 3, L / 2 - 3]) {
    g.beam([x, y0 + 1, -W / 2 - 5], [x, y0 + 13, -W / 2 - 5], 0.8);
    g.beam([x, y0 + 1, -W / 2 - 1], [x, y0 + 13, -W / 2 - 1], 0.8);
  }
  g.box(-L / 2 + 2, y0 + 13, -W / 2 - 5.5, L / 2 - 2, y0 + 14.2, -W / 2 - 0.5);
  // draft-tube outlets downstream
  g.paint(col('#2c2e2e'), P.PLAIN, 0.9);
  for (let i = 0; i < 3; i++) g.boxC(-L / 3 + (i * L) / 3, y0 - 8, W / 2 + 4.02, 7, 5, 0.05);
  // transformers beside the hall
  d.paint(col('#5c6b5e'), P.METAL, 0.55, 0.3);
  for (let i = 0; i < 2; i++) d.boxC(L / 2 + 6, y0, -6 + i * 10, 5, 5, 4);
}

// ------------------------------------------------------------------------------ signs
/** Canvas texture with large letters (entrance signs, station name). */
export function textTexture(text: string, color: string, w = 1024, h = 256, font = 'bold 170px sans-serif', fit = false): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  if (!x) return null;
  x.clearRect(0, 0, w, h);
  x.font = font;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillStyle = color;
  let size = 1;
  const mw = x.measureText(text).width;
  if (mw > w * 0.94 || fit) {
    size = Math.min((w * 0.94) / mw, fit ? (h * 0.95) / (parseFloat(font.replace(/^\D*/, '')) || h) : 1);
    x.setTransform(size, 0, 0, size, (w / 2) * (1 - size), (h / 2) * (1 - size));
  }
  x.fillText(text, w / 2, h / 2 + 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------------------ fountain
/** Round fountain: granite basin, water surface, central bowl; returns jet positions (local). */
export function buildFountain(g: Geo, y0: number, r: number): void {
  g.paint(col('#7b6f68'), P.GRANITE, 0.3, 0, F.FLOOD);
  g.lathe(0, y0 - 0.5, 0, [r + 0.45, 0, r + 0.45, 1.05, r + 0.5, 1.1, r + 0.5, 1.25, r, 1.25, r, 0.9], 40, false);
  g.paint(col('#1c3a40'), P.WINDOW, 0.05, 0, 0);
  g.disc(0, y0 + 0.75, 0, r, 40, true);
  g.paint(col('#8a7f78'), P.GRANITE, 0.3, 0, F.FLOOD);
  g.cyl(0, y0 + 0.7, 0, 0.9, 0.6, 1.4, 20, false, false);
  g.lathe(0, y0 + 2.1, 0, [0.6, 0, 2.0, 0.35, 2.1, 0.55, 1.9, 0.55, 0.5, 0.25], 28, false);
}

// ------------------------------------------------------------------------------ ice arena
/** Modern ice arena: rectangular hall with a shallow barrel roof, panel facade with a blue band, glazed foyer. */
export function buildArena(g: Geo, d: Geo, L: number, W: number, y0: number): void {
  const wh = 11, rise = 5.5;
  const white = col('#e4e6e6'), blue = col('#2f5d9a'), grey = col('#9aa3a8');
  const bands: Array<[number, number, number, RGB, number]> = [
    [-2, 1.0, P.PANEL, grey, 0], [1.0, 6.5, P.CORR, white, 0], [6.5, 8.3, P.CORR, blue, 0], [8.3, wh, P.CORR, white, 0],
  ];
  const wallQ = (ax: number, az: number, bx: number, bz: number) => {
    for (const [a, b, pat, c, fl] of bands) {
      g.paint(c, pat, 0.5, 0.2, fl);
      g.quad([ax, y0 + a, az], [bx, y0 + a, bz], [bx, y0 + b, bz], [ax, y0 + b, az], 0, a);
    }
  };
  wallQ(L / 2, -W / 2, -L / 2, -W / 2);
  wallQ(-L / 2, W / 2, L / 2, W / 2);
  wallQ(-L / 2, -W / 2, -L / 2, W / 2);
  wallQ(L / 2, W / 2, L / 2, -W / 2);
  // barrel roof along X (arc across Z)
  const n = 12;
  const R = (W * W / 4 + rise * rise) / (2 * rise);
  const zc = 0, yc = y0 + wh + rise - R;
  const a0 = Math.asin((W / 2) / R);
  g.paint(col('#b9c0c4'), P.ROOFSEAM, 0.45, 0.5);
  for (let i = 0; i < n; i++) {
    const t0 = -a0 + (2 * a0 * i) / n, t1 = -a0 + (2 * a0 * (i + 1)) / n;
    const z0 = zc + Math.sin(t0) * R, y0a = yc + Math.cos(t0) * R, z1 = zc + Math.sin(t1) * R, y1a = yc + Math.cos(t1) * R;
    g.quad([-L / 2 - 0.4, y0a, z0], [-L / 2 - 0.4, y1a, z1], [L / 2 + 0.4, y1a, z1], [L / 2 + 0.4, y0a, z0]);
    // gable end walls under the arc
    g.paint(white, P.CORR, 0.5, 0.2);
    g.tri3([L / 2, y0 + wh, 0], [L / 2, y0a, z0], [L / 2, y1a, z1]);
    g.tri3([-L / 2, y0 + wh, 0], [-L / 2, y1a, z1], [-L / 2, y0a, z0]);
    g.paint(col('#b9c0c4'), P.ROOFSEAM, 0.45, 0.5);
  }
  // glazed foyer on the -X end
  g.paint(col('#4f6166'), P.GLAZING, 0.2, 0, F.WINLIT);
  g.box(-L / 2 - 6, y0 - 1, -W / 4, -L / 2, y0 + 7, W / 4, 63 - 4 - 2);
  g.paint(grey, P.PLAIN, 0.5, 0.3);
  g.box(-L / 2 - 7, y0 + 7, -W / 4 - 1, -L / 2, y0 + 7.6, W / 4 + 1);
  d.paint(col('#6b7478'), P.METAL, 0.5, 0.5);
  for (let i = 0; i < 6; i++) d.cyl(L / 2 - 6 - i * (L - 12) / 5, y0 + wh + rise - 0.3, 0, 0.5, 0.5, 1.2, 10);
}
