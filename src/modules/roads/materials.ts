// Materials for the roads module.
//
// One physically based "surface" shader (MeshStandardMaterial + onBeforeCompile) renders every hard
// surface the module draws: carriageways, sidewalks, ballast, platforms, curbs, bridge decks and
// structures, and road markings. It samples an 8-layer texture array (procedural PBR textures from
// pipeline/roads_textures.py) with anti-tiling, and adds procedural detail: oxidised / patched /
// cracked asphalt, wheel-track polish and ruts, oil strips, dust at the edges, crumbling edges on
// old private-sector roads, potholes, wetness + puddles (ctx.env.rain) and street-lamp light pools
// at night (a lamp grid texture: up to two lamps per 16 m cell, evaluated with three's RE_Direct).
import * as THREE from 'three';
import type { AppContext } from '../../core/context';

/** Surface ids (keep in sync with pipeline/build_roads.py). */
export const S = {
  ASPH: 0, ASPH_OLD: 1, CONCRETE: 2, GRAVEL: 3, DIRT: 4, PAVING: 5, SIDEWALK: 6, BALLAST: 7, PLATFORM: 8,
  PARKING: 9, PAVING_ROAD: 10, CURB: 11, STRUCT: 12, MARK_WHITE: 20, MARK_YELLOW: 21,
} as const;

/** Height of each ground surface above the terrain (m). */
export const ELEV: Record<number, number> = {
  0: 0.085, 1: 0.085, 2: 0.085, 3: 0.075, 4: 0.07, 5: 0.22, 6: 0.22, 7: 0.38, 8: 0.95, 9: 0.085, 10: 0.085, 11: 0.22, 12: 0,
};

export interface SharedUniforms {
  rsAlb: THREE.IUniform<THREE.Texture | null>;
  rsNrm: THREE.IUniform<THREE.Texture | null>;
  rsNoise: THREE.IUniform<THREE.Texture | null>;
  rsLamp: THREE.IUniform<THREE.Texture | null>;
  rsLampP: THREE.IUniform<THREE.Vector4>;
  rsLampCol0: THREE.IUniform<THREE.Color>;
  rsLampCol1: THREE.IUniform<THREE.Color>;
  rsNight: THREE.IUniform<number>;
  rsWet: THREE.IUniform<number>;
  rsTime: THREE.IUniform<number>;
  rsLampI: THREE.IUniform<number>;
  rsCam: THREE.IUniform<THREE.Vector3>;
  rsDash: THREE.IUniform<THREE.Vector4[]>;
  /** lamps currently rendered as real spot lights: (x, z, weight, 0); their lamp-map light is scaled by 1-weight */
  rsReal: THREE.IUniform<THREE.Vector4[]>;
}

export function makeSharedUniforms(): SharedUniforms {
  const dash: THREE.Vector4[] = [];
  // style -> (dash, gap, width, _) ; see MARK_STYLES in build_roads.py
  const tbl = [[0, 0], [3, 6], [3, 9], [0, 0], [0, 0], [0, 0], [0, 0], [1, 1]];
  for (const [d, g] of tbl) dash.push(new THREE.Vector4(d, g, 0, 0));
  return {
    rsAlb: { value: null },
    rsNrm: { value: null },
    rsNoise: { value: null },
    rsLamp: { value: null },
    rsLampP: { value: new THREE.Vector4(-10240, -10240, 1 / 16, 0) },
    rsLampCol0: { value: new THREE.Color(1.0, 0.93, 0.82) },   // LED ~4000 K
    rsLampCol1: { value: new THREE.Color(1.0, 0.62, 0.25) },   // high-pressure sodium
    rsNight: { value: 0 },
    rsWet: { value: 0 },
    rsTime: { value: 0 },
    rsLampI: { value: 70 },
    rsCam: { value: new THREE.Vector3() },
    rsDash: { value: dash },
    rsReal: { value: Array.from({ length: 8 }, () => new THREE.Vector4(1e9, 1e9, 0, 0)) },
  };
}

