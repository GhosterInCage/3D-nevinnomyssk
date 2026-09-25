// Shader patches shared by all vegetation materials: wind, LOD cross-fade dithering and
// foliage translucency. Materials stay MeshStandardMaterial (lights, CSM shadows, fog work).
import * as THREE from 'three';

/** Uniform objects shared by every vegetation material (updated once per frame). */
export const VU = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector2(2.5, -1.2) },
  uCamPos: { value: new THREE.Vector3() },
};

export const GLSL_COMMON = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uCamPos;
float vegHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// World-space wind displacement for a vertex at offset 'rel' (world units, from the tree base)
// with per-vertex weights w = (branch flex, phase, leaf flutter); 'origin' = tree base; treeH in m.
vec3 vegWind(vec3 rel, vec3 w, vec3 origin, float treeH, float stiff) {
  float spd = length(uWind);
  vec2 dir = spd > 1e-3 ? uWind / spd : vec2(1.0, 0.0);
  float ph = vegHash12(origin.xz) * 6.2832;
  float t = uTime;
  // gusts travelling downwind
  float gust = 0.6 + 0.4 * sin(dot(origin.xz, dir) * 0.035 - t * (0.6 + spd * 0.15) + ph * 0.2)
                   * sin(dot(origin.xz, vec2(-dir.y, dir.x)) * 0.021 + t * 0.37);
  float s = spd * gust * stiff;
  float hN = clamp(rel.y / max(treeH, 0.5), 0.0, 1.3);
  float bend = s * 0.0045 * hN * hN * treeH;
  vec3 d = vec3(dir.x, 0.0, dir.y) * bend * (0.75 + 0.25 * sin(t * 1.1 + ph));
  d += vec3(-dir.y, 0.0, dir.x) * bend * 0.25 * sin(t * 1.7 + ph * 1.3);
  d.y -= bend * bend / max(treeH, 1.0) * 0.5;
  // branches
  float bp = w.y * 6.2832 + ph;
  d += (vec3(dir.x, 0.25, dir.y) * sin(t * 1.9 + bp) + vec3(0.3, 0.0, -0.4) * sin(t * 2.7 + bp * 1.7)) * w.x * s * 0.028;
  // leaf flutter
  float fl = w.z * (0.012 + s * 0.006);
  d += vec3(sin(t * 7.3 + bp * 5.0 + rel.x * 2.1), sin(t * 9.1 + rel.y * 3.0) * 0.6, cos(t * 8.2 + bp * 3.0 + rel.z * 2.3)) * fl;
  return d;
}
float vegIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

/** Foliage lighting: adds back-lit transmission to every direct light (shadowed like the diffuse term). */
export const GLSL_TRANSLUCENT = /* glsl */ `
uniform float uTransl;
void RE_Direct_Veg( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float back = saturate( dot( -geometryNormal, directLight.direction ) );
  float fwd = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 5.0 );
  float wrap = saturate( dot( geometryNormal, directLight.direction ) * 0.5 + 0.5 );
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor * uTransl * ( 0.22 * back + 0.85 * fwd + 0.08 * wrap );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Veg
`;

/**
 * Install `patch` as onBeforeCompile in a way that survives other modules overwriting
 * material.onBeforeCompile (e.g. CSM.setupMaterial): later assignments are chained after ours.
 */
export function protectOnBeforeCompile(mat: THREE.Material, patch: (shader: any, renderer: THREE.WebGLRenderer) => void, cacheKey: string): void {
  let external: ((s: any, r: THREE.WebGLRenderer) => void) | null = null;
  const chained = (shader: any, renderer: THREE.WebGLRenderer) => {
    if (!shader.__vegPatched) {
      shader.__vegPatched = true;
      patch(shader, renderer);
    }
    if (external && external !== chained) external(shader, renderer);
  };
  Object.defineProperty(mat, 'onBeforeCompile', {
    configurable: true,
    get: () => chained,
    set: (f) => { if (f !== chained) external = f; },
  });
  mat.customProgramCacheKey = () => `veg:${cacheKey}:${external ? external.toString().length : 0}`;
}

export interface TreeMatOpts {
  leaves: boolean;
  modelH: number;
  stiff?: number;
  translucency?: number;
  fade: { value: THREE.Vector4 };
}

