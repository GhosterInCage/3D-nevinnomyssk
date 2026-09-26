// GLSL for the building material (injected into MeshStandardMaterial via
// onBeforeCompile so that lights, CSM shadows, fog, env maps and the path
// tracer's standard-material path keep working).
//
// Everything procedural: facade grids, parallax-recessed windows with interior
// mapping, frames, curtains, panel seams, bricks, plaster, weathering, roofing
// profiles, night-time lit windows. See mesher.ts for the vertex attributes.

export const VERT_PARS = /* glsl */ `
attribute vec4 aA;
attribute vec4 aC;
attribute vec4 aW;
flat varying vec4 vA;
flat varying vec4 vW;
varying vec4 vC;
varying vec2 vUvB;
varying vec3 vWPos;
varying vec3 vWNrm;
`;

export const VERT_MAIN = /* glsl */ `
vA = aA; vC = aC; vW = aW; vUvB = uv;
{
  vec4 bwp = modelMatrix * vec4(transformed, 1.0);
  vWPos = bwp.xyz;
  vWNrm = normalize(mat3(modelMatrix) * objectNormal);
}
`;

export const FRAG_PARS = /* glsl */ `
uniform sampler2D uNoise;
uniform float uNight;
uniform float uDay;
uniform float uTime;
uniform float uLitFrac;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uGroundRefl;
uniform float uDetail;
uniform float uDetailDist;
flat varying vec4 vA;
flat varying vec4 vW;
varying vec4 vC;
varying vec2 vUvB;
varying vec3 vWPos;
varying vec3 vWNrm;

vec3 bAlbedo; float bRough; float bMetal; vec3 bN; vec3 bEmis; float bAO; float bGlass; float bLitId;

float bh11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float bh21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 bh22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 bLin(vec3 c) { return c * c * (c * 0.3 + 0.7); } // cheap sRGB -> linear
float bBox(float x, float a, float b, float w) { return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x); }
float bRect(vec2 p, vec2 lo, vec2 hi, float w) { return bBox(p.x, lo.x, hi.x, w) * bBox(p.y, lo.y, hi.y, w); }
vec4 bNoise(vec2 uv) { return texture2D(uNoise, uv); }
// explicit-LOD lookup (safe inside branches); f = texture uv units per metre, px = metres per pixel
vec4 bNoiseL(vec2 uv, float f, float px) { return textureLod(uNoise, uv, max(0.0, log2(max(px * f * 512.0, 1e-6)))); }
float bFlag(float flags, float bit) { return mod(floor(flags / bit), 2.0); }

// ------------------------------------------------------------ fake environment reflection (when no env map)
vec3 bSky(vec3 R) {
  float up = R.y;
  vec3 sky = mix(uSkyHorizon, uSkyZenith, smoothstep(0.0, 0.6, up));
  vec3 city = uGroundRefl * (0.7 + 0.6 * bh11(floor(atan(R.x, R.z) * 24.0)));
  float skyline = 0.06 + 0.1 * bh11(floor(atan(R.x, R.z) * 40.0));
  return up > skyline ? sky : mix(city, uGroundRefl * 0.6, smoothstep(0.0, -0.4, up));
}

// ------------------------------------------------------------ interior mapping
// o: point on the glass plane in room coords (x across [0,w], y up from floor [0,h], z=0 at glass),
// d: ray direction (tangent space: x along wall, y up, z out of the wall; into the room is -z)
vec3 bInterior(vec3 o, vec3 d, float w, float h, float depth, float rnd, float lit, out float dist) {
  vec3 dd = d;
  dd.z = min(dd.z, -0.05);
  float tx = dd.x > 0.0 ? (w - o.x) / dd.x : (0.0 - o.x) / min(dd.x, -1e-4);
  float ty = dd.y > 0.0 ? (h - o.y) / dd.y : (0.0 - o.y) / min(dd.y, -1e-4);
  float tz = (-depth - o.z) / dd.z;
  float t = min(tx, min(ty, tz));
  vec3 p = o + dd * t;
  dist = -p.z;
  vec3 wallpaper = mix(vec3(0.62, 0.55, 0.42), vec3(0.55, 0.60, 0.52), bh11(rnd * 13.1));
  wallpaper = mix(wallpaper, vec3(0.70, 0.66, 0.60), bh11(rnd * 7.7));
  vec3 col;
  if (t == tz) {
    col = wallpaper;
    // furniture silhouettes on the back wall (wardrobe / sofa / shelf)
    float f1 = bh11(rnd * 3.3);
    float fx0 = w * (0.1 + 0.4 * f1), fx1 = fx0 + w * (0.25 + 0.3 * bh11(rnd * 5.1));
    float fh = h * (0.35 + 0.5 * bh11(rnd * 9.2));
    if (p.x > fx0 && p.x < fx1 && p.y < fh) col = mix(vec3(0.20, 0.13, 0.08), vec3(0.35, 0.30, 0.26), bh11(rnd * 2.9));
    // picture / carpet on wall (very Soviet)
    if (bh11(rnd * 4.4) > 0.55 && abs(p.x - w * 0.5) < w * 0.22 && p.y > h * 0.35 && p.y < h * 0.75) col = vec3(0.45, 0.12, 0.08);
  } else if (t == ty) {
    col = dd.y > 0.0 ? vec3(0.78, 0.77, 0.74) : mix(vec3(0.30, 0.19, 0.11), vec3(0.42, 0.32, 0.22), bh11(rnd * 1.7));
  } else {
    col = wallpaper * 0.85;
  }
  // light: daylight falls off with depth; artificial light from the ceiling
  float dayL = uDay * (0.018 + 0.05 * exp(-dist * 0.5));
  float lk = bh11(rnd * 8.8);
  vec3 lampC = lk < 0.55 ? vec3(1.0, 0.66, 0.34) : lk < 0.8 ? vec3(1.0, 0.8, 0.55) : vec3(0.9, 0.92, 0.95);
  if (bh11(rnd * 6.6) > 0.93) lampC = vec3(0.55, 0.65, 1.0); // TV glow
  float lamp = lit * (0.55 + 0.45 * smoothstep(h, 0.0, length(p - vec3(w * 0.5, h, -depth * 0.5)) * 0.6));
  return col * (dayL + lamp * lampC * 0.13);
}

// ------------------------------------------------------------ one window (opening + recessed glass)
// f: position in the cell (metres), win: (x0, y0, x1, y1) opening rect in the cell,
// Vt: view direction in tangent space, room: (w, h, yFloorOffset), rid: random id of this window.
// Writes albedo/rough/metal/normal (tangent) / emissive. Returns 1 if the pixel belongs to the opening.
float bWindow(vec2 f, vec4 win, vec3 Vt, vec3 room, float rid, float px, float frameType, float sashes, bool transom,
              vec3 wallCol, inout vec3 alb, inout float rough, inout float metal, inout vec3 nT, inout vec3 emis, inout float ao) {
  float inOpen = bRect(f, win.xy, win.zw, px * 0.7);
  // metal window sill (otliv) below the opening
  float sill = bBox(f.x, win.x - 0.05, win.z + 0.05, px) * bBox(f.y, win.y - 0.06, win.y, px);
  if (sill > 0.5 && inOpen < 0.5) {
    alb = mix(alb, vec3(0.62, 0.62, 0.60), sill); rough = 0.45; metal = 0.3;
    nT = normalize(vec3(0.0, -0.6, 1.0));
    return 0.0;
  }
  // dark sealant / shadow line around the opening
  float ring = bRect(f, win.xy - 0.025, win.zw + 0.025, px * 0.7) * (1.0 - inOpen);
  alb = mix(alb, alb * 0.45, ring * 0.8);
  if (inOpen < 0.01) return 0.0;
  float depth = 0.2;
  vec2 gp = f;
  bool reveal = false;
  vec3 revN = vec3(0.0, 0.0, 1.0);
  if (uDetail > 0.5 && px < 0.05) {
    vec2 off = -Vt.xy / max(Vt.z, 0.08) * depth;
    gp = f + off;
    if (gp.x < win.x) { reveal = true; revN = vec3(1.0, 0.0, 0.0); }
    else if (gp.x > win.z) { reveal = true; revN = vec3(-1.0, 0.0, 0.0); }
    else if (gp.y > win.w) { reveal = true; revN = vec3(0.0, -1.0, 0.0); }
    else if (gp.y < win.y) { reveal = true; revN = vec3(0.0, 1.0, 0.0); }
  }
  if (reveal) {
    alb = mix(alb, wallCol * 0.85, inOpen); rough = 0.9; metal = 0.0;
    nT = revN; ao *= 0.75;
    return inOpen;
  }
  // frames
  vec3 frameCol = frameType < 0.62 ? vec3(0.86, 0.86, 0.84) : frameType < 0.78 ? vec3(0.28, 0.16, 0.09) :
                  frameType < 0.95 ? vec3(0.70, 0.68, 0.62) : vec3(0.55, 0.57, 0.58);
  float fw = frameType < 0.62 ? 0.065 : 0.05;
  vec2 lp = gp - win.xy;
  vec2 sz = win.zw - win.xy;
  float frame = 1.0 - bRect(lp, vec2(fw), sz - fw, px * 0.6);
  // mullions
  for (int k = 1; k < 3; k++) {
    if (float(k) < sashes) {
      float mx = sz.x * float(k) / sashes;
      frame = max(frame, bBox(lp.x, mx - fw * 0.6, mx + fw * 0.6, px * 0.6));
    }
  }
  if (transom) {
    float ty = sz.y * 0.72;
    frame = max(frame, bBox(lp.y, ty - fw * 0.5, ty + fw * 0.5, px * 0.6) * step(lp.x, sz.x / sashes));
  }
  // curtains / tulle (in glass-plane coords)
  float cl = 0.35 * bh11(rid * 3.7), cr = 0.35 * bh11(rid * 5.3);
  float curtain = step(lp.x, sz.x * cl) + step(sz.x * (1.0 - cr), lp.x);
  float tulle = step(0.5, bh11(rid * 9.1)) * 0.6;
  vec3 curtainCol = mix(vec3(0.75, 0.68, 0.52), vec3(0.45, 0.18, 0.14), step(0.7, bh11(rid * 2.1)));
  curtainCol = mix(curtainCol, vec3(0.35, 0.45, 0.35), step(0.88, bh11(rid * 4.9)));
  // lit at night?
  float lit = step(bLitId, uLitFrac) * uNight;
  // interior
  vec3 o = vec3(gp.x - (win.x + win.z) * 0.5 + room.x * 0.5, gp.y + room.z, 0.0);
  vec3 dir = -Vt;
  float dist;
  vec3 inter;
  if (uDetail > 0.5 && px < 0.08) inter = bInterior(o, dir, room.x, room.y, 4.5, rid, lit, dist);
  else inter = vec3(0.35, 0.3, 0.25) * (uDay * 0.06 + lit * 0.12);
  float lk = bh11(rid * 8.8);
  vec3 lampC = lk < 0.55 ? vec3(1.0, 0.66, 0.34) : lk < 0.8 ? vec3(1.0, 0.8, 0.55) : vec3(0.9, 0.92, 0.95);
  // tulle diffuses daylight / lamp light
  vec3 tulleCol = vec3(0.85, 0.84, 0.80) * (uDay * 0.07 + lit * lampC * 0.13);
  inter = mix(inter, tulleCol, tulle);
  vec3 curt = curtainCol * (uDay * 0.06 + lit * lampC * 0.09);
  inter = mix(inter, curt, clamp(curtain, 0.0, 1.0));
  // glass: dark, glossy, slightly tilted per pane (varied reflections)
  vec2 tilt = (bh22(vec2(rid, rid * 1.3)) - 0.5) * 0.06;
  vec3 gN = normalize(vec3(tilt, 1.0));
  float cosv = clamp(dot(normalize(Vt), gN), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);
  vec3 glassEmis = inter * (1.0 - F) * 0.85;
  float isFrame = clamp(frame, 0.0, 1.0);
  alb = mix(mix(alb, vec3(0.01), inOpen), frameCol, isFrame * inOpen);
  rough = mix(mix(rough, 0.04 + 0.05 * bh11(rid), inOpen), 0.5, isFrame * inOpen);
  metal = mix(metal, 0.0, inOpen);
  nT = normalize(mix(nT, gN, inOpen * (1.0 - isFrame)));
  // the head of the opening shades the top of the pane
  float headShade = mix(0.55, 1.0, smoothstep(0.0, 0.35, win.w - gp.y));
  emis += glassEmis * inOpen * (1.0 - isFrame);
  bGlass = inOpen * (1.0 - isFrame) * headShade;
  ao *= mix(1.0, headShade, inOpen);
  ao *= mix(1.0, 0.9, inOpen);
  return inOpen;
}
`;

