// Terrain proxy for the path tracer: nested square LOD rings centred on the
// camera, sampled from the terrain module's rendered (bicubic) surface.
// Ring k has spacing s0*2^k and half-size n*s0*2^k; each ring skips the cells
// covered by the previous one. The outer border of every ring interpolates its
// odd vertices from the even ones, which coincide with the next (coarser)
// ring's vertices, so there are no T-junction cracks for rays to leak through.
// The surface is dropped by a few cm (more on coarse rings) so draped road
// layers never get pierced by the linear interpolation of a bicubic surface.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import type { PTSrcGeo } from '../../workers/pathtracer-build.worker';
import { nextFrame } from './gather';

export interface TerrainProxyParams {
  /** finest spacing (m) */
  s0: number;
  /** half-size of every ring in cells of its own spacing (even) */
  n: number;
  /** camera position (world) */
  center: THREE.Vector3;
  /** re-centring offset */
  origin: THREE.Vector3;
  /** stop adding rings beyond this distance (m) */
  extent: number;
  sliceMs: number;
  /** optional high-resolution albedo bake: cells inside it use this material and local uv */
  bake?: { x0: number; z0: number; size: number; material: THREE.Material } | null;
}

export interface TerrainPart { geo: PTSrcGeo; material: THREE.Material }

export interface TerrainProxy {
  parts: TerrainPart[];
  /** the macro (10 m albedo) material */
  macroMaterial: THREE.Material;
  triangles: number;
  rings: number;
}

/** Terrain module's proxy material (ground albedo map) or a plain fallback. */
export function terrainMacroMaterial(ctx: AppContext, center: THREE.Vector3): THREE.Material {
  const terrain = ctx.get<any>('terrain');
  try {
    if (terrain && typeof terrain.pathTraceProxy === 'function') {
      const m = terrain.pathTraceProxy(new THREE.Vector3(center.x, 0, center.z), 1, 10) as THREE.Mesh;
      m.geometry.dispose();
      return m.material as THREE.Material;
    }
  } catch (e) {
    console.warn('[pathtracer] terrain proxy material', e);
  }
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(0.2, 0.19, 0.14), roughness: 0.95 });
}

function split(pos: number[], nrm: number[], uv: number[], idx: number[], uvFn: ((x: number, z: number) => [number, number]) | null): PTSrcGeo {
  const remap = new Map<number, number>();
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
  for (const v of idx) {
    let r = remap.get(v);
    if (r === undefined) {
      r = P.length / 3;
      remap.set(v, r);
      P.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
      N.push(nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]);
      if (uvFn) { const t = uvFn(pos[3 * v], pos[3 * v + 2]); U.push(t[0], t[1]); } else U.push(uv[2 * v], uv[2 * v + 1]);
    }
    I.push(r);
  }
  return { pos: new Float32Array(P), nrm: new Float32Array(N), uv: new Float32Array(U), col: null, idx: new Uint32Array(I), tan: false };
}

