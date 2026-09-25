// Water data: parses public/data/water/{water.json, water.bin.gz} (see pipeline/build_water.py)
// into per-tile BufferGeometries plus CPU-side copies for point queries (water service).
import * as THREE from 'three';
import { fetchBuffer, fetchJSON } from '../../core/data';

export interface WaterBody {
  idx: number;
  type: 'river_fast' | 'river' | 'canal' | 'stream' | 'pond' | 'industrial' | 'pool';
  typeId: number;
  name: string | null;
  albedo: [number, number, number];
  ext: number;
  speed: number;
  rough: number;
  wind: number;
  level?: number;
  width?: number;
  area?: number;
}

interface Section { offset: number; bytes: number }

export interface WaterTileMeta {
  i: number; j: number; cx: number; cz: number; nv: number; nt: number;
  yMin: number; yMax: number; bbox: [number, number, number, number]; bodies: number[];
  pos: number; flow: number; attr: number; body: number; index: number;
}

export interface WaterMeta {
  version: number;
  tile: number;
  layout: Record<'pos' | 'flow' | 'attr' | 'body' | 'index', Section>;
  tiles: WaterTileMeta[];
  bodies: WaterBody[];
  types: Record<string, number>;
  weir?: { line: [number, number][]; up: number; down: number } | null;
  stats?: { vertices: number; triangles: number; samples: number };
}

/** CPU copy of a tile, world coordinates, plus a uniform grid over its triangles for queries. */
export class WaterTile {
  readonly meta: WaterTileMeta;
  readonly geometry: THREE.BufferGeometry;
  readonly x: Float32Array;       // world x
  readonly z: Float32Array;       // world z
  readonly y: Float32Array;       // water level
  readonly flow: Int8Array;       // (vx, vz) * 20
  readonly attr: Uint8Array;      // shore, foam, bar, 0
  readonly body: Uint16Array;
  readonly index: Uint16Array;
  private gridCell = 32;
  private gx0 = 0; private gz0 = 0; private gnx = 0; private gnz = 0;
  private gStart: Int32Array | null = null;
  private gItems: Int32Array | null = null;

  constructor(meta: WaterTileMeta, blob: ArrayBuffer, layout: WaterMeta['layout']) {
    this.meta = meta;
    const nv = meta.nv, nt = meta.nt;
    const pos = new Int16Array(blob, layout.pos.offset + meta.pos, nv * 3);
    const flow = new Int8Array(blob, layout.flow.offset + meta.flow, nv * 2);
    const attr = new Uint8Array(blob, layout.attr.offset + meta.attr, nv * 4);
    const body = new Uint16Array(blob, layout.body.offset + meta.body, nv);
    const index = new Uint16Array(blob, layout.index.offset + meta.index, nt * 3);
    const lvl = new Uint16Array(blob, layout.pos.offset + meta.pos, nv * 3);
    this.x = new Float32Array(nv);
    this.z = new Float32Array(nv);
    this.y = new Float32Array(nv);
    const p = new Float32Array(nv * 3);
    for (let k = 0; k < nv; k++) {
      const lx = pos[k * 3] * 0.1, lz = pos[k * 3 + 1] * 0.1;
      const h = 200 + lvl[k * 3 + 2] * 0.01;
      p[k * 3] = lx; p[k * 3 + 1] = h; p[k * 3 + 2] = lz;
      this.x[k] = lx + meta.cx; this.z[k] = lz + meta.cz; this.y[k] = h;
    }
    this.flow = flow.slice();
    this.attr = attr.slice();
    this.body = body.slice();
    this.index = index.slice();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aFlow', new THREE.BufferAttribute(this.flow, 2, false));
    g.setAttribute('aAttr', new THREE.BufferAttribute(this.attr, 4, true));
    g.setAttribute('aBody', new THREE.BufferAttribute(this.body, 1, false));
    g.setIndex(new THREE.BufferAttribute(this.index, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.geometry = g;
  }

  private buildGrid(): void {
    const [x0, z0, x1, z1] = this.meta.bbox;
    const c = this.gridCell;
    this.gx0 = x0; this.gz0 = z0;
    this.gnx = Math.max(1, Math.ceil((x1 - x0) / c) + 1);
    this.gnz = Math.max(1, Math.ceil((z1 - z0) / c) + 1);
    const ncell = this.gnx * this.gnz;
    const counts = new Int32Array(ncell + 1);
    const idx = this.index, X = this.x, Z = this.z;
    const nt = idx.length / 3;
    const range = (t: number): [number, number, number, number] => {
      const a = idx[t * 3], b = idx[t * 3 + 1], d = idx[t * 3 + 2];
      const mnx = Math.min(X[a], X[b], X[d]), mxx = Math.max(X[a], X[b], X[d]);
      const mnz = Math.min(Z[a], Z[b], Z[d]), mxz = Math.max(Z[a], Z[b], Z[d]);
      return [
        Math.max(0, Math.floor((mnx - this.gx0) / c)), Math.min(this.gnx - 1, Math.floor((mxx - this.gx0) / c)),
        Math.max(0, Math.floor((mnz - this.gz0) / c)), Math.min(this.gnz - 1, Math.floor((mxz - this.gz0) / c)),
      ];
    };
    for (let t = 0; t < nt; t++) {
      const [i0, i1, j0, j1] = range(t);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * this.gnx + i + 1]++;
    }
    for (let k = 1; k <= ncell; k++) counts[k] += counts[k - 1];
    const items = new Int32Array(counts[ncell]);
    const fill = counts.slice(0, ncell);
    for (let t = 0; t < nt; t++) {
      const [i0, i1, j0, j1] = range(t);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) items[fill[j * this.gnx + i]++] = t;
    }
    this.gStart = counts;
    this.gItems = items;
  }

