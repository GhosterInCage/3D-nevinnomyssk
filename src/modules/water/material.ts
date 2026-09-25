// Water surface material: MeshPhysicalMaterial (so the scene lights, shadows/CSM, fog, the
// environment map and IBL all keep working) patched with onBeforeCompile:
//   * animated world-space normals: two-phase flow-map advection of FFT ripple maps along the
//     per-vertex flow velocity, wind-driven gravity waves (direction/fetch/exposure), rain rings
//   * depth from the terrain height field -> Beer-Lambert absorption along the refracted view path,
//     body-specific in-scatter colour (turbid glacial Kuban, greener canal, dark ponds, milky
//     industrial ponds), soft shorelines
//   * foam / white water from baked turbulence (weir, riffles, gravel bars), speed and shallow depth
//   * Fresnel-weighted premultiplied output (terrain seen through the water), planar reflections
//     replacing the IBL radiance where available
//
// Other modules may assign `onBeforeCompile` (e.g. the sky's CSM / cloud-shadow patches). The setter
// below keeps our patch and chains theirs after it, so the material survives such patching.
import * as THREE from 'three';

export interface WaterUniforms {
  uTime: { value: number };
  uWind: { value: THREE.Vector2 };
  uRain: { value: number };
  uNight: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uDetail: { value: number };
  tRipple: { value: THREE.Texture | null };
  tWave: { value: THREE.Texture | null };
  tFoam: { value: THREE.Texture | null };
  tNoise: { value: THREE.Texture | null };
  tHF: { value: THREE.Texture | null };
  uHF: { value: THREE.Vector3 };
  tBodies: { value: THREE.Texture | null };
  tReflect: { value: THREE.Texture | null };
  uReflMatrix: { value: THREE.Matrix4 };
  uReflY: { value: number };
  uReflOn: { value: number };
}

const VERT_PARS = /* glsl */ `
attribute vec2 aFlow;
attribute vec4 aAttr;
attribute float aBody;
uniform sampler2D tBodies;
varying vec3 vWPos;
varying vec2 vFlow;
varying float vShore;
varying float vFoamB;
varying float vBar;
flat varying vec4 vAlb;
flat varying vec4 vPar;
`;

const VERT_MAIN = /* glsl */ `
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFlow = aFlow * 0.05;
vShore = aAttr.x * 63.75 - 8.0;
vFoamB = aAttr.y;
vBar = aAttr.z;
int bi = int(aBody + 0.5);
vAlb = texelFetch(tBodies, ivec2(bi, 0), 0);
vPar = texelFetch(tBodies, ivec2(bi, 1), 0);
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uRain;
uniform float uNight;
uniform vec3 uSunDir;
uniform float uDetail;
uniform sampler2D tRipple;
uniform sampler2D tWave;
uniform sampler2D tFoam;
uniform sampler2D tNoise;
uniform sampler2D tHF;
uniform vec3 uHF;         // half size, resolution, samples per side
uniform sampler2D tReflect;
uniform mat4 uReflMatrix;
uniform float uReflY;
uniform float uReflOn;
varying vec3 vWPos;
varying vec2 vFlow;
varying float vShore;
varying float vFoamB;
varying float vBar;
flat varying vec4 vAlb;   // scatter albedo rgb, extinction (1/m)
flat varying vec4 vPar;   // base roughness, wind exposure, type id, max speed

float wHF(ivec2 p) {
  int n = int(uHF.z) - 1;
  return texelFetch(tHF, clamp(p, ivec2(0), ivec2(n)), 0).r;
}
float waterGround(vec2 xz) {
  vec2 g = (xz + uHF.x) / uHF.y;
  vec2 fi = floor(g);
  vec2 f = g - fi;
  ivec2 i = ivec2(fi);
  float a = wHF(i), b = wHF(i + ivec2(1, 0)), c = wHF(i + ivec2(0, 1)), d = wHF(i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// normal-map sample -> (-dh/dx, -dh/dz) slope pair; .z = length of the filtered normal (Toksvig)
vec3 wSlope(sampler2D t, vec2 uv) {
  vec3 n = texture2D(t, uv).rgb * 2.0 - 1.0;
  float len = length(n);
  return vec3(n.xy / max(n.z, 0.25), len);
}
vec3 wHash3(vec2 p) {
  vec3 q = vec3(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)));
  return fract(sin(q) * 43758.5453);
}
// expanding rain rings, returns slope
vec2 wRain(vec2 p, float t) {
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 3; k++) {
    float sc = k == 0 ? 2.1 : (k == 1 ? 2.9 : 3.7);
    vec2 q = p * sc + float(k) * 17.31;
    vec2 cell = floor(q);
    vec2 f = fract(q) - 0.5;
    vec3 rnd = wHash3(cell + float(k) * 3.7);
    vec2 d = f - (rnd.xy - 0.5) * 0.5;
    float ph = fract(t * (0.9 + 0.5 * rnd.z) + rnd.z * 7.0);
    float r = length(d);
    float x = (r - ph * 0.45) * 28.0;
    float ring = sin(x * 3.1416) * exp(-x * x * 0.35) * (1.0 - ph) * (1.0 - ph);
    acc += d / max(r, 1e-3) * ring;
  }
  return acc;
}
`;

