// Parametric Russian Orthodox church: plinth, chetverik with risalits and zakomary
// (kokoshnik gables), east apse, west narthex, octagonal bell tower, drums with arched
// windows, onion domes with Orthodox crosses. Walls white stone or brick; domes gilded,
// blue with gold stars (rendered gold-accented), or green. Floodlit and lit windows at night.
import * as THREE from 'three';
import { Geo, P, F, col, mix3, type RGB } from './builder';

const GOLD = col('#e8b04a');
const WALL: Record<string, RGB> = {
  white: col('#e8e2d4'),
  cream: col('#e6d8b8'),
  brick: col('#93503a'),
};
const TRIM: Record<string, RGB> = {
  white: col('#faf9f5'),
  cream: col('#f2ede2'),
  brick: col('#ebe6da'),
};
const DOME: Record<string, RGB> = {
  gold: GOLD,
  blue: col('#27538f'),
  green: col('#2f6b4f'),
  silver: col('#b8bcc0'),
};
const ROOF = col('#4d6d58');

/** Onion-dome profile (radius r at the base, total height ~2.2 r) as lathe [r, y, ...]. */
export function onionProfile(r: number): number[] {
  const H = 2.2 * r;
  const k = [
    [1.0, 0], [1.13, 0.12], [1.22, 0.26], [1.24, 0.36], [1.18, 0.48], [1.02, 0.6], [0.78, 0.71], [0.52, 0.8],
    [0.3, 0.88], [0.16, 0.94], [0.09, 0.985], [0.06, 1.0],
  ];
  const out: number[] = [];
  for (const [a, b] of k) out.push(Math.max(0.01, a * r), b * H);
  return out;
}

/** Orthodox cross (eight-pointed) standing at (x, y, z), height h, facing along local X. */
export function cross(g: Geo, x: number, y: number, z: number, h: number, rot: number): void {
  const t = Math.max(0.06, h * 0.05);
  g.paint(GOLD, P.GOLD, 0.2, 1, F.NOGRIME);
  g.at(x, y, z, rot);
  g.box(-t / 2, 0, -t / 2, t / 2, h, t / 2);
  g.box(-t / 2, h * 0.78, -h * 0.16, t / 2, h * 0.78 + t, h * 0.16);
  g.box(-t / 2, h * 0.9, -h * 0.09, t / 2, h * 0.9 + t, h * 0.09);
  // slanted foot bar
  g.push(new THREE.Matrix4().makeRotationX(0.35).setPosition(0, h * 0.3, 0));
  g.box(-t / 2, 0, -h * 0.12, t / 2, t, h * 0.12);
  g.pop();
  // small crescent-free orb at the base
  g.sphere(0, 0, 0, t * 1.4, 10, 6);
  g.pop();
}

/** Drum with arched windows + cornice + onion dome + cross. Returns the top height. */
function drumDome(g: Geo, x: number, y: number, z: number, r: number, dh: number, wall: RGB, trim: RGB, dome: RGB, rot: number, windows = 8): number {
  const seg = Math.max(16, windows * 3);
  g.paint(wall, P.STONE, 0.8, 0, F.FLOOD);
  g.cyl(x, y, z, r, r, dh, seg, false, false);
  // windows (dark, arched top approximated by a narrower upper part)
  for (let i = 0; i < windows; i++) {
    const a = (i / windows) * Math.PI * 2 + Math.PI / windows;
    const ca = Math.cos(a), sa = Math.sin(a);
    const wx = x + ca * (r + 0.02), wz = z + sa * (r + 0.02);
    const ww = Math.min(0.9, (2 * Math.PI * r) / windows * 0.32);
    g.paint(col('#20242a'), P.WINDOW, 0.1, 0, F.WINLIT);
    g.boxC(wx, y + dh * 0.22, wz, 0.08, dh * 0.5, ww, -a);
    g.paint(trim, P.STONE, 0.7, 0, F.FLOOD);
    g.boxC(x + ca * (r + 0.05), y + dh * 0.72, z + sa * (r + 0.05), 0.12, 0.16, ww * 1.5, -a);
    // pilaster between windows
    const b = a + Math.PI / windows;
    g.boxC(x + Math.cos(b) * (r + 0.06), y, z + Math.sin(b) * (r + 0.06), 0.16, dh, 0.3, -b);
  }
  // cornice
  g.paint(trim, P.STONE, 0.7, 0, F.FLOOD);
  g.lathe(x, y + dh, z, [r, -0.2, r + 0.25, 0, r + 0.25, 0.25, r * 0.98, 0.35], seg, false);
  // dome
  const dr = r * 1.02;
  const pat = dome === GOLD ? P.GOLD : P.METAL;
  g.paint(dome, pat, dome === GOLD ? 0.2 : 0.35, dome === GOLD ? 1 : 0.5, F.NOGRIME | F.FLOOD);
  const prof = onionProfile(dr);
  g.lathe(x, y + dh + 0.3, z, prof, 32, true);
  const top = y + dh + 0.3 + prof[prof.length - 1];
  cross(g, x, top - 0.05, z, Math.max(1.2, r * 0.9), rot);
  return top + Math.max(1.2, r * 0.9);
}

