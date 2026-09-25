// Procedural models for instanced street furniture, rail catenary and power pylons.
// Local frame of every model: +x = right (across the road / line), +y = up, -z = forward
// (towards the road for lamps and shelters, along the line for pylons). An instance with heading h
// (deg cw from north, the direction local -z should face) uses rotation.y = -h.
import * as THREE from 'three';
import { MeshBuilder } from './geom';

type V3 = [number, number, number];

export const COL = {
  concrete: [0.42, 0.41, 0.39] as V3,
  concreteDark: [0.3, 0.3, 0.29] as V3,
  galv: [0.46, 0.48, 0.5] as V3,
  steelDark: [0.16, 0.17, 0.18] as V3,
  paintGrey: [0.3, 0.32, 0.33] as V3,
  glassLamp: [0.9, 0.88, 0.8] as V3,
  black: [0.03, 0.03, 0.03] as V3,
  insulGlass: [0.18, 0.28, 0.24] as V3,
  insulPorcelain: [0.75, 0.74, 0.7] as V3,
  wood: [0.28, 0.17, 0.09] as V3,
  woodGreen: [0.1, 0.24, 0.13] as V3,
  blue: [0.05, 0.16, 0.42] as V3,
  white: [0.8, 0.8, 0.78] as V3,
  yellowWall: [0.62, 0.52, 0.3] as V3,
};

/** Box from a to b (centre line) with cross-section w x h (w horizontal, h perpendicular). */
export function beam(mb: MeshBuilder, a: V3, b: V3, w: number, h: number, c: V3, e = 0, caps = true): void {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const L = d.length();
  if (L < 1e-5) return;
  d.divideScalar(L);
  const up = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(d, up).normalize();   // horizontal-ish
  const v = new THREE.Vector3().crossVectors(u, d).normalize();
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const ring = (P: THREE.Vector3) => corners.map(([i, j]) => P.clone().addScaledVector(u, (i * w) / 2).addScaledVector(v, (j * h) / 2));
  const ra = ring(A), rb = ring(B);
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    const n = new THREE.Vector3().addScaledVector(u, corners[k][0] + corners[k2][0]).addScaledVector(v, corners[k][1] + corners[k2][1]).normalize();
    const i0 = mb.vert(ra[k].x, ra[k].y, ra[k].z, n.x, n.y, n.z, c[0], c[1], c[2], e);
    const i1 = mb.vert(ra[k2].x, ra[k2].y, ra[k2].z, n.x, n.y, n.z, c[0], c[1], c[2], e);
    const i2 = mb.vert(rb[k2].x, rb[k2].y, rb[k2].z, n.x, n.y, n.z, c[0], c[1], c[2], e);
    const i3 = mb.vert(rb[k].x, rb[k].y, rb[k].z, n.x, n.y, n.z, c[0], c[1], c[2], e);
    mb.idx.push(i0, i1, i2, i0, i2, i3);
  }
  if (caps) {
    for (const [R, sgn] of [[ra, -1], [rb, 1]] as Array<[THREE.Vector3[], number]>) {
      const n = d.clone().multiplyScalar(sgn);
      const ids = R.map((p) => mb.vert(p.x, p.y, p.z, n.x, n.y, n.z, c[0], c[1], c[2], e));
      if (sgn > 0) mb.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
      else mb.idx.push(ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]);
    }
  }
  // fix winding of sides if needed (u x v = d orientation check)
}

/** Axis-aligned box centred at c. */
export function abox(mb: MeshBuilder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: V3, e = 0): void {
  beam(mb, [cx, cy - sy / 2, cz], [cx, cy + sy / 2, cz], sx, sz, col, e);
}