export async function buildTerrainProxy(ctx: AppContext, p: TerrainProxyParams, onProgress?: (f: number) => void): Promise<TerrainProxy | null> {
  const hf = ctx.heightfield;
  if (!hf) return null;
  const terrain = ctx.get<any>('terrain');
  const heightAt: (x: number, z: number) => number = terrain && typeof terrain.heightAt === 'function'
    ? (x, z) => { const h = terrain.heightAt(x, z); return Number.isFinite(h) ? h : hf.sample(x, z); }
    : (x, z) => hf.sample(x, z);
  const half = hf.half;
  const size = 2 * half;
  const n = Math.max(8, p.n & ~1);

  const material = terrainMacroMaterial(ctx, p.center);
  const bake = p.bake ?? null;
  const idxNear: number[] = [];

  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let rings = 0;
  let prev: { x0: number; z0: number; x1: number; z1: number } | null = null;
  let t0 = performance.now();
  const ox = p.origin.x, oy = p.origin.y, oz = p.origin.z;
  const maxRings = 12;
  for (let k = 0; k < maxRings; k++) {
    const s = p.s0 * Math.pow(2, k);
    const R = n * s;
    // snap the ring centre to twice its spacing so holes align with the next ring's grid
    const cx = Math.round(p.center.x / (2 * s)) * 2 * s;
    const cz = Math.round(p.center.z / (2 * s)) * 2 * s;
    const x0 = cx - R, z0 = cz - R;
    const N = 2 * n; // cells per side
    // region clip
    const inRegion = (x: number, z: number) => x >= -half - 1e-3 && x <= half + 1e-3 && z >= -half - 1e-3 && z <= half + 1e-3;
    const vid = new Int32Array((N + 1) * (N + 1)).fill(-1);
    const cellUsed = (i: number, j: number): boolean => {
      const xa = x0 + i * s, xb = xa + s, za = z0 + j * s, zb = za + s;
      if (xb <= -half || xa >= half || zb <= -half || za >= half) return false;
      if (prev && xa >= prev.x0 - 1e-6 && xb <= prev.x1 + 1e-6 && za >= prev.z0 - 1e-6 && zb <= prev.z1 + 1e-6) return false;
      return true;
    };
    const drop = 0.03 + 0.012 * s;
    const vertex = (i: number, j: number): number => {
      const key = j * (N + 1) + i;
      let v = vid[key];
      if (v >= 0) return v;
      let x = x0 + i * s, z = z0 + j * s;
      x = Math.min(half, Math.max(-half, x)); z = Math.min(half, Math.max(-half, z));
      let y: number;
      const onBorder = i === 0 || i === N || j === 0 || j === N;
      if (onBorder && ((i === 0 || i === N) ? (j & 1) : (i & 1))) {
        // odd vertex on the outer border: interpolate along the edge (matches the coarser ring)
        const along = (i === 0 || i === N) ? [[i, j - 1], [i, j + 1]] : [[i - 1, j], [i + 1, j]];
        const ya = heightAt(Math.min(half, Math.max(-half, x0 + along[0][0] * s)), Math.min(half, Math.max(-half, z0 + along[0][1] * s)));
        const yb = heightAt(Math.min(half, Math.max(-half, x0 + along[1][0] * s)), Math.min(half, Math.max(-half, z0 + along[1][1] * s)));
        y = 0.5 * (ya + yb);
      } else {
        y = heightAt(x, z);
      }
      // the next ring's drop applies to the shared border so seams stay closed
      const dropHere = onBorder ? 0.03 + 0.012 * 2 * s : drop;
      v = pos.length / 3;
      pos.push(x - ox, y - dropHere - oy, z - oz);
      // normal from the bicubic surface
      const e = Math.max(0.5, s * 0.5);
      const hx = heightAt(x + e, z) - heightAt(x - e, z);
      const hz = heightAt(x, z + e) - heightAt(x, z - e);
      const nl = Math.hypot(hx, 2 * e, hz);
      nrm.push(-hx / nl, (2 * e) / nl, -hz / nl);
      uv.push((x + half) / size, 1 - (z + half) / size);
      vid[key] = v;
      return v;
    };
    let any = false;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (!cellUsed(i, j)) continue;
        const xa = x0 + i * s, za = z0 + j * s;
        if (!inRegion(Math.max(-half, xa), Math.max(-half, za)) && !inRegion(Math.min(half, xa + s), Math.min(half, za + s))) continue;
        const a = vertex(i, j), b = vertex(i + 1, j), c = vertex(i, j + 1), d = vertex(i + 1, j + 1);
        // cells fully inside the albedo bake go to the "near" part
        const inBake = !!bake && xa >= bake.x0 && xa + s <= bake.x0 + bake.size && za >= bake.z0 && za + s <= bake.z0 + bake.size;
        const out = inBake ? idxNear : idx;
        // alternate the diagonal for a more isotropic surface
        if ((i + j) & 1) { out.push(a, c, b, b, c, d); } else { out.push(a, c, d, a, d, b); }
        any = true;
      }
      if (performance.now() - t0 > p.sliceMs) { onProgress?.((k + j / N) / maxRings); await nextFrame(); t0 = performance.now(); }
    }
    if (any) rings++;
    prev = { x0, z0, x1: x0 + N * s, z1: z0 + N * s };
    // stop when the ring covers the whole region (or the requested extent)
    const coversRegion = prev.x0 <= -half && prev.z0 <= -half && prev.x1 >= half && prev.z1 >= half;
    if (coversRegion || R >= p.extent) break;
  }
  // (a, c, d) with +z down the rows is counter-clockwise seen from above: faces point up
  const parts: TerrainPart[] = [];
  if (idx.length) parts.push({ geo: split(pos, nrm, uv, idx, null), material });
  if (bake && idxNear.length) {
    const bx = bake.x0 - ox, bz = bake.z0 - oz, bs = bake.size;
    // bake texel rows run from the south edge (v = 0) to the north edge (v = 1)
    parts.push({ geo: split(pos, nrm, uv, idxNear, (x, z) => [(x - bx) / bs, 1 - (z - bz) / bs]), material: bake.material });
  }
  return { parts, macroMaterial: material, triangles: (idx.length + idxNear.length) / 3, rings };
}
