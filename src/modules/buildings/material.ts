// Building material: MeshStandardMaterial + procedural facade/roof shader
// injected with onBeforeCompile (chain-safe: other modules such as CSM may
// assign their own onBeforeCompile later; both run).
import * as THREE from 'three';
import { VERT_PARS, VERT_MAIN, FRAG_PARS, FRAG_SURFACE, LAMP_FN } from './shader';

export interface BuildingUniforms {
  uNoise: { value: THREE.Texture | null };
  uNight: { value: number };
  uDay: { value: number };
  uTime: { value: number };
  uLitFrac: { value: number };
  uSkyZenith: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
  uGroundRefl: { value: THREE.Color };
  uDetail: { value: number };
  uDetailDist: { value: number };
  /** ground height field (R32F, see HeightField.texture) + (half, res, n): street-lamp lighting */
  bHF: { value: THREE.Texture | null };
  bHFP: { value: THREE.Vector3 };
}

export function makeUniforms(): BuildingUniforms {
  return {
    uNoise: { value: null },
    uNight: { value: 0 },
    uDay: { value: 1 },
    uTime: { value: 0 },
    uLitFrac: { value: 0.5 },
    uSkyZenith: { value: new THREE.Color(0.25, 0.45, 0.85) },
    uSkyHorizon: { value: new THREE.Color(0.75, 0.82, 0.9) },
    uGroundRefl: { value: new THREE.Color(0.12, 0.12, 0.11) },
    uDetail: { value: 1 },
    uDetailDist: { value: 400 },
    bHF: { value: null },
    bHFP: { value: new THREE.Vector3(10240, 10, 2049) },
  };
}

type OBC = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => void;

/** Install `mine` as an onBeforeCompile that survives later assignments (they get chained after it). */
export function chainOnBeforeCompile(mat: THREE.Material, mine: OBC, key: string): void {
  let other: OBC | null = null;
  let depth = 0;
  const combined: OBC = (shader, renderer) => {
    // re-entrancy guard: a wrapper assigned later may call the previous value (this function)
    if (depth > 0) return;
    depth++;
    try {
      mine(shader, renderer);
      if (other) other(shader, renderer);
    } finally {
      depth--;
    }
  };
  Object.defineProperty(mat, 'onBeforeCompile', {
    configurable: true,
    enumerable: true,
    get: () => combined,
    set: (fn: OBC) => { other = fn === combined ? other : fn; },
  });
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${key}|${prevKey()}`;
}

function patch(shader: THREE.WebGLProgramParametersWithUniforms, u: BuildingUniforms, extra: Record<string, THREE.IUniform>): void {
  Object.assign(shader.uniforms, u, extra);
  let vs = shader.vertexShader;
  vs = vs.replace('#include <common>', `#include <common>\n${VERT_PARS}`);
  vs = vs.replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
  shader.vertexShader = vs;
  let fs = shader.fragmentShader;
  fs = fs.replace('#include <common>', `#include <common>\n${FRAG_PARS}\n${FRAG_SURFACE}`);
  fs = fs.replace('#include <map_fragment>', `#include <map_fragment>\n  bSurface();`);
  fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n  diffuseColor.rgb = bAlbedo;`);
  fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n  roughnessFactor = bRough;`);
  fs = fs.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n  metalnessFactor = bMetal;`);
  fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n  normal = normalize((viewMatrix * vec4(bN, 0.0)).xyz);`);
  fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance += bEmis;`);
  fs = fs.replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${LAMP_FN}`);
  fs = fs.replace('#include <lights_fragment_end>', `#ifdef BLD_LAMPS\n  bLamps(reflectedLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material);\n#endif\n#include <lights_fragment_end>`);
  fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= bAO;\n  reflectedLight.indirectSpecular *= mix(1.0, bAO, 0.5);`);
  shader.fragmentShader = fs;
}

export function createBuildingMaterial(u: BuildingUniforms, extra: Record<string, THREE.IUniform> = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0, envMapIntensity: 1.0 });
  mat.name = 'buildings';
  chainOnBeforeCompile(mat, (shader) => patch(shader, u, extra), 'nev-buildings-v2');
  return mat;
}

/**
 * Street-lamp light on facades at night: share the roads module's lamp grid
 * (roads.lampMap / roads.uniforms, see src/modules/roads/materials.ts rsLamps)
 * and switch the BLD_LAMPS variant on. Returns false if the roads service lacks it.
 */
export function enableStreetLamps(mat: THREE.MeshStandardMaterial, extra: Record<string, THREE.IUniform>, roads: any): boolean {
  const ru = roads?.uniforms;
  if (!ru?.rsLamp || !ru.rsLampP) return false;
  for (const k of ['rsLamp', 'rsLampP', 'rsLampCol0', 'rsLampCol1', 'rsLampI', 'rsReal']) {
    if (!ru[k]) return false;
    extra[k] = ru[k];
  }
  mat.defines = { ...(mat.defines ?? {}), BLD_LAMPS: 1 };
  mat.needsUpdate = true;
  return true;
}

/** Tileable noise texture (RGBA: low / mid / grain / streaks) from raw 512x512 RGBA8 bytes. */
export function noiseTexture(buf: ArrayBuffer): THREE.Texture {
  const n = Math.round(Math.sqrt(buf.byteLength / 4));
  const t = new THREE.DataTexture(new Uint8Array(buf), n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