/** Tapered cylinder / cone along a -> b. */
export function tube(mb: MeshBuilder, a: V3, b: V3, r0: number, r1: number, seg: number, c: V3, e = 0, capTop = true): void {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const L = d.length();
  if (L < 1e-5) return;
  d.divideScalar(L);
  const up = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(d, up).normalize();
  const v = new THREE.Vector3().crossVectors(u, d).normalize();
  const base = mb.count;
  for (let i = 0; i <= seg; i++) {
    const ang = (i / seg) * Math.PI * 2;
    const n = u.clone().multiplyScalar(Math.cos(ang)).addScaledVector(v, Math.sin(ang));
    mb.vert(a[0] + n.x * r0, a[1] + n.y * r0, a[2] + n.z * r0, n.x, n.y, n.z, c[0], c[1], c[2], e);
    mb.vert(b[0] + n.x * r1, b[1] + n.y * r1, b[2] + n.z * r1, n.x, n.y, n.z, c[0], c[1], c[2], e);
  }
  for (let i = 0; i < seg; i++) {
    const a0 = base + i * 2, a1 = a0 + 1, b0 = a0 + 2, b1 = a0 + 3;
    mb.idx.push(a0, b0, b1, a0, b1, a1);
  }
  if (capTop && r1 > 0.001) {
    const cIdx = mb.vert(b[0], b[1], b[2], d.x, d.y, d.z, c[0], c[1], c[2], e);
    const ring: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const ang = (i / seg) * Math.PI * 2;
      const n = u.clone().multiplyScalar(Math.cos(ang)).addScaledVector(v, Math.sin(ang));
      ring.push(mb.vert(b[0] + n.x * r1, b[1] + n.y * r1, b[2] + n.z * r1, d.x, d.y, d.z, c[0], c[1], c[2], e));
    }
    for (let i = 0; i < seg; i++) mb.idx.push(cIdx, ring[i], ring[i + 1]);
  }
}

/** Glass-disc insulator string hanging from `top` down by `len`. */
function insulator(mb: MeshBuilder, top: V3, len: number, glass = true): void {
  const n = Math.max(2, Math.round(len / 0.17));
  tube(mb, top, [top[0], top[1] - len, top[2]], 0.02, 0.02, 4, COL.steelDark, 0, false);
  for (let i = 0; i < n; i++) {
    const y = top[1] - 0.1 - (i * (len - 0.15)) / n;
    tube(mb, [top[0], y, top[2]], [top[0], y - 0.05, top[2]], 0.13, 0.05, 8, glass ? COL.insulGlass : COL.insulPorcelain);
  }
}

// ======================================================================= street lights
/** type 0: LED on a galvanised steel conical pole 10 m, arm 1.8 m. */
export function lampLED(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const g = COL.galv;
  abox(mb, 0, 0.35, 0, 0.36, 0.7, 0.36, COL.concreteDark);                 // footing
  tube(mb, [0, 0.6, 0], [0, 10, 0], 0.1, 0.055, 8, g);
  tube(mb, [0, 9.2, 0], [0, 9.9, -0.9], 0.035, 0.03, 6, g, 0, false);
  tube(mb, [0, 9.9, -0.9], [0, 10.1, -1.8], 0.03, 0.03, 6, g, 0, false);
  // luminaire body + lens
  beam(mb, [0, 10.12, -1.55], [0, 10.12, -2.3], 0.34, 0.09, COL.paintGrey);
  beam(mb, [0, 10.06, -1.65], [0, 10.06, -2.25], 0.26, 0.02, COL.glassLamp, 1);
  return mb.build(true, true)!;
}

/** type 1: sodium cobra head on a concrete SV-95 pole (9.5 m) with a steel bracket. */
export function lampHPS(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  tube(mb, [0, -0.5, 0], [0, 9.5, 0], 0.13, 0.085, 8, COL.concrete);
  tube(mb, [0, 8.6, 0.02], [0, 9.3, -1.2], 0.03, 0.028, 6, COL.galv, 0, false);
  tube(mb, [0, 9.3, -1.2], [0, 9.45, -1.6], 0.028, 0.028, 6, COL.galv, 0, false);
  beam(mb, [0, 9.45, -1.5], [0, 9.3, -2.25], 0.3, 0.22, COL.paintGrey);
  beam(mb, [0, 9.33, -1.6], [0, 9.2, -2.2], 0.22, 0.03, COL.glassLamp, 1);
  return mb.build(true, true)!;
}