// Main surface evaluation: sets bAlbedo, bRough, bMetal, bN (world), bEmis, bAO.
export const FRAG_SURFACE = /* glsl */ `
void bSurface() {
  float kind = floor(vA.x + 0.5);
  float style = floor(vA.y + 0.5);
  float seed = vA.z;
  float levels = vA.w;
  vec3 N = normalize(vWNrm);
  vec3 base = bLin(vC.rgb);
  bAlbedo = base; bRough = 0.85; bMetal = 0.0; bN = N; bEmis = vec3(0.0); bAO = 1.0; bGlass = 0.0; bLitId = 1.0;
  vec3 V = normalize(cameraPosition - vWPos);
  float distCam = length(cameraPosition - vWPos);
  vec2 p = vUvB;
  vec2 fwv = fwidth(p);
  float px = max(max(fwv.x, fwv.y), 1e-4);

  if (kind < 0.5 || kind > 5.5 && kind < 6.5) {
    // ===================================================================== WALLS / GLAZING
    vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
    vec3 B = vec3(0.0, 1.0, 0.0);
    if (abs(N.y) > 0.5) { T = vec3(1.0, 0.0, 0.0); B = normalize(cross(N, T)); }
    vec3 Vt = vec3(dot(V, T), dot(V, B), dot(V, N));
    vec3 nT = vec3(0.0, 0.0, 1.0);
    vec3 alb = base;
    float rough = 0.85, metal = 0.0, ao = 1.0;
    vec3 emis = vec3(0.0);
    vec4 nz = bNoiseL(p * 0.013 + seed * 0.37, 0.013, px);
    vec4 nf = px < 0.06 ? bNoiseL(p * 0.21 + seed * 0.11, 0.21, px) : vec4(0.5);

    if (kind > 5.5) {
      // --------------------------------------------------------- balcony glazing panel
      float ft = vC.a * 255.0;
      float frameType = ft < 0.5 ? 0.3 : ft < 1.5 ? 0.7 : ft < 2.5 ? 0.9 : 0.99;
      float cw = 0.75;
      float cx = floor(p.x / cw);
      bLitId = bh21(vec2(floor(vWPos.x * 0.3) + floor(vWPos.z * 0.3), floor(vWPos.y / 2.8)));
      vec2 f = vec2(p.x - cx * cw, p.y);
      float hgt = 1.4;
      vec4 win = vec4(0.0, 0.0, cw, 5.0);
      bWindow(f, win, Vt, vec3(cw * 3.0, 2.6, 0.9), bh21(vec2(cx, seed) + floor(vWPos.y / 2.8) * 7.0), px, frameType, 1.0, false, alb, alb, rough, metal, nT, emis, ao);
      alb = mix(alb, vec3(0.2, 0.2, 0.2), 0.0);
      vec3 Nw = normalize(T * nT.x + B * nT.y + N * nT.z);
#ifndef USE_ENVMAP
      if (bGlass > 0.0) {
        float Fr = 0.04 + 0.96 * pow(1.0 - clamp(dot(V, Nw), 0.0, 1.0), 5.0);
        emis += bSky(reflect(-V, Nw)) * Fr * bGlass;
      }
#endif
      bAlbedo = alb; bRough = rough; bMetal = metal; bN = Nw; bEmis = emis; bAO = ao;
      return;
    }

    float L = vW.x * 0.01;
    float cellW = max(vW.y * 0.01, 0.5);
    float nCols = mod(vW.z, 256.0);
    float secCols = floor(vW.z / 256.0);
    float wflags = mod(vW.w, 256.0);
    float floorH = max(floor(vW.w / 256.0) * 0.1, 2.0);
    bool entranceWall = bFlag(wflags, 1.0) > 0.5;
    bool shopWall = bFlag(wflags, 2.0) > 0.5;
    bool gable = bFlag(wflags, 4.0) > 0.5;
    bool parapetBand = bFlag(wflags, 32.0) > 0.5;
    bool isHole = bFlag(wflags, 16.0) > 0.5;

    // ------------------------------------------------ base facade material
    float isBrick = (style == 2.0 || style == 4.0 || style == 10.0 && seed > 128.0) ? 1.0 : 0.0;
    if (style == 7.0 && bh11(seed) > 0.5) isBrick = 1.0;
    float isPanel = (style == 3.0 || style == 5.0) ? 1.0 : 0.0;
    float farT = smoothstep(0.015, 0.05, px);
    if (farT > 0.999) {
      // distant: pattern averages only (cheap path)
      if (isBrick > 0.5) alb = mix(base, vec3(0.55, 0.53, 0.50), 0.16);
      else if (style == 9.0 || style == 11.0) { alb = base * 0.95; rough = 0.55; metal = 0.25; }
      else if (style == 8.0) { alb = base * 0.93; rough = 0.5; metal = 0.2; }
      else alb = base * 0.97;
    } else if (isBrick > 0.5) {
      vec2 bs = vec2(0.26, 0.077);
      float row = floor(p.y / bs.y);
      float xx = p.x / bs.x + 0.5 * mod(row, 2.0);
      float bx = floor(xx);
      vec2 f = vec2(fract(xx) * bs.x, fract(p.y / bs.y) * bs.y);
      float m = 1.0 - bRect(f, vec2(0.006), bs - 0.006, px * 0.5);
      float h = bh21(vec2(bx, row) + seed);
      vec3 bc = base * (0.86 + 0.26 * h) * (0.94 + 0.12 * nf.b);
      if (h > 0.93) bc *= 0.8; // burnt bricks
      vec3 mortar = mix(vec3(0.55, 0.53, 0.50), base * 1.1, 0.25);
      vec3 detailed = mix(bc, mortar, m);
      vec3 avg = mix(base, mortar, 0.18);
      alb = mix(detailed, avg, farT);
      ao *= mix(1.0 - 0.25 * m, 1.0, farT);
      rough = 0.9;
    } else if (isPanel > 0.5) {
      // large panels: one per bay and floor, seams + sealant patches
      float pw = cellW;
      float margin = (L - nCols * cellW) * 0.5;
      float pu = (p.x - margin) / pw;
      float pcol = floor(pu);
      float prow = floor(p.y / floorH);
      vec2 f = vec2(fract(pu) * pw, p.y - prow * floorH);
      float seam = 1.0 - bRect(f, vec2(0.02), vec2(pw, floorH) - 0.02, px * 0.6);
      float patchV = step(0.55, bh21(vec2(pcol, seed))) * bBox(f.x, -0.07, 0.07, px) ;
      float patchH = step(0.6, bh21(vec2(prow, seed + 3.0))) * bBox(f.y, -0.06, 0.06, px);
      float hp = bh21(vec2(pcol, prow) + seed * 0.1);
      vec3 pc = base * (0.9 + 0.14 * hp) * (0.88 + 0.24 * nf.b);
      // weathered panels: darker lower edges and rust stains from the joints
      pc *= 1.0 - 0.08 * smoothstep(0.4, 0.0, f.y) ;
      // tiled finish on some series: fine grid
      if (style == 5.0 && bh11(seed + 2.0) > 0.5) {
        vec2 tg = fract(p / 0.05);
        pc *= 0.97 + 0.03 * step(0.1, min(tg.x, tg.y));
      }
      vec3 detailed = mix(pc, vec3(0.30, 0.30, 0.31), seam * 0.85);
      detailed = mix(detailed, vec3(0.24, 0.24, 0.25), clamp(patchV + patchH, 0.0, 1.0) * 0.8);
      alb = mix(detailed, base * 0.96, farT);
      rough = 0.88;
    } else if (style == 9.0 || style == 11.0) {
      // corrugated / sandwich cladding with vertical ribs
      float per = style == 9.0 ? 0.25 : 0.2;
      float r = fract(p.x / per);
      float slope = (smoothstep(0.1, 0.2, r) - smoothstep(0.5, 0.6, r)) * 2.0 - 1.0;
      nT = normalize(vec3(slope * 0.35 * (1.0 - farT), 0.0, 1.0));
      alb = base * (0.92 + 0.08 * nf.b);
      float panelSeam = style == 9.0 ? bBox(fract(p.y / 1.2) * 1.2, -0.01, 0.015, px) : 0.0;
      alb *= 1.0 - 0.3 * panelSeam * (1.0 - farT);
      rough = 0.55; metal = 0.25;
    } else if (style == 15.0) {
      // vinyl siding: horizontal laps
      float r = fract(p.y / 0.2);
      nT = normalize(vec3(0.0, (r - 0.5) * 0.25 * (1.0 - farT), 1.0));
      alb = base * (0.9 + 0.1 * r);
      rough = 0.6;
    } else if (style == 8.0) {
      // composite cladding panels
      vec2 g = fract(p / vec2(1.2, 0.6));
      float seam = 1.0 - bRect(g * vec2(1.2, 0.6), vec2(0.01), vec2(1.19, 0.59), px);
      alb = mix(base, base * 0.6, seam * (1.0 - farT));
      rough = 0.5; metal = 0.2;
    } else {
      // plaster / render
      float g = nf.g;
      alb = base * (0.92 + 0.14 * g) * (0.96 + 0.08 * nf.b);
      rough = 0.92;
      if (style == 6.0) {
        // stalinka rustication on the ground floor
        float rr = fract(p.y / 0.35);
        float groove = bBox(rr, -0.02, 0.05, px / 0.35) * step(p.y, floorH) * step(0.0, p.y);
        alb *= 1.0 - 0.25 * groove * (1.0 - farT);
      }
    }
    // large-scale colour variation & grime
    alb *= 0.9 + 0.2 * nz.r;

    // ------------------------------------------------ socle (below the ground floor)
    float wallTopV = levels * floorH;
    if (p.y < 0.0 && !parapetBand) {
      vec3 sc = style == 1.0 || style == 2.0 || style == 15.0 ? vec3(0.42, 0.40, 0.37) : vec3(0.50, 0.49, 0.47);
      alb = sc * (0.85 + 0.2 * nf.g) * (0.9 + 0.2 * nz.r);
      rough = 0.95;
      // basement vents on apartment blocks
      if (isPanel + isBrick > 0.5 && levels >= 4.0) {
        float vu = fract(p.x / 3.0) * 3.0;
        float vent = bRect(vec2(vu, p.y), vec2(1.3, -0.55), vec2(1.7, -0.3), px);
        alb = mix(alb, vec3(0.05), vent);
      }
    }
    // band between socle and first floor
    alb = mix(alb, alb * 0.8, bBox(p.y, -0.06, 0.04, px) * (1.0 - farT));

    // ------------------------------------------------ windows
    float margin = (L - nCols * cellW) * 0.5;
    float cu = (p.x - margin) / cellW;
    float col = floor(cu);
    float row = floor(p.y / floorH);
    vec2 f = vec2((cu - col) * cellW, p.y - row * floorH);
    bool inGrid = col >= 0.0 && col < nCols && row >= 0.0 && row < levels && !gable && !parapetBand && p.y >= 0.0;
    float ww = 1.4, wh = 1.45, sill = 0.85, sashes = 2.0; bool transom = false;
    float sd = bh11(seed * 1.7);
    if (style == 1.0 || style == 2.0 || style == 15.0) { ww = 1.25 + 0.3 * sd; wh = 1.4; sill = 0.9; sashes = 2.0 + step(0.6, sd); }
    else if (style == 3.0) { ww = 1.45; wh = 1.45; sill = 0.8; transom = true; }
    else if (style == 4.0) { ww = 1.5; wh = 1.5; sill = 0.8; transom = sd > 0.5; }
    else if (style == 5.0) { ww = mix(1.5, 1.8, step(0.5, bh11(col + seed))); wh = 1.45; sill = 0.8; sashes = 2.0 + step(1.7, ww); }
    else if (style == 6.0) { ww = 1.35; wh = 2.0; sill = 0.9; transom = true; }
    else if (style == 7.0) { ww = min(cellW - 0.5, 2.6); wh = 2.1; sill = 0.9; sashes = 3.0; transom = true; }
    else if (style == 8.0) { ww = min(cellW - 0.8, 2.4); wh = 1.8; sill = 1.0; sashes = 2.0; }
    else if (style == 9.0) { ww = cellW * 0.85; wh = 1.6; sill = floorH - 2.2; sashes = 3.0; }
    else if (style == 11.0) { ww = 1.2; wh = 0.7; sill = floorH - 1.2; sashes = 2.0; inGrid = inGrid && mod(col, 2.0) < 0.5; }
    else if (style == 13.0) { ww = 1.6; wh = 1.6; sill = 0.8; sashes = 2.0; }
    else if (style == 14.0) { ww = 1.7; wh = 1.8; sill = 0.9; sashes = 3.0; transom = true; }
    else if (style == 12.0) { ww = cellW - 0.06; wh = floorH - 0.06; sill = 0.03; sashes = 1.0; }
    else if (style == 0.0 || style == 10.0) { inGrid = false; }
    ww = min(ww, cellW - 0.4);
    wh = min(wh, floorH - sill - 0.25);
    bool stair = entranceWall && secCols > 0.0 && mod(col, secCols) == floor(secCols * 0.5);
    float rid = bh21(vec2(col + 17.0 * floor(vWPos.x * 0.01) + seed, row * 13.0 + floor(vWPos.z * 0.01)));
    // lights are switched per flat (~2 bays) and per building mood, not per window
    float wallKey = floor(vWPos.x * 0.02) * 7.0 + floor(vWPos.z * 0.02) * 13.0;
    bLitId = bh21(vec2(floor((col + mod(seed, 2.0)) / 2.0) + seed * 3.1, row * 7.0 + wallKey));
    bLitId = clamp(bLitId + (bh11(seed * 5.3) - 0.5) * 0.35, 0.0, 1.0);
    // private houses: few rooms per facade, curtains / shutters drawn -> fewer visible lit windows
    if (style == 1.0 || style == 2.0 || style == 15.0) bLitId = min(1.0, bLitId / 0.6);
    float frameType = bh11(rid * 2.3 + seed * 0.01);
    if (bh11(seed + 9.0) < 0.35) frameType = 0.3; // renovated building: all white PVC
    vec3 wallCol = alb;

    // far-field: average windows into the facade to avoid aliasing / moire
    float winFar = smoothstep(cellW * 0.12, cellW * 0.4, px);
    if (inGrid && winFar > 0.99) {
      float cover = (ww * wh) / (cellW * floorH);
      float lit = step(bLitId, uLitFrac) * uNight;
      vec3 winAvg = vec3(0.035, 0.04, 0.05);
      alb = mix(alb, winAvg, cover * 0.9);
      rough = mix(rough, 0.3, cover);
      emis += vec3(1.0, 0.7, 0.4) * lit * cover * 0.1;
    } else if (inGrid) {
      vec3 Vtl = Vt;
      bool door = false;
      vec4 win = vec4((cellW - ww) * 0.5, sill, (cellW + ww) * 0.5, sill + wh);
      vec3 room = vec3(cellW, floorH - 0.25, 0.0);
      if (stair) {
        // staircase: narrower windows shifted by half a floor; entrance door on the ground floor
        float sw = 1.0;
        if (row < 0.5) {
          door = true;
        } else {
          win = vec4((cellW - sw) * 0.5, sill - floorH * 0.5 + 0.2, (cellW + sw) * 0.5, sill - floorH * 0.5 + 0.2 + 1.2);
        }
      }
      bool shopFront = row < 0.5 && (shopWall || (style == 8.0 && (entranceWall || shopWall || L > 14.0)));
      if (shopFront && !door) {
        win = vec4(0.25, 0.35, cellW - 0.25, floorH - 0.75);
        sashes = 2.0; transom = false; frameType = 0.99;
        room = vec3(cellW, floorH, 0.0);
      }
      if (style == 10.0) door = false;
      bool houseStyle = style == 1.0 || style == 2.0 || style == 15.0;
      bool houseDoor = houseStyle && entranceWall && nCols >= 2.0 && col == nCols - 1.0 && row < 0.5;
      if (houseDoor) door = true;
      if (door) {
        float dw = houseDoor ? 0.95 : 1.3;
        vec4 dr = vec4((cellW - dw) * 0.5, 0.0, (cellW + dw) * 0.5, houseDoor ? 2.05 : 2.15);
        float inD = bRect(f, dr.xy, dr.zw, px);
        float dk = bh11(seed + col * 1.7);
        vec3 dc = dk < 0.4 ? vec3(0.18, 0.16, 0.15) : dk < 0.7 ? vec3(0.32, 0.22, 0.14) : dk < 0.85 ? vec3(0.45, 0.2, 0.12) : vec3(0.2, 0.28, 0.2);
        float frame = 1.0 - bRect(f, dr.xy + 0.06, dr.zw - 0.06, px);
        // two recessed panels + handle
        vec2 dl = f - dr.xy;
        float dW = dr.z - dr.x, dH = dr.w - dr.y;
        float pan = bRect(dl, vec2(0.14, 0.18), vec2(dW - 0.14, dH * 0.45), px) + bRect(dl, vec2(0.14, dH * 0.52), vec2(dW - 0.14, dH - 0.16), px);
        float handle = bRect(dl, vec2(dW - 0.2, dH * 0.46), vec2(dW - 0.12, dH * 0.5), px);
        vec3 dcol = mix(dc, dc * 0.7, frame);
        dcol = mix(dcol, dc * 0.85, clamp(pan, 0.0, 1.0));
        dcol = mix(dcol, vec3(0.7, 0.68, 0.6), handle);
        alb = mix(alb, dcol, inD);
        nT = mix(nT, normalize(vec3(0.0, 0.25, 1.0)), clamp(pan, 0.0, 1.0) * inD * 0.5);
        rough = mix(rough, 0.45, inD); metal = mix(metal, 0.5, inD);
        // lamp glow pool on the wall above the door at night
        float gl = exp(-length((f - vec2(cellW * 0.5, 2.8)) * vec2(1.2, 1.6)) * 1.5);
        emis += vec3(1.0, 0.78, 0.5) * gl * uNight * 0.18;
      } else if (px > 0.06) {
        // mid distance: no parallax / interior, but frames stay visible as anti-aliased lines
        // (averaging them into the pane made windows read as flat coloured tiles)
        float inW = bRect(f, win.xy, win.zw, px);
        float lit = step(bLitId, uLitFrac) * uNight;
        float lk = bh11(rid * 8.8);
        vec3 lampC = lk < 0.55 ? vec3(1.0, 0.66, 0.34) : lk < 0.8 ? vec3(1.0, 0.8, 0.55) : vec3(0.9, 0.92, 0.95);
        vec3 frameCol = frameType < 0.62 ? vec3(0.86, 0.86, 0.84) : frameType < 0.78 ? vec3(0.28, 0.16, 0.09) :
                        frameType < 0.95 ? vec3(0.70, 0.68, 0.62) : vec3(0.55, 0.57, 0.58);
        float fw = frameType < 0.62 ? 0.065 : 0.05;
        vec2 lp = f - win.xy;
        vec2 sz = win.zw - win.xy;
        float fr = 1.0 - bRect(lp, vec2(fw), sz - fw, px * 0.5);
        for (int k = 1; k < 3; k++) {
          if (float(k) < sashes) {
            float mx = sz.x * float(k) / sashes;
            fr = max(fr, bBox(lp.x, mx - fw * 0.6, mx + fw * 0.6, px * 0.5));
          }
        }
        if (transom) fr = max(fr, bBox(lp.y, sz.y * 0.72 - fw * 0.5, sz.y * 0.72 + fw * 0.5, px * 0.5) * step(lp.x, sz.x / sashes));
        fr = clamp(fr, 0.0, 1.0);
        // curtains / tulle seen through the glass (a hint of the interior)
        float cl = 0.35 * bh11(rid * 3.7), cr = 0.35 * bh11(rid * 5.3);
        float curtain = clamp(step(lp.x, sz.x * cl) + step(sz.x * (1.0 - cr), lp.x), 0.0, 1.0);
        float tulle = step(0.5, bh11(rid * 9.1)) * 0.5;
        vec3 curtainCol = mix(vec3(0.75, 0.68, 0.52), vec3(0.45, 0.18, 0.14), step(0.7, bh11(rid * 2.1)));
        vec3 inside = mix(vec3(0.012), vec3(0.05), tulle);
        inside = mix(inside, curtainCol * 0.08, curtain * 0.8);
        vec3 glassAlb = inside;
        alb = mix(alb, mix(glassAlb, frameCol, fr), inW);
        rough = mix(rough, mix(0.06, 0.5, fr), inW);
        metal = mix(metal, 0.0, inW);
        emis += (lampC * lit * mix(0.11, 0.08, tulle)) * inW * (1.0 - fr);
        bGlass = inW * (1.0 - fr) * 0.85;
        nT = mix(nT, normalize(vec3((bh22(vec2(rid, rid * 1.3)) - 0.5) * 0.06, 1.0)), inW * (1.0 - fr));
        ao *= mix(1.0, 0.85, inW * smoothstep(win.w - 0.3, win.w, f.y));
      } else {
        bWindow(f, win, Vtl, room, rid, px, frameType, sashes, transom, wallCol, alb, rough, metal, nT, emis, ao);
      }
      // stalinka window surrounds
      if (style == 6.0 && !stair) {
        float sur = bRect(f, win.xy - 0.12, win.zw + vec2(0.12, 0.22), px) * (1.0 - bRect(f, win.xy, win.zw, px));
        alb = mix(alb, wallCol * 1.12, sur * 0.8);
      }
      // private houses: painted window trims (nalichniki) and shutters on some houses
      if (houseStyle && !door) {
        float hs = bh11(seed * 4.1);
        if (hs > 0.5) {
          vec3 trimC = hs > 0.85 ? vec3(0.25, 0.45, 0.62) : hs > 0.78 ? vec3(0.30, 0.50, 0.32) : vec3(0.85, 0.85, 0.82);
          float sur = bRect(f, win.xy - vec2(0.1, 0.08), win.zw + vec2(0.1, 0.16), px) * (1.0 - bRect(f, win.xy, win.zw, px));
          alb = mix(alb, trimC, sur);
        }
        if (bh11(seed * 7.7) > 0.88) {
          float sw = (win.z - win.x) * 0.5;
          float sh = bRect(f, vec2(win.x - sw - 0.1, win.y), vec2(win.x - 0.1, win.w), px) + bRect(f, vec2(win.z + 0.1, win.y), vec2(win.z + sw + 0.1, win.w), px);
          vec3 shC = bh11(seed * 3.3) > 0.5 ? vec3(0.22, 0.38, 0.25) : vec3(0.22, 0.32, 0.5);
          shC *= 0.85 + 0.15 * step(0.5, fract(f.y / 0.12));
          alb = mix(alb, shC, clamp(sh, 0.0, 1.0));
        }
      }
      // dirt streaks below the window
      if (px < 0.06) {
        float below = step(f.y, win.y) * bBox(f.x, win.x, win.z, 0.1) * smoothstep(win.y - 2.0, win.y, f.y);
        float streak = bNoiseL(vec2(p.x * 0.6, p.y * 0.05) + seed, 0.6, px).a;
        alb *= 1.0 - 0.18 * below * smoothstep(0.45, 0.8, streak) * (1.0 - farT);
      }
    }
    // faux loggias beyond the detail radius (real geometry is used up close)
    float typC = floor(vC.a * 255.0 + 0.5);
    bool aptT = typC == 4.0 || typC == 5.0 || typC == 6.0 || typC == 7.0 || typC == 8.0 || typC == 19.0;
    if (inGrid && aptT && bFlag(wflags, 8.0) > 0.5 && distCam > uDetailDist && L > 10.0 && !isHole && row >= 1.0 && !stair
        && !(typC == 7.0 && entranceWall)) {
      float every = (typC == 5.0 || typC == 6.0) ? 2.0 : 3.0;
      float inSec = secCols > 0.0 ? mod(col, secCols) : col;
      if (mod(inSec + mod(seed, 2.0), every) < 0.5) {
        float bw = min(cellW * 0.92, 3.1);
        float inB = bBox(f.x, (cellW - bw) * 0.5, (cellW + bw) * 0.5, px);
        float hb = bh21(vec2(col, row) + seed);
        vec3 pc = mix(vec3(0.80, 0.79, 0.76), vec3(0.62, 0.64, 0.66), step(0.6, hb));
        float par = step(f.y, 1.0);
        float slab = bBox(f.y, -0.1, 0.06, px);
        vec3 glaz = hb < 0.6 ? vec3(0.05, 0.055, 0.06) : vec3(0.12, 0.11, 0.1);
        vec3 lc = mix(glaz, pc, par);
        lc = mix(lc, vec3(0.55, 0.54, 0.52), slab);
        alb = mix(alb, lc, inB);
        rough = mix(rough, mix(0.25, 0.85, par), inB);
        ao *= mix(1.0, 0.85, inB * step(1.0, f.y) * step(f.y, 1.5));
      }
    }
    // industrial / warehouse sectional doors on the ground floor
    if ((style == 9.0 || style == 11.0) && !gable && !parapetBand && p.y >= 0.0 && row < 0.5 && L > 12.0 && col >= 0.0 && col < nCols
        && mod(col + floor(seed / 16.0), 4.0) < 0.5) {
      float gw = min(cellW - 1.0, 4.2);
      float inG = bRect(f, vec2((cellW - gw) * 0.5, 0.0), vec2((cellW + gw) * 0.5, min(4.6, floorH - 0.6)), px);
      vec3 gc = mix(vec3(0.55, 0.56, 0.56), vec3(0.25, 0.35, 0.55), step(0.6, bh11(seed + col)));
      gc *= 0.85 + 0.15 * step(0.08, fract(f.y / 0.55));
      alb = mix(alb, gc, inG);
      metal = mix(metal, 0.4, inG); rough = mix(rough, 0.5, inG);
      nT = mix(nT, vec3(0.0, 0.0, 1.0), inG);
    }
    // garage gates
    if (style == 10.0 && !gable && !parapetBand && p.y >= 0.0 && L > 7.0) {
      float gw = cellW - 0.6;
      float inG = bRect(f, vec2(0.3, 0.0), vec2(0.3 + gw, 2.2), px) * step(0.0, col) * step(col, nCols - 1.0);
      float gh = bh11(col * 1.3 + seed);
      vec3 gc = gh < 0.3 ? vec3(0.35, 0.36, 0.36) : gh < 0.5 ? vec3(0.20, 0.30, 0.22) : gh < 0.7 ? vec3(0.35, 0.22, 0.14) : gh < 0.85 ? vec3(0.22, 0.28, 0.40) : vec3(0.40, 0.22, 0.12);
      float leaf = bBox(f.x, 0.3 + gw * 0.5 - 0.02, 0.3 + gw * 0.5 + 0.02, px);
      float rib = step(0.5, fract(f.y / 0.25));
      gc *= 0.9 + 0.1 * rib;
      gc = mix(gc, gc * 0.5, leaf);
      alb = mix(alb, gc * (0.8 + 0.3 * nf.g), inG);
      metal = mix(metal, 0.4, inG); rough = mix(rough, 0.6, inG);
    }
    // cornice / parapet band
    if (p.y > wallTopV && !gable) {
      float band = smoothstep(wallTopV, wallTopV + 0.05, p.y);
      if (style == 6.0) {
        alb = mix(alb, wallCol * 1.15, band);
        nT = normalize(mix(nT, vec3(0.0, 0.5, 1.0), bBox(p.y, wallTopV + 0.15, wallTopV + 0.45, px)));
      }
    }
    // ground-contact dirt + rain streaks from the roof edge
    if (px < 0.15) {
      float streakTop = bNoiseL(vec2(p.x * 0.3, p.y * 0.02) + seed * 0.3, 0.3, px).a;
      alb *= 1.0 - 0.12 * smoothstep(0.6, 0.9, streakTop) * smoothstep(wallTopV - 6.0, wallTopV, p.y);
    }
    alb *= mix(0.8, 1.0, smoothstep(-1.0, 0.8, p.y));
    if (isHole) alb *= 0.95;

    bAlbedo = alb;
    bRough = rough;
    bMetal = metal;
    bN = normalize(T * nT.x + B * nT.y + N * nT.z);
#ifndef USE_ENVMAP
    if (bGlass > 0.0) {
      vec3 Rw = reflect(-V, bN);
      float Fr = 0.04 + 0.96 * pow(1.0 - clamp(dot(V, bN), 0.0, 1.0), 5.0);
      emis += bSky(Rw) * Fr * bGlass;
    }
#endif
    bEmis = emis;
    bAO = ao;
    return;
  }

  if (kind < 1.5) {
    // ===================================================================== PITCHED ROOFS
    vec3 e = normalize(vec3(-N.z, 0.0, N.x) + 1e-5);
    vec3 s = normalize(cross(N, e));
    vec2 q = p; // x along the eave, y up the slope (m)
    vec4 nf = bNoiseL(q * 0.08 + seed * 0.13, 0.08, px);
    vec4 nl = bNoiseL(q * 0.015 + seed * 0.07, 0.015, px);
    float farT = smoothstep(0.02, 0.08, px);
    vec3 alb = base;
    float rough = 0.6, metal = 0.0;
    vec3 nt = vec3(0.0, 0.0, 1.0); // (along e, along s, along N)
    if (style == 2.0) {
      // corrugated sheet: trapezoidal ribs every 0.2 m
      float r = fract(q.x / 0.2);
      float sl = (smoothstep(0.05, 0.12, r) - smoothstep(0.45, 0.52, r)) * 2.0 - 1.0;
      nt = vec3(sl * 0.4 * (1.0 - farT), 0.0, 1.0);
      alb = base * (0.9 + 0.12 * nf.g);
      float galv = step(0.62, vC.r) * step(0.62, vC.g);
      metal = galv > 0.5 ? 0.5 : 0.3;
      rough = galv > 0.5 ? 0.55 : 0.55;
      // sheet overlaps every ~6 m
      alb *= 1.0 - 0.15 * bBox(fract(q.y / 6.0) * 6.0, 0.0, 0.05, px) * (1.0 - farT);
    } else if (style == 3.0) {
      // metal tile (monterrey): waves across, steps down the slope
      float wx = fract(q.x / 0.185);
      float wy = fract(q.y / 0.35);
      float sx = sin(wx * 6.2832) * 0.35;
      float sy = (wy < 0.85 ? 0.12 : -1.2);
      nt = vec3(sx * (1.0 - farT), sy * (1.0 - farT), 1.0);
      alb = base * (0.85 + 0.25 * smoothstep(0.0, 0.85, wy)) * (0.95 + 0.1 * nf.g);
      metal = 0.3; rough = 0.35;
    } else if (style == 4.0) {
      // asbestos-cement slate (shifer): sine waves, sheet grid 1.13 x 1.75 m, lichen and dirt
      float wx = fract(q.x / 0.167);
      nt = vec3(sin(wx * 6.2832) * 0.3 * (1.0 - farT), 0.0, 1.0);
      vec2 sh = vec2(q.x / 1.13, q.y / 1.75);
      vec2 cellS = floor(sh);
      float over = bBox(fract(sh.y) * 1.75, 1.6, 1.8, px) + bBox(fract(sh.x) * 1.13, 1.08, 1.2, px) * 0.5;
      float age = bh21(cellS + seed);
      alb = base * (0.8 + 0.25 * age) * (0.9 + 0.15 * nf.g);
      alb = mix(alb, vec3(0.25, 0.27, 0.2), smoothstep(0.62, 0.8, nl.r) * 0.6); // lichen / moss
      alb *= 1.0 - 0.2 * clamp(over, 0.0, 1.0) * (1.0 - farT);
      rough = 0.9;
    } else if (style == 5.0) {
      // standing seam
      float r = fract(q.x / 0.55);
      float seam = bBox(r * 0.55, 0.0, 0.03, px);
      nt = vec3((r < 0.05 ? 0.8 : 0.0) * (1.0 - farT), 0.0, 1.0);
      alb = base * (0.9 + 0.12 * nl.r) * (1.0 - 0.2 * seam);
      // rust: streaks running down individual sheets, more on old roofs (per-building seed)
      float sheet = bh11(floor(q.x / 0.55) + seed * 3.1);
      float rs = bNoiseL(vec2(q.x * 1.2, q.y * 0.08) + seed, 1.2, px).a;
      float rustAmt = smoothstep(0.62, 0.9, rs) * step(0.55, sheet) * (0.25 + 0.5 * bh11(seed * 1.9));
      alb = mix(alb, vec3(0.30, 0.17, 0.10), rustAmt * (1.0 - farT) * 0.6);
      metal = 0.35; rough = 0.5;
    } else if (style == 6.0) {
      // greenhouse glazing
      vec2 g = fract(q / vec2(0.8, 1.2));
      float fr = 1.0 - bRect(g * vec2(0.8, 1.2), vec2(0.03), vec2(0.77, 1.17), px);
      alb = mix(vec3(0.02, 0.025, 0.03), vec3(0.8), fr);
      rough = mix(0.05, 0.5, fr);
      bEmis = vec3(0.25, 0.3, 0.2) * uDay * 0.25 * (1.0 - fr);
    } else {
      alb = base * (0.9 + 0.15 * nf.g);
      rough = 0.7;
    }
    // ridge / hip cap along the top of the slope
    float slopeLen = vW.x * 0.01;
    if (slopeLen > 0.5 && style != 6.0) {
      float cap = smoothstep(slopeLen - 0.2 - px, slopeLen - 0.2 + px, q.y);
      alb = mix(alb, base * 0.8, cap);
      nt = mix(nt, vec3(0.0, 0.6, 1.0), cap * (1.0 - farT));
      rough = mix(rough, 0.6, cap);
    }
    // weathering: darker near the eave, dirt streaks down the slope
    if (px < 0.1) {
      float streak = bNoiseL(vec2(q.x * 0.35, q.y * 0.03) + seed, 0.35, px).a;
      alb *= 1.0 - 0.12 * smoothstep(0.55, 0.85, streak);
    }
    alb *= 0.92 + 0.12 * nl.g;
    bAlbedo = alb; bRough = rough; bMetal = metal;
    bN = normalize(e * nt.x + s * nt.y + N * nt.z);
    return;
  }

  if (kind < 2.5) {
    // ===================================================================== FLAT ROOFS
    vec2 q = vWPos.xz;
    vec4 nf = bNoiseL(q * 0.07 + seed * 0.1, 0.07, px);
    vec4 nl = bNoiseL(q * 0.012, 0.012, px);
    vec3 alb = base;
    // repair patches (rolled roofing strips) on a 1 m x ~8 m grid
    vec2 cell = floor(vec2(q.x / 1.0, q.y / 8.0));
    float patchS = bh21(cell + seed);
    alb *= 0.85 + 0.25 * patchS * step(0.6, bh21(cell.yx * 1.7 + seed));
    alb *= 0.85 + 0.25 * nf.g;
    // puddle stains / dust
    alb = mix(alb, alb * 0.7, smoothstep(0.65, 0.85, nl.r));
    alb = mix(alb, alb * 1.35 + vec3(0.02), smoothstep(0.55, 0.85, nl.g) * 0.35); // dust / faded felt
    float rough = 0.92 - 0.3 * smoothstep(0.7, 0.9, nl.r);
    if (style == 1.0) { alb = base * (0.7 + 0.5 * bNoise(q * 0.9).b); rough = 0.95; }
    bAlbedo = alb; bRough = rough; bMetal = 0.0;
    return;
  }

  if (kind < 3.5) {
    // ===================================================================== PLAIN (caps, parapet inner, stacks)
    vec4 nf = bNoise(p * 0.3 + vWPos.xz * 0.05);
    float aux = vC.a * 255.0;
    bAlbedo = base * (0.85 + 0.25 * nf.g);
    bRough = aux < 1.5 && aux > 0.5 ? 0.5 : 0.9;
    bMetal = aux < 1.5 && aux > 0.5 ? 0.35 : 0.0;
    return;
  }

  if (kind < 4.5) {
    // ===================================================================== BALCONY FRONT (parapet)
    float aux = vC.a * 255.0;
    vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
    float u = dot(vWPos, T);
    vec4 nf = bNoise(vec2(u, vWPos.y) * 0.2);
    vec3 alb = base * (0.88 + 0.2 * nf.g);
    vec3 nT = vec3(0.0, 0.0, 1.0);
    if (aux < 0.5) {
      // ribbed concrete panel
      float r = fract(u / 0.3);
      nT = vec3(sin(r * 6.2832) * 0.25, 0.0, 1.0);
    } else if (aux < 1.5) {
      // corrugated sheet
      float r = fract(u / 0.12);
      nT = vec3((r < 0.5 ? 0.35 : -0.35), 0.0, 1.0);
      bMetal = 0.3;
    } else if (aux < 2.5) {
      // brick
      vec2 bs = vec2(0.26, 0.077);
      float row = floor(vWPos.y / bs.y);
      float xx = u / bs.x + 0.5 * mod(row, 2.0);
      float m = 1.0 - bRect(vec2(fract(xx) * bs.x, fract(vWPos.y / bs.y) * bs.y), vec2(0.006), bs - 0.006, px);
      alb = mix(vec3(0.55, 0.26, 0.18) * (0.85 + 0.3 * bh21(vec2(floor(xx), row))), vec3(0.55), m);
    } else {
      // painted metal railing with sheet behind
      float r = fract(u / 0.12);
      alb = mix(alb * 0.5, alb, step(0.2, r));
    }
    // rust / dirt streaks from the slab
    float st = bNoise(vec2(u * 0.8, vWPos.y * 0.08)).a;
    alb *= 1.0 - 0.2 * smoothstep(0.6, 0.85, st);
    bAlbedo = alb; bRough = 0.8;
    vec3 B = vec3(0.0, 1.0, 0.0);
    bN = normalize(T * nT.x + B * nT.y + N * nT.z);
    return;
  }

  if (kind < 5.5) {
    // ===================================================================== SLABS / CANOPIES / STEPS
    vec4 nf = bNoise(vWPos.xz * 0.2 + vWPos.y * 0.1);
    bAlbedo = base * (0.8 + 0.3 * nf.g);
    if (N.y < -0.5) bAlbedo *= 0.8;
    bRough = 0.9;
    return;
  }

  if (kind < 7.5) {
    // ===================================================================== METAL (AC units, pipes, antennas, gutters)
    bAlbedo = base;
    bRough = 0.45;
    bMetal = vC.a * 255.0 > 0.5 ? 0.1 : 0.6;
    // AC unit fan grille
    if (vC.a * 255.0 > 0.5 && vC.a * 255.0 < 1.5 && abs(N.y) < 0.5) {
      vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
      float u = fract(dot(vWPos, T) / 0.8);
      float grille = step(0.3, fract(vWPos.y / 0.03)) * step(abs(u - 0.65), 0.18);
      bAlbedo = mix(base, base * 0.3, grille * 0.7);
    }
    return;
  }

  if (kind < 8.5) {
    // ===================================================================== SOFFIT
    bAlbedo = base * 0.9;
    bRough = 0.85;
    return;
  }

  if (kind < 9.5) {
    // ===================================================================== LAMPS / SIGN BOARDS
    float aux = vC.a * 255.0;
    if (aux > 0.5) {
      // shop sign: coloured board, glowing at night
      bAlbedo = base * 0.9;
      bRough = 0.4;
      bEmis = base * (0.12 * uDay + 0.6 * uNight);
    } else {
      bAlbedo = vec3(0.9);
      bEmis = vec3(1.0, 0.8, 0.55) * (uNight * 2.0);
      bRough = 0.3;
    }
    return;
  }

  if (kind < 11.5) {
    // ===================================================================== PLOT FENCES
    vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
    vec3 nT = vec3(0.0, 0.0, 1.0);
    vec4 nf = bNoise(p * vec2(0.5, 0.5) + seed * 0.13);
    vec3 alb = base;
    float rough = 0.5, metal = 0.0;
    float farT = smoothstep(0.01, 0.04, px);
    if (style < 1.5 || style > 3.5) {
      // corrugated steel sheet (profnastil), vertical trapezoid ribs
      float r = fract(p.x / 0.115);
      float sl = (smoothstep(0.05, 0.15, r) - smoothstep(0.45, 0.55, r)) * 2.0 - 1.0;
      nT = vec3(sl * 0.45 * (1.0 - farT), 0.0, 1.0);
      alb = base * (0.92 + 0.08 * nf.g);
      metal = 0.35; rough = 0.45;
      if (style > 3.5) {
        // gate: frame and two leaves
        float L = vW.x * 0.01;
        float fr = 1.0 - bRect(p, vec2(0.05, 0.05), vec2(L - 0.05, 1.9), px);
        float mid = bBox(p.x, L * 0.5 - 0.03, L * 0.5 + 0.03, px);
        alb = mix(alb, base * 0.55, clamp(fr + mid, 0.0, 1.0));
      }
    } else if (style < 2.5) {
      // wooden planks
      float r = fract(p.x / 0.14);
      float gap = 1.0 - bBox(r * 0.14, 0.008, 0.132, px);
      float plank = bh11(floor(p.x / 0.14) + seed);
      vec4 grain = bNoise(vec2(p.x * 3.0, p.y * 0.15) + plank);
      alb = base * (0.75 + 0.35 * plank) * (0.85 + 0.3 * grain.b);
      alb = mix(alb, vec3(0.33, 0.31, 0.28), smoothstep(0.4, 0.8, nf.r) * 0.5); // weathered grey
      alb = mix(alb, vec3(0.03), gap * 0.9);
      rough = 0.9;
    } else {
      // metal picket (rendered solid): bars
      float r = fract(p.x / 0.12);
      float bar = bBox(r * 0.12, 0.0, 0.03, px);
      alb = mix(base * 0.35, base, bar);
      metal = 0.3; rough = 0.5;
    }
    // ground splash and rust at the bottom
    alb *= mix(0.7, 1.0, smoothstep(-0.1, 0.5, p.y));
    alb = mix(alb, vec3(0.3, 0.17, 0.1), smoothstep(0.7, 0.95, nf.a) * smoothstep(0.6, 0.0, p.y) * 0.6);
    bAlbedo = alb; bRough = rough; bMetal = metal;
    bN = normalize(T * nT.x + vec3(0.0, 1.0, 0.0) * nT.y + N * nT.z);
    return;
  }
}
`;

