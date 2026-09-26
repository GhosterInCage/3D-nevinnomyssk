// Landmark surface material: MeshStandardMaterial (lights, CSM shadows, fog, IBL and the
// sky module's cloud-shadow patch keep working) + procedural surface detail injected with
// onBeforeCompile. Geometry carries per-vertex colour, a metre-scaled surface uv (lmUv) and
// aSurf = (pattern, roughness*255, metalness*255, flags) - see builder.ts P / F.
//
// Patterns: brick bond, slip-form concrete, profiled sheet, 6x1.2 m wall panels, industrial
// glazing (night-lit panes), painted steel with rust runs, gilding, white stone, gratings,
// lamps (steady / blinking obstruction lights), standing-seam roofing, tiles, windows,
// polished granite, asphalt. Weathering: triplanar noise (stains, vertical rain streaks,
// splash-zone darkening near the ground), bump from the pattern relief. Night: floodlit
// facades (FLOOD) and lit windows (WINLIT) scaled by env.night.
import * as THREE from 'three';

export interface LmUniforms {
  lmNoise: THREE.IUniform<THREE.Texture | null>;
  lmNight: THREE.IUniform<number>;
  lmTime: THREE.IUniform<number>;
  lmFlood: THREE.IUniform<THREE.Color>;
  lmLitFrac: THREE.IUniform<number>;
  /** Eternal-flame light: world position (xyz) + intensity (w); lights nearby landmark surfaces. */
  lmFlame: THREE.IUniform<THREE.Vector4>;
}

export function makeLmUniforms(): LmUniforms {
  return {
    lmNoise: { value: null },
    lmNight: { value: 0 },
    lmTime: { value: 0 },
    lmFlood: { value: new THREE.Color(1.0, 0.78, 0.52) },
    lmLitFrac: { value: 0.35 },
    lmFlame: { value: new THREE.Vector4(0, -1e5, 0, 0) },
  };
}

const VERT_PARS = /* glsl */ `
attribute vec4 aSurf;
attribute vec2 lmUv;
varying vec4 vLmSurf;
varying vec3 vLmPos;
varying vec3 vLmNrm;
varying vec2 vLmUv;
varying vec3 vLmW;
varying vec3 vLmWN;
`;

