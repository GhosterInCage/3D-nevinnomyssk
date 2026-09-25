// GLSL for the terrain: shared height-field sampling, CDLOD vertex morphing and the ground
// material (injected into MeshStandardMaterial via onBeforeCompile).

/** Height field access + Catmull-Rom bicubic interpolation (matches sampling.ts on the CPU). */
export const HF_COMMON = /* glsl */ `
uniform sampler2D uHeight;
uniform vec3 uHf;            // (n, half, res)
float tHF(ivec2 p) {
  int n = int(uHf.x) - 1;
  p = clamp(p, ivec2(0), ivec2(n));
  return texelFetch(uHeight, p, 0).r;
}
float tHeightBilinear(vec2 xz) {
  vec2 g = clamp((xz + uHf.y) / uHf.z, vec2(0.0), vec2(uHf.x - 1.001));
  vec2 f = floor(g); vec2 t = g - f; ivec2 b = ivec2(f);
  float a = tHF(b), c = tHF(b + ivec2(1, 0)), d = tHF(b + ivec2(0, 1)), e = tHF(b + ivec2(1, 1));
  return mix(mix(a, c, t.x), mix(d, e, t.x), t.y);
}
vec4 tCR(float t) {
  float t2 = t * t, t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}
vec4 tCRd(float t) {
  float t2 = t * t;
  return vec4(-1.5 * t2 + 2.0 * t - 0.5, 4.5 * t2 - 5.0 * t, -4.5 * t2 + 4.0 * t + 0.5, 1.5 * t2 - t);
}
// bicubic height and its gradient (dh/dx, dh/dz)
float tHeightBicubic(vec2 xz, out vec2 grad) {
  vec2 g = clamp((xz + uHf.y) / uHf.z, vec2(0.0), vec2(uHf.x - 1.001));
  vec2 f = floor(g); vec2 t = g - f; ivec2 b = ivec2(f) - 1;
  vec4 wx = tCR(t.x), wz = tCR(t.y), dx = tCRd(t.x), dz = tCRd(t.y);
  float h = 0.0; vec2 gr = vec2(0.0);
  for (int j = 0; j < 4; j++) {
    vec4 r = vec4(tHF(b + ivec2(0, j)), tHF(b + ivec2(1, j)), tHF(b + ivec2(2, j)), tHF(b + ivec2(3, j)));
    float rv = dot(r, wx), rd = dot(r, dx);
    h += rv * wz[j]; gr.x += rd * wz[j]; gr.y += rv * dz[j];
  }
  grad = gr / uHf.z;
  return h;
}
float tHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// value noise with analytic derivative: returns (value, d/dx, d/dy), value in [0,1]
vec3 tNoiseD(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = tHash12(i), b = tHash12(i + vec2(1.0, 0.0)), c = tHash12(i + vec2(0.0, 1.0)), d = tHash12(i + vec2(1.0, 1.0));
  float v = a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  vec2 dd = du * (vec2(b - a, c - a) + (a - b - c + d) * u.yx);
  return vec3(v, dd);
}
float tNoise(vec2 p) { return tNoiseD(p).x; }
`;

/** Vertex: CDLOD morphing + bicubic heights + micro relief. Declarations. */
export const VERT_PARS = /* glsl */ `
attribute vec4 aPatch;                 // (x0, z0, size, lod)
uniform vec2 uMorph[TERRAIN_LEVELS];
uniform vec4 uMicro;                   // (amplitude m, fade start, fade end, enabled)
uniform vec4 uClip;                    // (xmin, zmin, xmax, zmax) region clamp
uniform vec3 uCamPos;                  // main camera (also used by the shadow pass)
uniform highp usampler2D uClassV;
uniform float uClassNV;
varying vec3 vTW;
varying float vTMorph;
${HF_COMMON}
float tMicroAt(vec2 xz, out vec2 grad) {
  vec3 n1 = tNoiseD(xz / 3.1);
  vec3 n2 = tNoiseD(xz / 1.3 + 17.0);
  grad = (n1.yz / 3.1) * 1.0 + (n2.yz / 1.3) * 0.45;
  return (n1.x - 0.5) + (n2.x - 0.5) * 0.45;
}
`;

