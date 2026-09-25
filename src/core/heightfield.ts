// Terrain height field shared by every module (terrain mesh, roads, buildings,
// vegetation, physics...). Always sample heights through this class so that all
// layers sit on exactly the same ground.
import * as THREE from 'three';
import { fetchBuffer } from './data';

export interface TerrainManifest {
  height: string;
  n: number;          // samples per side (vertex-centred grid)
  size: number;       // metres covered by the grid (edge to edge of first/last sample)
  hMin: number;
  hScale: number;
  format: 'u16le';
  rowOrder: 'north-to-south';
  ortho: string;
  orthoGain: number;
  landcover: string;
  minHeight: number;
  maxHeight: number;
}

export class HeightField {
  readonly n: number;
  readonly size: number;
  readonly half: number;
  readonly res: number;
  /** Heights in metres, row-major, row 0 = north edge (z = -half). */
  readonly data: Float32Array;
  minHeight = Infinity;
  maxHeight = -Infinity;
  private _texture: THREE.DataTexture | null = null;

  constructor(n: number, size: number, data: Float32Array) {
    this.n = n;
    this.size = size;
    this.half = size / 2;
    this.res = size / (n - 1);
    this.data = data;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < this.minHeight) this.minHeight = v;
      if (v > this.maxHeight) this.maxHeight = v;
    }
  }

  static async load(m: TerrainManifest, onProgress?: (l: number, t: number) => void): Promise<HeightField> {
    const buf = await fetchBuffer(m.height, onProgress);
    const u16 = new Uint16Array(buf);
    const f = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) f[i] = m.hMin + u16[i] * m.hScale;
    return new HeightField(m.n, m.size, f);
  }

  /** Grid-space coordinates (fractional column, row) for world x/z. */
  toGrid(x: number, z: number): [number, number] {
    return [(x + this.half) / this.res, (z + this.half) / this.res];
  }

  inBounds(x: number, z: number): boolean {
    return Math.abs(x) <= this.half && Math.abs(z) <= this.half;
  }

  /** Raw sample at integer grid coords (clamped). */
  at(i: number, j: number): number {
    const n = this.n;
    i = i < 0 ? 0 : i >= n ? n - 1 : i;
    j = j < 0 ? 0 : j >= n ? n - 1 : j;
    return this.data[j * n + i];
  }

  /** Bilinear height (m above sea level) at world x/z. Clamped outside the grid. */
  sample(x: number, z: number): number {
    let gx = (x + this.half) / this.res;
    let gz = (z + this.half) / this.res;
    const max = this.n - 1.000001;
    gx = gx < 0 ? 0 : gx > max ? max : gx;
    gz = gz < 0 ? 0 : gz > max ? max : gz;
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const n = this.n, d = this.data;
    const k = j * n + i;
    const a = d[k], b = d[k + 1], c = d[k + n], e = d[k + n + 1];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + e * fx) * fz;
  }

  /** Surface normal (world space) at x/z using central differences. */
  normal(x: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
    const e = this.res;
    const hx = this.sample(x + e, z) - this.sample(x - e, z);
    const hz = this.sample(x, z + e) - this.sample(x, z - e);
    return target.set(-hx, 2 * e, -hz).normalize();
  }

  /** Minimum / maximum height over a set of xz points (e.g. a building footprint). */
  range(points: ArrayLike<number>, stride = 2): { min: number; max: number } {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < points.length; i += stride) {
      const h = this.sample(points[i], points[i + 1]);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    return { min, max };
  }

  /**
   * Cast a ray against the height field (for picking/teleports).
   * Returns distance along the ray or -1.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist = 50000): number {
    let t = 0;
    let step = Math.max(1, this.res * 0.5);
    let prevAbove = origin.y - this.sample(origin.x, origin.z);
    if (prevAbove < 0) return 0;
    while (t < maxDist) {
      const nt = t + step;
      const x = origin.x + dir.x * nt, y = origin.y + dir.y * nt, z = origin.z + dir.z * nt;
      const above = y - this.sample(x, z);
      if (above < 0) {
        // refine by bisection
        let lo = t, hi = nt;
        for (let k = 0; k < 20; k++) {
          const mid = (lo + hi) / 2;
          const my = origin.y + dir.y * mid;
          if (my - this.sample(origin.x + dir.x * mid, origin.z + dir.z * mid) < 0) hi = mid; else lo = mid;
        }
        return (lo + hi) / 2;
      }
      prevAbove = above;
      t = nt;
      step = Math.max(this.res * 0.5, Math.min(200, above * 0.5));
    }
    return -1;
  }

  /**
   * Height field as a float texture (R32F, LinearFilter where supported) for
   * GPU-side draping. UV (0,0) = north-west corner, i.e.
   *   u = (x + half) / size,  v = (z + half) / size   (flipY = false)
   */
  get texture(): THREE.DataTexture {
    if (!this._texture) {
      const t = new THREE.DataTexture(this.data, this.n, this.n, THREE.RedFormat, THREE.FloatType);
      t.flipY = false;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this._texture = t;
    }
    return this._texture;
  }

  /** Call after modifying `data` in place (e.g. flattening a construction site). */
  markDirty(): void {
    if (this._texture) this._texture.needsUpdate = true;
  }
}