const VERT_MAIN = /* glsl */ `
vLmSurf = aSurf;
vLmPos = transformed;
vLmNrm = objectNormal;
vLmUv = lmUv;
{
  vec4 lmw = vec4(transformed, 1.0);
  vec3 lmn = objectNormal;
  #ifdef USE_INSTANCING
  lmw = instanceMatrix * lmw;
  lmn = mat3(instanceMatrix) * lmn;
  #endif
  vLmW = (modelMatrix * lmw).xyz;
  vLmWN = mat3(modelMatrix) * lmn;
}
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D lmNoise;
uniform float lmNight;
uniform float lmTime;
uniform vec3 lmFlood;
uniform float lmLitFrac;
uniform vec4 lmFlame;
varying vec3 vLmW;
varying vec3 vLmWN;
varying vec4 vLmSurf;
varying vec3 vLmPos;
varying vec3 vLmNrm;
varying vec2 vLmUv;

struct LmS { vec3 alb; vec3 over; float overA; float rough; float metal; float h; vec3 emis; };
LmS lmS;

float lmHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float lmHash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }

vec4 lmTri(vec3 p, vec3 n, float s) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-5);
  return texture2D(lmNoise, p.zy * s) * w.x + texture2D(lmNoise, p.xz * s + 0.37) * w.y + texture2D(lmNoise, p.xy * s + 0.71) * w.z;
}

// fold a bit field
float lmBit(float fl, float b) { return mod(floor(fl / b), 2.0); }
// anti-aliased line mask: d = distance to the line centre (m), w = half width (m), px = m per pixel
float lmLine(float d, float w, float px) { float a = max(px, 1e-4); return (1.0 - smoothstep(w - a, w + a, d)) * min(1.0, 1.5 * w / a); }
// relief only where a feature of width w spans a few pixels (avoids derivative sparkle)
float lmBumpOk(float w, float px) { return 1.0 - smoothstep(w * 0.25, w * 0.8, px); }

void lmSurface(vec3 baseCol) {
  float pat = floor(vLmSurf.x + 0.5);
  float fl = floor(vLmSurf.w + 0.5);
  vec3 p = vLmPos;
  vec3 n = normalize(vLmNrm);
  vec2 uv = vLmUv;
  vec2 fw = fwidth(uv);
  float px = max(max(fw.x, fw.y), 1e-5);           // metres per pixel on this surface
  lmS.alb = vec3(1.0); lmS.over = vec3(0.0); lmS.overA = 0.0;
  lmS.rough = vLmSurf.y / 255.0; lmS.metal = vLmSurf.z / 255.0;
  lmS.h = 0.0; lmS.emis = vec3(0.0);

  vec4 nz = lmTri(p, n, 0.23);
  vec4 nz2 = lmTri(p, n, 0.029);
  float vert = 1.0 - smoothstep(0.55, 0.8, abs(n.y));
  float grime = 1.0 - lmBit(fl, 2.0);
  float var = (nz.g - 0.5) * 0.35 + (nz2.b - 0.5) * 0.45;
  lmS.alb *= 1.0 + var * 0.35;
  lmS.h = (nz.r - 0.5) * 0.0025;

  if (pat < 0.5) {
    // plain painted / rendered
  } else if (pat < 1.5) {
    // CONCRETE: slip-form lifts (1.5 m), formwork boards, stains
    float lift = abs(fract(uv.y / 1.5 + 0.5) - 0.5) * 1.5;
    float j = lmLine(lift, 0.012, px);
    float fade = 1.0 - smoothstep(0.02, 0.08, px);
    lmS.alb *= 1.0 - j * 0.16 * fade;
    lmS.h += -j * 0.006 * lmBumpOk(0.024, px);
    lmS.alb *= 0.92 + nz.r * 0.16;
  } else if (pat < 2.5) {
    // BRICK: 250 x 65 mm, 10 mm joints, running bond
    vec2 b = vec2(uv.x / 0.26, uv.y / 0.075);
    float row = floor(b.y);
    b.x += mod(row, 2.0) * 0.5;
    vec2 cell = floor(b);
    vec2 f = fract(b);
    float mx = min(f.x, 1.0 - f.x) * 0.26, my = min(f.y, 1.0 - f.y) * 0.075;
    float mortar = lmLine(min(mx, my), 0.005, px * 0.7);
    float fade = 1.0 - smoothstep(0.008, 0.025, px);
    float hb = lmHash(cell + floor(p.y * 0.01));
    vec3 tint = vec3(1.0 + (hb - 0.5) * 0.28, 1.0 + (hb - 0.5) * 0.22, 1.0 + (hb - 0.5) * 0.2);
    if (hb > 0.93) tint *= 0.72;                    // over-burnt bricks
    lmS.alb *= mix(vec3(1.0), tint, fade);
    lmS.over = baseCol * 0.35 + vec3(0.42, 0.40, 0.37) * 0.65;
    lmS.overA = mortar * fade * 0.85;
    lmS.h += -mortar * 0.004 * lmBumpOk(0.01, px) + (nz.r - 0.5) * 0.002;
  } else if (pat < 3.5) {
    // CORRUGATED / profiled sheet, ribs along v (period 0.2 m)
    float w = fract(uv.x / 0.2);
    float prof = smoothstep(0.1, 0.25, w) - smoothstep(0.55, 0.7, w);
    float fade = lmBumpOk(0.1, px);
    lmS.h += prof * 0.02 * fade;
    lmS.alb *= 1.0 - (1.0 - fade) * 0.04 + prof * 0.05 * fade;
    // sheet laps every 6 m
    float seam = lmLine(abs(fract(uv.y / 6.0 + 0.5) - 0.5) * 6.0, 0.02, px);
    lmS.alb *= 1.0 - seam * 0.18;
  } else if (pat < 4.5) {
    // PANEL: 6 x 1.2 m reinforced-concrete wall panels
    vec2 g = vec2(uv.x / 6.0, uv.y / 1.2);
    vec2 cell = floor(g); vec2 f = fract(g);
    float sx = min(f.x, 1.0 - f.x) * 6.0, sy = min(f.y, 1.0 - f.y) * 1.2;
    float seam = lmLine(min(sx, sy), 0.018, px);
    float fade = 1.0 - smoothstep(0.05, 0.25, px);
    float hp = lmHash(cell);
    lmS.alb *= 1.0 + (hp - 0.5) * 0.12;
    lmS.alb *= 1.0 - seam * 0.3 * fade;
    lmS.h += -seam * 0.008 * lmBumpOk(0.036, px);
  } else if (pat < 5.5) {
    // GLAZING: steel mullions every 1.5 m, transoms every 1.2 m
    vec2 g = vec2(uv.x / 1.5, uv.y / 1.2);
    vec2 cell = floor(g); vec2 f = fract(g);
    float fx = min(f.x, 1.0 - f.x) * 1.5, fy = min(f.y, 1.0 - f.y) * 1.2;
    float frame = lmLine(min(fx, fy), 0.05, px);
    float fade = 1.0 - smoothstep(0.03, 0.12, px);
    float hp = lmHash(cell + floor(p.xz * 0.01));
    // dusty industrial glass: grey-green, partly translucent-looking
    vec3 glass = vec3(0.11, 0.13, 0.125) * (0.75 + hp * 0.5) * (0.85 + nz.g * 0.3);
    float board = step(0.975, hp);                   // replaced panes (plastic / panels)
    glass = mix(glass, vec3(0.3, 0.3, 0.28), board);
    vec3 frameCol = baseCol;
    vec3 c = mix(glass, frameCol, frame * fade + (1.0 - fade) * 0.25);
    lmS.over = c; lmS.overA = 1.0;
    lmS.rough = mix(0.22 + board * 0.6 + nz.r * 0.15, 0.6, frame * fade);
    lmS.metal = 0.0;
    lmS.h += frame * 0.02 * lmBumpOk(0.1, px);
    // halls are lit section by section (18 m wide, whole glazing band), mercury / sodium lamps;
    // the glow through dusty glass is soft and uneven
    vec2 bay = floor(uv / vec2(18.0, 40.0));
    float hbay = lmHash(bay + floor(p.xz * 0.004) * 7.0);
    float lit = step(hbay, lmLitFrac + 0.12) * (1.0 - board) * (1.0 - frame * fade) * lmBit(fl, 4.0);
    vec3 lampC = hbay < 0.3 ? vec3(0.8, 0.92, 0.85) : vec3(1.0, 0.72, 0.42);
    // (per-pane variation fades out with distance so far facades do not turn into noise)
    float paneVar = mix(0.55 + hp * 0.9, 1.0, 1.0 - fade);
    lmS.emis = lampC * lmNight * (lit * 0.019 * paneVar * (0.88 + nz.g * 0.24) + 0.001) * (1.0 - board);
  } else if (pat < 6.5) {
    // METAL: painted steel with rust runs
    float rust = smoothstep(0.55, 0.8, nz.a) * grime * vert;
    lmS.over = vec3(0.23, 0.11, 0.05);
    lmS.overA = rust * 0.45 + smoothstep(0.7, 0.9, nz2.g) * 0.15;
    lmS.rough = clamp(lmS.rough + (nz.r - 0.5) * 0.2 + rust * 0.3, 0.05, 1.0);
  } else if (pat < 7.5) {
    // GOLD leaf / gilded titanium nitride
    lmS.metal = 1.0;
    lmS.rough = clamp(0.2 + (nz.r - 0.5) * 0.12 + (nz2.g - 0.5) * 0.1, 0.08, 0.5);
    lmS.alb = vec3(1.0);
    lmS.h = (nz.r - 0.5) * 0.0015;
    grime = 0.0;
  } else if (pat < 8.5) {
    // STONE / smooth render
    lmS.alb *= 0.96 + nz.r * 0.08;
    lmS.h = (nz.r - 0.5) * 0.0012;
  } else if (pat < 9.5) {
    // GRATING
    float fade = 1.0 - smoothstep(0.01, 0.04, px);
    float gx = lmLine(abs(fract(uv.x / 0.034) - 0.5) * 0.034, 0.004, px);
    lmS.alb *= mix(0.55, mix(0.25, 1.0, gx), fade);
  } else if (pat < 10.5) {
    // LAMP
    float blink = lmBit(fl, 8.0) > 0.5 ? step(fract(lmTime * 0.75), 0.4) : 1.0;
    float day = lmBit(fl, 16.0);
    lmS.emis = baseCol * blink * (lmNight * 3.0 + day * (1.0 - lmNight) * 6.0);
    lmS.alb = vec3(0.6);
    grime = 0.0;
  } else if (pat < 11.5) {
    // ROOFSEAM: standing seams every 0.55 m along u
    float s = abs(fract(uv.x / 0.55) - 0.5) * 0.55;
    float seam = lmLine(s, 0.012, px);
    lmS.h += seam * 0.025 * lmBumpOk(0.024, px);
    lmS.alb *= 1.0 + seam * 0.08;
  } else if (pat < 12.5) {
    // TILES / slabs 0.6 m
    vec2 g = uv / 0.6; vec2 f = fract(g);
    float gr = lmLine(min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * 0.6, 0.005, px);
    lmS.alb *= (1.0 + (lmHash(floor(g)) - 0.5) * 0.12) * (1.0 - gr * 0.3);
    lmS.h += -gr * 0.003 * lmBumpOk(0.01, px);
  } else if (pat < 13.5) {
    // WINDOW pane (single window geometry): dark glass, lit at night
    float hp = lmHash(floor(p.xz * 0.5) + floor(p.y * 0.3));
    lmS.over = vec3(0.03, 0.04, 0.05); lmS.overA = 1.0;
    lmS.rough = 0.06; lmS.metal = 0.0;
    lmS.emis = vec3(1.0, 0.78, 0.48) * lmNight * lmBit(fl, 4.0) * (0.6 + hp * 0.8) * 0.2;
    grime = 0.0;
  } else if (pat < 14.5) {
    // GRANITE (polished)
    float sp = lmTri(p, n, 2.1).r;
    lmS.alb *= 0.75 + sp * 0.5;
    lmS.rough = 0.18 + (nz.r - 0.5) * 0.1;
    lmS.h = 0.0;
    grime *= 0.3;
  } else {
    // ASPHALT / gravel
    lmS.alb *= 0.85 + nz.r * 0.3;
    lmS.rough = 0.92;
  }

  // weathering: stains, vertical rain streaks, splash zone near the ground
  float streak = clamp((nz.a - 0.5) * 2.2, 0.0, 1.0) * vert;
  float stain = clamp((nz2.g - 0.55) * 2.0, 0.0, 1.0);
  float splash = (1.0 - smoothstep(0.0, 1.2, p.y)) * vert;
  lmS.alb *= 1.0 - grime * (streak * 0.22 + stain * 0.12 + splash * 0.25);
  lmS.rough = clamp(lmS.rough + grime * streak * 0.08, 0.04, 1.0);

  // night floodlighting (warm, from ground projectors)
  if (lmBit(fl, 1.0) > 0.5) {
    // projectors at the foot of the walls: strongest low down and on vertical faces
    float fall = 0.35 + 0.65 * exp(-max(p.y, 0.0) / 22.0);
    float facing = mix(0.35, 1.0, vert);
    lmS.emis += baseCol * lmS.alb * lmFlood * lmNight * fall * facing * 0.11;
  }

  // Eternal flame: a flickering warm point light on the nearby memorial surfaces (inverse square)
  if (lmFlame.w > 0.0) {
    vec3 dF = lmFlame.xyz - vLmW;
    float d2 = dot(dF, dF);
    if (d2 < 900.0 && pat != 10.0) {
      float ndl = max(dot(normalize(vLmWN), dF * inversesqrt(d2)), 0.0);
      vec3 alb = mix(baseCol * lmS.alb, lmS.over, lmS.overA);
      lmS.emis += alb * vec3(1.0, 0.52, 0.18) * lmFlame.w * (0.15 + 0.85 * ndl) / (d2 + 0.6) * (1.0 - smoothstep(300.0, 900.0, d2));
    }
  }
}

vec3 lmPerturb(vec3 surfPos, vec3 surfNorm, float h) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  float dhx = dFdx(h);
  float dhy = dFdy(h);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

type OBC = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => void;

function patch(shader: THREE.WebGLProgramParametersWithUniforms, u: LmUniforms): void {
  Object.assign(shader.uniforms, u);
  let vs = shader.vertexShader;
  vs = vs.replace('#include <common>', `#include <common>\n${VERT_PARS}`);
  vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
  shader.vertexShader = vs;
  let fs = shader.fragmentShader;
  fs = fs.replace('#include <common>', `#include <common>\n${FRAG_PARS}`);
  fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n  vec3 lmBase = diffuseColor.rgb;\n  lmSurface(lmBase);\n  diffuseColor.rgb = mix(diffuseColor.rgb * lmS.alb, lmS.over, lmS.overA);`);
  fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n  roughnessFactor = lmS.rough;`);
  fs = fs.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n  metalnessFactor = lmS.metal;`);
  fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n  normal = lmPerturb(-vViewPosition, normal, lmS.h);`);
  fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance += lmS.emis;`);
  shader.fragmentShader = fs;
}

export interface LmMaterialOptions {
  side?: THREE.Side;
  name?: string;
  envMapIntensity?: number;
}

/** Create a landmark material (vertex colours + procedural surface). Register it with ctx.registerMaterial. */
export function createLmMaterial(u: LmUniforms, opts: LmMaterialOptions = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    side: opts.side ?? THREE.FrontSide,
    envMapIntensity: opts.envMapIntensity ?? 1,
  });
  m.name = opts.name ?? 'landmark';
  const mine: OBC = (shader) => patch(shader, u);
  m.onBeforeCompile = mine;
  m.customProgramCacheKey = () => `landmarks-v2-${m.side}`;
  return m;
}
