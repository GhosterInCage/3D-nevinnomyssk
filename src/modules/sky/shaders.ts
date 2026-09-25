// GLSL shared by the atmosphere post effect (AtmosphereEffect) and the
// environment-map sky material (EnvSky). Built on Eric Bruneton's precomputed
// atmospheric scattering as packaged by @takram/three-atmosphere (MIT/BSD).
//
// Units: the Bruneton functions return "relative luminance" (the sun has unit
// luminance for unit radiance, noon sun illuminance ~1.5). Everything we output
// is multiplied by skRadianceScale (S = 2) so that the noon sun irradiance is
// ~3, matching three.js conventions (DirectionalLight intensity 3, exposure ~1).
//
// Name prefix `sk` avoids collisions with three.js built-ins and with the
// bruneton unit constants (m, km, nm, rad, sr, pi, deg, cd...).
import { resolveIncludes } from '@takram/three-geospatial';
import { depth, math, packing, transform } from '@takram/three-geospatial/shaders';
import { common, definitions, runtime } from '@takram/three-atmosphere/shaders/bruneton';

export const SK_EARTH_RADIUS = 6371000;

/** Uniform declarations + helpers shared by every sky shader. */
const skyCore = /* glsl */ `
#include "core/math"
#include "bruneton/definitions"

uniform AtmosphereParameters ATMOSPHERE;
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler2D irradiance_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D higher_order_scattering_texture;

#include "bruneton/common"
#include "bruneton/runtime"

uniform mat4 skWorldToECEF;      // world (m) -> ECEF (m)
uniform vec3 skCamWorld;         // camera position, world (m)
uniform vec3 skCamECEF;          // camera position, ECEF (km) incl. altitude correction
uniform vec3 skSunDirECEF;
uniform vec3 skMoonDirECEF;
uniform vec3 skSunDirW;
uniform vec3 skMoonDirW;
uniform float skRadianceScale;
uniform float skMoonLight;       // moon-lit scattering relative to the sun (phase * boost)
uniform float skCosSunRadius;
uniform float skSunDiscScale;
uniform float skMoonAngularRadius;
uniform float skLunarScale;
uniform float skTime;

uniform sampler2D skCloudTex;
uniform vec4 skCloudP0;          // x cover, y uv scale (1/m), zw wind offset (m)
uniform vec4 skCloudP1;          // x base altitude (m ASL), y thickness (m), z optical depth, w coverage variation
uniform vec4 skCloudP2;          // x cirrus altitude, y cirrus cover, z detail erosion, w rain
uniform vec3 skMoonIrr;          // moon irradiance (luminance, unscaled) at normal incidence
uniform vec3 skCityGlow;         // city light irradiance from below on cloud bases (app units)
uniform vec3 skNightZenith;      // night sky radiance at zenith (app units)
uniform vec3 skNightHorizon;     // light-pollution glow at horizon (app units)
uniform vec4 skFog;              // x density at base (1/m), y base altitude (m), z scale height (m), w max distance (m)
uniform vec3 skFogSun;           // fog in-scatter from the sun (app units, before phase)
uniform vec3 skFogAmb;           // fog ambient in-scatter (app units)
uniform vec3 skGroundAlbedo;
uniform vec3 skCloudKeyDirW;     // key light direction for clouds (sun by day, moon by night)
uniform vec3 skCloudKey;         // key irradiance at cloud level (luminance, unscaled)
uniform vec3 skCloudAmb;         // sky irradiance on a horizontal surface at cloud level (luminance, unscaled)
uniform vec3 skCloudGnd;         // upward irradiance from the ground incl. city glow (luminance, unscaled)
uniform vec4 skCloudP3;          // x steps, y max march length (m), z extinction scale, w detail strength
uniform vec4 skLut;              // x first slice distance d0 (m), y log(dmax/d0), z slices, w unused

const float SK_R = ${SK_EARTH_RADIUS.toFixed(1)};

// world (m) -> ECEF (km) relative to the camera for precision
vec3 skToECEF(const vec3 pW) {
  return skCamECEF + mat3(skWorldToECEF) * (pW - skCamWorld) * METER_TO_LENGTH_UNIT;
}
vec3 skDirToECEF(const vec3 dW) {
  return normalize(mat3(skWorldToECEF) * dW);
}

float skHG(const float c, const float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// Distance along the ray to the sphere of radius SK_R + alt around the planet
// centre (0,-SK_R,0). Returns -1 when missed/behind.
float skShellHit(const vec3 ro, const vec3 rd, const float alt) {
  vec3 oc = ro + vec3(0.0, SK_R, 0.0);
  float rc = length(oc);
  float rad = SK_R + alt;
  float b = dot(oc, rd);
  float c = (rc - rad) * (rc + rad);
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  h = sqrt(h);
  float t0 = -b - h;
  float t1 = -b + h;
  if (t0 > 0.0) return t0;
  if (t1 > 0.0) return t1;
  return -1.0;
}
`;