/** Vertex: replaces <beginnormal_vertex>; defines terrainPos + objectNormal. */
export const VERT_MAIN = /* glsl */ `
vec2 tGrid = position.xy;
float tN = position.z;
vec2 tXZ = aPatch.xy + tGrid / tN * aPatch.z;
float tH0 = tHeightBilinear(tXZ);
float tD = distance(uCamPos, vec3(tXZ.x, tH0, tXZ.y));
int tL = int(aPatch.w + 0.5);
vec2 tM = uMorph[tL];
float tK = clamp((tD - tM.x) / max(tM.y - tM.x, 1e-3), 0.0, 1.0);
tXZ -= mod(tGrid, 2.0) / tN * aPatch.z * tK;
tXZ = clamp(tXZ, uClip.xy, uClip.zw);
vec2 tGrad;
float tH = tHeightBicubic(tXZ, tGrad);
#ifdef TERRAIN_MICRO
if (uMicro.w > 0.5 && tD < uMicro.z) {
  // micro relief only on natural ground (not on urban / gravel / water beds)
  ivec2 cp = clamp(ivec2((tXZ - uClip.xy) / (uClip.zw - uClip.xy) * uClassNV), ivec2(0), ivec2(int(uClassNV) - 1));
  uint cls = texelFetch(uClassV, cp, 0).r & 15u;
  float nat = (cls == 5u || cls == 7u || cls == 8u || cls == 9u) ? 0.0 : 1.0;
  float amp = uMicro.x * nat * (1.0 - smoothstep(uMicro.y, uMicro.z, tD));
  vec2 mg; float mh = tMicroAt(tXZ, mg);
  tH += mh * amp;
  tGrad += mg * amp;
}
#endif
vec3 terrainPos = vec3(tXZ.x, tH, tXZ.y);
vTW = terrainPos;
vTMorph = tK;
vec3 objectNormal = normalize(vec3(-tGrad.x, 1.0, -tGrad.y));
`;