/** Semicircular kokoshnik / zakomara slab in the plane of a wall (local frame: wall along X, facing +Z). */
function kokoshnik(g: Geo, cx: number, cy: number, cz: number, rot: number, r: number, t: number): void {
  const ring: number[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI;
    ring.push(Math.cos(a) * r, -Math.sin(a) * r);
  }
  g.at(cx, cy, cz, rot);
  g.push(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  g.prism(ring, -t / 2, t / 2, true, true);
  g.pop();
  g.pop();
}

/** Arched window (dark pane + semicircular head + white surround) on a wall facing local +Z after rot. */
function archWindow(g: Geo, cx: number, y: number, cz: number, rot: number, w: number, h: number, trim: RGB): void {
  const r = w / 2;
  g.at(cx, y, cz, rot);
  g.paint(col('#1d2126'), P.WINDOW, 0.1, 0, F.WINLIT);
  g.box(-r, 0, 0, r, h - r, 0.06, 32);
  kokoshnik(g, 0, h - r, 0.03, 0, r, 0.06);
  g.paint(trim, P.STONE, 0.7, 0, F.FLOOD);
  const t = Math.max(0.12, w * 0.14);
  g.box(-r - t, -0.05, 0, -r, h - r, 0.14, 63 - 4);
  g.box(r, -0.05, 0, r + t, h - r, 0.14, 63 - 4);
  g.box(-r - t * 1.6, -0.22, 0, r + t * 1.6, -0.02, 0.22);
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI, a1 = ((i + 1) / 8) * Math.PI;
    g.beam([Math.cos(a0) * (r + t / 2), h - r + Math.sin(a0) * (r + t / 2), 0.07], [Math.cos(a1) * (r + t / 2), h - r + Math.sin(a1) * (r + t / 2), 0.07], t, 0.14);
  }
  g.pop();
}

