// CPU-side terrain queries that match the GPU surface (Catmull-Rom bicubic over the shared
// HeightField) and the ground-class map.
import * as THREE from 'three';
import type { HeightField } from '../../core/heightfield';

export const GROUND_CLASSES = ['grass', 'crop', 'stubble', 'ploughed', 'bare', 'gravel', 'forest', 'urban',
  'pebbles', 'mud', 'sand', 'rock'] as const;
export type GroundType = (typeof GROUND_CLASSES)[number] | 'water' | 'outside';

function cr(t: number, out: number[]): void {
  const t2 = t * t, t3 = t2 * t;
  out[0] = -0.5 * t3 + t2 - 0.5 * t;
  out[1] = 1.5 * t3 - 2.5 * t2 + 1.0;
  out[2] = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
  out[3] = 0.5 * t3 - 0.5 * t2;
}
function crd(t: number, out: number[]): void {
  const t2 = t * t;
  out[0] = -1.5 * t2 + 2.0 * t - 0.5;
  out[1] = 4.5 * t2 - 5.0 * t;
  out[2] = -4.5 * t2 + 4.0 * t + 0.5;
  out[3] = 1.5 * t2 - t;
}

const wx = [0, 0, 0, 0], wz = [0, 0, 0, 0], dx = [0, 0, 0, 0], dz = [0, 0, 0, 0];

export class TerrainSampler {
  constructor(readonly hf: HeightField, public classData: Uint8Array | null = null, public classN = 0,
              public isWater: ((x: number, z: number) => boolean) | null = null) {}

  /** Bicubic (Catmull-Rom) height; equals HeightField.sample at grid samples. */
  heightAt(x: number, z: number): number {
    return this.eval(x, z, null);
  }

  /** Unit normal of the rendered (bicubic) surface. */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const g = [0, 0];
    this.eval(x, z, g);
    return out.set(-g[0], 1, -g[1]).normalize();
  }

  private eval(x: number, z: number, grad: number[] | null): number {
    const hf = this.hf, n = hf.n, d = hf.data;
    let gx = (x + hf.half) / hf.res, gz = (z + hf.half) / hf.res;
    const mx = n - 1.001;
    gx = gx < 0 ? 0 : gx > mx ? mx : gx;
    gz = gz < 0 ? 0 : gz > mx ? mx : gz;
    const fx = Math.floor(gx), fz = Math.floor(gz);
    const tx = gx - fx, tz = gz - fz;
    cr(tx, wx); cr(tz, wz);
    if (grad) { crd(tx, dx); crd(tz, dz); }
    let h = 0, ggx = 0, ggz = 0;
    const last = n - 1;
    for (let j = 0; j < 4; j++) {
      let jj = fz - 1 + j; jj = jj < 0 ? 0 : jj > last ? last : jj;
      const row = jj * n;
      let rv = 0, rd = 0;
      for (let i = 0; i < 4; i++) {
        let ii = fx - 1 + i; ii = ii < 0 ? 0 : ii > last ? last : ii;
        const v = d[row + ii];
        rv += v * wx[i];
        if (grad) rd += v * dx[i];
      }
      h += rv * wz[j];
      if (grad) { ggx += rd * wz[j]; ggz += rv * dz[j]; }
    }
    if (grad) { grad[0] = ggx / hf.res; grad[1] = ggz / hf.res; }
    return h;
  }

  /** Ground class index (see GROUND_CLASSES) or -1 outside the class map. */
  classAt(x: number, z: number): number {
    if (!this.classData || !this.classN) return -1;
    const hf = this.hf;
    const u = (x + hf.half) / hf.size, v = (z + hf.half) / hf.size;
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return -1;
    const n = this.classN;
    return this.classData[Math.floor(v * n) * n + Math.floor(u * n)] & 15;
  }

  groundTypeAt(x: number, z: number): GroundType {
    if (!this.hf.inBounds(x, z)) return 'outside';
    if (this.isWater && this.isWater(x, z)) return 'water';
    const c = this.classAt(x, z);
    return c >= 0 && c < GROUND_CLASSES.length ? GROUND_CLASSES[c] : 'grass';
  }
}
