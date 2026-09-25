// Procedural helper textures generated at start-up (no downloads).
import * as THREE from 'three';
import type { HeightField } from '../../core/heightfield';

/** RG8 world-space normal (x, z) of the height field at every sample (central differences). */
export function buildNormalMap(hf: HeightField, tex?: THREE.DataTexture): THREE.DataTexture {
  const n = hf.n, d = hf.data, inv = 1 / (2 * hf.res);
  const out = (tex?.image.data as Uint8Array) ?? new Uint8Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    const jm = j > 0 ? j - 1 : 0, jp = j < n - 1 ? j + 1 : n - 1;
    for (let i = 0; i < n; i++) {
      const im = i > 0 ? i - 1 : 0, ip = i < n - 1 ? i + 1 : n - 1;
      const gx = (d[j * n + ip] - d[j * n + im]) * inv * (2 / Math.max(1, ip - im));
      const gz = (d[jp * n + i] - d[jm * n + i]) * inv * (2 / Math.max(1, jp - jm));
      const l = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      const k = (j * n + i) * 2;
      out[k] = Math.round((-gx * l * 0.5 + 0.5) * 255);
      out[k + 1] = Math.round((-gz * l * 0.5 + 0.5) * 255);
    }
  }
  if (tex) { tex.needsUpdate = true; return tex; }
  const t = new THREE.DataTexture(out, n, n, THREE.RGFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.unpackAlignment = 1;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 256^2 RGBA tiling value noise (4 independent channels, 2 octaves). */
export function buildNoiseTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const rnd = mulberry32(1234567);
  const octave = (cells: number) => {
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return (x: number, y: number) => {
      const fx = (x / size) * cells, fy = (y / size) * cells;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const at = (a: number, b: number) => g[((b + cells) % cells) * cells + ((a + cells) % cells)];
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
      return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    };
  };
  for (let ch = 0; ch < 4; ch++) {
    const o1 = octave(32), o2 = octave(64);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = (o1(x, y) * 0.68 + o2(x, y) * 0.32);
        data[(y * size + x) * 4 + ch] = Math.round(Math.min(1, Math.max(0, (v - 0.5) * 1.35 + 0.5)) * 255);
      }
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