/** type 2 / 4: concrete distribution pole (0.4 kV) with shackle insulators, optional lamp. */
export function distPole(withLamp: boolean): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  tube(mb, [0, -0.5, 0], [0, 9.7, 0], 0.13, 0.09, 8, COL.concrete);
  // insulators on hooks (4 wires + SIP clamp)
  for (const [y, s] of [[9.3, 1], [9.0, -1], [8.7, 1], [8.4, -1]]) {
    tube(mb, [0, y, 0], [0.22 * s, y, 0], 0.012, 0.012, 4, COL.steelDark, 0, false);
    tube(mb, [0.22 * s, y - 0.05, 0], [0.22 * s, y + 0.07, 0], 0.045, 0.035, 6, COL.insulPorcelain);
  }
  if (withLamp) {
    tube(mb, [0, 7.4, 0], [0, 7.9, -1.1], 0.028, 0.026, 6, COL.galv, 0, false);
    beam(mb, [0, 7.95, -1.0], [0, 7.8, -1.7], 0.28, 0.2, COL.paintGrey);
    beam(mb, [0, 7.83, -1.1], [0, 7.72, -1.65], 0.2, 0.03, COL.glassLamp, 1);
  }
  return mb.build(true, true)!;
}

/** type 3: bridge lamp on the parapet (steel pole 8 m). */
export function lampBridge(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  tube(mb, [0, 0.8, 0], [0, 8.5, 0], 0.08, 0.05, 8, COL.galv);
  tube(mb, [0, 8.0, 0], [0, 8.6, -1.2], 0.03, 0.03, 6, COL.galv, 0, false);
  beam(mb, [0, 8.62, -1.0], [0, 8.62, -1.75], 0.32, 0.09, COL.paintGrey);
  beam(mb, [0, 8.56, -1.1], [0, 8.56, -1.7], 0.24, 0.02, COL.glassLamp, 1);
  return mb.build(true, true)!;
}

/** Head (luminaire lens) position in the local frame of each lamp type (for glow sprites). */
export const LAMP_HEAD: Record<number, V3> = { 0: [0, 10.05, -1.95], 1: [0, 9.25, -1.9], 2: [0, 7.75, -1.4], 3: [0, 8.55, -1.4] };
/** SIP cable attachment height on distribution poles. */
export const POLE_WIRE_Y = 9.0;

// ======================================================================= traffic signal
/** Signal pole + T.1 head. aEmit: 1 red, 2 yellow, 3 green lens. Faces local -z. */
export function trafficSignal(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  tube(mb, [0, 0, 0], [0, 3.6, 0], 0.06, 0.05, 8, COL.paintGrey);
  // pedestrian push-button box
  abox(mb, 0, 1.1, -0.07, 0.12, 0.2, 0.08, COL.steelDark);
  // housing (with a white-bordered back plate)
  abox(mb, 0, 2.95, 0.02, 0.6, 1.25, 0.03, COL.white);
  abox(mb, 0, 2.95, -0.1, 0.34, 1.05, 0.22, COL.black);
  const lens = [[3.3, 1], [2.95, 2], [2.6, 3]];
  for (const [y, id] of lens) {
    tube(mb, [0, y, -0.2], [0, y, -0.22], 0.1, 0.1, 12, COL.black, id);
    // visor
    beam(mb, [0, y + 0.12, -0.21], [0, y + 0.12, -0.4], 0.26, 0.015, COL.black);
  }
  return mb.build(true, true)!;
}

// ======================================================================= bus stops
/** Modern steel/glass shelter frame (opaque parts). Opening faces local -z (road). */
export function shelterFrame(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const W = 4.2, D = 1.5, H = 2.5;
  for (const x of [-W / 2, W / 2]) for (const z of [-D / 2 + 0.05, D / 2 - 0.05]) beam(mb, [x, 0, z], [x, H, z], 0.08, 0.08, COL.paintGrey);
  // roof: slightly sloped panel + blue fascia
  beam(mb, [-W / 2 - 0.15, H + 0.08, 0], [W / 2 + 0.15, H + 0.08, 0], D + 0.4, 0.1, COL.white);
  beam(mb, [-W / 2 - 0.16, H - 0.08, -D / 2 - 0.2], [W / 2 + 0.16, H - 0.08, -D / 2 - 0.2], 0.03, 0.32, COL.blue);
  // bench
  beam(mb, [-1.4, 0.45, 0.35], [1.4, 0.45, 0.35], 0.45, 0.05, COL.woodGreen);
  for (const x of [-1.2, 1.2]) beam(mb, [x, 0, 0.35], [x, 0.44, 0.35], 0.06, 0.3, COL.paintGrey);
  // floor slab
  abox(mb, 0, 0.06, 0, W + 0.6, 0.12, D + 0.6, COL.concrete);
  return mb.build(true, false)!;
}