// ------------------------------------------------------------------------------------------ GLSL
const VERT_PARS = /* glsl */ `
attribute vec4 aAtt;
attribute float aLat;
attribute vec2 aDir;
uniform vec3 rsPullP;
varying vec3 rsW;
varying vec3 rsNW;
flat varying float rsSurf;
varying float rsLat;
varying vec4 rsA;
varying vec2 rsDir;
`;

const VERT_MAIN = /* glsl */ `
#include <project_vertex>
rsW = (modelMatrix * vec4(transformed, 1.0)).xyz;
rsNW = normalize(mat3(modelMatrix) * objectNormal);
rsSurf = aAtt.x;
rsLat = aAtt.x > 19.5 ? aLat : aLat * 0.01;
rsA = vec4(aAtt.y, aAtt.z * 0.1, aAtt.w / 255.0, aAtt.y);
rsDir = aDir;
{
  // pull towards the camera by a depth-precision dependent amount: draped layers never z-fight with
  // the terrain (whose far LODs may deviate from the exact height field) and never visibly float.
  float rsD = -mvPosition.z;
  if (rsD > 0.05) {
    float rsNear = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
    float rsPull = rsPullP.x + rsPullP.y * rsD + rsPullP.z * rsD * rsD / max(rsNear, 0.05);
    // never pull closer than half the distance (keeps triangles near / behind the camera intact)
    mvPosition.xyz *= max(0.5, 1.0 - rsPull / rsD);
    gl_Position = projectionMatrix * mvPosition;
  }
}
`;

