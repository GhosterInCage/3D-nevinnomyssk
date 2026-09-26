// Parametric body shape of a VAZ-2170 "Lada Priora"-like 3-box sedan (the most common car on
// the streets of Nevinnomyssk / Stavropol Krai in the 2010s-2020s).
//
// Car-local frame: +z forward, +y up, x lateral (symmetric), y = 0 at the ground at rest.
// Published dimensions: length 4350, width 1680, height 1420, wheelbase 2492 mm,
// track 1410/1380 mm, tyres 185/65 R14, ground clearance 165 mm.

export const DIM = {
  halfL: 2.175,
  halfW: 0.84,
  height: 1.42,
  wheelbase: 2.492,
  frontAxle: 1.345,
  rearAxle: -1.147,
  trackF: 1.41,
  trackR: 1.38,
  tyreR: 0.297,
  tyreW: 0.185,
  rimR: 0.1778,
  archR: 0.375,
};

/** Monotone cubic (Fritsch-Carlson) interpolation through [x, y] keys (x ascending). */
export function curve(keys: Array<[number, number]>): (x: number) => number {
  const n = keys.length;
  const xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
  const d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Side-panel top edge: hood edge at the front, beltline along the cabin, deck edge at the rear. */
export const belt = curve([
  [-2.175, 0.93], [-2.15, 0.975], [-2.1, 0.995], [-1.9, 1.005], [-1.55, 1.0], [-1.0, 0.985], [0.0, 0.962],
  [0.8, 0.935], [1.25, 0.885], [1.7, 0.83], [1.95, 0.795], [2.1, 0.765], [2.175, 0.70],
]);

/** Crown of the hood / deck above the edge line. */
const crown = curve([[-2.175, 0.0], [-2.1, 0.022], [-1.7, 0.03], [0.8, 0.03], [1.3, 0.042], [1.9, 0.035], [2.1, 0.018], [2.175, 0.0]]);

/** Body underside / bumper bottoms. */
const bottomBase = curve([
  [-2.175, 0.42], [-2.15, 0.35], [-2.05, 0.30], [-1.75, 0.255], [-1.45, 0.215], [1.0, 0.195], [1.7, 0.215],
  [1.98, 0.255], [2.12, 0.31], [2.175, 0.37],
]);

/** Plan-view half width (m) with rounded superelliptic nose and tail. */
export function halfWidth(z: number): number {
  const W = DIM.halfW, L = DIM.halfL;
  let f = 1;
  if (z > 1.42) {
    const u = Math.min(1, (z - 1.42) / (L - 1.42));
    f = Math.pow(Math.max(0, 1 - Math.pow(u, 2.7)), 1 / 2.7);
  } else if (z < -1.62) {
    const u = Math.min(1, (-1.62 - z) / (L - 1.62));
    f = Math.pow(Math.max(0, 1 - Math.pow(u, 3.2)), 1 / 3.2);
  }
  // slight coke-bottle: widest over the wheels
  const bulge = 1 + 0.008 * Math.exp(-((z - DIM.frontAxle) ** 2) / 0.3) + 0.01 * Math.exp(-((z - DIM.rearAxle) ** 2) / 0.35);
  return W * f * bulge / 1.01;
}

/** Height of the wheel-arch opening at z (or -Infinity away from the arches). */
export function archTop(z: number): number {
  let y = -Infinity;
  for (const za of [DIM.frontAxle, DIM.rearAxle]) {
    const dz = z - za;
    const r = DIM.archR;
    if (Math.abs(dz) < r) y = Math.max(y, DIM.tyreR + Math.sqrt(r * r - dz * dz) * 1.0);
  }
  return y;
}

export function bottom(z: number): number {
  return Math.max(bottomBase(z), archTop(z));
}

/** How much the arch lifts the bottom at z (0..1): the lip then stays near full width. */
function archness(z: number): number {
  return smooth(0, 0.08, bottom(z) - bottomBase(z));
}

// side profile: width factor vs height fraction (0 = bottom edge, 1 = shoulder at the belt)
const sideW = curve([[0, 0.8], [0.05, 0.9], [0.14, 0.962], [0.28, 0.985], [0.55, 1.0], [0.8, 0.992], [0.92, 0.972], [1.0, 0.93]]);

/**
 * Half cross-section of the lower body at z: [x, y] from the bottom centre, up the side, over the
 * hood/deck crown to the top centre (x >= 0).
 */
export function bodySection(z: number): Array<[number, number]> {
  const hw = halfWidth(z);
  const yb = bottom(z), yt = belt(z), cr = crown(z);
  const out: Array<[number, number]> = [];
  const ar = archness(z);
  out.push([0, yb]);
  out.push([hw * (0.55 + 0.4 * ar), yb]);
  const H = Math.max(0.02, yt - yb);
  const hs = [0.0, 0.03, 0.08, 0.16, 0.3, 0.45, 0.6, 0.75, 0.86, 0.94, 1.0];
  for (const h of hs) {
    let w = sideW(h);
    // at the arches the lip stays out at the fender surface
    if (ar > 0) w = w + (Math.max(w, 0.975) - w) * ar;
    out.push([hw * w, yb + h * H]);
  }
  const tops = [0.1, 0.25, 0.45, 0.7, 1.0];
  const x0 = hw * sideW(1.0);
  for (const q of tops) {
    const x = x0 * (1 - q);
    const y = yt + cr * (1 - (1 - q) * (1 - q));
    out.push([x, y]);
  }
  return out;
}

// ------------------------------------------------------------------ greenhouse
export const GH = { zWS: 0.8, zWT: 0.03, zRT: -0.95, zRB: -1.55 };

/** Roof centreline height over the greenhouse span. */
export const roofC = curve([
  [-1.56, 1.0], [-1.45, 1.075], [-1.3, 1.17], [-1.15, 1.265], [-0.95, 1.37], [-0.75, 1.405], [-0.45, 1.42],
  [-0.15, 1.41], [0.03, 1.385], [0.25, 1.27], [0.5, 1.13], [0.7, 1.02], [0.81, 0.965],
]);

export function roofRail(z: number): number {
  return Math.max(belt(z) + 0.0, roofC(z) - 0.042);
}

export function greenhouseBase(z: number): number {
  return halfWidth(z) * 0.93 - 0.045;
}

export function railHalfWidth(z: number): number {
  const hb = greenhouseBase(z);
  const k = Math.pow(smooth(0, 0.34, roofRail(z) - belt(z)), 0.9);
  return hb + (0.625 - hb) * k;
}

/** Half cross-section of the greenhouse at z: from the belt (side) up to the roof centre. */
export function cabinSection(z: number): Array<[number, number]> {
  const yb = belt(z) - 0.004;
  const hb = greenhouseBase(z);
  const yr = roofRail(z), yc = Math.max(roofC(z), yr + 0.004);
  const hr = railHalfWidth(z);
  const out: Array<[number, number]> = [];
  const glassH = yr - yb;
  for (const t of [0, 0.25, 0.5, 0.75, 1.0]) {
    // slight outward bow of the side glass
    const x = hb + (hr - hb) * t + 0.012 * Math.sin(Math.PI * t) * Math.min(1, glassH / 0.3);
    out.push([x, yb + glassH * t]);
  }
  out.push([hr - 0.03, yr + (yc - yr) * 0.45]);
  out.push([hr - 0.09, yr + (yc - yr) * 0.8]);
  out.push([hr * 0.55, yc - 0.004]);
  out.push([hr * 0.22, yc]);
  out.push([0, yc]);
  return out;
}

/** Longitudinal stations for the lower body: dense at the rounded ends and around the arches. */
export function bodyStations(): number[] {
  const L = DIM.halfL;
  const s = new Set<number>();
  for (let z = -L + 0.12; z < L - 0.12; z += 0.05) s.add(+z.toFixed(4));
  for (let k = 0; k < 14; k++) {
    const d = 0.12 * Math.pow(k / 13, 1.8);
    s.add(+(L - d).toFixed(4));
    s.add(+(-L + d).toFixed(4));
  }
  for (const za of [DIM.frontAxle, DIM.rearAxle]) {
    for (let a = -1; a <= 1.0001; a += 0.1) s.add(+(za + a * DIM.archR).toFixed(4));
    s.add(+(za + DIM.archR + 0.004).toFixed(4));
    s.add(+(za - DIM.archR - 0.004).toFixed(4));
  }
  return [...s].sort((a, b) => a - b);
}

export function cabinStations(): number[] {
  const out: number[] = [];
  const n = 64;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // denser near the windshield and rear window bases
    const u = t < 0.5 ? 0.5 * Math.pow(t * 2, 1.25) : 1 - 0.5 * Math.pow((1 - t) * 2, 1.25);
    out.push(GH.zRB - 0.01 + (GH.zWS + 0.01 - (GH.zRB - 0.01)) * u);
  }
  return out;
}