/** Glass panels of the modern shelter (back + sides). */
export function shelterGlass(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const W = 4.2, D = 1.5, H = 2.5;
  beam(mb, [-W / 2, 1.3, D / 2 - 0.05], [W / 2, 1.3, D / 2 - 0.05], 0.015, 2.1, COL.white);
  for (const x of [-W / 2, W / 2]) beam(mb, [x, 1.3, -D / 2 + 0.3], [x, 1.3, D / 2 - 0.05], 0.015, 2.1, COL.white);
  void H;
  return mb.build(false, false)!;
}

/** Soviet concrete pavilion: three walls + roof slab, painted. */
export function shelterSoviet(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const W = 4.6, D = 2.0, H = 2.6;
  abox(mb, 0, H / 2, D / 2 - 0.1, W, H, 0.18, COL.yellowWall);
  abox(mb, -W / 2 + 0.09, H / 2, 0, 0.18, H, D, COL.yellowWall);
  abox(mb, W / 2 - 0.09, H / 2, 0, 0.18, H, D, COL.yellowWall);
  abox(mb, 0, H + 0.1, -0.1, W + 0.5, 0.2, D + 0.6, COL.concrete);
  // mosaic band
  abox(mb, 0, H - 0.5, D / 2 - 0.2, W - 0.4, 0.6, 0.02, COL.blue);
  beam(mb, [-1.6, 0.45, 0.6], [1.6, 0.45, 0.6], 0.4, 0.06, COL.wood);
  abox(mb, 0, 0.06, 0, W + 0.6, 0.12, D + 0.8, COL.concrete);
  return mb.build(true, false)!;
}

// ======================================================================= signs and benches
/** Sign pole (2.9 m) - plate is a separate textured quad geometry. */
export function signPole(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  tube(mb, [0, -0.3, 0], [0, 2.95, 0], 0.03, 0.03, 6, COL.galv);
  return mb.build(true, false)!;
}

/** Double-sided sign plate (0.7 m) at the top of the pole; uv cell (col,row) of a 4x2 atlas. */
export function signPlate(cellFront: number, cellBack: number, size = 0.7, y = 2.55): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const h = size / 2;
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
  const uv = (cell: number) => {
    const cx = cell % 4, cy = Math.floor(cell / 4);
    return [cx / 4, 1 - (cy + 1) / 2, (cx + 1) / 4, 1 - cy / 2];
  };
  // front faces -z
  const f = uv(cellFront);
  P.push(-h, y - h, -0.045, h, y - h, -0.045, h, y + h, -0.045, -h, y + h, -0.045);
  N.push(0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1);
  U.push(f[2], f[1], f[0], f[1], f[0], f[3], f[2], f[3]);
  I.push(0, 2, 1, 0, 3, 2);
  const b = uv(cellBack);
  P.push(-h, y - h, -0.035, h, y - h, -0.035, h, y + h, -0.035, -h, y + h, -0.035);
  N.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
  U.push(b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]);
  I.push(4, 5, 6, 4, 6, 7);
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(I);
  return g;
}

/** Sign atlas: 4 x 2 cells of 128 px. 0 ped crossing 5.19.1, 1 ped crossing 5.19.2, 2 give way, 3 stop,
 *  4 bus stop 5.16, 5 plain back (grey). */