const FRAG_PARS = /* glsl */ `
uniform highp sampler2DArray rsAlb;
uniform highp sampler2DArray rsNrm;
uniform sampler2D rsNoise;
uniform sampler2D rsLamp;
uniform vec4 rsLampP;
uniform vec3 rsLampCol0;
uniform vec3 rsLampCol1;
uniform float rsNight;
uniform float rsWet;
uniform float rsTime;
uniform float rsLampI;
uniform vec3 rsCam;
uniform vec4 rsDash[8];
uniform vec4 rsReal[8];
varying vec3 rsW;
varying vec3 rsNW;
flat varying float rsSurf;
varying float rsLat;
varying vec4 rsA;
varying vec2 rsDir;

//                          0    1    2    3    4    5    6    7    8    9    10   11   12
const float RS_LAYER[13] = float[13](0., 0., 1., 2., 3., 4., 0., 5., 6., 0., 4., 7., 1.);
const float RS_SCALE[13] = float[13](1.5, 1.5, 4., 3., 4., 2., 1.5, 2., 4., 1.5, 2., 2., 4.);

vec3 rsAlbedo = vec3(1.0);
float rsRough = 0.9;
vec3 rsN = vec3(0.0, 1.0, 0.0);
float rsAlpha = 1.0;

float rsNz(vec2 p) { return texture(rsNoise, p).r; }
float rsHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void rsSurface() {
  int s = int(rsSurf + 0.5);
  vec2 xz = rsW.xz;
  vec3 nG = normalize(rsNW);
  float dist = length(rsCam - rsW);
  float wet = rsWet;

  if (s >= 20) {
    // ---------------------------------------------------------------- road markings (paint)
    float along = rsLat;
    int st = int(rsA.w + 0.5);
    vec4 dg = rsDash[st];
    float cov = 1.0;
    if (dg.x > 0.0) {
      float per = dg.x + dg.y;
      float ph = mod(along + rsHash(floor(xz / 50.0)) * per, per);
      float aa = max(fwidth(along) * 1.5, 0.02);
      cov *= smoothstep(0.0, aa, ph) * (1.0 - smoothstep(dg.x - aa, dg.x, ph));
    }
    vec4 nz = texture(rsNoise, xz * 0.21);
    float worn = smoothstep(0.35, 0.8, texture(rsNoise, xz * 0.037 + 0.3).b);
    float speck = texture(rsNoise, xz * 1.37).a;
    cov *= 1.0 - worn * (0.55 + 0.45 * smoothstep(0.3, 0.7, nz.r)) * 0.85;
    cov *= smoothstep(0.08, 0.35, speck + 0.2 - worn * 0.2);
    // fade out with distance (sub-pixel lines alias)
    cov *= 1.0 - smoothstep(350.0, 900.0, dist);
    rsAlbedo = s == 21 ? vec3(0.75, 0.52, 0.07) : vec3(0.72, 0.72, 0.70);
    rsAlbedo *= 0.85 + 0.15 * nz.g;
    rsRough = mix(0.55, 0.12, wet);
    rsN = nG;
    rsAlpha = cov;
    return;
  }

  int li = s <= 12 ? s : 12;
  float layer = RS_LAYER[li];
  float sc = RS_SCALE[li];
  vec2 uv1;
  bool tri = (s == 11 || s == 12);
  vec3 an = abs(nG);
  int plane = 1;
  if (tri) {
    if (an.y > max(an.x, an.z)) { uv1 = xz; plane = 1; }
    else if (an.x > an.z) { uv1 = rsW.zy; plane = 0; }
    else { uv1 = rsW.xy; plane = 2; }
    uv1 /= sc;
  } else {
    uv1 = xz / sc;
  }
  vec2 uv2 = mat2(0.8253, 0.5646, -0.5646, 0.8253) * uv1 * 0.4219 + 0.37;
  float mN = texture(rsNoise, xz * 0.0243).r;
  float bl = smoothstep(0.3, 0.7, mN);
  vec4 a1 = texture(rsAlb, vec3(uv1, layer));
  vec4 a2 = texture(rsAlb, vec3(uv2, layer));
  vec4 n1 = texture(rsNrm, vec3(uv1, layer));
  vec4 n2 = texture(rsNrm, vec3(uv2, layer));
  vec3 alb = mix(a1.rgb, a2.rgb, bl);
  vec3 nt = mix(n1.rgb, n2.rgb, bl);
  float rough = nt.b;
  vec2 nd = nt.rg * 2.0 - 1.0;   // (d/du, -d/dv) style tangent normal xy
  float nStr = 1.0;

  vec4 macro = texture(rsNoise, xz * 0.0071 + 0.17);   // ~140 m features
  vec4 mid = texture(rsNoise, xz * 0.061 + 0.53);      // ~16 m features
  float lanes = rsA.x;
  float hw = rsA.y;
  float wear = rsA.z;
  float lat = rsLat;
  float alat = abs(lat);
  float edge = hw > 0.1 ? smoothstep(hw - 0.9, hw + 0.05, alat) : 0.0;
  float rut = 0.0;   // 0..1 wheel-track mask (puddles collect there)

  bool asph = (s == 0 || s == 1 || s == 6 || s == 9);
  if (asph) {
    float old = (s == 1 || s == 9) ? 1.0 : 0.0;
    if (s == 6) old = 0.5;
    // oxidised bitumen: new asphalt is near-black, old goes to blue-grey
    float ox = old * (0.55 + 0.6 * macro.r) + (1.0 - old) * 0.25 * macro.g;
    alb *= mix(0.72, 1.3, ox);
    if (s == 6) alb *= 1.25;
    alb *= vec3(0.98, 0.99, 1.02 + 0.03 * ox);
    alb *= 0.88 + 0.24 * mid.r;
    // road-aligned rectangular repair patches (cut & refill), fresher = darker, with tar-sealed seams
    float patchm = 0.0, seam = 0.0, ptone = 0.0;
    {
      float th = 0.5 * atan(rsDir.y, rsDir.x + 1e-5);
      vec2 T = vec2(cos(th), sin(th));
      vec2 Bn = vec2(-T.y, T.x);
      const float CS = 7.0;
      vec2 f = fract(xz / CS);
      vec2 base = floor(xz / CS) - vec2(f.x < 0.5 ? 1.0 : 0.0, f.y < 0.5 ? 1.0 : 0.0);
      float prob = mix(0.06, 0.34, old) * (0.5 + macro.b);
      for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) {
          vec2 cid = base + vec2(float(i), float(j));
          if (rsHash(cid) > prob) continue;
          vec2 c = (cid + vec2(rsHash(cid + 1.7), rsHash(cid + 3.1))) * CS;
          vec2 hs = vec2(0.5 + 2.6 * rsHash(cid + 5.3), 0.4 + 1.3 * rsHash(cid + 7.9));
          vec2 d = xz - c;
          vec2 q = abs(vec2(dot(d, T), dot(d, Bn))) - hs;
          float e = max(q.x, q.y);
          float inside = 1.0 - smoothstep(-0.015, 0.015, e);
          if (inside > patchm) { patchm = inside; ptone = rsHash(cid + 9.4); }
          seam = max(seam, 1.0 - smoothstep(0.0, 0.035, abs(e)));
        }
      }
    }
    alb = mix(alb, alb * mix(0.5, 0.85, ptone), patchm);
    rough = mix(rough, rough * 0.9, patchm);
    alb *= 1.0 - 0.6 * seam;
    // crack network (tar-sealed or open)
    float cmask = smoothstep(0.5, 0.72, texture(rsNoise, xz * 0.011 + 0.71).r * 0.8 + 0.2 * mid.b + 0.18 * old - 0.12) * (1.0 - patchm);
    float cr = texture(rsNoise, xz * 0.083).g;
    float cr2 = texture(rsNoise, xz * 0.19 + 0.5).g;
    float crack = max(smoothstep(0.55, 0.9, cr), smoothstep(0.6, 0.95, cr2) * old) * cmask * (0.12 + 0.88 * old);
    alb *= 1.0 - 0.6 * crack;
    rough = mix(rough, 0.6, crack * 0.5);
    // potholes on very old roads (away from junctions)
    if (old > 0.9 && wear > 0.5) {
      float ph = texture(rsNoise, xz * 0.16 + vec2(0.3, 0.8)).r;
      float badness = smoothstep(0.55, 0.8, macro.b);
      float hole = smoothstep(0.79, 0.81, ph + 0.12 * badness) * badness;
      if (hole > 0.0) {
        vec4 g = texture(rsAlb, vec3(xz / 3.0, 2.0));
        vec4 gn = texture(rsNrm, vec3(xz / 3.0, 2.0));
        alb = mix(alb, g.rgb * 0.75, hole);
        nd = mix(nd, gn.rg * 2.0 - 1.0, hole);
        rough = mix(rough, gn.b, hole);
        float rim = smoothstep(0.76, 0.79, ph + 0.12 * badness) - hole;
        alb *= 1.0 - 0.35 * rim * badness;
        rut = max(rut, hole);
      }
    }
    // dust / sand at the edges, crumbling edges on old narrow roads
    alb = mix(alb, vec3(0.20, 0.18, 0.15), edge * 0.45 * (0.5 + mid.g));
    if (old > 0.9 && lanes > 0.5 && wear > 0.9 && hw < 4.0) {
      float crumble = texture(rsNoise, xz * 0.29 + 0.1).r * 0.9 + texture(rsNoise, xz * 1.3).a * 0.25;
      if (alat > hw - 0.55 * crumble * (0.4 + macro.b)) discard;
    }
  } else if (s == 2) {
    // concrete road slabs: world aligned joints every 6 x 3.5 m, uneven tone per slab
    vec2 cell = floor(xz / vec2(3.5, 6.0));
    vec2 f = fract(xz / vec2(3.5, 6.0));
    vec2 ed = min(f, 1.0 - f) * vec2(3.5, 6.0);
    float joint = 1.0 - smoothstep(0.015, 0.05, min(ed.x, ed.y));
    alb *= (0.85 + 0.25 * rsHash(cell)) * (1.0 - 0.55 * joint);
    alb *= 0.8 + 0.3 * mid.r;
    alb = mix(alb, vec3(0.14, 0.13, 0.12), 0.35 * smoothstep(0.5, 0.9, macro.g));
  } else if (s == 3 || s == 4) {
    alb *= 0.85 + 0.3 * mid.r;
    alb = mix(alb, alb * vec3(1.05, 1.0, 0.9), macro.r);
  } else if (s == 5 || s == 10) {
    alb *= 0.85 + 0.25 * mid.g;
    alb = mix(alb, alb * 0.7, smoothstep(0.6, 0.9, macro.b) * 0.5);
  } else if (s == 7) {
    // ballast: sleepers + rails pattern for the mid distance (3D rails replace it nearby)
    float far = smoothstep(260.0, 420.0, dist);
    float sleep = (1.0 - smoothstep(1.2, 1.45, alat));
    alb = mix(alb, mix(alb, vec3(0.30, 0.29, 0.27), 0.55 * sleep), far);
    float railL = 1.0 - smoothstep(0.03, 0.09, abs(alat - 0.76));
    alb = mix(alb, vec3(0.08, 0.06, 0.05), railL * far * 0.8);
    // rust between the rails, dirt/oil darkening, less pink
    alb = mix(alb, vec3(dot(alb, vec3(0.333))), 0.35) * vec3(1.02, 0.98, 0.93);
    alb = mix(alb, alb * vec3(1.1, 0.88, 0.72), (1.0 - smoothstep(0.6, 0.9, alat)) * 0.6);
    alb *= (0.62 + 0.25 * mid.b) * (1.0 - 0.25 * (1.0 - smoothstep(0.0, 1.4, alat)));
  } else if (s == 8 || s == 12 || s == 11) {
    alb *= (s == 11 ? 1.25 : 1.0) * (0.85 + 0.2 * mid.r);
    alb = mix(alb, alb * vec3(0.8, 0.8, 0.78), smoothstep(0.55, 0.85, macro.g) * 0.6);
  }

  // wheel tracks on carriageways
  bool carr = s <= 4 || s == 10;
  if (carr && lanes > 0.5 && hw > 0.5) {
    float lw = 2.0 * hw / lanes;
    float u = (lat + hw) / lw;
    float lx = (fract(u) - 0.5) * lw;
    float wt = exp(-pow((abs(lx) - 0.85) / 0.36, 2.0)) * wear;
    float oil = exp(-pow(lx / 0.35, 2.0)) * wear * smoothstep(0.35, 0.75, mid.b);
    if (s <= 1) {
      alb *= 1.0 - (s == 0 ? 0.2 : 0.12) * wt;
      rough = mix(rough, rough * 0.72, wt);
      alb *= 1.0 - 0.3 * oil;
      rut = max(rut, wt * (s == 1 ? 1.0 : 0.4));
    } else if (s == 3 || s == 4) {
      // dirt / gravel: compacted ruts, grass strip in the centre of single-lane tracks
      alb = mix(alb, alb * vec3(0.8, 0.78, 0.76), wt);
      rut = max(rut, wt);
      if (lanes < 1.5 && s == 4) {
        float grassC = (1.0 - smoothstep(0.25, 0.6, alat)) * smoothstep(0.35, 0.6, mid.r);
        alb = mix(alb, vec3(0.10, 0.13, 0.05), grassC * 0.8);
      }
    }
  }

  // ---------------------------------------------------------------- manhole covers + storm-drain grates
  if ((s <= 2 || s == 10) && dist < 180.0 && hw > 2.0) {
    vec2 cid = floor(xz / 23.0);
    if (rsHash(cid + 11.3) < 0.5) {
      vec2 c = (cid + 0.2 + 0.6 * vec2(rsHash(cid + 2.2), rsHash(cid + 4.4))) * 23.0;
      vec2 d = xz - c;
      float r = length(d);
      if (r < 0.45 && alat < hw - 0.9) {
        float disc = 1.0 - smoothstep(0.31, 0.33, r);
        float frame = (1.0 - smoothstep(0.40, 0.44, r)) - disc;
        float pat = step(0.55, fract((d.x + d.y) * 7.0)) + step(0.55, fract((d.x - d.y) * 7.0));
        alb = mix(alb, vec3(0.05, 0.045, 0.04) * (0.8 + 0.35 * pat), disc);
        alb = mix(alb, vec3(0.09, 0.085, 0.08), frame);
        rough = mix(rough, 0.35 + 0.2 * pat, disc);
        nd += vec2(0.25 * pat - 0.2) * disc;
        rut = max(rut, frame * 0.6);
      }
    }
    if (hw > 2.5 && alat > hw - 0.55 && alat < hw - 0.05) {
      float th = 0.5 * atan(rsDir.y, rsDir.x + 1e-5);
      vec2 T = vec2(cos(th), sin(th));
      float al = dot(xz, T);
      float k = floor(al / 38.0);
      float u = al - (k + 0.5) * 38.0;
      if (abs(u) < 0.45 && rsHash(vec2(k, floor(lat))) < 0.8) {
        float slots = step(0.45, fract(u * 12.0));
        alb = mix(alb, vec3(0.03) + 0.07 * slots, 0.9);
        rough = 0.5;
        rut = 1.0;
      }
    }
  }

  // ---------------------------------------------------------------- wetness
  if (wet > 0.001 && s != 12) {
    float por = (s == 3 || s == 4) ? 1.0 : 0.75;
    float pud = smoothstep(0.58, 0.72, texture(rsNoise, xz * 0.093 + 0.4).r + 0.45 * rut - 0.15 * edge + 0.2 * (wet - 0.5));
    if (s == 7 || s == 11) pud = 0.0;
    pud *= smoothstep(0.2, 0.7, wet);
    alb *= mix(1.0, 0.55, wet * por);
    rough = mix(rough, 0.28, wet * 0.75);
    alb = mix(alb, alb * 0.75, pud);
    rough = mix(rough, 0.03, pud);
    nStr *= 1.0 - pud;
    // rain ripples
    if (pud > 0.2) {
      vec2 rp = xz * 3.0;
      vec2 ci = floor(rp);
      float h = rsHash(ci);
      float t = fract(rsTime * 0.9 + h);
      float r = length(fract(rp) - 0.5 - (vec2(rsHash(ci + 3.1), rsHash(ci + 7.7)) - 0.5) * 0.4);
      float ring = exp(-pow((r - t * 0.45) * 22.0, 2.0)) * (1.0 - t);
      nd += vec2(ring * 0.4 * (rsHash(ci + 1.0) - 0.5), ring * 0.4) * pud;
      nStr = max(nStr, ring * pud);
    }
  }

  // ---------------------------------------------------------------- normal
  vec3 bump;
  if (tri && plane != 1) {
    // vertical faces: perturb along the face plane
    vec3 t = plane == 0 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    bump = t * nd.x + vec3(0.0, 1.0, 0.0) * nd.y;
  } else {
    bump = vec3(nd.x, 0.0, -nd.y);
  }
  rsN = normalize(nG + bump * 0.9 * nStr);
  rsAlbedo = alb;
  rsRough = clamp(rough, 0.02, 1.0);
}

`;