  /** Barycentric hit of the water triangle containing (x, z), or null. */
  locate(x: number, z: number, out: { a: number; b: number; c: number; wa: number; wb: number; wc: number }): boolean {
    const [x0, z0, x1, z1] = this.meta.bbox;
    if (x < x0 || x > x1 || z < z0 || z > z1) return false;
    if (!this.gStart) this.buildGrid();
    const i = Math.floor((x - this.gx0) / this.gridCell), j = Math.floor((z - this.gz0) / this.gridCell);
    if (i < 0 || j < 0 || i >= this.gnx || j >= this.gnz) return false;
    const cell = j * this.gnx + i;
    const s = this.gStart!, items = this.gItems!, idx = this.index, X = this.x, Z = this.z;
    for (let k = s[cell]; k < s[cell + 1]; k++) {
      const t = items[k];
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      const ax = X[a], az = Z[a];
      const v0x = X[b] - ax, v0z = Z[b] - az, v1x = X[c] - ax, v1z = Z[c] - az, v2x = x - ax, v2z = z - az;
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-9) continue;
      const wb = (v2x * v1z - v1x * v2z) / den;
      const wc = (v0x * v2z - v2x * v0z) / den;
      const wa = 1 - wb - wc;
      if (wa >= -1e-6 && wb >= -1e-6 && wc >= -1e-6) {
        out.a = a; out.b = b; out.c = c; out.wa = wa; out.wb = wb; out.wc = wc;
        return true;
      }
    }
    return false;
  }
}

export interface WaterData {
  meta: WaterMeta;
  tiles: WaterTile[];
  /** tiles by key j*100+i */
  byKey: Map<number, WaterTile>;
}

export async function loadWaterData(): Promise<WaterData> {
  const [meta, blob] = await Promise.all([
    fetchJSON<WaterMeta>('water/water.json'),
    fetchBuffer('water/water.bin.gz'),
  ]);
  const tiles: WaterTile[] = [];
  const byKey = new Map<number, WaterTile>();
  for (const t of meta.tiles) {
    const tile = new WaterTile(t, blob, meta.layout);
    tiles.push(tile);
    byKey.set(t.j * 100 + t.i, tile);
  }
  return { meta, tiles, byKey };
}
