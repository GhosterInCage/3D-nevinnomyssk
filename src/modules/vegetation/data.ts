// Loading + spatial indexing of the vegetation instance data (public/data/vegetation/trees.bin.gz,
// format documented in pipeline/build_vegetation.py).
import { fetchBuffer } from '../../core/data';
import type { HeightField } from '../../core/heightfield';
import { HEDGE_ID, SPECIES_BY_ID } from './species';

export class VegData {
  n = 0;
  C = 0;
  cell = 64;
  origin = -10240;
  cellStart!: Uint32Array;   // C*C + 1
  x!: Float32Array;
  z!: Float32Array;
  y!: Float32Array;          // base height (NaN until computed)
  sp!: Uint8Array;
  h!: Float32Array;
  w!: Float32Array;
  rot!: Float32Array;
  rank!: Float32Array;       // 0..1 random (density LOD)
  removed!: Uint8Array;
  private cellY!: Uint8Array;

  static async load(url = 'vegetation/trees.bin.gz'): Promise<VegData> {
    const buf = await fetchBuffer(url);
    const d = new VegData();
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'VEG1') throw new Error('vegetation: bad magic ' + magic);
    const n = dv.getUint32(8, true), C = dv.getUint32(12, true);
    const cell = dv.getFloat32(16, true), origin = dv.getFloat32(20, true);
    const pq = dv.getFloat32(24, true), hq = dv.getFloat32(28, true), cq = dv.getFloat32(32, true);
    d.n = n; d.C = C; d.cell = cell; d.origin = origin;
    let o = 40;
    const counts = new Uint16Array(buf.slice(o, o + C * C * 2)); o += C * C * 2;
    const qx = new Uint8Array(buf, o, n); o += n;
    const qz = new Uint8Array(buf, o, n); o += n;
    const sp = new Uint8Array(buf, o, n); o += n;
    const qh = new Uint8Array(buf, o, n); o += n;
    const qc = new Uint8Array(buf, o, n); o += n;
    const qr = new Uint8Array(buf, o, n); o += n;
    d.cellStart = new Uint32Array(C * C + 1);
    for (let i = 0; i < C * C; i++) d.cellStart[i + 1] = d.cellStart[i] + counts[i];
    d.x = new Float32Array(n); d.z = new Float32Array(n); d.y = new Float32Array(n).fill(NaN);
    d.sp = new Uint8Array(sp); d.h = new Float32Array(n); d.w = new Float32Array(n); d.rot = new Float32Array(n);
    d.rank = new Float32Array(n);
    d.removed = new Uint8Array(n);
    d.cellY = new Uint8Array(C * C);
    for (let c = 0; c < C * C; c++) {
      const s = d.cellStart[c], e = d.cellStart[c + 1];
      if (s === e) continue;
      const col = c % C, row = (c / C) | 0;
      const x0 = origin + col * cell, z0 = origin + row * cell;
      for (let i = s; i < e; i++) {
        d.x[i] = x0 + (qx[i] + 0.5) * pq;
        d.z[i] = z0 + (qz[i] + 0.5) * pq;
        d.h[i] = qh[i] * hq;
        d.w[i] = qc[i] * cq;
        const hsh = hash32(i * 2654435761 + 12345);
        d.rank[i] = (hsh & 0xffff) / 65536;
        d.rot[i] = sp[i] === HEDGE_ID ? (qr[i] / 256) * Math.PI * 2 : ((hsh >>> 16) / 65536) * Math.PI * 2;
      }
    }
    return d;
  }

  cellIndex(x: number, z: number): number {
    const col = Math.floor((x - this.origin) / this.cell), row = Math.floor((z - this.origin) / this.cell);
    if (col < 0 || row < 0 || col >= this.C || row >= this.C) return -1;
    return row * this.C + col;
  }

  /** Ensure base heights for a cell (sampled so trunks never float on slopes). */
  ensureHeights(c: number, hf: HeightField | { sample(x: number, z: number): number }): void {
    if (this.cellY[c]) return;
    this.cellY[c] = 1;
    const s = this.cellStart[c], e = this.cellStart[c + 1];
    for (let i = s; i < e; i++) {
      const x = this.x[i], z = this.z[i];
      const def = SPECIES_BY_ID.get(this.sp[i]);
      const r = def && def.kind === 'tree' ? 0.35 : 0.2;
      const h0 = hf.sample(x, z);
      const m = Math.min(h0, hf.sample(x + r, z), hf.sample(x - r, z), hf.sample(x, z + r), hf.sample(x, z - r));
      this.y[i] = m - 0.12;
    }
  }

  /** Forget cached heights (after terrain edits). */
  invalidateHeights(): void { this.cellY.fill(0); }

  /** Visit cell indices overlapping an axis-aligned square. */
  forCells(x0: number, z0: number, x1: number, z1: number, fn: (c: number) => void): void {
    const C = this.C;
    const c0 = Math.max(0, Math.floor((x0 - this.origin) / this.cell)), c1 = Math.min(C - 1, Math.floor((x1 - this.origin) / this.cell));
    const r0 = Math.max(0, Math.floor((z0 - this.origin) / this.cell)), r1 = Math.min(C - 1, Math.floor((z1 - this.origin) / this.cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * C + c);
  }
}

export function hash32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Point-in-polygon for a flat xz ring [x0,z0,x1,z1,...]. */
export function pointInRing(x: number, z: number, ring: ArrayLike<number>): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], zi = ring[2 * i + 1], xj = ring[2 * j], zj = ring[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}