const LAMP_FN = /* glsl */ `
// street lamp light pools (up to two lamps per 16 m cell)
void rsLamps(inout ReflectedLight reflectedLight, const in vec3 geometryPosition, const in vec3 geometryNormal,
             const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material) {
  if (rsNight < 0.01) return;
  vec2 g = (rsW.xz - rsLampP.xy) * rsLampP.z;
  ivec2 c = ivec2(floor(g));
  int n = int(rsLampP.w);
  if (c.x < 0 || c.y < 0 || c.x >= n || c.y >= n) return;
  vec4 t = floor(texelFetch(rsLamp, c, 0) * 255.0 + 0.5);
  vec2 cc = (vec2(c) + 0.5) / rsLampP.z + rsLampP.xy;
  for (int k = 0; k < 2; k++) {
    vec2 q = k == 0 ? t.rg : t.ba;
    if (q.y < 0.5) continue;
    float typ = mod(q.x, 2.0);
    vec2 off = vec2(floor(q.x * 0.5), floor(q.y * 0.5)) * 0.5 - 32.0;
    vec3 L = vec3(cc.x + off.x - rsW.x, 9.0, cc.y + off.y - rsW.z);
    float d2 = dot(L, L);
    vec3 Ld = L * inversesqrt(d2);
    float cosE = Ld.y;
    float I = rsLampI * rsNight * (0.25 + 0.75 * cosE * cosE) * smoothstep(0.28, 0.55, cosE);
    vec2 lp = cc + off;
    for (int r = 0; r < 8; r++) {
      vec2 dd = rsReal[r].xy - lp;
      if (dot(dd, dd) < 0.5) I *= 1.0 - rsReal[r].z;
    }
    IncidentLight dl;
    dl.color = (typ > 0.5 ? rsLampCol1 : rsLampCol0) * (I / d2);
    dl.direction = normalize((viewMatrix * vec4(Ld, 0.0)).xyz);
    dl.visible = true;
    RE_Direct(dl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  }
}
`;