/** Cloud layer functions (2D cumulus + cirrus shells) and fog/night helpers. */
const skyClouds = /* glsl */ `
const mat2 SK_ROT = mat2(0.8660254, 0.5, -0.5, 0.8660254);

vec2 skCloudUv(const vec2 xz) {
  return (xz + skCloudP0.zw) * skCloudP0.y;
}

// signed coverage field (large-scale variation included); density ramp 0..1
float skCloudDensityCoarse(const vec2 xz) {
  vec2 uv = skCloudUv(xz);
  vec4 c = texture(skCloudTex, uv);
  float large = texture(skCloudTex, SK_ROT * uv * 0.37 + 0.21).a;
  float cov = clamp(skCloudP0.x + (large - 0.5) * skCloudP1.w * (1.0 - skCloudP0.x) * 2.0, 0.0, 1.0);
  float th = 1.0 - cov * 1.35;
  return saturate((c.r - th) / 0.35);
}

float skCloudDensity(const vec2 xz, const float detail) {
  float d = skCloudDensityCoarse(xz);
  if (d <= 0.0 || detail <= 0.0) return d;
  vec2 uv = skCloudUv(xz);
  float e1 = texture(skCloudTex, SK_ROT * uv * 4.3 + vec2(skTime * 0.0004, 0.0)).b;
  float e2 = texture(skCloudTex, uv * 11.7 + 0.37).b;
  float ero = e1 * 0.65 + e2 * 0.35;
  return saturate(d - (1.0 - d) * ero * detail - ero * detail * 0.25);
}

// Cloud shadow transmittance for a world position (used by the ground-material patch too)
float skCloudShadowAt(const vec3 pW) {
  if (skCloudP0.x <= 0.001) return 1.0;
  vec3 s = skSunDirW;
  float alt = skCloudP1.x + skCloudP1.y * 0.5;
  float t = (alt - pW.y) / max(s.y, 0.05);
  vec2 q = pW.xz + s.xz * t;
  float d = skCloudDensityCoarse(q);
  float tau = d * skCloudP1.z * 0.45;
  return exp(-tau);
}

// Night sky base radiance (airglow + light pollution), app units
vec3 skNightSky(const vec3 rdW, const float cloudAlpha) {
  float el = max(rdW.y, 0.0);
  vec3 c = skNightZenith + skNightHorizon * exp(-el * 9.0);
  return c;
}

// Lit radiance (luminance, unscaled) of the cumulus layer at world point p
// seen along rd. tau = local optical depth, alpha = opacity along the view.
vec3 skCumulusRadiance(const vec3 p, const vec3 rd, const float tau, const float tauView, const bool fromBelow) {
  vec3 up = normalize(p + vec3(0.0, SK_R, 0.0));
  vec3 pE = skToECEF(p + up * skCloudP1.y * 0.5);
  vec3 skyIrr;
  vec3 sunIrr = GetSunAndSkyScalarIrradiance(pE, skSunDirECEF, skyIrr);
  vec3 skyH = skyIrr / (2.0 * PI);
  float mus = dot(up, skSunDirW);
  float mu = max(mus, 0.0);
  float cosT = dot(rd, skSunDirW);
  float phase = mix(skHG(cosT, 0.75), skHG(cosT, -0.15), 0.35);
  // diffuse (two-stream) transmission / reflection of the slab
  float Tr = 1.0 / (1.0 + 0.11 * tau);
  float Rf = 1.0 - Tr;
  vec3 gnd = skGroundAlbedo * (sunIrr * mu + skyH);
  vec3 L;
  // near-horizon views see the sunlit/shaded flanks of the clouds
  float side = 1.0 - saturate(abs(dot(rd, up)) * 3.5);
  float flank = mix(0.35, 1.25, saturate(0.5 + 0.5 * cosT));
  if (fromBelow) {
    L = sunIrr * mu * Tr * (1.0 / PI) * 1.6
      + sunIrr * phase * exp(-tau * 0.35) * 2.0
      + skyH * (0.45 * Tr + 0.25) * (1.0 / PI)
      + gnd * Rf * (1.0 / PI);
    L = mix(L, sunIrr * max(mus + 0.15, 0.0) * Rf * flank * (1.0 / PI) + skyH * 0.6 / PI, side * 0.55);
  } else {
    L = sunIrr * mu * Rf * (1.0 / PI) * 1.1
      + sunIrr * phase * exp(-tau * 0.35) * 1.2
      + skyH * (0.8 * Rf + 0.2) * (1.0 / PI);
  }
  // moonlight (luminance-relative irradiance) + city glow on the base at night
  float mum = max(dot(up, skMoonDirW), 0.0);
  L += skMoonIrr * mum * (fromBelow ? Tr * 1.6 : Rf) * (1.0 / PI);
  L += skCityGlow / skRadianceScale * Rf * (fromBelow ? 1.0 : 0.15) * (1.0 / PI);
  return L;
}

// Composite the cloud layers over 'base' (radiance along the ray, app units)
// for a ray from the camera; maxDist = distance of opaque geometry.
// Returns updated radiance.
vec3 skApplyClouds(vec3 base, const vec3 rdW, const float maxDist, const bool aerial, const float detail) {
  vec3 ro = skCamWorld;
  float S = skRadianceScale;
  // ---- cirrus (high, thin, behind cumulus)
  if (skCloudP2.y > 0.001 && maxDist > 1e7) {
    float tc = skShellHit(ro, rdW, skCloudP2.x);
    if (tc > 0.0) {
      vec3 pc = ro + rdW * tc;
      vec2 uv = skCloudUv(pc.xz * 0.6);
      float g = texture(skCloudTex, SK_ROT * uv * 0.8 + 0.5).g;
      float mask = texture(skCloudTex, uv * 0.23 + 0.11).a;
      float d = saturate((g - (1.0 - skCloudP2.y * 1.1)) / 0.3) * smoothstep(0.15, 0.6, mask + skCloudP2.y * 0.4);
      if (d > 0.0) {
        vec3 up = normalize(pc + vec3(0.0, SK_R, 0.0));
        float mu = max(abs(dot(rdW, up)), 0.06);
        float a = 1.0 - exp(-d * 0.35 / mu);
        vec3 pE = skToECEF(pc);
        vec3 skyIrr;
        vec3 sunIrr = GetSunAndSkyScalarIrradiance(pE, skSunDirECEF, skyIrr);
        float cosT = dot(rdW, skSunDirW);
        vec3 L = sunIrr * (skHG(cosT, 0.7) * 1.5 + 0.12) + skyIrr / (2.0 * PI) * 0.3 / PI;
        L += skMoonIrr * 0.15;
        vec3 T;
        vec3 Sc = GetSkyRadianceToPoint(skCamECEF, pE, 0.0, skSunDirECEF, T);
        base = mix(base, (L * T + Sc) * S, a);
      }
    }
  }
  // ---- cumulus / stratocumulus layer
  if (skCloudP0.x > 0.001) {
    float alt = skCloudP1.x + skCloudP1.y * 0.5;
    float t = skShellHit(ro, rdW, alt);
    if (t > 0.0 && t < maxDist && t < 1.6e5) {
      vec3 p = ro + rdW * t;
      float lod = saturate((t - 4000.0) / 60000.0);
      float d = skCloudDensity(p.xz, skCloudP2.z * (1.0 - lod * 0.7));
      if (d > 0.002) {
        vec3 up = normalize(p + vec3(0.0, SK_R, 0.0));
        float mu = abs(dot(rdW, up));
        float tau = d * skCloudP1.z;
        float tauView = tau / max(mu, 0.12);
        float a = 1.0 - exp(-tauView);
        // soften the far field (sub-pixel clouds) to avoid aliasing
        a *= 1.0 - lod * 0.25;
        bool fromBelow = ro.y < p.y;
        vec3 L = skCumulusRadiance(p, rdW, tau, tauView, fromBelow);
        vec3 T;
        vec3 pE = skToECEF(p);
        vec3 Sc = aerial ? GetSkyRadianceToPoint(skCamECEF, pE, 0.0, skSunDirECEF, T) : vec3(0.0);
        if (!aerial) T = vec3(1.0);
        if (skMoonLight > 0.0 && aerial) {
          vec3 Tm;
          Sc += GetSkyRadianceToPoint(skCamECEF, pE, 0.0, skMoonDirECEF, Tm) * skMoonLight;
        }
        vec3 cloudCol = (L * T + Sc) * S + skNightSky(rdW, 1.0) * (1.0 - dot(T, vec3(0.3333)));
        base = mix(base, cloudCol, a);
      }
    }
  }
  return base;
}

// ---- 2.5D raymarched cumulus: 2D coverage field extruded into dome-shaped
// columns (flat bases, rounded tops), lit with analytic optical depth to the
// column top towards the key light (+ multiple-scattering boost), sky ambient
// from above and ground/city bounce from below. Returns premultiplied radiance
// (luminance, unscaled) and alpha; tMean = transmittance-weighted distance.
float skIGN(const vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

vec4 skMarchCumulus(const vec3 ro, const vec3 rd, const float jitter, out float tMean) {
  tMean = 1e9;
  if (skCloudP0.x <= 0.001) return vec4(0.0);
  float hb = skCloudP1.x;
  float H = skCloudP1.y;
  float camAlt = length(ro + vec3(0.0, SK_R, 0.0)) - SK_R;
  float tb = skShellHit(ro, rd, hb);
  float tt = skShellHit(ro, rd, hb + H);
  float t0;
  float t1;
  if (camAlt < hb) {
    if (tb < 0.0) return vec4(0.0);
    t0 = tb;
    t1 = tt > 0.0 ? tt : tb + skCloudP3.y;
  } else if (camAlt > hb + H) {
    if (tt < 0.0) return vec4(0.0);
    t0 = tt;
    t1 = tb > 0.0 ? tb : tt + skCloudP3.y;
  } else {
    t0 = 0.0;
    t1 = rd.y > 0.0 ? tt : tb;
    if (t1 < 0.0) t1 = skCloudP3.y;
  }
  if (t0 > 1.6e5) return vec4(0.0);
  t1 = min(t1, t0 + skCloudP3.y);
  float fsteps = skCloudP3.x;
  float dt = (t1 - t0) / fsteps;
  float cosT = dot(rd, skCloudKeyDirW);
  float phase = mix(skHG(cosT, 0.78), skHG(cosT, -0.2), 0.35);
  float keyMu = max(skCloudKeyDirW.y, 0.05);
  float sigma0 = skCloudP1.z / (H * 0.55) * skCloudP3.z;
  float lod = clamp((t0 - 4000.0) / 50000.0, 0.0, 1.0);
  float detailK = skCloudP3.w * mix(1.0, 0.35, lod);
  vec3 Lsum = vec3(0.0);
  float T = 1.0;
  float tw = 0.0;
  float ws = 0.0;
  vec3 amb = skCloudAmb * (1.0 / (2.0 * PI));
  vec3 gnd = skCloudGnd * (1.0 / (2.0 * PI));
  for (int i = 0; i < 64; i++) {
    if (float(i) >= fsteps || T < 0.015) break;
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    float h = (length(p + vec3(0.0, SK_R, 0.0)) - SK_R - hb) / H;
    float d = skCloudDensityCoarse(p.xz);
    if (d < 0.01) continue;
    float top = pow(d, 0.55);
    float prof = (1.0 - smoothstep(top * 0.72 - 0.06, top, h)) * smoothstep(-0.02, 0.09, h);
    if (prof <= 0.0) continue;
    vec2 duv = skCloudUv(p.xz);
    float det = texture(skCloudTex, duv * 5.3 + vec2(0.13, skTime * 0.00003)).b * 0.7
              + texture(skCloudTex, SK_ROT * duv * 13.1 + 0.4).b * 0.3;
    float dens = clamp(d * prof * 1.25 - det * detailK * (1.0 - d * 0.55), 0.0, 1.0);
    if (dens <= 0.0) continue;
    float sig = dens * sigma0;
    float toTop = max(top - h, 0.0) * H;
    float tauKey = sigma0 * d * toTop / keyMu * 0.75;
    float Tkey = exp(-tauKey) + 0.28 * exp(-tauKey * 0.12);
    float tauUp = sigma0 * d * toTop * 0.35;
    float tauDn = sigma0 * d * max(h, 0.0) * H * 0.35;
    // powder: dark edges when looking away from the light
    float powder = 1.0 - 0.6 * exp(-sig * 90.0);
    vec3 src = skCloudKey * (phase * Tkey * mix(1.0, powder, 0.5 - 0.5 * cosT))
             + amb * (0.2 + 0.8 * exp(-tauUp))
             + gnd * exp(-tauDn);
    float a = 1.0 - exp(-sig * dt);
    Lsum += T * a * src;
    tw += T * a * t;
    ws += T * a;
    T *= 1.0 - a;
  }
  tMean = ws > 1e-4 ? tw / ws : 1e9;
  return vec4(Lsum, 1.0 - T);
}

// Thin cirrus sheet (premultiplied radiance in luminance units, alpha); t = distance
vec4 skCirrus(const vec3 ro, const vec3 rd, out float tc) {
  tc = 1e9;
  if (skCloudP2.y <= 0.001) return vec4(0.0);
  tc = skShellHit(ro, rd, skCloudP2.x);
  if (tc <= 0.0) { tc = 1e9; return vec4(0.0); }
  vec3 pc = ro + rd * tc;
  vec2 uv = skCloudUv(pc.xz * 0.6);
  float g = texture(skCloudTex, SK_ROT * uv * 0.8 + 0.5).g;
  float mask = texture(skCloudTex, uv * 0.23 + 0.11).a;
  float d = saturate((g - (1.0 - skCloudP2.y * 1.1)) / 0.3) * smoothstep(0.15, 0.6, mask + skCloudP2.y * 0.4);
  if (d <= 0.0) return vec4(0.0);
  vec3 up = normalize(pc + vec3(0.0, SK_R, 0.0));
  float mu = max(abs(dot(rd, up)), 0.06);
  float a = 1.0 - exp(-d * 0.3 / mu);
  float cosT = dot(rd, skCloudKeyDirW);
  vec3 L = skCloudKey * (skHG(cosT, 0.7) * 1.4 + 0.1) + skCloudAmb * (0.35 / PI);
  return vec4(L * a, a);
}

// Aerial perspective from the froxel LUT (app units). uv = screen uv, dist = metres.
vec3 skApLookup(const sampler3D lut, const vec2 uv, const float dist, out vec3 T) {
  float D = skLut.z;
  float k = clamp(log(max(dist, skLut.x) / skLut.x) / skLut.y * (D - 1.0), 0.0, D - 1.0);
  vec3 S = texture(lut, vec3(uv, (k + 0.5) / (2.0 * D))).rgb;
  T = texture(lut, vec3(uv, (k + D + 0.5) / (2.0 * D))).rgb;
  float f = clamp(dist / skLut.x, 0.0, 1.0);
  T = mix(vec3(1.0), T, f);
  return S * f;
}

// Exponential height fog, analytic integral along the ray (app units)
vec3 skApplyFog(const vec3 col, const vec3 rdW, const float dist) {
  if (skFog.x <= 0.0) return col;
  float d = min(dist, skFog.w);
  float H = skFog.z;
  float h0 = skCamWorld.y - skFog.y;
  float k = rdW.y * d / H;
  float integral = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0 - 0.5 * k;
  float od = skFog.x * exp(-h0 / H) * d * integral;
  float tr = exp(-od);
  float cosT = dot(rdW, skSunDirW);
  vec3 inscatter = skFogSun * (skHG(cosT, 0.65) * 4.0 * PI * 0.35 + 0.65) + skFogAmb;
  return col * tr + inscatter * (1.0 - tr);
}
`;