// runs right after <normal_fragment_maps>: replaces the normal, sets albedo/roughness/opacity
const FRAG_MAIN = /* glsl */ `
vec3 wp = vWPos;
float tt = uTime;
vec3 toCam = cameraPosition - wp;
float dView = length(toCam);
vec3 Vw = toCam / dView;
float ground = waterGround(wp.xz);
float depth = wp.y - ground;
if (depth < -0.04) discard;
float dpos = max(depth, 0.0);
vec2 flow = vFlow;
float spd = length(flow);
float typeId = vPar.z;
float isPool = step(6.5, typeId);

// ---- surface slopes
float far = smoothstep(120.0, 2600.0, dView);
float jit = texture2D(tNoise, wp.xz * 0.0137).r;
float cyc = 1.8;
float ph0 = fract(tt / cyc + jit);
float ph1 = fract(tt / cyc + jit + 0.5);
float wA = 1.0 - abs(1.0 - 2.0 * ph0);
vec2 offA = flow * (ph0 - 0.5) * cyc;
vec2 offB = flow * (ph1 - 0.5) * cyc;
// slow phase for large structures (boils, sediment plumes, foam rafts)
float cycL = 7.0;
float pl0 = fract(tt / cycL + jit * 0.5);
float pl1 = fract(tt / cycL + jit * 0.5 + 0.5);
float wL = 1.0 - abs(1.0 - 2.0 * pl0);
vec2 offLA = flow * (pl0 - 0.5) * cycL;
vec2 offLB = flow * (pl1 - 0.5) * cycL;
float spdN = smoothstep(0.05, 2.2, spd);
// flow frame (x along the current)
vec2 fdir = spd > 0.02 ? flow / spd : vec2(1.0, 0.0);
mat2 toFlow = mat2(fdir.x, -fdir.y, fdir.y, fdir.x);
mat2 fromFlow = mat2(fdir.x, fdir.y, -fdir.y, fdir.x);
// boils / slicks: patches of rough and glassy water drifting with the current
float bA = texture2D(tNoise, (wp.xz - offLA) / 21.0).r;
float bB = texture2D(tNoise, (wp.xz - offLB) / 21.0 + vec2(0.5, 0.31)).r;
float boil = mix(bB, bA, wL);
float boilMask = smoothstep(0.30, 0.72, boil);
// flowing ripples (two scales, each two-phase advected)
float s1 = isPool > 0.5 ? 0.9 : 2.7;
float s2 = isPool > 0.5 ? 2.6 : 8.3;
vec3 rA = wSlope(tRipple, (wp.xz - offA) / s1);
vec3 rB = wSlope(tRipple, (wp.xz - offB) / s1 + vec2(0.37, 0.71));
vec3 r2A = wSlope(tRipple, mat2(0.8, 0.6, -0.6, 0.8) * (wp.xz - offA) / s2 + vec2(0.13, 0.52));
vec3 r2B = wSlope(tRipple, mat2(0.8, 0.6, -0.6, 0.8) * (wp.xz - offB) / s2 + vec2(0.61, 0.29));
vec2 ripple = mix(rB.xy, rA.xy, wA) * 0.55 + mix(r2B.xy, r2A.xy, wA) * 0.75;
// large, slowly advected swells / boils of fast water (stretched along the current)
if (spdN > 0.05) {
  vec2 lA = toFlow * (wp.xz - offLA);
  vec2 lB = toFlow * (wp.xz - offLB);
  vec2 big = mix(wSlope(tRipple, lB / vec2(26.0, 17.0) + 0.21).xy, wSlope(tRipple, lA / vec2(26.0, 17.0) + 0.63).xy, wL);
  ripple += (fromFlow * big) * 0.55 * spdN;
}
float toks = mix(rB.z, rA.z, wA);
// turbulence grows with flow speed; slack water keeps only faint ripples
float turb = 0.10 + 0.75 * spdN + 0.45 * vFoamB;
turb *= mix(1.0, mix(0.35, 1.6, boilMask), spdN);
// standing waves over riffles / gravel bars: crests across the current, nearly stationary
float riffle = clamp(vFoamB * 1.4 + vBar * 0.8, 0.0, 1.0) * spdN * smoothstep(0.1, 0.6, dpos + 0.3);
vec2 sw = vec2(0.0);
if (riffle > 0.02) {
  vec2 qf = toFlow * wp.xz;
  vec2 wv1 = wSlope(tWave, (qf + vec2(sin(tt * 0.7) * 0.15, 0.0)) / vec2(5.5, 9.0)).xy;
  vec2 wv2 = wSlope(tWave, (qf * mat2(0.96, 0.28, -0.28, 0.96) - vec2(tt * 0.35, 0.0)) / 3.1 + 0.37).xy;
  sw = fromFlow * (wv1 * 1.3 + wv2 * 0.6) * riffle;
}
// wind waves (Phillips spectrum map aligned with the wind)
float wspd = length(uWind);
vec2 wd = wspd > 1e-3 ? uWind / wspd : vec2(1.0, 0.0);
mat2 toWind = mat2(wd.x, -wd.y, wd.y, wd.x);        // world -> wind frame (x along the wind)
mat2 fromWind = mat2(wd.x, wd.y, -wd.y, wd.x);
vec2 q = toWind * wp.xz;
vec2 wv = wSlope(tWave, (q - vec2(tt * 1.7, 0.0)) / 19.0).xy * 0.8
        + wSlope(tWave, mat2(0.94, 0.34, -0.34, 0.94) * (q - vec2(tt * 1.15, 0.0)) / 7.3 + vec2(0.4, 0.2)).xy * 0.6;
wv = fromWind * wv;
float fetch = clamp(vShore / 45.0, 0.25, 1.0);
float windAmp = vPar.y * smoothstep(0.5, 9.0, wspd) * fetch * (1.0 - 0.5 * smoothstep(0.3, 1.5, spd));
vec2 slope = ripple * turb + wv * windAmp + sw;
if (uRain > 0.001) slope += wRain(wp.xz, tt) * 0.9 * uRain * (1.0 - far);
slope *= uDetail * mix(1.0, 0.45, far);
vec3 Nw = normalize(vec3(slope.x, 1.0, slope.y));
normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);

// ---- optics
float cosI = clamp(dot(Nw, Vw), 0.02, 1.0);
float Fr = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);
float cosT = sqrt(1.0 - (1.0 - cosI * cosI) / 1.7689);
float sunCosT = sqrt(1.0 - (1.0 - uSunDir.y * uSunDir.y) / 1.7689);
float ext = vAlb.a;
float Tr = exp(-ext * dpos * (1.0 / cosT + 1.0 / max(sunCosT, 0.35)));
// the mapped shoreline also softens the edge when the terrain is not carved (depth unknown)
Tr = max(Tr, 1.0 - smoothstep(-1.5, 2.5, vShore) * smoothstep(0.0, 0.25, dpos));
Tr = mix(Tr, 1.0, 1.0 - smoothstep(0.0, 0.06, dpos));

// ---- foam / white water
// baked turbulence (weir, riffles) scaled by the actual current; bars only foam in fast water
float fastN = smoothstep(0.6, 2.2, spd);
float fm = min(vFoamB, 0.85) * (0.3 + 0.55 * fastN);
fm += (1.0 - smoothstep(0.02, 0.3, dpos)) * fastN * 0.2;
fm += smoothstep(1.2, 3.2, spd) * 0.22;
fm += riffle * fastN * 0.25;
fm *= 1.0 - isPool;
float foamA = 0.0;
if (fm > 0.01) {
  // streaks stretched along the current
  vec2 fa = toFlow * (wp.xz - offLA);
  vec2 fb = toFlow * (wp.xz - offLB);
  float fA = texture2D(tFoam, fa / vec2(7.5, 2.2)).r;
  float fB = texture2D(tFoam, fb / vec2(7.5, 2.2) + vec2(0.5, 0.25)).r;
  float fp = mix(fB, fA, wL);
  float fine = mix(texture2D(tFoam, (wp.xz - offB) / 1.3).r, texture2D(tFoam, (wp.xz - offA) / 1.3 + 0.3).r, wA);
  float clump = mix(bB, bA, wL);
  float pat = (fp * 0.7 + fine * 0.45) * (0.35 + 1.2 * clump);
  // threshold at the pattern quantile so that the covered fraction ~ foam amount
  float fmc = clamp(fm, 0.0, 0.95);
  float thr = 0.70 * exp(-2.3 * pow(fmc, 0.8));
  foamA = smoothstep(thr - 0.05, thr + 0.14, pat);
  foamA = mix(foamA, fmc * 0.45, far);
  foamA *= smoothstep(-0.02, 0.05, depth);
}

// ---- premultiplied colour / coverage
float waterA = 1.0 - Tr;
vec3 scatter = vAlb.rgb;
// turbid rivers look lighter/greyer in fast shallow reaches (resuspended silt)
scatter *= (1.0 + 0.25 * vBar) * mix(1.0, 0.86 + 0.28 * boil, spdN);
// foam on silty water is never paper-white: partly translucent, tinted by the water
float foamTone = 0.55 + 0.25 * smoothstep(0.2, 0.9, foamA);
vec3 foamCol = mix(vec3(0.80, 0.80, 0.77), scatter * 6.0, 0.18);
diffuseColor.rgb = scatter * (1.0 - Fr) * waterA * (1.0 - foamA) + foamCol * foamTone * foamA;
float wAlpha = 1.0 - (1.0 - Fr) * Tr * (1.0 - foamA);
// roughness: base + unresolved waves at distance (specular anti-aliasing via Toksvig) + foam
float tk = clamp(toks, 0.3, 1.0);
float rough = vPar.x + (1.0 - tk) / tk * 0.35 + far * 0.10 + turb * 0.05 + windAmp * 0.03 + riffle * 0.08;
rough += uRain * 0.08 * (1.0 - far);
roughnessFactor = mix(rough, 0.6, foamA);

// ---- planar reflection sample (applied to the IBL radiance after <lights_fragment_maps>)
vec4 wRefl = vec4(0.0);
#ifdef WATER_PLANAR
{
  vec4 rc = uReflMatrix * vec4(wp.x, uReflY, wp.z, 1.0);
  vec2 ruv = rc.xy / rc.w;
  vec3 nv = normal - normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float dist = (0.07 + 0.12 * spdN + 0.05 * windAmp) / (1.0 + dView * 0.003);
  ruv += nv.xy * dist;
  // rough / fast water stretches reflections vertically
  float smear = (0.004 + 0.02 * spdN + 0.01 * windAmp) / (1.0 + dView * 0.002);
  vec2 cu = clamp(ruv, vec2(0.001), vec2(0.999));
  wRefl = texture2D(tReflect, cu) * 0.4
        + texture2D(tReflect, clamp(cu + vec2(0.0, smear), vec2(0.001), vec2(0.999))) * 0.2
        + texture2D(tReflect, clamp(cu - vec2(0.0, smear), vec2(0.001), vec2(0.999))) * 0.2
        + texture2D(tReflect, clamp(cu + vec2(0.0, 2.2 * smear), vec2(0.001), vec2(0.999))) * 0.1
        + texture2D(tReflect, clamp(cu - vec2(0.0, 2.2 * smear), vec2(0.001), vec2(0.999))) * 0.1;
  float dy = abs(wp.y - uReflY);
  // the target is cleared to transparent black, so filtered samples are premultiplied
  wRefl *= uReflOn * (1.0 - smoothstep(0.6, 4.0, dy)) * (1.0 - foamA);
}
#endif
`;

