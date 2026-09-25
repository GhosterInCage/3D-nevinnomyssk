// Loading of terrain assets: macro textures, ground-class map, detail texture arrays.
import * as THREE from 'three';
import { dataUrl, fetchBuffer, fetchJSON } from '../../core/data';

export interface LayerInfo { name: string; tile: number; mean: [number, number, number]; rough: number }
export interface LayersJson { size: number; layers: LayerInfo[] }

const TEX_BASE = `${import.meta.env.BASE_URL}textures/terrain/`;

export async function loadTexture(path: string, srgb: boolean, anisotropy = 8): Promise<THREE.Texture> {
  const t = await new THREE.TextureLoader().loadAsync(dataUrl(path));
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Ground class map: uint8 n x n, low nibble = class, high nibble = orientation / variant. */
export async function loadClassMap(path: string, n: number): Promise<{ data: Uint8Array; tex: THREE.DataTexture }> {
  const buf = await fetchBuffer(path);
  const data = new Uint8Array(buf);
  if (data.length !== n * n) throw new Error(`class map size ${data.length} != ${n * n}`);
  const tex = new THREE.DataTexture(data, n, n, THREE.RedIntegerFormat, THREE.UnsignedByteType);
  tex.internalFormat = 'R8UI';
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return { data, tex };
}

async function decode(url: string, size: number): Promise<Uint8ClampedArray> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, {
    colorSpaceConversion: 'none', premultiplyAlpha: 'none', resizeWidth: size, resizeHeight: size, resizeQuality: 'high',
  });
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = (c as any).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  return g.getImageData(0, 0, size, size).data;
}

/** Packs per-layer images into a mip-mapped 2D texture array. */
export async function loadLayerArray(prefix: string, count: number, size: number, srgb: boolean): Promise<THREE.DataArrayTexture> {
  const data = new Uint8Array(size * size * 4 * count);
  await Promise.all(Array.from({ length: count }, async (_, k) => {
    const px = await decode(`${TEX_BASE}${prefix}_${k}.webp`, size);
    data.set(px, k * size * size * 4);
  }));
  const t = new THREE.DataArrayTexture(data, size, size, count);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export async function loadLayersJson(): Promise<LayersJson> {
  const res = await fetch(`${TEX_BASE}layers.json`);
  if (!res.ok) throw new Error(`layers.json: ${res.status}`);
  return (await res.json()) as LayersJson;
}

export { fetchJSON };
