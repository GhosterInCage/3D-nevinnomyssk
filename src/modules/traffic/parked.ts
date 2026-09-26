// Parked cars (pipeline/build_traffic.py -> traffic/parked.bin.gz): courtyards of the apartment
// districts, kerbs, private-sector verges, parking lots. Streamed around the camera into their own
// instanced fleet (static matrices, rebuilt when the camera moves).
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { fetchBuffer } from '../../core/data';
import type { Net } from './net';
import type { VehicleType } from './models';
import { paletteColor } from './models';
import { FleetRenderer, basisMatrix } from './render';
import { hash01, pickWeighted, clamp } from './util';

const CELL = 128;
const _col = new THREE.Color();

export class Parked {
  n = 0;
  x!: Float32Array; z!: Float32Array; h!: Float32Array; kind!: Uint8Array;
  type!: Uint8Array;
  col!: Float32Array; data!: Float32Array;
  y!: Float32Array;
  mat!: Float32Array;
  private ready!: Uint8Array;
  private grid = new Map<number, number[]>();
  renderer!: FleetRenderer;
  private lastX = Infinity; private lastZ = Infinity; private lastR = 0;
  radius = 450;
  visible = 0;
  hidden: Set<number> = new Set();

  constructor(private ctx: AppContext, private net: Net, private types: VehicleType[], private material: THREE.Material) {}

  async load(): Promise<void> {
    const buf = await fetchBuffer('traffic/parked.bin.gz');
    const n = Math.floor(buf.byteLength / 10);
    const dv = new DataView(buf);
    this.n = n;
    this.x = new Float32Array(n); this.z = new Float32Array(n); this.h = new Float32Array(n); this.kind = new Uint8Array(n);
    this.type = new Uint8Array(n); this.col = new Float32Array(n * 3); this.data = new Float32Array(n * 4);
    this.y = new Float32Array(n); this.mat = new Float32Array(n * 16); this.ready = new Uint8Array(n);
    // type weights per parking kind
    const pw = this.types.map((t) => t.parkWeight);
    const byKind = [0, 1, 2, 3, 4].map((k) => this.types.map((t, i) => {
      let w = pw[i];
      if (k === 2 && (t.name.includes('2107') || t.name.includes('Niva') || t.name.includes('UAZ') || t.name.includes('2114'))) w *= 2.2;
      if (k === 2 && t.kind === 'truck') w *= 1.5;
      if (k === 4 && t.kind === 'truck') w *= 8;
      if (k === 1 && t.kind !== 'car') w *= 0.4;
      if (k === 0 && t.kind === 'truck') w *= 0.2;
      return w;
    }));
    for (let i = 0; i < n; i++) {
      const o = i * 10;
      const x = dv.getFloat32(o, true), z = dv.getFloat32(o + 4, true);
      this.x[i] = x; this.z[i] = z;
      this.h[i] = (dv.getUint8(o + 8) * 360) / 256;
      const k = dv.getUint8(o + 9);
      this.kind[i] = k;
      const t = pickWeighted(byKind[Math.min(4, k)], hash01(i, 3));
      this.type[i] = t;
      const ty = this.types[t];
      const metal = paletteColor(ty.palette, hash01(i, 5), _col);
      this.col[i * 3] = _col.r; this.col[i * 3 + 1] = _col.g; this.col[i * 3 + 2] = _col.b;
      this.data[i * 4] = hash01(i, 7) * 6.28;
      this.data[i * 4 + 1] = -1; // lights off
      this.data[i * 4 + 2] = metal;
      this.data[i * 4 + 3] = clamp(ty.dirt * (0.6 + hash01(i, 9)), 0, 1);
      const key = Math.floor(x / CELL) * 4096 + Math.floor(z / CELL);
      let l = this.grid.get(key);
      if (!l) this.grid.set(key, (l = []));
      l.push(i);
    }
    const caps = this.types.map((t) => {
      const w = t.parkWeight;
      if (w <= 0) return [1, 1, 1];
      return [Math.ceil(40 + w * 12), Math.ceil(80 + w * 40), Math.ceil(200 + w * 110)];
    });
    this.renderer = new FleetRenderer('traffic-parked', { lods: this.types.map((t) => [t.lod0, t.lod1, t.lod2]) }, this.material, caps);
  }

  private prepare(i: number): void {
    const ty = this.types[this.type[i]];
    const a = (this.h[i] * Math.PI) / 180;
    const fx = Math.sin(a), fz = -Math.cos(a);
    const x = this.x[i], z = this.z[i];
    const hw = ty.wb * 0.5;
    const yf = this.net.surfaceY(x + fx * hw, z + fz * hw, -1);
    const yr = this.net.surfaceY(x - fx * hw, z - fz * hw, -1);
    const y = (yf + yr) * 0.5;
    this.y[i] = y;
    basisMatrix(this.mat, i * 16, x, y, z, fx, (yf - yr) / Math.max(1, ty.wb), fz);
    this.ready[i] = 1;
  }

  update(): void {
    if (!this.renderer) return;
    const ctx = this.ctx;
    const cam = ctx.camera.position;
    const agl = Math.max(0, ctx.cameraAGL);
    const q = ctx.settings.quality;
    const base = q === 'low' ? 260 : q === 'medium' ? 420 : 560;
    const R = clamp(base + agl * 1.6, base, base * 2.2);
    const moved = Math.hypot(cam.x - this.lastX, cam.z - this.lastZ);
    if (moved < 10 && Math.abs(R - this.lastR) < 40) return;
    this.lastX = cam.x; this.lastZ = cam.z; this.lastR = R;
    this.radius = R;
    const lod0 = q === 'low' ? 45 : 85;
    const lod1 = q === 'low' ? 120 : 210;
    const r2 = R * R, l2 = lod0 * lod0, l3 = lod1 * lod1;
    const Rn = this.renderer;
    Rn.begin();
    let cnt = 0;
    const c0x = Math.floor((cam.x - R) / CELL), c1x = Math.floor((cam.x + R) / CELL);
    const c0z = Math.floor((cam.z - R) / CELL), c1z = Math.floor((cam.z + R) / CELL);
    for (let gx = c0x; gx <= c1x; gx++) {
      for (let gz = c0z; gz <= c1z; gz++) {
        const l = this.grid.get(gx * 4096 + gz);
        if (!l) continue;
        for (const i of l) {
          const dx = this.x[i] - cam.x, dz = this.z[i] - cam.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2 || this.hidden.has(i)) continue;
          if (!this.ready[i]) this.prepare(i);
          const lod = d2 < l2 ? 0 : d2 < l3 ? 1 : 2;
          if (Rn.push(this.type[i], lod, this.mat, i * 16, this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2],
            this.data[i * 4], this.data[i * 4 + 1], this.data[i * 4 + 2], this.data[i * 4 + 3])) cnt++;
        }
      }
    }
    Rn.end();
    this.visible = cnt;
  }
}