const FRAG_REFL = /* glsl */ `
#ifdef WATER_PLANAR
radiance = radiance * (1.0 - clamp(wRefl.a, 0.0, 1.0)) + wRefl.rgb;
#endif
`;

const FRAG_OUT = /* glsl */ `
gl_FragColor = vec4(outgoingLight, wAlpha);
`;

const FRAG_FOG = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * gl_FragColor.a, fogFactor );
#endif
`;

type CompileHook = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => void;

export class WaterMaterial extends THREE.MeshPhysicalMaterial {
  readonly uniforms: WaterUniforms;
  private extraHooks: CompileHook[] = [];
  private shaderRef: THREE.WebGLProgramParametersWithUniforms | null = null;
  readonly isWaterMaterial = true;

  constructor(uniforms: WaterUniforms) {
    super({
      color: 0xffffff,
      roughness: 0.05,
      metalness: 0,
      ior: 1.333,
      specularIntensity: 1,
      transparent: true,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    this.name = 'water';
    this.uniforms = uniforms;
    this.blending = THREE.CustomBlending;
    this.blendEquation = THREE.AddEquation;
    this.blendSrc = THREE.OneFactor;
    this.blendDst = THREE.OneMinusSrcAlphaFactor;
    this.blendSrcAlpha = THREE.OneFactor;
    this.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    this.premultipliedAlpha = false;
    this.envMapIntensity = 1.0;
    const self = this;
    const own: CompileHook = (shader) => {
      Object.assign(shader.uniforms, self.uniforms);
      let vs = shader.vertexShader;
      vs = vs.replace('#include <common>', `#include <common>\n${VERT_PARS}`);
      vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );');
      vs = vs.replace('#include <fog_vertex>', `#include <fog_vertex>\n${VERT_MAIN}`);
      let fs = shader.fragmentShader;
      fs = fs.replace('#include <common>', `#include <common>\n${FRAG_PARS}`);
      fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_MAIN}`);
      fs = fs.replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${FRAG_REFL}`);
      fs = fs.replace('#include <opaque_fragment>', FRAG_OUT);
      fs = fs.replace('#include <fog_fragment>', FRAG_FOG);
      shader.vertexShader = vs;
      shader.fragmentShader = fs;
      self.shaderRef = shader;
    };
    Object.defineProperty(this, 'onBeforeCompile', {
      configurable: true,
      get() {
        return (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => {
          own(shader, renderer);
          for (const h of self.extraHooks) {
            try { h.call(self, shader, renderer); } catch (e) { console.error('[water] chained onBeforeCompile failed', e); }
          }
        };
      },
      set(fn: CompileHook) {
        // keep only the latest external hook per source function
        if (typeof fn === 'function' && !self.extraHooks.includes(fn)) self.extraHooks.push(fn);
      },
    });
  }

  override customProgramCacheKey(): string {
    return `water-v1|${this.extraHooks.map((h) => h.toString().length).join(',')}`;
  }

  setPlanar(on: boolean): void {
    const has = this.defines && 'WATER_PLANAR' in this.defines;
    if (on === !!has) return;
    this.defines = { ...(this.defines || {}) };
    if (on) this.defines.WATER_PLANAR = ''; else delete this.defines.WATER_PLANAR;
    this.needsUpdate = true;
  }
}

/** Physical proxy for the path tracer (no custom shader code). */
export function makePathTracerProxy(normalMap: THREE.Texture | null): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    name: 'water-pt-proxy',
    color: new THREE.Color(0.42, 0.45, 0.36),
    roughness: 0.03,
    metalness: 0,
    ior: 1.333,
    transmission: 0.55,
    thickness: 1.5,
    attenuationColor: new THREE.Color(0.55, 0.6, 0.45),
    attenuationDistance: 0.8,
  });
  if (normalMap) {
    const n = normalMap.clone();
    n.repeat.set(0.25, 0.25);
    m.normalMap = n;
    m.normalScale.set(0.35, 0.35);
  }
  return m;
}