export interface SurfaceMaterialOptions {
  /** depth pull: constant (m), linear (per m), quadratic depth-precision term */
  pull?: [number, number, number];
  transparent?: boolean;
  side?: THREE.Side;
  lamps?: boolean;
}

export function createSurfaceMaterial(ctx: AppContext, u: SharedUniforms, key: string, opt: SurfaceMaterialOptions = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: opt.side ?? THREE.FrontSide });
  const pull = new THREE.Vector3(...(opt.pull ?? [0.02, 0.0004, 1.2e-7]));
  m.userData.rsPull = pull;
  if (opt.transparent) {
    m.transparent = true;
    m.depthWrite = false;
  }
  m.polygonOffset = true;
  m.polygonOffsetFactor = opt.transparent ? -2 : -1;
  m.polygonOffsetUnits = opt.transparent ? -4 : -2;
  const lamps = opt.lamps !== false;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.uniforms.rsPullP = { value: pull };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <map_fragment>', 'rsSurface();\n  diffuseColor.rgb *= rsAlbedo;\n  diffuseColor.a *= rsAlpha;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rsRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(rsN, 0.0)).xyz);');
    if (lamps) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${LAMP_FN}`)
        .replace('#include <lights_fragment_end>',
        'rsLamps(reflectedLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material);\n#include <lights_fragment_end>');
    }
  };
  m.customProgramCacheKey = () => `roads-surface-${lamps ? 1 : 0}-${opt.transparent ? 1 : 0}`;
  m.name = `roads-surface-${key}`;
  return ctx.registerMaterial(m);
}

// ------------------------------------------------------------------------------------------ textures
/** Load a vertically stacked atlas (width x width*layers) into a DataArrayTexture. */
export async function loadArrayTexture(path: string, layers: number, srgb: boolean, maxSize: number): Promise<THREE.DataArrayTexture> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = path.startsWith('http') ? path : `${import.meta.env.BASE_URL}${path}`;
  await img.decode();
  const w0 = img.naturalWidth;
  const size = Math.min(w0, maxSize);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size * layers;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, size, size * layers);
  const data = new Uint8Array(g.getImageData(0, 0, size, size * layers).data.buffer);
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Procedural tileable noise texture (RGBA): r = fBm, g = crack network, b = fBm (other seed), a = fine noise. */
export function makeNoiseTexture(n = 256): THREE.DataTexture {
  const rnd = mulberry32(7);
  const fbm = (seed: number, oct: number): Float32Array => {
    const out = new Float32Array(n * n);
    let amp = 1, tot = 0;
    const r2 = mulberry32(seed);
    for (let o = 0; o < oct; o++) {
      const g = 4 << o;
      const grid = new Float32Array(g * g);
      for (let i = 0; i < grid.length; i++) grid[i] = r2();
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const fx = (x / n) * g, fy = (y / n) * g;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = fx - x0, ty = fy - y0;
          const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
          const a = grid[(y0 % g) * g + (x0 % g)], b = grid[(y0 % g) * g + ((x0 + 1) % g)];
          const c = grid[((y0 + 1) % g) * g + (x0 % g)], d = grid[((y0 + 1) % g) * g + ((x0 + 1) % g)];
          out[y * n + x] += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
        }
      }
      tot += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= tot;
    // contrast stretch
    let mn = 1, mx = 0;
    for (const v of out) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) / (mx - mn);
    return out;
  };
  const r = fbm(11, 6);
  const b = fbm(23, 5);
  // crack network: wrapped Voronoi F2-F1 edges, modulated
  const np = 40;
  const px: number[] = [], py: number[] = [];
  for (let i = 0; i < np; i++) { px.push(rnd() * n); py.push(rnd() * n); }
  const g = new Float32Array(n * n);
  const jit = fbm(5, 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let d1 = 1e9, d2 = 1e9;
      const xx = x + (jit[y * n + x] - 0.5) * 18, yy = y + (jit[((y + 64) % n) * n + x] - 0.5) * 18;
      for (let i = 0; i < np; i++) {
        let dx = Math.abs(xx - px[i]); dx = Math.min(dx, n - dx);
        let dy = Math.abs(yy - py[i]); dy = Math.min(dy, n - dy);
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      const e = Math.sqrt(d2) - Math.sqrt(d1);
      g[y * n + x] = Math.max(0, 1 - e / 1.6);
    }
  }
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = r[i] * 255;
    data[i * 4 + 1] = g[i] * 255;
    data[i * 4 + 2] = b[i] * 255;
    data[i * 4 + 3] = rnd() * 255;
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lamp grid texture: per 16 m cell up to two nearby lamps (see rsLamps in the shader). */
export function makeLampMap(lamps: Array<{ x: number; z: number; typ: number }>, half: number, cell = 16): { tex: THREE.DataTexture; params: THREE.Vector4 } {
  const n = Math.ceil((2 * half) / cell);
  const data = new Uint8Array(n * n * 4);
  const best = new Float32Array(n * n * 2).fill(1e9);
  const R = 26;
  for (const L of lamps) {
    const ci = Math.floor((L.x + half) / cell), cj = Math.floor((L.z + half) / cell);
    const rc = Math.ceil(R / cell) + 1;
    for (let j = cj - rc; j <= cj + rc; j++) {
      if (j < 0 || j >= n) continue;
      for (let i = ci - rc; i <= ci + rc; i++) {
        if (i < 0 || i >= n) continue;
        const cx = -half + (i + 0.5) * cell, cz = -half + (j + 0.5) * cell;
        const dx = L.x - cx, dz = L.z - cz;
        if (Math.abs(dx) > 31.4 || Math.abs(dz) > 31.4) continue;
        // distance from the lamp to the cell (0 if inside)
        const ex = Math.max(0, Math.abs(dx) - cell / 2), ez = Math.max(0, Math.abs(dz) - cell / 2);
        const d = Math.hypot(ex, ez);
        if (d > R) continue;
        const k = j * n + i;
        const qx = Math.round((dx + 32) * 2), qz = Math.round((dz + 32) * 2);
        const enc = [qx * 2 + (L.typ ? 1 : 0), qz * 2];
        if (d < best[k * 2]) {
          best[k * 2 + 1] = best[k * 2];
          data[k * 4 + 2] = data[k * 4]; data[k * 4 + 3] = data[k * 4 + 1];
          best[k * 2] = d;
          data[k * 4] = enc[0]; data[k * 4 + 1] = enc[1];
        } else if (d < best[k * 2 + 1]) {
          best[k * 2 + 1] = d;
          data[k * 4 + 2] = enc[0]; data[k * 4 + 3] = enc[1];
        }
      }
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, params: new THREE.Vector4(-half, -half, 1 / cell, n) };
}