/** Spandrel over an arched opening: rectangle (2w x H) minus a semicircle of radius w (the arch void). */
function spandrel(g: Geo, cx: number, cy: number, cz: number, rot: number, w: number, H: number, t: number): void {
  const ring: number[] = [-w, -0, -w, -H, w, -H, w, -0];
  const n = 10;
  for (let i = 1; i < n; i++) {
    const a = (i / n) * Math.PI;
    ring.push(Math.cos(a) * w, -Math.sin(a) * w);
  }
  g.at(cx, cy, cz, rot);
  g.push(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  g.prism(ring, -t / 2, t / 2, true, true);
  g.pop();
  g.pop();
}

export interface ChurchSpec {
  x: number; z: number; len: number; wid: number; rot: number;
  kind: string; domes: number; dome: string; walls: string; bell: number; h: number;
}

/**
 * Build a church in its local frame (origin = footprint centre at ground level, +X = east / altar).
 * Returns approximate collider boxes (local).
 */
export function buildChurch(g: Geo, s: ChurchSpec): Array<{ x: number; z: number; sx: number; sz: number; h: number }> {
  const wall = WALL[s.walls] ?? WALL.white;
  const trim = TRIM[s.walls] ?? TRIM.white;
  const dome = DOME[s.dome] ?? GOLD;
  const wallPat = s.walls === 'brick' ? P.BRICK : P.STONE;
  const L = Math.max(8, s.len), W = Math.max(7, s.wid);
  const boxes: Array<{ x: number; z: number; sx: number; sz: number; h: number }> = [];
  const small = s.kind === 'chapel';
  // proportions
  const hb = small ? Math.min(7, s.h * 0.45) : s.kind === 'cathedral' ? 15 : Math.max(8, s.h * 0.4);
  const coreW = small ? W : Math.min(W, L * 0.62) * (s.kind === 'cathedral' ? 0.82 : 0.9);
  const apseR = small ? W * 0.3 : coreW * 0.3;
  const narthexL = small ? 0 : Math.max(0, L - coreW - apseR - (s.bell > 0 ? 0 : 0));
  const coreX = small ? 0 : -L / 2 + narthexL + coreW / 2;   // chetverik centre (x)
  // plinth
  g.paint(mix3(wall, col('#8d8a84'), 0.45), P.STONE, 0.9, 0, F.FLOOD);
  g.box(-L / 2 - 0.4, -2.5, -W / 2 - 0.4, L / 2 + 0.4, 0.8, W / 2 + 0.4);
  // west portal: arched door with a white surround and a small gabled canopy
  {
    const px = -L / 2 - (s.bell > 0 && !small ? 0.45 : 0.02);
    const dh = small ? 2.4 : Math.min(4.2, hb * 0.3);
    const dw = small ? 1.4 : 2.2;
    g.at(px, 0.8, 0, -Math.PI / 2);
    g.paint(col('#4a3222'), P.PLAIN, 0.6, 0, 0);
    g.box(-dw / 2, 0, 0, dw / 2, dh - dw / 2, 0.08, 32);
    kokoshnik(g, 0, dh - dw / 2, 0.04, 0, dw / 2, 0.08);
    g.paint(trim, P.STONE, 0.7, 0, F.FLOOD);
    g.box(-dw / 2 - 0.4, 0, 0, -dw / 2, dh - dw / 2, 0.35, 63 - 4);
    g.box(dw / 2, 0, 0, dw / 2 + 0.4, dh - dw / 2, 0.35, 63 - 4);
    kokoshnik(g, 0, dh - dw / 2, 0.17, 0, dw / 2 + 0.4, 0.34);
    g.paint(ROOF, P.ROOFSEAM, 0.55, 0.25);
    g.box(-dw / 2 - 0.6, dh + 0.25, 0, dw / 2 + 0.6, dh + 0.45, 1.4);
    g.pop();
  }
  // steps at the west entrance
  for (let i = 0; i < 3; i++) g.box(-L / 2 - 0.4 - (3 - i) * 0.35, -0.5, -1.8, -L / 2 - 0.4, 0.8 - (3 - i) * 0.27 + 0.27, 1.8);
  // ---- chetverik
  const cx0 = coreX - coreW / 2, cx1 = coreX + coreW / 2, cz0 = -coreW / 2 * (W / coreW > 1.2 ? 1 : W / coreW) , cz1 = -cz0;
  const halfZ = Math.min(W / 2, coreW / 2 + (s.kind === 'cathedral' ? 0 : 0));
  g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
  g.box(cx0, 0.8, -halfZ, cx1, hb, halfZ, 63 - 4);
  void cz1;
  // risalits (projecting centre bays) on north and south
  if (!small && W / 2 > halfZ - 0.01) {
    const rw = coreW * 0.42, rd = Math.max(0.6, W / 2 - halfZ + 1.2);
    g.box(coreX - rw / 2, 0.8, -halfZ - rd + 1.2, coreX + rw / 2, hb + 1.2, -halfZ + 0.01, 63 - 4);
    g.box(coreX - rw / 2, 0.8, halfZ - 0.01, coreX + rw / 2, hb + 1.2, halfZ + rd - 1.2, 63 - 4);
    // gables of the risalits
    g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
    kokoshnik(g, coreX, hb + 1.2, -halfZ - rd + 1.2 + 0.25, 0, rw / 2, 0.5);
    kokoshnik(g, coreX, hb + 1.2, halfZ + rd - 1.2 - 0.25, 0, rw / 2, 0.5);
    boxes.push({ x: coreX, z: 0, sx: rw, sz: 2 * (halfZ + rd - 1.2), h: hb + 1.2 });
  }
  // zakomary (three per facade) on north and south, cornice
  g.paint(trim, P.STONE, 0.75, 0, F.FLOOD);
  g.box(cx0 - 0.25, hb - 0.5, -halfZ - 0.25, cx1 + 0.25, hb, halfZ + 0.25, 63 - 4);
  const nk = small ? 1 : 3;
  for (let i = 0; i < nk; i++) {
    const kx = cx0 + (coreW * (i + 0.5)) / nk;
    const kr = coreW / nk / 2 * 0.95;
    g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
    kokoshnik(g, kx, hb, -halfZ + 0.3, 0, kr, 0.6);
    kokoshnik(g, kx, hb, halfZ - 0.3, 0, kr, 0.6);
    g.paint(ROOF, P.ROOFSEAM, 0.55, 0.25);
    // roof behind the zakomary: curved band (approximate: small gable)
    g.box(kx - kr, hb, -halfZ + 0.6, kx + kr, hb + kr * 0.55, halfZ - 0.6, 8 | 1 | 2 | 16 | 32);
  }
  for (let i = 0; i < nk; i++) {
    const kz = -halfZ + (2 * halfZ * (i + 0.5)) / nk;
    const kr = (2 * halfZ) / nk / 2 * 0.95;
    g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
    kokoshnik(g, cx0 + 0.3, hb, kz, Math.PI / 2, kr, 0.6);
    kokoshnik(g, cx1 - 0.3, hb, kz, Math.PI / 2, kr, 0.6);
  }
  g.paint(ROOF, P.ROOFSEAM, 0.55, 0.25);
  g.box(cx0 + 0.3, hb, -halfZ + 0.3, cx1 - 0.3, hb + 0.4, halfZ - 0.3, 8);
  boxes.push({ x: coreX, z: 0, sx: coreW, sz: 2 * halfZ, h: hb });
  // corner pilasters + windows on the facades (two tiers: "двухсветный")
  g.paint(trim, P.STONE, 0.75, 0, F.FLOOD);
  for (const px of [cx0, cx1]) for (const pz of [-halfZ, halfZ]) g.boxC(px, 0.8, pz, 0.9, hb - 0.8, 0.9);
  const tiers = small ? [0.3] : [0.16, 0.58];
  for (const ty of tiers) {
    for (let i = 0; i < nk; i++) {
      const wx = cx0 + (coreW * (i + 0.5)) / nk;
      for (const sz of [-1, 1]) archWindow(g, wx, hb * ty, sz * halfZ, sz > 0 ? 0 : Math.PI, small ? 0.9 : 1.2, hb * 0.28, trim);
    }
    // east / west facades
    if (!small) for (const sx of [-1, 1]) {
      const wz = (sx < 0 ? 1 : -1) * coreW * 0.25;
      archWindow(g, sx < 0 ? cx0 : cx1, hb * ty, wz, sx < 0 ? -Math.PI / 2 : Math.PI / 2, 1.1, hb * 0.26, trim);
    }
  }
  // bay pilasters (lopatki) and a mid-height string course
  g.paint(trim, P.STONE, 0.75, 0, F.FLOOD);
  for (let i = 1; i < nk; i++) {
    const px = cx0 + (coreW * i) / nk;
    for (const sz of [-1, 1]) g.boxC(px, 0.8, sz * (halfZ + 0.06), 0.7, hb - 1.3, 0.12);
  }
  if (!small) {
    g.box(cx0 - 0.12, hb * 0.49, -halfZ - 0.12, cx1 + 0.12, hb * 0.49 + 0.3, halfZ + 0.12, 63 - 4);
    // belt of small blind arches (arcature) under the zakomary
    for (let i = 0; i < Math.floor(coreW / 0.9); i++) {
      const ax = cx0 + 0.45 + i * 0.9;
      for (const sz of [-1, 1]) g.boxC(ax, hb - 1.3, sz * (halfZ + 0.04), 0.14, 0.7, 0.08);
    }
  }
  // ---- apse (east)
  {
    const ax = cx1;
    const ah = hb * 0.72;
    g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
    g.lathe(ax, 0.8, 0, [apseR, 0, apseR, ah - 0.8], 16, true, -Math.PI / 2, Math.PI / 2);
    g.paint(trim, P.STONE, 0.75, 0, F.FLOOD);
    g.lathe(ax, ah, 0, [apseR, -0.3, apseR + 0.2, 0, apseR + 0.2, 0.2], 16, false, -Math.PI / 2, Math.PI / 2);
    g.paint(ROOF, P.ROOFSEAM, 0.55, 0.25);
    const pr: number[] = [];
    for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI / 2; pr.push(Math.max(0.01, (apseR + 0.2) * Math.cos(a)), 0.2 + Math.sin(a) * apseR * 0.45); }
    g.lathe(ax, ah, 0, pr, 16, true, -Math.PI / 2, Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 3 + (i * Math.PI) / 3;
      archWindow(g, ax + Math.cos(a) * apseR, ah * 0.32, Math.sin(a) * apseR, Math.PI / 2 - a, 0.9, ah * 0.36, trim);
    }
    boxes.push({ x: ax + apseR / 2, z: 0, sx: apseR, sz: apseR * 2, h: ah });
  }
  // ---- narthex / refectory (west) and bell tower
  if (!small && narthexL > 1) {
    const nx0 = -L / 2, nx1 = cx0 + 0.01;
    const nw = Math.min(W, coreW) * 0.8;
    const nh = hb * 0.62;
    g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
    g.box(nx0, 0.8, -nw / 2, nx1, nh, nw / 2, 63 - 4);
    g.paint(trim, P.STONE, 0.75, 0, F.FLOOD);
    g.box(nx0 - 0.2, nh - 0.4, -nw / 2 - 0.2, nx1, nh, nw / 2 + 0.2, 63 - 4);
    g.paint(ROOF, P.ROOFSEAM, 0.55, 0.25);
    g.gable(nx0, nx1, -nw / 2, nw / 2, nh, nh + nw * 0.22, 0.3);
    for (let i = 0; i < Math.max(1, Math.floor((nx1 - nx0) / 3.5)); i++) {
      const wx = nx0 + 1.8 + i * 3.5;
      if (wx > nx1 - 1) break;
      for (const sz of [-1, 1]) archWindow(g, wx, nh * 0.28, sz * nw / 2, sz > 0 ? 0 : Math.PI, 1.0, nh * 0.42, trim);
    }
    boxes.push({ x: (nx0 + nx1) / 2, z: 0, sx: nx1 - nx0, sz: nw, h: nh });
  }
  if (s.bell > 0 && !small) {
    const bx = -L / 2 + Math.min(4.5, L * 0.12);
    const bw = Math.min(8, W * 0.42);
    const H = s.bell;
    const crossH = Math.max(2, H * 0.06);
    // square lower tier
    const t1 = H * 0.36;
    g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
    g.box(bx - bw / 2, 0.8, -bw / 2, bx + bw / 2, t1, bw / 2, 63 - 4);
    g.paint(trim, P.STONE, 0.75, 0, F.FLOOD);
    g.box(bx - bw / 2 - 0.3, t1 - 0.5, -bw / 2 - 0.3, bx + bw / 2 + 0.3, t1, bw / 2 + 0.3);
    for (const sz of [-1, 1]) {
      g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
      kokoshnik(g, bx, t1, sz * (bw / 2 - 0.2), 0, bw / 2 * 0.9, 0.4);
    }
    // octagonal tiers: body, belfry (open arches), upper tier
    const oct = (y0: number, y1: number, r: number, open: boolean) => {
      const h = y1 - y0;
      if (!open) {
        g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
        g.lathe(bx, y0, 0, [r, 0, r, h], 8, false);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
          const fx = bx + Math.cos(a) * (r * 0.925 + 0.03), fz = Math.sin(a) * (r * 0.925 + 0.03);
          g.paint(col('#1d2126'), P.WINDOW, 0.1, 0, F.WINLIT);
          g.boxC(fx, y0 + h * 0.18, fz, 0.1, h * 0.5, r * 0.765 * 0.4, -a);
        }
      } else {
        // open belfry: eight piers with arched openings between them, band above
        const hp = h * 0.74;
        g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          g.boxC(bx + Math.cos(a) * r * 0.9, y0, Math.sin(a) * r * 0.9, r * 0.24, hp, r * 0.3, -a);
        }
        g.lathe(bx, y0, 0, [r, hp, r, h], 8, false);
        g.lathe(bx, y0, 0, [r * 0.8, h, r * 0.8, hp], 8, false);
        g.disc(bx, y0 + hp, 0, r, 8, false, r * 0.8);
        // arched heads of the openings (spandrels between the piers)
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
          const ow = r * 0.765 * 0.5 * 0.82;
          spandrel(g, bx + Math.cos(a) * r * 0.9, y0 + hp - ow * 1.25, Math.sin(a) * r * 0.9, -a - Math.PI / 2, ow, ow * 1.25, r * 0.2);
        }
      }
      g.paint(trim, P.STONE, 0.75, 0, F.FLOOD);
      g.lathe(bx, y1, 0, [r, -0.3, r + 0.3, 0, r + 0.3, 0.3, r * 0.9, 0.35], 8, false);
    };
    const r2 = bw * 0.52;
    const t2 = t1 + H * 0.16, t3 = t2 + H * 0.17, t4 = t3 + H * 0.1;
    oct(t1, t2, r2, false);
    oct(t2 + 0.35, t3, r2 * 0.9, true);
    // bells hanging in the open belfry (bronze): a big one in the centre, smaller ones around
    {
      const by = t2 + 0.35 + (t3 - t2) * 0.62;
      const bell = (x: number, z: number, sz: number) => {
        const k = [0.5, 0, 0.47, 0.07, 0.36, 0.28, 0.3, 0.62, 0.29, 0.84, 0.19, 0.95, 0.03, 1.0];
        const prof: number[] = [];
        for (let i = 0; i < k.length; i += 2) prof.push(k[i] * sz, k[i + 1] * sz);
        g.paint(col('#6e5634'), P.METAL, 0.4, 0.85, F.NOGRIME);
        g.lathe(x, by - sz, z, prof, 14, true);
        g.lathe(x, by - sz, z, [0.3 * sz, 0.5 * sz, 0.46 * sz, 0.02 * sz], 14, true);
      };
      bell(bx, 0, Math.min(1.8, r2 * 0.55));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        bell(bx + Math.cos(a) * r2 * 0.52, Math.sin(a) * r2 * 0.52, Math.min(0.8, r2 * 0.22));
      }
      g.paint(col('#3b3027'), P.PLAIN, 0.8, 0, F.NOGRIME);
      g.box(bx - r2 * 0.8, by - 0.12, -0.1, bx + r2 * 0.8, by + 0.1, 0.1);
      g.box(bx - 0.1, by - 0.12, -r2 * 0.8, bx + 0.1, by + 0.1, r2 * 0.8);
      // floor of the belfry
      g.paint(col('#8d8a84'), P.STONE, 0.9, 0, 0);
      g.disc(bx, t2 + 0.4, 0, r2 * 0.88, 8, true);
    }
    oct(t3 + 0.35, t4, r2 * 0.72, false);
    // spire-like dome (tent + small onion)
    const domeBase = t4 + 0.35;
    const remain = H - crossH - domeBase;
    const pat = dome === GOLD ? P.GOLD : P.METAL;
    g.paint(dome, pat, 0.22, dome === GOLD ? 1 : 0.5, F.NOGRIME | F.FLOOD);
    const onR = r2 * 0.5;
    const prof = onionProfile(onR);
    const scaleY = Math.max(0.6, remain / prof[prof.length - 1]);
    for (let i = 1; i < prof.length; i += 2) prof[i] *= scaleY;
    g.lathe(bx, domeBase, 0, prof, 24, true);
    cross(g, bx, domeBase + prof[prof.length - 1] - 0.05, 0, crossH, 0);
    boxes.push({ x: bx, z: 0, sx: bw, sz: bw, h: H * 0.8 });
  }
  // ---- drums and domes on the chetverik
  const roofY = hb + 0.4;
  const main = small ? Math.max(1.3, W * 0.2) : coreW * (s.domes >= 5 ? 0.2 : 0.24);
  const mainDh = Math.max(2.5, Math.min(9, (s.h - roofY) * 0.33));
  // base (postament) for the drum
  g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
  g.box(coreX - main * 1.25, hb, -main * 1.25, coreX + main * 1.25, roofY + 1.2, main * 1.25, 63 - 4);
  drumDome(g, coreX, roofY + 1.2, 0, main, mainDh, wall, trim, dome, 0, small ? 4 : 8);
  if (s.domes >= 5) {
    const off = coreW * 0.3;
    const sr = main * 0.55;
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as Array<[number, number]>) {
      g.paint(wall, wallPat, 0.85, 0, F.FLOOD);
      g.box(coreX + dx * off - sr * 1.3, hb, dz * off - sr * 1.3, coreX + dx * off + sr * 1.3, roofY + 0.8, dz * off + sr * 1.3, 63 - 4);
      drumDome(g, coreX + dx * off, roofY + 0.8, dz * off, sr, mainDh * 0.62, wall, trim, dome, 0, 6);
    }
  }
  return boxes;
}
