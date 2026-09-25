// Continuous distance-dependent LOD (CDLOD, Strugar 2009) for a square height field.
//
// A quadtree over the region selects patches every frame; every patch is the same
// N x N vertex grid (plus an N/2 grid for "partial" parents), drawn with two instanced
// draw calls. Vertices morph to the next coarser grid in the outer part of each LOD range
// (in the vertex shader), so there are no cracks and no popping.
import * as THREE from 'three';

export interface CdlodOptions {
  /** World x/z of the root's min corner. */
  x0: number;
  z0: number;
  /** Root size (m). */
  size: number;
  /** Number of LOD levels (level 0 = finest, root = levels-1). */
  levels: number;
  /** Quads per side of a full patch (even). */
  gridN: number;
  /** LOD ranges (m), one per level, increasing; range[L] >= range[L-1] + 1.42 * nodeSize(L). */
  ranges: number[];
  /** Fraction of each level's band where morphing happens (0..1, e.g. 0.35). */
  morphFraction: number;
  /** Height bounds of a node, used for the range and frustum tests. */
  bounds: (level: number, ix: number, iz: number) => [number, number];
  maxPatches?: number;
}

export interface PatchSet {
  full: THREE.InstancedBufferGeometry;
  half: THREE.InstancedBufferGeometry;
}

/** Grid geometry: position = (i, j, N) integer grid coordinates. */
export function makeGridGeometry(n: number, maxInstances: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let k = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) { pos[k++] = i; pos[k++] = j; pos[k++] = n; }
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      // uniform diagonal: a fully morphed fine grid equals the next coarser grid exactly
      idx.push(a, c, b, b, c, d);
    }
  }
  g.setIndex(idx);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const inst = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 4), 4);
  inst.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aPatch', inst);
  g.instanceCount = 0;
  // bounds are irrelevant: the owning mesh is not frustum culled (we cull per patch)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e7, -1e7, -1e7), new THREE.Vector3(1e7, 1e7, 1e7));
  return g;
}

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

export class Cdlod {
  readonly opt: CdlodOptions;
  readonly full: THREE.InstancedBufferGeometry;
  readonly half: THREE.InstancedBufferGeometry;
  /** vec2 per level: (morphStart, morphEnd) - feed to the shader. */
  readonly morph: THREE.Vector2[];
  readonly maxPatches: number;
  patchCount = 0;
  triangles = 0;
  private nFull = 0;
  private nHalf = 0;
  private frustum: THREE.Frustum | null = null;
  private cam = new THREE.Vector3();
  private cullDist = Infinity;
  /** optional: skip whole nodes (e.g. hidden regions) */
  skip: ((x0: number, z0: number, size: number) => boolean) | null = null;

  constructor(opt: CdlodOptions) {
    this.opt = opt;
    this.maxPatches = opt.maxPatches ?? 4096;
    this.full = makeGridGeometry(opt.gridN, this.maxPatches);
    this.half = makeGridGeometry(opt.gridN / 2, this.maxPatches);
    this.morph = opt.ranges.map(() => new THREE.Vector2());
    this.setRanges(opt.ranges);
  }

  setRanges(ranges: number[]): void {
    this.opt.ranges = ranges.slice();
    for (let L = 0; L < ranges.length; L++) {
      const prev = L > 0 ? ranges[L - 1] : 0;
      const end = ranges[L];
      const start = prev + (end - prev) * (1 - this.opt.morphFraction);
      this.morph[L].set(start, end);
    }
  }

  nodeSize(level: number): number {
    return this.opt.size / (1 << (this.opt.levels - 1 - level));
  }

  /**
   * Select patches for a camera. `frustum` may be null (no culling). `noCullWithin` keeps
   * patches within that distance even when outside the frustum (shadow casters).
   */
  select(camPos: THREE.Vector3, frustum: THREE.Frustum | null, noCullWithin = 0): void {
    this.cam.copy(camPos);
    this.frustum = frustum;
    this.cullDist = noCullWithin;
    this.nFull = 0;
    this.nHalf = 0;
    const top = this.opt.levels - 1;
    if (!this.visit(top, 0, 0)) this.add(false, top, 0, 0, this.nodeSize(top));
    this.full.instanceCount = this.nFull;
    this.half.instanceCount = this.nHalf;
    (this.full.attributes.aPatch as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.half.attributes.aPatch as THREE.InstancedBufferAttribute).needsUpdate = true;
    const n = this.opt.gridN;
    this.patchCount = this.nFull + this.nHalf;
    this.triangles = this.nFull * n * n * 2 + this.nHalf * (n / 2) * (n / 2) * 2;
  }

  private box(level: number, ix: number, iz: number, s: number): THREE.Box3 {
    const [lo, hi] = this.opt.bounds(level, ix, iz);
    const x = this.opt.x0 + ix * s, z = this.opt.z0 + iz * s;
    _box.min.set(x, lo, z);
    _box.max.set(x + s, hi, z + s);
    return _box;
  }

