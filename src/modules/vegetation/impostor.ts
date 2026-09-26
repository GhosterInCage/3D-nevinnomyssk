// Hemi-octahedral tree impostors: every tree species is rendered once at startup from N x N
// view directions over the upper hemisphere into an albedo + normal atlas (MRT). Far trees are
// camera-facing quads that blend the 4 nearest baked views, lit with the baked normals by the
// standard three.js lighting (sun, sky, CSM shadows, fog), wind-swayed like the meshes.
import * as THREE from 'three';
import { GLSL_COMMON, GLSL_TRANSLUCENT, LEAF_SPECULAR, VU, protectOnBeforeCompile } from './materials';

export const MAX_SLOTS = 32;

export interface BakeSource {
  slot: number;
  bark: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  barkMap: THREE.Texture | null;
  leafMap: THREE.Texture;
  barkTint: THREE.Color;
  leafTint: THREE.Color;
  centerY: number;
  radius: number;
  height: number;
}

const OCT_GLSL = /* glsl */ `
vec3 impOctDecode(vec2 g) {
  vec2 p = vec2(g.x + g.y, g.x - g.y) * 0.5;
  return normalize(vec3(p.x, 1.0 - abs(p.x) - abs(p.y), p.y));
}
vec2 impOctEncode(vec3 d) {
  d /= (abs(d.x) + abs(d.y) + abs(d.z));
  return vec2(d.x + d.z, d.x - d.z);
}
void impBasis(vec3 d, out vec3 r, out vec3 u) {
  vec3 f = -d;
  vec3 up = abs(d.y) > 0.999 ? vec3(0.0, 0.0, -1.0) : vec3(0.0, 1.0, 0.0);
  r = normalize(cross(f, up));
  u = cross(r, f);
}
`;

export class ImpostorAtlas {
  readonly N: number;          // frames per side
  readonly F: number;          // frame size (px)
  readonly cols: number;
  readonly rows: number;
  readonly rt: THREE.WebGLRenderTarget;
  /** per slot: (u0, v0, slotSizeU, N) and (centerY, radius, height, 0) */
  readonly slotA: THREE.Vector4[] = [];
  readonly slotB: THREE.Vector4[] = [];

  constructor(slots: number, N = 8, F = 64) {
    this.N = N; this.F = F;
    this.cols = Math.min(slots, 8);
    this.rows = Math.ceil(slots / this.cols);
    const S = N * F;
    this.rt = new THREE.WebGLRenderTarget(this.cols * S, this.rows * S, {
      count: 2,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
    });
    for (const t of this.rt.textures) { t.anisotropy = 4; t.colorSpace = THREE.NoColorSpace; }
    for (let i = 0; i < MAX_SLOTS; i++) { this.slotA.push(new THREE.Vector4(0, 0, 0, N)); this.slotB.push(new THREE.Vector4(0, 1, 1, 0)); }
  }

  get albedo(): THREE.Texture { return this.rt.textures[0]; }
  get normal(): THREE.Texture { return this.rt.textures[1]; }

