// Small helpers shared by the traffic module: deterministic RNG, hashing, polylines.

/** Mulberry32 PRNG (deterministic, fast). */
export class Rng {
  private s: number;
  constructor(seed = 1) { this.s = seed >>> 0 || 1; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  /** index from a weight table */
  weighted(w: ArrayLike<number>, total?: number): number {
    let t = total ?? 0;
    if (total === undefined) for (let i = 0; i < w.length; i++) t += w[i];
    let r = this.next() * t;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
    return w.length - 1;
  }
  gauss(): number {
    const u = Math.max(1e-9, this.next()), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Integer hash -> [0,1). */
export function hash01(i: number, salt = 0): number {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Weighted pick using a hash value in [0,1). */
export function pickWeighted(w: ArrayLike<number>, u: number): number {
  let t = 0;
  for (let i = 0; i < w.length; i++) t += w[i];
  let r = u * t;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return w.length - 1;
}

/** Polyline with cumulative arc length (x,z pairs). */
export class Poly {
  readonly p: Float32Array;
  readonly c: Float32Array;
  readonly length: number;
  constructor(p: ArrayLike<number>) {
    this.p = p instanceof Float32Array ? p : new Float32Array(p);
    const n = this.p.length >> 1;
    this.c = new Float32Array(n);
    let acc = 0;
    for (let i = 1; i < n; i++) {
      acc += Math.hypot(this.p[i * 2] - this.p[i * 2 - 2], this.p[i * 2 + 1] - this.p[i * 2 - 1]);
      this.c[i] = acc;
    }
    this.length = acc;
  }

  /** segment index containing arc length s (binary search) */
  seg(s: number): number {
    const c = this.c;
    let lo = 0, hi = c.length - 1;
    if (s <= 0) return 0;
    if (s >= c[hi]) return Math.max(0, hi - 1);
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m; else hi = m;
    }
    return lo;
  }

  /** point at arc length s -> out[0..1]; also tangent in out[2..3] */
  at(s: number, out: Float64Array | number[]): void {
    const k = this.seg(s);
    const p = this.p, c = this.c;
    const L = c[k + 1] - c[k];
    const t = L > 1e-6 ? Math.min(1, Math.max(0, (s - c[k]) / L)) : 0;
    const dx = p[k * 2 + 2] - p[k * 2], dz = p[k * 2 + 3] - p[k * 2 + 1];
    out[0] = p[k * 2] + dx * t;
    out[1] = p[k * 2 + 1] + dz * t;
    const l = Math.hypot(dx, dz) || 1;
    out[2] = dx / l;
    out[3] = dz / l;
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