/** takram's sky.glsl (sun + moon discs), adapted: returns transmittance. */
const skySphere = /* glsl */ `
vec3 skLunarRadiance() {
  return ATMOSPHERE.solar_irradiance * 0.000002 / (PI * skMoonAngularRadius * skMoonAngularRadius) * SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
}
float skIntersectSphere(const vec3 ray, const vec3 point, const float radius) {
  vec3 P = -point;
  float PoR = dot(P, ray);
  float D = dot(P, P) - radius * radius;
  return -PoR - sqrt(PoR * PoR - D);
}
float skOrenNayar(const vec3 L, const vec3 V, const vec3 N) {
  float NoL = dot(N, L);
  float NoV = dot(N, V);
  float s = dot(L, V) - NoL * NoV;
  float t = mix(1.0, max(NoL, NoV), step(0.0, s));
  return max(0.0, NoL) * (0.62406015 + 0.41284404 * s / t);
}
// Sky radiance (luminance, unscaled) along an ECEF ray incl. sun & moon discs
vec3 skSkyRadiance(const vec3 rayE, const float fragAngle, const bool discs, out vec3 T) {
  vec3 radiance = GetSkyRadiance(skCamECEF, rayE, 0.0, skSunDirECEF, T);
  if (skMoonLight > 0.0) {
    vec3 Tm;
    radiance += GetSkyRadiance(skCamECEF, rayE, 0.0, skMoonDirECEF, Tm) * skMoonLight;
  }
  if (discs) {
    float vds = dot(rayE, skSunDirECEF);
    if (vds > skCosSunRadius) {
      float ang = acos(clamp(vds, -1.0, 1.0));
      float aa = smoothstep(ATMOSPHERE.sun_angular_radius, ATMOSPHERE.sun_angular_radius - fragAngle, ang);
      radiance += T * GetSolarRadiance() * aa * skSunDiscScale;
    }
    float ix = skIntersectSphere(rayE, skMoonDirECEF, skMoonAngularRadius);
    if (ix > 0.0) {
      vec3 n = normalize(skMoonDirECEF - rayE * ix);
      float diffuse = skOrenNayar(-skSunDirECEF, rayE, n);
      float ang = acos(clamp(dot(rayE, skMoonDirECEF), -1.0, 1.0));
      float aa = smoothstep(skMoonAngularRadius, skMoonAngularRadius - fragAngle, ang);
      radiance += T * skLunarRadiance() * skLunarScale * (diffuse + 0.004) * aa;
    }
  }
  return radiance;
}
`;