/** Fragment: declarations + ground material functions. */
export const FRAG_PARS = /* glsl */ `
precision highp usampler2D;
precision mediump sampler2DArray;
uniform highp usampler2D uClass;
uniform float uClassN;
uniform sampler2D uOrtho;
uniform sampler2D uGround;
uniform sampler2D uShade;
uniform sampler2DArray uAlb;
uniform sampler2DArray uNrm;
uniform vec4 uLayerP[TERRAIN_NLAYERS];      // (1/tile m, roughness, normal strength, unused)
uniform vec3 uLayerMean[TERRAIN_NLAYERS];   // mean linear albedo
uniform vec4 uClassDef[TERRAIN_NCLASSES];   // (layerA, layerB, layerC, oriented)
uniform vec4 uClassDef2[TERRAIN_NCLASSES];  // (patch coverage of C, patch frequency, A/B by lushness?, 0)
uniform vec4 uBlend;     // (ortho blend start, ortho blend end, detail far, ground-albedo enabled)
uniform vec4 uRegion;    // (xmin, zmin, size, 1/size)
uniform vec4 uLook;      // (tint strength near, macro contrast, ao strength, wetness strength)
uniform vec4 uDebug;
uniform vec4 uWeather;          // (ground wetness from rain 0..1, puddles 0..1, 0, 0)
uniform vec3 uHf;               // (n, half, res)
#include <terrain_haze_pars>
uniform sampler2D uNormalMap;   // RG = world normal x/z of the height field (vertex grid)
uniform sampler2D uNoise;       // 4 independent tiling value noises (256 px)
varying vec3 vTW;
varying float vTMorph;
uniform float uTexSize;        // detail texture array resolution (px)
float gFoot;                    // world footprint of the pixel (m), set in main
float tNoise(vec2 p) { return texture2D(uNoise, p * (1.0 / 64.0)).r; }
vec4 tNoise4(vec2 p) { return texture2D(uNoise, p * (1.0 / 64.0)); }

float tHeightBlend(float wA, float hA, float hB) {
  // height based blend: returns weight of A
  float a = hA + wA, b = hB + (1.0 - wA);
  float m = max(a, b) - 0.25;
  float ka = max(a - m, 0.0), kb = max(b - m, 0.0);
  return ka / max(ka + kb, 1e-4);
}

// one texture layer with anti-tiling: two lookups of the same layer with different rotation /
// scale / offset, blended by a low-frequency noise (continuous uv -> implicit derivatives are fine)
// out alb: linear albedo; out nrm: (nx_world, nz_world, height)
void tLayer(int layer, vec2 xz, float rot, float vn, bool oriented, out vec3 alb, out vec3 nrm) {
  vec4 P = uLayerP[layer];
  float c = cos(rot), s = sin(rot);
  mat2 R = mat2(c, -s, s, c);          // uv = (c x + s z, -s x + c z)
  vec2 uv1 = R * xz * P.x;
  // second lookup: mirrored + shifted; oriented (row) layers keep the exact row period
  vec2 uv2 = oriented ? vec2(-uv1.x * 0.917 + 0.37, uv1.y + 0.5) : vec2(-uv1.x, uv1.y) * 0.917 + vec2(0.37, 0.61);
  float fl = float(layer);
#ifdef TERRAIN_LITE
  // explicit LOD from the per-pixel world footprint (cheaper on software rasterisers)
  float lod = log2(max(gFoot * P.x * uTexSize, 1e-6));
  vec4 a1 = textureLod(uAlb, vec3(uv1, fl), lod);
  vec4 n1 = textureLod(uNrm, vec3(uv1, fl), lod);
  vec4 a2 = a1, n2 = n1;
#else
  vec4 a1 = texture(uAlb, vec3(uv1, fl));
  vec4 n1 = texture(uNrm, vec3(uv1, fl));
  vec4 a2 = texture(uAlb, vec3(uv2, fl));
  vec4 n2 = texture(uNrm, vec3(uv2, fl));
#endif
  // blend by noise, sharpened by the texture heights so it looks like material, not a cross-fade
  float b = clamp((vn - 0.5) * 3.0 + 0.5 + (n2.z - n1.z) * 0.8, 0.0, 1.0);
  alb = mix(a1.rgb, a2.rgb, b);
  vec2 t1 = (n1.xy * 2.0 - 1.0), t2 = (n2.xy * 2.0 - 1.0) * vec2(-1.0, 1.0);   // mirrored u
  vec2 t = mix(t1, t2, b) * P.z;
  // texture-space (u, v) slope back to world (x, z): transpose of R
  vec2 w = vec2(c * t.x - s * t.y, s * t.x + c * t.y);
  nrm = vec3(w, mix(n1.z, n2.z, b));
}

// evaluate one ground class: A/B blended by lushness (or noise), C in noise-driven patches
vec4 gN1, gN2, gN5;   // shared noise lookups (computed once per pixel)
void tClass(int cls, float orient, vec2 xz, float lush, float vn, float dist,
            out vec3 alb, out vec3 nrm, out float rough, out vec3 mean) {
  vec4 D = uClassDef[cls];
  vec4 E = uClassDef2[cls];
  int la = int(D.x + 0.5), lb = int(D.y + 0.5), lc = int(D.z + 0.5);
  bool ori = D.w > 0.5;
  float rot = ori ? orient * 0.19634954 : float(cls) * 1.37 + 0.4;
  // per-class decorrelation by channel permutation of the shared noises
  vec4 pn = (cls & 1) == 0 ? gN1 : gN1.gbar;
  vec4 pf = (cls & 2) == 0 ? gN2 : gN2.barg;
  float wA;
  if (E.z > 0.5) wA = smoothstep(0.05, 0.95, lush + (pn.r - 0.5) * 0.7 + (pf.b - 0.5) * 0.35);
  else wA = 1.0 - smoothstep(0.55, 0.75, pn.g * 0.7 + pf.a * 0.3);
  vec3 aA, nA;
  tLayer(la, xz, rot, vn, ori, aA, nA);
  alb = aA; nrm = nA; rough = uLayerP[la].y; mean = uLayerMean[la];
  if (wA < 0.995 && lb != la) {
    vec3 aB, nB;
    tLayer(lb, xz, ori ? rot : rot + 0.9, vn, ori, aB, nB);
    float k = mix(tHeightBlend(wA, nA.z, nB.z), wA, smoothstep(15.0, 70.0, dist));
    alb = mix(aB, alb, k); nrm = mix(nB, nrm, k);
    rough = mix(uLayerP[lb].y, rough, k);
    mean = mix(uLayerMean[lb], mean, k);
  }
#ifndef TERRAIN_LITE
  if (E.x > 0.0 && lc != la) {
    vec4 pc = (cls & 1) == 0 ? gN5 : gN5.argb;
    float cov = mix(pc.b, pn.a, clamp(E.y * 10.0 - 0.3, 0.0, 1.0)) * 0.65 + pf.g * 0.35;
    float wC = smoothstep(1.0 - E.x, 1.0 - E.x + 0.12, cov);
    if (wC > 0.005) {
      vec3 aC, nC;
      tLayer(lc, xz, rot + 2.1, vn, ori, aC, nC);
      float k = tHeightBlend(1.0 - wC, nrm.z, nC.z);
      alb = mix(aC, alb, k); nrm = mix(nC, nrm, k);
      rough = mix(uLayerP[lc].y, rough, k);
      mean = mix(uLayerMean[lc], mean, 1.0 - wC);
    }
  }
#endif
}

vec3 terrainNormalW;
float terrainRough;
float terrainAO;
`;