  private intersectsSphere(b: THREE.Box3, r: number): boolean {
    b.clampPoint(this.cam, _v);
    return _v.distanceToSquared(this.cam) <= r * r;
  }

  private culled(b: THREE.Box3): boolean {
    if (!this.frustum) return false;
    if (this.frustum.intersectsBox(b)) return false;
    if (this.cullDist > 0) {
      b.clampPoint(this.cam, _v);
      if (_v.distanceTo(this.cam) < this.cullDist) return false;
    }
    return true;
  }

  /** Returns true when the node's area is handled (drawn or culled). */
  private visit(level: number, ix: number, iz: number): boolean {
    const s = this.nodeSize(level);
    const b = this.box(level, ix, iz, s);
    if (!this.intersectsSphere(b, this.opt.ranges[level])) return false;
    if (this.skip && this.skip(this.opt.x0 + ix * s, this.opt.z0 + iz * s, s)) return true;
    if (this.culled(b)) return true;
    if (level === 0) { this.add(false, 0, ix, iz, s); return true; }
    if (!this.intersectsSphere(b, this.opt.ranges[level - 1])) { this.add(false, level, ix, iz, s); return true; }
    const hs = s / 2;
    for (let c = 0; c < 4; c++) {
      const cx = ix * 2 + (c & 1), cz = iz * 2 + (c >> 1);
      if (!this.visit(level - 1, cx, cz)) {
        // child out of its range: draw the child's area with this (parent) level's resolution
        if (this.skip && this.skip(this.opt.x0 + cx * hs, this.opt.z0 + cz * hs, hs)) continue;
        const cb = this.box(level - 1, cx, cz, hs);
        if (this.culled(cb)) continue;
        this.add(true, level, cx, cz, hs);
      }
    }
    return true;
  }

  private add(half: boolean, level: number, ix: number, iz: number, s: number): void {
    const g = half ? this.half : this.full;
    const n = half ? this.nHalf : this.nFull;
    if (n >= this.maxPatches) return;
    const a = (g.attributes.aPatch as THREE.InstancedBufferAttribute).array as Float32Array;
    a[n * 4] = this.opt.x0 + ix * s;
    a[n * 4 + 1] = this.opt.z0 + iz * s;
    a[n * 4 + 2] = s;
    a[n * 4 + 3] = level;
    if (half) this.nHalf++; else this.nFull++;
  }
}

/** Min/max pyramid over a (n x n) vertex grid for quadtree node bounds. */
export class MinMaxPyramid {
  readonly levels: Array<{ n: number; min: Float32Array; max: Float32Array }> = [];

  /**
   * @param data   heights, row-major n x n (vertex grid, n = cells + 1)
   * @param n      samples per side
   * @param leafCells cells per leaf node side
   * @param levels  number of levels
   * @param margin  added to max / subtracted from min (m)
   */
  constructor(data: Float32Array, n: number, leafCells: number, levels: number, margin = 2) {
    const cells = n - 1;
    let nodes = Math.max(1, Math.round(cells / leafCells));
    const min0 = new Float32Array(nodes * nodes), max0 = new Float32Array(nodes * nodes);
    for (let jz = 0; jz < nodes; jz++) {
      for (let ix = 0; ix < nodes; ix++) {
        let lo = Infinity, hi = -Infinity;
        const i0 = Math.max(0, ix * leafCells - 1), i1 = Math.min(cells, (ix + 1) * leafCells + 1);
        const j0 = Math.max(0, jz * leafCells - 1), j1 = Math.min(cells, (jz + 1) * leafCells + 1);
        for (let j = j0; j <= j1; j++) {
          const row = j * n;
          for (let i = i0; i <= i1; i++) {
            const v = data[row + i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        min0[jz * nodes + ix] = lo - margin;
        max0[jz * nodes + ix] = hi + margin;
      }
    }
    this.levels.push({ n: nodes, min: min0, max: max0 });
    for (let L = 1; L < levels; L++) {
      const p = this.levels[L - 1];
      const m = Math.max(1, p.n >> 1);
      const mn = new Float32Array(m * m), mx = new Float32Array(m * m);
      for (let z = 0; z < m; z++) {
        for (let x = 0; x < m; x++) {
          let lo = Infinity, hi = -Infinity;
          for (let c = 0; c < 4; c++) {
            const cx = Math.min(p.n - 1, x * 2 + (c & 1)), cz = Math.min(p.n - 1, z * 2 + (c >> 1));
            lo = Math.min(lo, p.min[cz * p.n + cx]);
            hi = Math.max(hi, p.max[cz * p.n + cx]);
          }
          mn[z * m + x] = lo;
          mx[z * m + x] = hi;
        }
      }
      this.levels.push({ n: m, min: mn, max: mx });
    }
  }

  get(level: number, ix: number, iz: number): [number, number] {
    const l = this.levels[Math.min(level, this.levels.length - 1)];
    const x = Math.min(l.n - 1, Math.max(0, ix)), z = Math.min(l.n - 1, Math.max(0, iz));
    return [l.min[z * l.n + x], l.max[z * l.n + x]];
  }
}