export function makeSignAtlas(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S * 4; c.height = S * 2;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8a8d90';
  g.fillRect(0, 0, c.width, c.height);
  const cell = (i: number) => [(i % 4) * S, Math.floor(i / 4) * S];
  const ped = (i: number, mirror: boolean) => {
    const [x, y] = cell(i);
    g.fillStyle = '#d7ff3a'; g.fillRect(x + 2, y + 2, S - 4, S - 4); // fluorescent yellow-green border
    g.fillStyle = '#0a4fa8'; g.fillRect(x + 12, y + 12, S - 24, S - 24);
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(x + S / 2, y + 22); g.lineTo(x + S - 22, y + S - 24); g.lineTo(x + 22, y + S - 24); g.closePath(); g.fill();
    g.fillStyle = '#111';
    g.save(); g.translate(x + S / 2, y + S / 2 + 12); if (mirror) g.scale(-1, 1);
    g.beginPath(); g.arc(-2, -26, 6, 0, Math.PI * 2); g.fill();
    g.lineWidth = 6; g.strokeStyle = '#111'; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-2, -18); g.lineTo(-6, 4); g.moveTo(-6, 4); g.lineTo(6, 20); g.moveTo(-6, 4); g.lineTo(-16, 20);
    g.moveTo(-4, -12); g.lineTo(10, -4); g.moveTo(-4, -12); g.lineTo(-16, -2); g.stroke();
    g.restore();
    // zebra under the walker
    g.fillStyle = '#111';
    for (let k = 0; k < 5; k++) g.fillRect(x + 38 + k * 11, y + S - 34, 6, 8);
  };
  ped(0, false); ped(1, true);
  { // give way (inverted triangle)
    const [x, y] = cell(2);
    g.fillStyle = '#c8102e';
    g.beginPath(); g.moveTo(x + 6, y + 14); g.lineTo(x + S - 6, y + 14); g.lineTo(x + S / 2, y + S - 8); g.closePath(); g.fill();
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(x + 24, y + 24); g.lineTo(x + S - 24, y + 24); g.lineTo(x + S / 2, y + S - 34); g.closePath(); g.fill();
  }
  { // stop
    const [x, y] = cell(3);
    g.fillStyle = '#c8102e';
    g.beginPath();
    for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + Math.PI / 8; g.lineTo(x + S / 2 + Math.cos(a) * 60, y + S / 2 + Math.sin(a) * 60); }
    g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 34px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('STOP', x + S / 2, y + S / 2 + 2);
  }
  { // bus stop 5.16
    const [x, y] = cell(4);
    g.fillStyle = '#0a4fa8'; g.fillRect(x + 4, y + 4, S - 8, S - 8);
    g.fillStyle = '#fff'; g.fillRect(x + 14, y + 14, S - 28, S - 28);
    g.fillStyle = '#111';
    g.fillRect(x + 30, y + 40, 68, 40); g.fillStyle = '#fff'; g.fillRect(x + 36, y + 46, 18, 14); g.fillRect(x + 58, y + 46, 18, 14); g.fillRect(x + 80, y + 46, 12, 14);
    g.fillStyle = '#111'; g.beginPath(); g.arc(x + 44, y + 84, 7, 0, Math.PI * 2); g.arc(x + 84, y + 84, 7, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Soviet park bench: concrete legs, wooden slats. Faces local -z. */
export function bench(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  for (const x of [-0.8, 0.8]) {
    abox(mb, x, 0.22, 0, 0.1, 0.44, 0.5, COL.concrete);
    beam(mb, [x, 0.42, 0.2], [x, 0.9, 0.3], 0.08, 0.08, COL.concrete);
  }
  for (let k = 0; k < 4; k++) abox(mb, 0, 0.46, -0.18 + k * 0.12, 2.0, 0.035, 0.09, COL.woodGreen);
  for (let k = 0; k < 3; k++) beam(mb, [-1, 0.6 + k * 0.12, 0.25 + k * 0.02], [1, 0.6 + k * 0.12, 0.25 + k * 0.02], 0.035, 0.1, COL.woodGreen);
  return mb.build(true, false)!;
}

// ======================================================================= rail catenary
/** Concrete catenary mast with a tubular cantilever reaching `off` m to the track (local -z). */
export function catenaryMast(off = 3.3): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  tube(mb, [0, -0.5, 0], [0, 9.6, 0], 0.2, 0.15, 10, COL.concrete);
  // cantilever: top tube (messenger support) + bottom strut + registration arm
  tube(mb, [0, 8.6, 0], [0, 8.6, -off - 0.4], 0.03, 0.03, 6, COL.galv, 0, false);
  tube(mb, [0, 7.1, 0], [0, 8.55, -off - 0.2], 0.03, 0.03, 6, COL.galv, 0, false);
  tube(mb, [0, 7.4, -off + 0.8], [0, 6.35, -off], 0.02, 0.02, 4, COL.galv, 0, false);
  // insulators at the mast
  tube(mb, [0, 8.6, -0.2], [0, 8.6, -0.8], 0.06, 0.06, 6, COL.insulPorcelain);
  tube(mb, [0, 7.2, -0.2], [0, 7.45, -0.7], 0.06, 0.06, 6, COL.insulPorcelain);
  return mb.build(true, false)!;
}

/** Lattice box beam between two points (portal girder). */
export function latticeBeam(mb: MeshBuilder, a: V3, b: V3, w: number, h: number, c: V3, panel = 1.5): void {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const L = d.length();
  d.normalize();
  const side = new THREE.Vector3(-d.z, 0, d.x).normalize();
  const P = (s: number, i: number, j: number): V3 => [a[0] + d.x * s + side.x * i * w / 2, a[1] + j * h / 2, a[2] + d.z * s + side.z * i * w / 2];
  for (const i of [-1, 1]) for (const j of [-1, 1]) beam(mb, P(0, i, j), P(L, i, j), 0.06, 0.06, c, 0, false);
  const n = Math.max(1, Math.round(L / panel));
  for (let k = 0; k < n; k++) {
    const s0 = (L * k) / n, s1 = (L * (k + 1)) / n;
    for (const i of [-1, 1]) beam(mb, P(s0, i, -1), P(s1, i, 1), 0.04, 0.04, c, 0, false);
    for (const j of [-1, 1]) beam(mb, P(s0, -1, j), P(s1, 1, j), 0.04, 0.04, c, 0, false);
  }
}

// ======================================================================= power pylons
export interface PylonDef {
  geo: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  /** phase attach points per circuit (local x across, y up, z along) */
  phases: V3[][];
  ground: V3[];
}

/** Lattice tower body: 4 legs from base half-width b0 at y0 to b1 at y1, braced faces. */
function latticeBody(mb: MeshBuilder, far: MeshBuilder, y0: number, y1: number, b0: number, b1: number, panels: number, c: V3, legW = 0.14, bw = 0.07): void {
  const at = (t: number) => b0 + (b1 - b0) * t;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [i, j] of corners) {
    beam(mb, [i * b0, y0, j * b0], [i * b1, y1, j * b1], legW, legW, c, 0, false);
    beam(far, [i * b0, y0, j * b0], [i * b1, y1, j * b1], legW * 2.5, legW * 2.5, c, 0, false);
  }
  for (let k = 0; k < panels; k++) {
    const ta = k / panels, tb = (k + 1) / panels;
    const ya = y0 + (y1 - y0) * ta, yb = y0 + (y1 - y0) * tb;
    const ba = at(ta), bb = at(tb);
    for (let f = 0; f < 4; f++) {
      const [i0, j0] = corners[f], [i1, j1] = corners[(f + 1) % 4];
      beam(mb, [i0 * ba, ya, j0 * ba], [i1 * bb, yb, j1 * bb], bw, bw, c, 0, false);
      beam(mb, [i1 * ba, ya, j1 * ba], [i0 * bb, yb, j0 * bb], bw, bw, c, 0, false);
      beam(mb, [i0 * bb, yb, j0 * bb], [i1 * bb, yb, j1 * bb], bw, bw, c, 0, false);
    }
  }
}