/** Fragment: replaces <map_fragment>. Computes albedo, normal, roughness, AO. */
export const FRAG_MAIN = /* glsl */ `
{
  vec2 xz = vTW.xz;
  vec3 dW = dFdx(vTW), dV = dFdy(vTW);
  vec2 dX = dW.xz, dY = dV.xz;
  gFoot = max(length(dW), length(dV));
  float dist = distance(cameraPosition, vTW);
  vec2 ruv = (xz - uRegion.xy) * uRegion.w;
  // --- base normal of the height field (per pixel, from the precomputed normal map)
  vec2 nuv = (xz + uHf.y) / uHf.z;
  vec2 nxz = texture2D(uNormalMap, (nuv + 0.5) / uHf.x).rg * 2.0 - 1.0;
  vec3 nBase = normalize(vec3(nxz.x, sqrt(max(1.0 - dot(nxz, nxz), 0.02)), nxz.y));
  // --- macro colour (albedo truth at 10 m) and shading maps
  vec3 ortho = texture2D(uOrtho, ruv).rgb;
  vec3 gAlb = texture2D(uGround, ruv).rgb;
  float oB = smoothstep(uBlend.x, uBlend.y, dist);
  vec3 macro = mix(gAlb, ortho, max(oB, 1.0 - uBlend.w));
  vec3 shade = texture2D(uShade, ruv).rgb;
  float lush = shade.b;
  // --- class lookup: 4 nearest texels of the 5 m class map, jittered for organic borders
  gN1 = tNoise4(xz * 0.045);
  gN2 = tNoise4(xz * 0.21 + 0.5);
  gN5 = tNoise4(xz * 0.021 + 0.2);
  vec4 nA4 = tNoise4(xz * 0.31);
  vec4 nB4 = tNoise4(xz * 1.3 + 0.37);
  float vn = gN2.b * 0.6 + nA4.a * 0.4;
  vec2 jit = (nA4.rg - 0.5) * 1.5 + (nB4.ba - 0.5) * 0.6;
  vec2 cuv = ruv * uClassN - 0.5 + jit;
  ivec2 c0 = ivec2(floor(cuv));
  vec2 cf = fract(cuv);
  ivec2 cmax = ivec2(int(uClassN) - 1);
  uint t00 = texelFetch(uClass, clamp(c0, ivec2(0), cmax), 0).r;
  uint t10 = texelFetch(uClass, clamp(c0 + ivec2(1, 0), ivec2(0), cmax), 0).r;
  uint t01 = texelFetch(uClass, clamp(c0 + ivec2(0, 1), ivec2(0), cmax), 0).r;
  uint t11 = texelFetch(uClass, clamp(c0 + ivec2(1, 1), ivec2(0), cmax), 0).r;
  uint tt[4] = uint[4](t00, t10, t01, t11);
  float ww[4] = float[4]((1.0 - cf.x) * (1.0 - cf.y), cf.x * (1.0 - cf.y), (1.0 - cf.x) * cf.y, cf.x * cf.y);
  // dominant class A and runner-up class B (a rare third class is ignored)
  int ia = 0;
  for (int i = 1; i < 4; i++) if (ww[i] > ww[ia]) ia = i;
  uint ca = tt[ia] & 15u;
  float wa = 0.0, wb = 0.0; int ib = -1;
  for (int i = 0; i < 4; i++) {
    uint ci = tt[i] & 15u;
    if (ci == ca) { wa += ww[i]; continue; }
    if (ib < 0) { ib = i; wb = ww[i]; }
    else if (ci == (tt[ib] & 15u)) wb += ww[i];
  }
  float orientA = float(tt[ia] >> 4);
  vec3 alb, nrmT, meanA; float rough;
  bool detail = dist < uBlend.z;
  if (detail) {
    tClass(int(ca), orientA, xz, lush, vn, dist, alb, nrmT, rough, meanA);
    if (ib >= 0 && wb > 0.02) {
      vec3 albB, nrmB, meanB; float roughB;
      uint cb = tt[ib] & 15u;
      tClass(int(cb), float(tt[ib] >> 4), xz, lush, vn, dist, albB, nrmB, roughB, meanB);
      float wl = wa / (wa + wb);
      // crisp height-blended borders up close, smooth bilinear transitions further away
      float k = mix(tHeightBlend(wl, nrmT.z, nrmB.z), wl, smoothstep(15.0, 70.0, dist));
      alb = mix(albB, alb, k); nrmT = mix(nrmB, nrmT, k); rough = mix(roughB, rough, k); meanA = mix(meanB, meanA, k);
    }
  } else {
    alb = uLayerMean[int(uClassDef[int(ca)].x + 0.5)];  // far: macro only
    meanA = alb; nrmT = vec3(0.0, 0.0, 0.5); rough = uLayerP[int(uClassDef[int(ca)].x + 0.5)].y;
  }
  // --- mid-distance structure: the dominant layer sampled at ~7x its tile size modulates the
  //     luminance so ground keeps material-like variation where the fine detail has averaged out
#ifndef TERRAIN_LITE
  if (dist > 15.0) {
    int lm = int(uClassDef[int(ca)].x + 0.5);
    vec4 Pm = uLayerP[lm];
    float rotm = orientA * 0.19634954 + 0.7;
    vec2 uvm = mat2(cos(rotm), -sin(rotm), sin(rotm), cos(rotm)) * xz * (Pm.x * 0.149) + 0.31;
    vec3 am = texture(uAlb, vec3(uvm, float(lm))).rgb;
    float lr = dot(am, vec3(0.2126, 0.7152, 0.0722)) / max(dot(uLayerMean[lm], vec3(0.2126, 0.7152, 0.0722)), 1e-3);
    float km = smoothstep(15.0, 60.0, dist) * (1.0 - smoothstep(600.0, 1400.0, dist));
    alb *= mix(1.0, clamp(pow(lr, 0.6), 0.6, 1.5), km);
  }
#endif
  // --- steep banks / escarpments: triplanar clay-rock
  float steep = smoothstep(0.86, 0.66, nBase.y);
#ifdef TERRAIN_LITE
  if (false) {
#else
  if (steep > 0.01 && detail) {
#endif
    vec3 an = abs(nBase);
    vec2 wts = an.xz / max(an.x + an.z, 1e-4);
    vec3 aX, nX, aZ, nZ;
    tLayer(13, vTW.zy, 0.0, vn, false, aX, nX);
    tLayer(13, vTW.xy, 0.0, vn, false, aZ, nZ);
    vec3 aR = aX * wts.x + aZ * wts.y;
    alb = mix(alb, aR, steep);
    meanA = mix(meanA, uLayerMean[13], steep);
    rough = mix(rough, uLayerP[13].y, steep);
    nrmT.xy *= 1.0 - steep;
  }
  // --- combine: detail texture tinted towards the macro albedo (colour truth), fading to macro
  vec3 ratio = clamp(macro / max(meanA, vec3(0.004)), vec3(0.3), vec3(3.0));
  float fade = smoothstep(uBlend.z * 0.35, uBlend.z, dist);
  float tintK = mix(uLook.x, 1.0, smoothstep(8.0, 110.0, dist));
  vec3 tinted = alb * mix(vec3(1.0), ratio, tintK);
  vec3 albedo = mix(tinted, macro, fade);
  // field swaths / tramlines readable from the air (analytically anti-aliased)
  if (ca >= 1u && ca <= 3u) {
    float rot = orientA * 0.19634954;
    vec2 dir = vec2(-sin(rot), cos(rot));
    float v = dot(dir, xz);
    float fw = abs(dot(dir, dX)) + abs(dot(dir, dY));
    float sw = 0.5 + 0.5 * sin(v * 6.2831853 / 7.2);
    float d = abs(fract(v / 24.0) - 0.5) * 24.0;
    float tram = 1.0 - smoothstep(0.12, 0.32 + fw, abs(d - 0.9));
    float kSw = 1.0 - smoothstep(0.8, 2.5, fw);
    float kTr = (1.0 - smoothstep(0.25, 0.9, fw)) * smoothstep(6.0, 40.0, dist);
    albedo *= 1.0 + 0.07 * (sw - 0.5) * kSw - 0.14 * tram * kTr;
  }
  // large-scale natural variation (breaks up 10 m ortho texels, adds life to lawns)
  float mv = gN5.a * 0.45 + gN1.b * 0.3 + nB4.r * 0.25;
  albedo *= 1.0 + uLook.y * (mv - 0.5);
  // --- wetness near water: darker, smoother
  float wet = shade.g * uLook.w;
  albedo *= 1.0 - 0.38 * wet;
  rough = mix(rough, 0.38, wet * 0.85);
  // --- rain: darker, glossier ground; puddles in flat low spots of soil / yards / tracks
  float puddle = 0.0;
  if (uWeather.x > 0.0) {
    float porous = (ca == 0u || ca == 6u) ? 0.55 : 1.0;          // grass / leaf litter stay matte-ish
    albedo *= 1.0 - 0.32 * uWeather.x * porous;
    rough = mix(rough, 0.32, uWeather.x * porous * 0.8);
    bool puddleClass = ca == 3u || ca == 4u || ca == 5u || ca == 7u || ca == 9u;
    if (puddleClass && uWeather.y > 0.0) {
      float flat_ = smoothstep(0.985, 0.998, nBase.y);
      float cavP = 1.0 - smoothstep(0.35, 0.6, nrmT.z);             // low spots of the detail relief
      float pn = gN2.r * 0.6 + nB4.g * 0.4;
      float th = 0.76 - 0.1 * uWeather.y;
      puddle = smoothstep(th, th + 0.04, pn * 0.75 + cavP * 0.25) * flat_ * uWeather.y;
      albedo = mix(albedo, albedo * 0.45, puddle);
      rough = mix(rough, 0.03, puddle);
    }
  }
  // --- normal: base + detail slopes (fade with distance)
  float dn = (1.0 - fade) * (detail ? 1.0 : 0.0) * (1.0 - puddle);
  vec3 n = normalize(vec3(nBase.x + nrmT.x * dn, nBase.y, nBase.z + nrmT.y * dn));
  terrainNormalW = n;
  terrainRough = rough;
  // ambient occlusion: terrain sky visibility + small-scale cavities of the detail texture
  float cav = mix(1.0, 0.72 + 0.28 * nrmT.z, dn * 0.8);
  terrainAO = mix(1.0, shade.r, uLook.z) * cav;
  albedo *= mix(1.0, cav, 0.5);
  if (uDebug.x > 0.5) albedo = vec3(float(ca) / 12.0, fract(float(ca) * 0.37), fract(float(ca) * 0.61)) * 0.4;
  diffuseColor.rgb = clamp(albedo, 0.0, 1.0);
}
`;