export function resolveSky(src: string): string {
  return resolveIncludes(src, {
    core: { depth, math, packing, transform },
    bruneton: { common, definitions, runtime },
  });
}

export const SKY_CORE = skyCore;
export const SKY_CLOUDS = skyClouds;
export const SKY_SPHERE = skySphere;

/** Fragment shader of the atmosphere post effect (pmndrs Effect). */
export const atmosphereEffectFrag = resolveSky(/* glsl */ `
${skyCore}
${skySphere}
${skyClouds}

uniform mat4 skInvView;
uniform mat4 skInvProj;
uniform mat4 skProj;
uniform float skCloudsOn;
uniform sampler3D skApLut;
uniform sampler2D skCloudBuf;    // premultiplied cloud radiance (app units, AP applied) + alpha
uniform sampler2D skCloudDist;   // r: cloud distance (km)
uniform float skGroundAlt;       // altitude of the fake distant ground (m ASL)

varying vec3 vSkRayW;

void mainImage(const vec4 inputColor, const vec2 uv, out vec4 outputColor) {
  vec3 rdW = normalize(vSkRayW);
  float S = skRadianceScale;
  float dpt = readDepth(uv);
  vec3 col;
  float dist;
  bool sky = dpt >= 1.0 - 1e-7;
  vec3 night = skNightSky(rdW, 0.0);
  if (sky) {
    float tg = rdW.y < 0.02 ? skShellHit(skCamWorld, rdW, skGroundAlt) : -1.0;
    float camAlt = skCamWorld.y;
    if (tg > 0.0 && camAlt > skGroundAlt && tg < 4.0e5) {
      // nothing drawn below the horizon here: continue the land as a hazy lambertian plain
      vec3 T;
      vec3 Sin = skApLookup(skApLut, uv, tg, T);
      vec3 pW = skCamWorld + rdW * tg;
      vec3 skyIrr;
      vec3 sunIrr = GetSunAndSkyIrradiance(skToECEF(pW), skDirToECEF(normalize(pW + vec3(0.0, SK_R, 0.0))), skSunDirECEF, skyIrr);
      vec3 g = skGroundAlbedo * (sunIrr * skCloudShadowAt(pW) + skyIrr) * (S / PI);
      col = g * T + Sin + night * (1.0 - dot(T, vec3(0.3333)));
      dist = tg;
    } else {
      vec3 dRdx = dFdx(rdW);
      vec3 dRdy = dFdy(rdW);
      float fragAngle = length(dRdx + dRdy);
      vec3 T;
      vec3 L = skSkyRadiance(skDirToECEF(rdW), fragAngle, true, T) * S + night;
      float a = clamp(inputColor.a, 0.0, 1.0);
      col = L * (1.0 - a) + inputColor.rgb * mix(vec3(1.0), T, 1.0 - a * 0.5);
      dist = 1e9;
    }
  } else {
    float viewZ = getViewZ(dpt);
    vec4 clip = vec4(vec3(uv, dpt) * 2.0 - 1.0, 1.0);
    float clipW = skProj[2][3] * viewZ + skProj[3][3];
    vec3 viewPos = (skInvProj * (clip * clipW)).xyz;
    dist = length(viewPos);
    vec3 T;
    vec3 Sin = skApLookup(skApLut, uv, dist, T);
    col = inputColor.rgb * T + Sin + night * (1.0 - dot(T, vec3(0.3333)));
  }
  if (skCloudsOn > 0.5) {
    vec4 cb = texture(skCloudBuf, uv);
    float cd = texture(skCloudDist, uv).r * 1000.0;
    if (cb.a > 0.0005 && cd < dist) col = col * (1.0 - cb.a) + cb.rgb;
  }
  col = skApplyFog(col, rdW, sky ? min(dist, 1e9) : dist);
  outputColor = vec4(max(col, vec3(0.0)), 1.0);
}
`);