/** Triangular cross-arm truss from the body (x0) to the tip (x1) at height y. */
function crossArm(mb: MeshBuilder, far: MeshBuilder, x0: number, x1: number, y: number, depth: number, c: V3): void {
  const z = depth / 2;
  beam(mb, [x0, y, -z], [x1, y, 0], 0.08, 0.08, c, 0, false);
  beam(mb, [x0, y, z], [x1, y, 0], 0.08, 0.08, c, 0, false);
  beam(mb, [x0, y + 1.6, 0], [x1, y, 0], 0.08, 0.08, c, 0, false);
  const n = Math.max(2, Math.round(Math.abs(x1 - x0) / 1.2));
  for (let k = 1; k < n; k++) {
    const t = k / n, x = x0 + (x1 - x0) * t;
    beam(mb, [x, y, -z * (1 - t)], [x, y, z * (1 - t)], 0.05, 0.05, c, 0, false);
    beam(mb, [x, y, 0], [x0 + (x1 - x0) * (t - 0.5 / n), y + 1.6 * (1 - t + 0.5 / n), 0], 0.05, 0.05, c, 0, false);
  }
  beam(far, [x0, y, 0], [x1, y, 0], 0.3, 0.3, c, 0, false);
}

export function makePylons(): PylonDef[] {
  const c = COL.galv;
  const defs: PylonDef[] = [];
  // ---- 0 / 1: wine-glass (рюмка) 500 / 330 kV
  for (const [H, span, waist, gw] of [[30, 13, 15, 8], [27, 10, 13.5, 6.5]] as Array<[number, number, number, number]>) {
    const mb = new MeshBuilder(), far = new MeshBuilder();
    latticeBody(mb, far, 0, waist, 3.2, 0.8, 5, c, 0.18, 0.08);
    // V arms from the waist to the beam
    const vx = span * 0.55;
    for (const s of [-1, 1]) {
      for (const j of [-1, 1]) {
        beam(mb, [s * 0.8, waist, j * 0.8], [s * vx, H, j * 0.9], 0.16, 0.16, c, 0, false);
        beam(far, [s * 0.8, waist, j * 0.8], [s * vx, H, j * 0.9], 0.4, 0.4, c, 0, false);
      }
      const n = 5;
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const xa = s * (0.8 + (vx - 0.8) * t0), xb = s * (0.8 + (vx - 0.8) * t1);
        const ya = waist + (H - waist) * t0, yb = waist + (H - waist) * t1;
        beam(mb, [xa, ya, -0.85], [xb, yb, 0.85], 0.06, 0.06, c, 0, false);
        beam(mb, [xb, yb, -0.85], [xb, yb, 0.85], 0.06, 0.06, c, 0, false);
      }
    }
    // horizontal beam (traverse) with phases hanging
    latticeBeam(mb, [-span, H, 0], [span, H, 0], 1.6, 1.6, c, 1.6);
    beam(far, [-span, H, 0], [span, H, 0], 1.0, 1.0, c, 0, false);
    // ground wire peaks
    for (const s of [-1, 1]) {
      beam(mb, [s * gw, H + 0.8, -0.7], [s * gw, H + 4.5, 0], 0.08, 0.08, c, 0, false);
      beam(mb, [s * gw, H + 0.8, 0.7], [s * gw, H + 4.5, 0], 0.08, 0.08, c, 0, false);
    }
    const phases: V3[] = [];
    for (const x of [-span + 1.2, 0, span - 1.2]) {
      insulator(mb, [x, H - 0.8, 0], 3.2);
      phases.push([x, H - 4.0, 0]);
    }
    defs.push({ geo: mb.build(true, false)!, far: far.build(true, false)!, phases: [phases], ground: [[-gw, H + 4.5, 0], [gw, H + 4.5, 0]] });
  }
  // ---- 2: P110-2 double circuit "barrel"
  {
    const mb = new MeshBuilder(), far = new MeshBuilder();
    latticeBody(mb, far, 0, 18, 2.3, 0.75, 6, c, 0.14, 0.06);
    latticeBody(mb, far, 18, 31, 0.75, 0.45, 5, c, 0.1, 0.05);
    const arms: Array<[number, number]> = [[19, 2.3], [23, 3.8], [27, 2.3]];
    const ph0: V3[] = [], ph1: V3[] = [];
    for (const [y, L] of arms) {
      for (const s of [-1, 1]) {
        crossArm(mb, far, s * 0.7, s * (0.7 + L), y, 1.3, c);
        insulator(mb, [s * (0.6 + L), y - 0.05, 0], 1.3);
        (s < 0 ? ph0 : ph1).push([s * (0.6 + L), y - 1.4, 0]);
      }
    }
    defs.push({ geo: mb.build(true, false)!, far: far.build(true, false)!, phases: [ph0, ph1], ground: [[0, 31.2, 0]] });
  }
  // ---- 3: P110-1 single circuit
  {
    const mb = new MeshBuilder(), far = new MeshBuilder();
    latticeBody(mb, far, 0, 17, 2.0, 0.7, 5, c, 0.13, 0.06);
    latticeBody(mb, far, 17, 26, 0.7, 0.45, 4, c, 0.1, 0.05);
    const arms: Array<[number, number, number]> = [[19, -1, 3.2], [19, 1, 2.4], [23, -1, 2.0]];
    const ph: V3[] = [];
    for (const [y, s, L] of arms) {
      crossArm(mb, far, s * 0.65, s * (0.65 + L), y, 1.2, c);
      insulator(mb, [s * (0.55 + L), y - 0.05, 0], 1.3);
      ph.push([s * (0.55 + L), y - 1.4, 0]);
    }
    defs.push({ geo: mb.build(true, false)!, far: far.build(true, false)!, phases: [ph], ground: [[0, 26.2, 0]] });
  }
  // ---- 4: P35 small lattice
  {
    const mb = new MeshBuilder(), far = new MeshBuilder();
    latticeBody(mb, far, 0, 12, 1.4, 0.5, 4, c, 0.11, 0.05);
    latticeBody(mb, far, 12, 18, 0.5, 0.35, 3, c, 0.09, 0.045);
    const arms: Array<[number, number, number]> = [[13.5, -1, 2.2], [13.5, 1, 2.2], [16, -1, 1.6]];
    const ph: V3[] = [];
    for (const [y, s, L] of arms) {
      crossArm(mb, far, s * 0.45, s * (0.45 + L), y, 0.9, c);
      insulator(mb, [s * (0.35 + L), y - 0.05, 0], 0.7);
      ph.push([s * (0.35 + L), y - 0.8, 0]);
    }
    defs.push({ geo: mb.build(true, false)!, far: far.build(true, false)!, phases: [ph], ground: [[0, 18.2, 0]] });
  }
  // ---- 5: 10 kV concrete pole with pin insulators
  {
    const mb = new MeshBuilder(), far = new MeshBuilder();
    tube(mb, [0, -0.5, 0], [0, 10.2, 0], 0.14, 0.09, 8, COL.concrete);
    tube(far, [0, -0.5, 0], [0, 10.2, 0], 0.2, 0.15, 4, COL.concrete);
    beam(mb, [-1.0, 9.8, 0], [1.0, 9.8, 0], 0.08, 0.08, COL.galv);
    const ph: V3[] = [];
    for (const x of [-0.85, 0.85]) {
      tube(mb, [x, 9.85, 0], [x, 10.05, 0], 0.07, 0.05, 8, COL.insulPorcelain);
      ph.push([x, 10.08, 0]);
    }
    tube(mb, [0, 10.2, 0], [0, 10.4, 0], 0.07, 0.05, 8, COL.insulPorcelain);
    ph.splice(1, 0, [0, 10.43, 0]);
    defs.push({ geo: mb.build(true, false)!, far: far.build(true, false)!, phases: [ph], ground: [] });
  }
  // ---- 6: substation portal
  {
    const mb = new MeshBuilder(), far = new MeshBuilder();
    for (const s of [-1, 1]) {
      tube(mb, [s * 5, 0, 0], [s * 5, 12, 0], 0.18, 0.15, 8, c);
      tube(far, [s * 5, 0, 0], [s * 5, 12, 0], 0.3, 0.3, 4, c);
    }
    latticeBeam(mb, [-5.5, 11, 0], [5.5, 11, 0], 1.0, 1.0, c, 1.0);
    const ph: V3[] = [];
    for (const x of [-3.5, 0, 3.5]) { insulator(mb, [x, 10.4, 0], 1.6); ph.push([x, 8.8, 0]); }
    defs.push({ geo: mb.build(true, false)!, far: far.build(true, false)!, phases: [ph], ground: [[-5, 12, 0], [5, 12, 0]] });
  }
  return defs;
}