export const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = terrainRough;
`;

export const FRAG_NORMAL = /* glsl */ `
normal = normalize((viewMatrix * vec4(terrainNormalW, 0.0)).xyz);
`;

export const FRAG_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= terrainAO;
reflectedLight.indirectSpecular *= terrainAO;
`;

/** Stand-alone aerial perspective (Rayleigh + Mie, exponential height profiles), used by the near
 *  and far terrain only when the sky module's post-processing is absent. Needs vec3 world pos. */
export const HAZE_PARS = /* glsl */ `
uniform float uHazeOn;
uniform vec3 uHazeCol;
uniform vec3 uBetaR;
uniform float uBetaM;
uniform vec2 uScaleH;
uniform float uSunGlow;
uniform vec3 uHazeSun;
float hzOd(float beta, float H, float h0, float h1, float len) {
  float a = exp(-max(h0, -200.0) / H), b = exp(-max(h1, -200.0) / H);
  float dh = h1 - h0;
  float avg = abs(dh) < 1.0 ? a : H * (a - b) / dh;
  return beta * len * avg;
}
vec3 hzApply(vec3 col, vec3 camPos, vec3 wp) {
  vec3 v = wp - camPos;
  float len = length(v);
  vec3 od = uBetaR * hzOd(1.0, uScaleH.x, camPos.y, wp.y, len) + vec3(hzOd(uBetaM, uScaleH.y, camPos.y, wp.y, len));
  vec3 T = exp(-od);
  float mu = dot(v / max(len, 1.0), uHazeSun);
  vec3 haze = uHazeCol * (1.0 + uSunGlow * pow(max(mu, 0.0), 8.0));
  return col * T + haze * (1.0 - T);
}
`;