export const atmosphereEffectVert = /* glsl */ `
uniform mat4 skInvView;
uniform mat4 skInvProj;
varying vec3 vSkRayW;
void mainSupport() {
  vec4 vp = skInvProj * vec4(position.xy, 1.0, 1.0);
  vp /= vp.w;
  vSkRayW = (skInvView * vec4(vp.xyz, 0.0)).xyz;
}
`;

const quadVert = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
export const fullscreenVert = quadVert;

/** Aerial-perspective froxel LUT: slice < D -> in-scatter (app units), else transmittance. */
export const apLutFrag = resolveSky(/* glsl */ `
${skyCore}
uniform mat4 skInvView;
uniform mat4 skInvProj;
uniform float uSlice;
uniform vec2 uLutSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uLutSize;
  vec4 vp = skInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vp /= vp.w;
  vec3 rdW = normalize((skInvView * vec4(vp.xyz, 0.0)).xyz);
  float D = skLut.z;
  float k = mod(uSlice, D);
  float dist = skLut.x * exp(skLut.y * k / (D - 1.0));
  vec3 pE = skToECEF(skCamWorld + rdW * dist);
  vec3 T;
  vec3 Sin = GetSkyRadianceToPoint(skCamECEF, pE, 0.0, skSunDirECEF, T);
  if (skMoonLight > 0.0) {
    vec3 Tm;
    Sin += GetSkyRadianceToPoint(skCamECEF, pE, 0.0, skMoonDirECEF, Tm) * skMoonLight;
  }
  Sin *= skRadianceScale;
  // under a heavy overcast deck the air is lit by diffuse grey light instead of the sun
  float oc = smoothstep(0.55, 1.0, skCloudP0.x) * (skCamWorld.y < skCloudP1.x ? 1.0 : 0.0);
  vec3 Soc = (vec3(1.0) - T) * (skFogAmb * 0.55 + skFogSun * 0.06);
  Sin = mix(Sin, Soc, oc * 0.85);
  gl_FragColor = uSlice < D ? vec4(Sin, 1.0) : vec4(T, 1.0);
}
`);