// Street-lamp pools on facades / roofs at night (roads module lamp grid, see
// src/modules/roads/materials.ts rsLamps: 16 m cells, up to two lamps per cell
// encoded as offsets, lamp heads ~9 m above the ground).
export const LAMP_FN = /* glsl */ `
#ifdef BLD_LAMPS
uniform sampler2D rsLamp;
uniform vec4 rsLampP;
uniform vec3 rsLampCol0;
uniform vec3 rsLampCol1;
uniform float rsLampI;
uniform vec4 rsReal[8];
uniform sampler2D bHF;
uniform vec3 bHFP; // half, res, n
void bLamps(inout ReflectedLight reflectedLight, const in vec3 geometryPosition, const in vec3 geometryNormal,
            const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material) {
  if (uNight < 0.01) return;
  vec2 g = (vWPos.xz - rsLampP.xy) * rsLampP.z;
  ivec2 c = ivec2(floor(g));
  int n = int(rsLampP.w);
  if (c.x < 0 || c.y < 0 || c.x >= n || c.y >= n) return;
  vec4 t = floor(texelFetch(rsLamp, c, 0) * 255.0 + 0.5);
  if (t.g < 0.5 && t.a < 0.5) return;
  vec2 huv = ((vWPos.xz + bHFP.x) / bHFP.y + 0.5) / bHFP.z;
  float hy = vWPos.y - texture2D(bHF, huv).r;
  if (hy > 16.0) return;
  vec2 cc = (vec2(c) + 0.5) / rsLampP.z + rsLampP.xy;
  vec3 wn = normalize(vWNrm);
  for (int k = 0; k < 2; k++) {
    vec2 q = k == 0 ? t.rg : t.ba;
    if (q.y < 0.5) continue;
    float typ = mod(q.x, 2.0);
    vec2 off = vec2(floor(q.x * 0.5), floor(q.y * 0.5)) * 0.5 - 32.0;
    vec3 L = vec3(cc.x + off.x - vWPos.x, 9.0 - hy, cc.y + off.y - vWPos.z);
    float d2 = max(dot(L, L), 1.0);
    vec3 Ld = L * inversesqrt(d2);
    // facing test on the geometric normal (walls behind the lamp stay dark)
    if (dot(Ld, wn) <= 0.0) continue;
    float cosE = Ld.y;
    // same cut-off luminaire as the roads' ground pools; roofs (seen from above) get less
    float I = rsLampI * uNight * (0.25 + 0.75 * cosE * cosE) * smoothstep(0.2, 0.5, cosE);
    I *= 0.8 * mix(1.0, 0.35, smoothstep(0.3, 0.8, wn.y));
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
#endif
`;
