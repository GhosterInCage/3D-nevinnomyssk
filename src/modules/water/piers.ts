// Foam wakes + bow waves at bridge piers standing in flowing water.
//
// Pier positions come from the roads module's published data (public/data/roads/objects.json.gz,
// bridges[].piers[] = {x, z, nx, nz, w0, w1}); the file is optional and parsed defensively. For
// every pier inside flowing water a small strip is laid on the water surface along the local
// current: a white-water cushion upstream of the pier and a V-shaped foam wake that spreads and
// breaks up downstream, advected with the flow speed.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { fetchJSON } from '../../core/data';

interface PierRec { x: number; z: number; nx?: number; nz?: number; w0?: number; w1?: number }

interface Query {
  levelAt(x: number, z: number): number | null;
  flowAt(x: number, z: number): { x: number; z: number } | null;
}

const WAKE_VERT = /* glsl */ `
attribute vec3 aWake;     // strip width (m), strip length (m), flow speed (m/s)
attribute vec3 aPier;     // nose, tail (fraction of the strip length), pier half width (fraction of strip width)
varying vec3 vWake;
varying vec3 vPier;
varying vec2 vWUv;
varying vec3 vWWorld;
`;

const WAKE_FRAG = /* glsl */ `
uniform float uTime;
uniform sampler2D tFoam;
uniform sampler2D tNoise;
varying vec3 vWake;
varying vec3 vPier;
varying vec2 vWUv;
varying vec3 vWWorld;
`;

const WAKE_ALPHA = /* glsl */ `
{
  float along = vWUv.y;
  float across = (vWUv.x - 0.5) * 2.0;        // -1..1
  float t0 = vPier.x, t1 = vPier.y, ph = vPier.z;
  // bow cushion at the nose, foam lines hugging the pier sides, spreading wake behind the tail
  float bow = exp(-pow((along - t0) / 0.035, 2.0)) * (1.0 - smoothstep(ph + 0.1, ph + 0.45, abs(across)));
  float onPier = step(t0, along) * step(along, t1);
  float sides = onPier * exp(-pow((abs(across) - ph - 0.04) / 0.07, 2.0));
  float d = clamp((along - t1) / max(1.0 - t1, 0.05), 0.0, 1.0);
  float behind = step(t1, along);
  float spread = ph + 0.05 + 0.8 * d;
  float arms = exp(-pow((abs(across) - spread * 0.85) / (0.08 + 0.25 * d), 2.0)) * behind;
  float core = (1.0 - smoothstep(0.0, spread, abs(across))) * behind * exp(-d * 2.4);
  float shape = max(max(bow, sides * 0.9), max(arms * 0.75, core));
  float fade = (1.0 - smoothstep(0.55, 1.0, d * behind + (1.0 - behind) * 0.0)) * smoothstep(0.0, 0.05, along);
  float w = vWake.x, L = vWake.y, spd = vWake.z;
  vec2 fuv = vec2(across * w * 0.5 / 1.6, (along * L - uTime * spd) / 4.2);
  float f = texture2D(tFoam, fuv).r * 0.7 + texture2D(tFoam, fuv * 2.3 + 0.37).r * 0.45;
  float n = texture2D(tNoise, vWWorld.xz / 17.0 - vec2(0.0, uTime * 0.02)).g;
  float amt = shape * fade * (0.55 + 0.6 * n);
  float thr = 0.70 * exp(-2.3 * pow(clamp(amt, 0.0, 0.95), 0.8));
  diffuseColor.a *= smoothstep(thr - 0.03, thr + 0.08, f) * clamp(amt * 3.0, 0.0, 1.0);
  if (diffuseColor.a < 0.01) discard;
}
`;

export async function buildPierWakes(ctx: AppContext, q: Query, tex: { foam: THREE.Texture; noise: THREE.Texture },
  time: { value: number }): Promise<THREE.Mesh | null> {
  let piers: PierRec[] = [];
  try {
    const o = await fetchJSON<any>('roads/objects.json.gz');
    for (const b of o?.bridges ?? []) for (const p of b?.piers ?? []) {
      if (Number.isFinite(p?.x) && Number.isFinite(p?.z)) piers.push(p);
    }
  } catch {
    return null;   // roads data not built / not present
  }
  if (!piers.length) return null;
  const pos: number[] = [], uv: number[] = [], wake: number[] = [], pier: number[] = [], idx: number[] = [];
  const SEG = 14;
  let count = 0;
  for (const p of piers) {
    // pier wall: from P + n*w0 to P + n*w1 (roads module convention), ~1.8 m thick
    const nx = Number.isFinite(p.nx) ? p.nx! : 0, nz = Number.isFinite(p.nz) ? p.nz! : 0;
    const w0 = Number.isFinite(p.w0) ? p.w0! : 0, w1 = Number.isFinite(p.w1) ? p.w1! : 0;
    const cx = p.x + nx * (w0 + w1) * 0.5, cz = p.z + nz * (w0 + w1) * 0.5;
    const lvl = q.levelAt(cx, cz);
    if (lvl === null) continue;
    const f = q.flowAt(cx, cz);
    const spd = f ? Math.hypot(f.x, f.z) : 0;
    if (!f || spd < 0.25) continue;
    const dx = f.x / spd, dz = f.z / spd;           // downstream
    const px = -dz, pz = dx;                          // across
    const halfLen = Math.abs(w1 - w0) * 0.5;
    const along = Math.abs(nx * dx + nz * dz) * halfLen + 0.9;      // pier half extent along the flow
    const acrossHalf = Math.abs(nx * px + nz * pz) * halfLen + 0.9; // pier half extent across the flow
    const wakeL = 16 + 20 * Math.min(spd, 2.5);
    const W = 2 * acrossHalf + 6 + 3 * Math.min(spd, 2.5);
    const a0 = -along - 4, a1 = along + wakeL;          // strip extent along the flow (m)
    const L = a1 - a0;
    const t0 = (-along - a0) / L, t1 = (along - a0) / L;
    const base = pos.length / 3;
    for (let k = 0; k <= SEG; k++) {
      const t = k / SEG;
      const a = a0 + t * L;
      const grow = Math.max(0, (a - along) / wakeL);
      const halfW = (W * 0.5) * (0.55 + 0.45 * grow);
      for (const side of [-1, 1]) {
        const x = cx + dx * a + px * halfW * side;
        const z = cz + dz * a + pz * halfW * side;
        const l = q.levelAt(x, z) ?? lvl;
        pos.push(x, l + 0.04, z);
        uv.push(side < 0 ? 0 : 1, t);
        wake.push(W, L, spd);
        pier.push(t0, t1, acrossHalf / (W * 0.5));
      }
      if (k < SEG) {
        const i0 = base + k * 2;
        idx.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
      }
    }
    count++;
  }
  if (!count) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aWake', new THREE.Float32BufferAttribute(wake, 3));
  g.setAttribute('aPier', new THREE.Float32BufferAttribute(pier, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xdcdcd4, roughness: 0.65, metalness: 0, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  mat.name = 'water-pier-wake';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.tFoam = { value: tex.foam };
    shader.uniforms.tNoise = { value: tex.noise };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WAKE_VERT}`)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWake = aWake; vPier = aPier; vWUv = uv; vWWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WAKE_FRAG}`)
      .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>\n${WAKE_ALPHA}`);
  };
  mat.customProgramCacheKey = () => 'water-pier-wake-v1';
  ctx.registerMaterial(mat);
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'water-pier-wakes';
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  mesh.userData.noPathTrace = true;
  console.info(`[water] ${count} pier wakes`);
  return mesh;
}