/** Half-resolution cloud pass (MRT: 0 = premultiplied radiance + alpha, 1 = distance km). */
export const cloudPassFrag = resolveSky(/* glsl */ `
${skyCore}
${skyClouds}
uniform mat4 skInvView;
uniform mat4 skInvProj;
uniform vec2 uSize;
uniform sampler3D skApLut;
layout(location = 1) out highp vec4 skDistOut;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec4 vp = skInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vp /= vp.w;
  vec3 rdW = normalize((skInvView * vec4(vp.xyz, 0.0)).xyz);
  float S = skRadianceScale;
  float jitter = skIGN(gl_FragCoord.xy);
  float tCu;
  vec4 cu = skMarchCumulus(skCamWorld, rdW, jitter, tCu);
  float tCi;
  vec4 ci = skCirrus(skCamWorld, rdW, tCi);
  vec3 night = skNightSky(rdW, 1.0);
  vec3 col = vec3(0.0);
  float a = 0.0;
  float dist = 1e9;
  if (ci.a > 0.0) {
    vec3 T;
    vec3 Sa = skApLookup(skApLut, uv, tCi, T);
    col = ci.rgb * S * T + (Sa + night * (1.0 - dot(T, vec3(0.3333)))) * ci.a;
    a = ci.a;
    dist = tCi;
  }
  if (cu.a > 0.0) {
    vec3 T;
    vec3 Sa = skApLookup(skApLut, uv, tCu, T);
    vec3 c = cu.rgb * S * T + (Sa + night * (1.0 - dot(T, vec3(0.3333)))) * cu.a;
    col = c + col * (1.0 - cu.a);
    a = cu.a + a * (1.0 - cu.a);
    dist = min(dist, tCu);
  }
  gl_FragColor = vec4(col, a);
  skDistOut = vec4(dist * 0.001, 0.0, 0.0, 1.0);
}
`);

