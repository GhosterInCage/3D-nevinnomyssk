// Ground material: MeshStandardMaterial patched with the CDLOD vertex stage and the splatted
// ground shader, so lights, shadows (incl. CSM), fog and tone mapping keep working.
import * as THREE from 'three';
import { FRAG_AO, FRAG_MAIN, FRAG_NORMAL, FRAG_PARS, FRAG_ROUGH, VERT_MAIN, VERT_PARS } from './shaders';

export type Uniforms = Record<string, THREE.IUniform>;

/**
 * Make `material.onBeforeCompile` robust against other modules assigning their own hook
 * (e.g. CSM.setupMaterial replaces it): our patch always runs first, then whatever was
 * assigned later. Re-entrant calls (a wrapper calling the previous hook) are ignored.
 */
export function lockOnBeforeCompile(mat: THREE.Material, base: (s: any, r: THREE.WebGLRenderer) => void): void {
  const extra: Array<(s: any, r: THREE.WebGLRenderer) => void> = [];
  let busy = false;
  const combined = function (this: unknown, s: any, r: THREE.WebGLRenderer) {
    if (busy) return;
    busy = true;
    try {
      base(s, r);
      for (const f of extra) f.call(mat, s, r);
    } finally { busy = false; }
  };
  Object.defineProperty(mat, 'onBeforeCompile', {
    configurable: true,
    get: () => combined,
    set: (f) => { if (typeof f === 'function' && f !== combined && !extra.includes(f)) extra.push(f); },
  });
}

function patchVertex(shader: THREE.WebGLProgramParametersWithUniforms, micro: boolean): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${micro ? '#define TERRAIN_MICRO\n' : ''}${VERT_PARS}`)
    .replace('#include <beginnormal_vertex>', VERT_MAIN)
    .replace('#include <begin_vertex>', 'vec3 transformed = terrainPos;');
}

export function createGroundMaterial(uniforms: Uniforms, defines: Record<string, number | string>): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 });
  mat.name = 'terrain-ground';
  mat.defines = { ...(mat.defines ?? {}), ...defines };
  lockOnBeforeCompile(mat, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchVertex(shader, true);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <map_fragment>', FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <aomap_fragment>', FRAG_AO);
  });
  mat.customProgramCacheKey = () => 'terrain-ground-v1';
  return mat;
}

/** Depth material for shadow maps with the same vertex displacement. */
export function createDepthMaterial(uniforms: Uniforms, defines: Record<string, number | string>): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.name = 'terrain-depth';
  mat.defines = { ...(mat.defines ?? {}), ...defines };
  lockOnBeforeCompile(mat, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `${VERT_MAIN.replace('vec3 objectNormal', 'vec3 tObjN')}\nvec3 transformed = terrainPos;`);
  });
  mat.customProgramCacheKey = () => 'terrain-depth-v1';
  return mat;
}