/** Vertex + fragment patch for instanced tree parts (bark or leaves) and their depth material. */
export function patchTree(shader: any, o: TreeMatOpts, depth: boolean): void {
  shader.uniforms.uTime = VU.uTime;
  shader.uniforms.uWind = VU.uWind;
  shader.uniforms.uCamPos = VU.uCamPos;
  shader.uniforms.uFade = o.fade;
  shader.uniforms.uModelH = { value: o.modelH };
  shader.uniforms.uStiff = { value: o.stiff ?? 1 };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
${GLSL_COMMON}
uniform vec4 uFade;
uniform float uModelH;
uniform float uStiff;
attribute vec3 wind;
varying vec2 vVegFade;
varying float vVegTint;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vVegFade = vec2(1.0);
vVegTint = 0.5;
#ifdef USE_INSTANCING
{
  vec3 iO = instanceMatrix[3].xyz;
  vVegTint = vegHash12(iO.xz + 7.1);
  mat3 iM = mat3(instanceMatrix);
  vec3 s2 = vec3(dot(iM[0], iM[0]), dot(iM[1], iM[1]), dot(iM[2], iM[2]));
  vec3 sc = sqrt(s2);
  float treeH = uModelH * sc.y;
  vec3 dW = vegWind(transformed * sc, wind, iO, treeH, uStiff);
  transformed += (transpose(iM) * dW) / s2;
  float dd = distance(iO + vec3(0.0, treeH * 0.5, 0.0), uCamPos);
  vVegFade = vec2(uFade.y > 0.0 ? clamp((dd - uFade.x) / max(uFade.y - uFade.x, 1e-3), 0.0, 1.0) : 1.0,
                  uFade.w > 0.0 ? 1.0 - clamp((dd - uFade.z) / max(uFade.w - uFade.z, 1e-3), 0.0, 1.0) : 1.0);
}
#endif`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec2 vVegFade;
varying float vVegTint;
float vegIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
{ float vn = vegIGN(gl_FragCoord.xy); if ((1.0 - vn) > vVegFade.x || vn >= vVegFade.y) discard; }`)
    .replace('#include <alphatest_fragment>', `#ifdef USE_MAP
{ vec2 mdx = dFdx(vMapUv * 2048.0), mdy = dFdy(vMapUv * 2048.0); float ml = 0.5 * log2(max(max(dot(mdx, mdx), dot(mdy, mdy)), 1e-6)); diffuseColor.a *= 1.0 + max(0.0, ml) * 0.22; }
#endif
#include <alphatest_fragment>`);
  if (!depth) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
{ float tj = vVegTint - 0.5; diffuseColor.rgb *= (1.0 + tj * 0.18) * vec3(1.0 + tj * 0.06, 1.0, 1.0 - tj * 0.06); }`);
  }
  if (!depth && o.leaves) {
    shader.uniforms.uTransl = { value: o.translucency ?? 0.5 };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
${GLSL_TRANSLUCENT}`)
      .replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;');
  }
}

export function makeTreeMaterials(opts: {
  leaves: boolean; map: THREE.Texture | null; normalMap?: THREE.Texture | null; color: THREE.Color;
  roughness: number; modelH: number; stiff?: number; translucency?: number; fade: { value: THREE.Vector4 }; key: string;
}): { mat: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const mat = new THREE.MeshStandardMaterial({
    map: opts.map,
    normalMap: opts.normalMap ?? null,
    color: opts.color,
    roughness: opts.roughness,
    metalness: 0,
    vertexColors: true,
    side: opts.leaves ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: opts.leaves ? 0.42 : 0,
    envMapIntensity: 0.6,
  });
  if (opts.normalMap) mat.normalScale.set(1.2, 1.2);
  const o: TreeMatOpts = { leaves: opts.leaves, modelH: opts.modelH, stiff: opts.stiff, translucency: opts.translucency, fade: opts.fade };
  protectOnBeforeCompile(mat, (s) => patchTree(s, o, false), `tree-${opts.leaves ? 'leaf' : 'bark'}`);
  const depth = new THREE.MeshDepthMaterial({ map: opts.leaves ? opts.map : null, alphaTest: opts.leaves ? 0.42 : 0, side: opts.leaves ? THREE.DoubleSide : THREE.FrontSide });
  protectOnBeforeCompile(depth, (s) => patchTree(s, o, true), `tree-depth-${opts.leaves ? 'leaf' : 'bark'}`);
  return { mat, depth };
}