  bake(renderer: THREE.WebGLRenderer, sources: BakeSource[]): void {
    const N = this.N, S = N * this.F;
    const W = this.cols * S, Hh = this.rows * S;
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      uniforms: {
        uN: { value: N }, uCY: { value: 0 }, uR: { value: 1 },
        uMap: { value: null }, uTint: { value: new THREE.Color() }, uAlphaTest: { value: 0.5 }, uUseMap: { value: 1 },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        in vec3 position; in vec3 normal; in vec2 uv; in vec3 color; in float frame;
        uniform float uN; uniform float uCY; uniform float uR;
        out vec2 vUv; out vec3 vN; out vec3 vC;
        ${OCT_GLSL}
        void main() {
          float fi = mod(frame, uN); float fj = floor(frame / uN + 0.001);
          vec2 g = vec2(fi, fj) / (uN - 1.0) * 2.0 - 1.0;
          vec3 d = impOctDecode(g);
          vec3 r, u; impBasis(d, r, u);
          vec3 lp = position - vec3(0.0, uCY, 0.0);
          vec2 xy = vec2(dot(lp, r), dot(lp, u)) / uR;
          float z = -dot(lp, d) / uR;
          vec2 cell = (vec2(fi, fj) + xy * 0.5 + 0.5) / uN * 2.0 - 1.0;
          gl_Position = vec4(cell, z * 0.5, 1.0);
          vUv = uv; vN = normal; vC = color;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uMap; uniform vec3 uTint; uniform float uAlphaTest; uniform int uUseMap;
        in vec2 vUv; in vec3 vN; in vec3 vC;
        layout(location = 0) out vec4 oAlbedo;
        layout(location = 1) out vec4 oNormal;
        void main() {
          vec4 t = texture(uMap, vUv);
          if (uUseMap == 1 && t.a < uAlphaTest) discard;
          vec3 c = t.rgb * uTint * vC;
          oAlbedo = vec4(pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
          vec3 n = normalize(vN);
          oNormal = vec4(n * 0.5 + 0.5, 1.0);
        }`,
    });
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const frames = new Float32Array(N * N).map((_, i) => i);
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    for (const src of sources) {
      const sx = (src.slot % this.cols) * S, sy = Math.floor(src.slot / this.cols) * S;
      this.slotA[src.slot].set(sx / W, sy / Hh, S / W, N);
      this.slotB[src.slot].set(src.centerY, src.radius, src.height, S / Hh);
      this.rt.viewport.set(sx, sy, S, S);
      this.rt.scissor.set(sx, sy, S, S);
      this.rt.scissorTest = true;
      renderer.setRenderTarget(this.rt);
      // transparent black: the atlas is premultiplied, so filtering / mips stay fringe-free
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      mat.uniforms.uCY.value = src.centerY;
      mat.uniforms.uR.value = src.radius;
      for (const part of [
        { g: src.bark, map: src.barkMap, tint: src.barkTint, useMap: src.barkMap ? 0 : 0 },
        { g: src.leaves, map: src.leafMap, tint: src.leafTint, useMap: 1 },
      ]) {
        if (!part.g.getAttribute('position') || part.g.getAttribute('position').count === 0) continue;
        const ig = new THREE.InstancedBufferGeometry();
        for (const name of ['position', 'normal', 'uv', 'color']) ig.setAttribute(name, part.g.getAttribute(name));
        ig.setIndex(part.g.getIndex());
        ig.setAttribute('frame', new THREE.InstancedBufferAttribute(frames, 1));
        ig.instanceCount = N * N;
        mat.uniforms.uMap.value = part.map ?? src.leafMap;
        mat.uniforms.uTint.value = part.tint;
        mat.uniforms.uUseMap.value = part.useMap;
        const mesh = new THREE.Mesh(ig, mat);
        mesh.frustumCulled = false;
        scene.add(mesh);
        renderer.render(scene, cam);
        scene.remove(mesh);
        ig.dispose();
      }
    }
    this.rt.scissorTest = false;
    this.rt.viewport.set(0, 0, W, Hh);
    this.rt.scissor.set(0, 0, W, Hh);
    // regenerate mipmaps over the whole atlas
    renderer.setRenderTarget(this.rt);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    mat.dispose();
  }
}

/** Uniforms controlling the impostor layer (shared by colour + depth materials). */
export interface ImpostorUniforms {
  /** x,y: fade-in start/end (m, near LOD boundary); z: thinning start distance; w: thinning exponent */
  uImpLod: { value: THREE.Vector4 };
  /** x: max shadow distance, y: global crown scale */
  uImpMisc: { value: THREE.Vector4 };
}

const IMP_VERTEX_PARS = /* glsl */ `
${GLSL_COMMON}
${OCT_GLSL}
attribute vec4 iPos;   // x, y, z (tree base, world), yaw
attribute vec4 iDim;   // scaleY, scaleXZ, slot, rank
uniform vec4 uImpA[${MAX_SLOTS}];
uniform vec4 uImpB[${MAX_SLOTS}];
uniform vec4 uImpLod;
uniform vec4 uImpMisc;
varying vec4 vImpUv01;
varying vec4 vImpUv23;
varying vec4 vImpF01;
varying vec4 vImpF23;
varying vec4 vImpW;
varying vec4 vImpSlot;
varying vec4 vImpRot;   // cos yaw, sin yaw, 1/sXZ, 1/sY
varying vec2 vImpFade;  // fade-in, tint seed
`;

const IMP_VERTEX_MAIN = /* glsl */ `
{
  int sidx = int(iDim.z + 0.5);
  vec4 A = uImpA[sidx];
  vec4 B = uImpB[sidx];
  float N = A.w;
  float sY = iDim.x, sXZ = iDim.y;
  vec3 base = iPos.xyz;
  float cy = cos(iPos.w), sy = sin(iPos.w);
  vec3 center = base + vec3(0.0, B.x * sY, 0.0);
  float dist = distance(center, uCamPos);
  float keep = dist > uImpLod.z ? pow(uImpLod.z / dist, uImpLod.w) : 1.0;
  float grow = mix(1.0, inversesqrt(max(keep, 0.03)), 0.9) * uImpMisc.y;
  // survivors close to the threshold shrink smoothly so the thinning is invisible
  float k2 = keep * 1.18;
  float alive = 1.0 - smoothstep(k2 * 0.85, k2, iDim.w);
  vImpFade = vec2(clamp((dist - uImpLod.x) / max(uImpLod.y - uImpLod.x, 1e-3), 0.0, 1.0), vegHash12(base.xz + 7.1));
#ifdef IMP_DEPTH
  if (dist > uImpMisc.x) alive = 0.0;
#endif
  if (dist < uImpLod.x || alive <= 0.0) {
    transformed = center; // degenerate quad
    vImpW = vec4(0.0);
  } else {
    vec3 camFwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    vec3 toCam = isOrthographic ? -camFwd : normalize(cameraPosition - center);
    // local (unrotated, unscaled) view direction
    vec3 tl = vec3(cy * toCam.x - sy * toCam.z, toCam.y, sy * toCam.x + cy * toCam.z);
    vec3 dl = normalize(vec3(tl.x / sXZ, max(tl.y, 0.0) / sY, tl.z / sXZ));
    vec2 gg = (impOctEncode(dl) * 0.5 + 0.5) * (N - 1.0);
    vec2 f0 = clamp(floor(gg), vec2(0.0), vec2(N - 2.0));
    vec2 fr = clamp(gg - f0, 0.0, 1.0);
#ifdef IMP_SINGLE
    f0 = floor(gg + 0.5); fr = vec2(0.0);
    f0 = clamp(f0, vec2(0.0), vec2(N - 1.0));
#endif
    // world billboard
    vec3 wr, wu; impBasis(toCam, wr, wu);
    float Rw = B.y * max(sXZ, sY) * grow * alive;
    // wind: sway the upper part like the trunk of the mesh LODs
    float treeH = B.z * sY;
    vec3 corner = center + (wr * position.x + wu * position.y) * Rw;
    vec3 rel = corner - base;
    corner += vegWind(vec3(0.0, max(rel.y, 0.0), 0.0), vec3(0.0), base, treeH * grow, 1.0) ;
    transformed = corner;
    // local offset of the corner (model units) for per-frame UVs
    vec3 vw = (corner - center) / max(grow * alive, 1e-3);
    vec3 vlr = vec3(cy * vw.x - sy * vw.z, vw.y, sy * vw.x + cy * vw.z);
    vec3 vl = vec3(vlr.x / sXZ, vlr.y / sY, vlr.z / sXZ);
    vec2 F[4];
    F[0] = f0; F[1] = f0 + vec2(1.0, 0.0); F[2] = f0 + vec2(0.0, 1.0); F[3] = f0 + vec2(1.0, 1.0);
    vec2 L[4];
    for (int k = 0; k < 4; k++) {
      vec3 fd = impOctDecode(F[k] / (N - 1.0) * 2.0 - 1.0);
      vec3 fr_, fu_; impBasis(fd, fr_, fu_);
      L[k] = vec2(dot(vl, fr_), dot(vl, fu_)) / B.y * 0.5 + 0.5;
    }
    vImpUv01 = vec4(L[0], L[1]);
    vImpUv23 = vec4(L[2], L[3]);
    vImpF01 = vec4(F[0], F[1]);
    vImpF23 = vec4(F[2], F[3]);
    vImpW = vec4((1.0 - fr.x) * (1.0 - fr.y), fr.x * (1.0 - fr.y), (1.0 - fr.x) * fr.y, fr.x * fr.y);
    vImpSlot = vec4(A.xy, A.z, B.w);
    vImpRot = vec4(cy, sy, 1.0 / sXZ, 1.0 / sY);
  }
}
`;

const IMP_FRAG_PARS = /* glsl */ `
uniform sampler2D uImpAlbedo;
uniform sampler2D uImpNormal;
uniform float uImpN;
uniform float uImpFramePx;
varying vec4 vImpUv01;
varying vec4 vImpUv23;
varying vec4 vImpF01;
varying vec4 vImpF23;
varying vec4 vImpW;
varying vec4 vImpSlot;
varying vec4 vImpRot;
varying vec2 vImpFade;
float vegIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec2 impAtlasUv(vec2 luv, vec2 F) { return vImpSlot.xy + (F + clamp(luv, 0.0, 1.0)) / uImpN * vImpSlot.zw; }
float impInside(vec2 luv) { return step(0.0, luv.x) * step(0.0, luv.y) * step(luv.x, 1.0) * step(luv.y, 1.0); }
`;

// accumulate colour + normal over the 4 frames
const IMP_FRAG_SAMPLE = /* glsl */ `
  vec4 impAcc = vec4(0.0);
  vec3 impNAcc = vec3(0.0);
  {
    vec2 luv[4]; luv[0] = vImpUv01.xy; luv[1] = vImpUv01.zw; luv[2] = vImpUv23.xy; luv[3] = vImpUv23.zw;
    vec2 fr[4]; fr[0] = vImpF01.xy; fr[1] = vImpF01.zw; fr[2] = vImpF23.xy; fr[3] = vImpF23.zw;
    float w[4]; w[0] = vImpW.x; w[1] = vImpW.y; w[2] = vImpW.z; w[3] = vImpW.w;
    for (int k = 0; k < IMP_FRAMES; k++) {
      if (w[k] < 0.001) continue;
      vec2 auv = impAtlasUv(luv[k], fr[k]);
      float ins = impInside(luv[k]);
      vec4 a = texture2D(uImpAlbedo, auv) * ins;
#ifndef IMP_DEPTH
      vec4 nt = texture2D(uImpNormal, auv);
      impNAcc += (nt.xyz * 2.0 - nt.a) * ins * w[k];
#endif
      impAcc += a * w[k];
    }
  }
  vec2 impDx = dFdx(vImpUv01.xy * uImpFramePx);
  vec2 impDy = dFdy(vImpUv01.xy * uImpFramePx);
  float impMip = max(0.0, 0.5 * log2(max(dot(impDx, impDx), dot(impDy, impDy))));
  float impA = impAcc.a * (1.0 + impMip * 0.28);
  if (impA < 0.5) discard;
`;

export function makeImpostorMaterials(atlas: ImpostorAtlas, u: ImpostorUniforms, quality: { blend: boolean; translucency: number }): {
  mat: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial;
} {
  const frames = quality.blend ? 4 : 1;
  const common = (shader: any, depth: boolean) => {
    shader.uniforms.uTime = VU.uTime;
    shader.uniforms.uWind = VU.uWind;
    shader.uniforms.uCamPos = VU.uCamPos;
    shader.uniforms.uImpA = { value: atlas.slotA };
    shader.uniforms.uImpB = { value: atlas.slotB };
    shader.uniforms.uImpLod = u.uImpLod;
    shader.uniforms.uImpMisc = u.uImpMisc;
    shader.uniforms.uImpAlbedo = { value: atlas.albedo };
    shader.uniforms.uImpNormal = { value: atlas.normal };
    shader.uniforms.uImpN = { value: atlas.N };
    shader.uniforms.uImpFramePx = { value: atlas.F };
    const fr = depth ? 1 : frames;
    const defs = `#define IMP_FRAMES ${fr}\n${fr === 1 ? '#define IMP_SINGLE\n' : ''}${depth ? '#define IMP_DEPTH\n' : ''}`;
    shader.vertexShader = defs + shader.vertexShader
      .replace('#include <common>', `#include <common>\n${IMP_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${IMP_VERTEX_MAIN}`);
    shader.fragmentShader = defs + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${IMP_FRAG_PARS}`);
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0, envMapIntensity: 0.5 });
  protectOnBeforeCompile(mat, (shader) => {
    common(shader, false);
    shader.uniforms.uTransl = { value: quality.translucency };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${GLSL_TRANSLUCENT}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  { float vn = vegIGN(gl_FragCoord.xy); if ((1.0 - vn) > vImpFade.x) discard; }`)
      .replace('#include <map_fragment>', `${IMP_FRAG_SAMPLE}
  vec3 impCol = impAcc.rgb / max(impAcc.a, 1e-4);
  impCol = pow(impCol, vec3(2.2));
  float tj = vImpFade.y - 0.5;
  impCol *= (1.0 + tj * 0.18) * vec3(1.0 + tj * 0.06, 1.0, 1.0 - tj * 0.06);
  diffuseColor.rgb *= impCol;
  vec3 impNl = normalize(impNAcc / max(impAcc.a, 1e-4));
  impNl = normalize(vec3(impNl.x * vImpRot.z, impNl.y * vImpRot.w, impNl.z * vImpRot.z));
  vec3 impNw = vec3(vImpRot.x * impNl.x + vImpRot.y * impNl.z, impNl.y, -vImpRot.y * impNl.x + vImpRot.x * impNl.z);`)
      .replace('#include <normal_fragment_begin>', `float faceDirection = 1.0;
  vec3 normal = normalize((viewMatrix * vec4(impNw, 0.0)).xyz);
  vec3 nonPerturbedNormal = normal;`)
      .replace('#include <normal_fragment_maps>', '')
      .replace('#include <lights_physical_fragment>', LEAF_SPECULAR);
  }, `impostor-${frames}`);

  const depth = new THREE.MeshDepthMaterial();
  protectOnBeforeCompile(depth, (shader) => {
    common(shader, true);
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', IMP_FRAG_SAMPLE);
  }, `impostor-depth-1`);
  return { mat, depth };
}

/** Quad geometry for impostor chunks (instanced attributes added per chunk). */
export function impostorQuad(): { position: THREE.BufferAttribute; index: THREE.BufferAttribute } {
  return {
    position: new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    index: new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1),
  };
}