/** Environment map sky (rendered onto a sphere by PMREMGenerator.fromScene). */
export const envSkyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

export const envSkyFrag = resolveSky(/* glsl */ `
${skyCore}
${skySphere}
${skyClouds}
varying vec3 vDir;
void main() {
  vec3 rdW = normalize(vDir);
  float S = skRadianceScale;
  vec3 col;
  float horizon = -0.02;
  if (rdW.y > horizon) {
    vec3 T;
    col = skSkyRadiance(skDirToECEF(rdW), 0.0, false, T) * S + skNightSky(rdW, 0.0);
    col = skApplyClouds(col, rdW, 1e10, true, 0.0);
  } else {
    // ground hemisphere: lambertian ground lit by sun + sky, seen through a little haze
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 skyIrr;
    vec3 sunIrr = GetSunAndSkyIrradiance(skCamECEF, skDirToECEF(up), skSunDirECEF, skyIrr);
    float cs = skCloudShadowAt(skCamWorld);
    vec3 E = sunIrr * mix(1.0, cs, 0.85) + skyIrr + skMoonIrr * max(skMoonDirW.y, 0.0);
    col = skGroundAlbedo * E * (1.0 / PI) * S + skCityGlow * skGroundAlbedo * 0.3;
    float k = smoothstep(horizon, horizon - 0.25, rdW.y);
    vec3 T;
    vec3 hz = skSkyRadiance(skDirToECEF(vec3(rdW.x, 0.001, rdW.z)), 0.0, false, T) * S;
    col = mix(hz * 0.6 + col * 0.4, col, k);
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`);
