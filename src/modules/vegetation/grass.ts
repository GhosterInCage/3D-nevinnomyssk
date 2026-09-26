// GPU grass / ground cover around the camera: rings of instanced blade tufts whose positions are
// derived from gl_InstanceID on a world-aligned grid (stable while the camera moves). Density,
// type (lawn, steppe, reeds, ripe cereal, green crop, stubble) and dryness come from the pipeline
// cover rasters (10 m); a 2 m "no-grow" mask removes grass from roads, sidewalks, buildings, rail
// and water. Colour is matched to the Sentinel-2 ortho the terrain uses.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { GLSL_COMMON, LEAF_SPECULAR, VU, protectOnBeforeCompile } from './materials';
import { pointInRing } from './data';

export interface GrassRing { spacing: number; rIn: number; rOut: number; blades: number; segs: number; width: number; density: number }

export function grassRings(q: string): GrassRing[] {
  switch (q) {
    case 'low': return [];
    case 'medium': return [
      { spacing: 0.2, rIn: 0, rOut: 11, blades: 4, segs: 3, width: 1.0, density: 1 },
      { spacing: 0.45, rIn: 11, rOut: 30, blades: 2, segs: 2, width: 1.6, density: 1 },
      { spacing: 1.1, rIn: 30, rOut: 70, blades: 1, segs: 1, width: 3.2, density: 0.9 },
    ];
    case 'ultra': return [
      { spacing: 0.13, rIn: 0, rOut: 16, blades: 5, segs: 4, width: 1.0, density: 1 },
      { spacing: 0.3, rIn: 16, rOut: 40, blades: 3, segs: 3, width: 1.4, density: 1 },
      { spacing: 0.7, rIn: 40, rOut: 95, blades: 2, segs: 2, width: 2.4, density: 1 },
      { spacing: 1.5, rIn: 95, rOut: 170, blades: 1, segs: 1, width: 4.0, density: 0.9 },
    ];
    case 'high':
    default: return [
      { spacing: 0.16, rIn: 0, rOut: 13, blades: 5, segs: 3, width: 1.0, density: 1 },
      { spacing: 0.36, rIn: 13, rOut: 34, blades: 3, segs: 3, width: 1.5, density: 1 },
      { spacing: 0.85, rIn: 34, rOut: 80, blades: 2, segs: 2, width: 2.6, density: 1 },
      { spacing: 1.8, rIn: 80, rOut: 140, blades: 1, segs: 1, width: 4.2, density: 0.85 },
    ];
  }
}

function bladeGeometry(blades: number, segs: number): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const base = pos.length / 3;
    for (let s = 0; s < segs; s++) {
      const t = s / segs;
      pos.push(-1, t, b, 1, t, b);
    }
    pos.push(0, 1, b); // tip
    for (let s = 0; s < segs - 1; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const a = base + (segs - 1) * 2;
    idx.push(a, a + 1, a + 2);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

const GRASS_VERT_PARS = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D uGCover;
uniform sampler2D uGType;
uniform sampler2D uGOrtho;
uniform sampler2D uGNoGrow;
uniform sampler2D uGHeight;
uniform vec4 uGNoGrowRect;  // x0, z0, size, texels
uniform vec4 uGRing;        // spacing, N, rIn, rOut
uniform vec4 uGRing2;       // width scale, density mul, segs, band
uniform vec4 uGHF;          // half, res, n
varying vec3 vGCol;
varying vec2 vGT;           // t along blade, flower flag
#ifdef GRASS_TERRAIN_HF
float gHeight(vec2 p) { vec2 gr; return tHeightBicubic(p, gr) + 0.015; }
#else
float gHeight(vec2 p) {
  vec2 g = (p + uGHF.x) / uGHF.y;
  g = clamp(g, vec2(0.0), vec2(uGHF.z - 1.001));
  ivec2 i = ivec2(floor(g)); vec2 f = g - vec2(i);
  float a = texelFetch(uGHeight, i, 0).r, b = texelFetch(uGHeight, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uGHeight, i + ivec2(0, 1), 0).r, d = texelFetch(uGHeight, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
#endif
`;

const GRASS_VERT_MAIN = /* glsl */ `
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
vec3 grassPos = vec3(0.0);
vGCol = vec3(0.0); vGT = vec2(0.0);
{
  float sp = uGRing.x;
  int Ni = int(uGRing.y);
  int id = gl_InstanceID;
  vec2 cell = floor(uCamPos.xz / sp) - floor(uGRing.y * 0.5) + vec2(float(id % Ni), float(id / Ni));
  vec2 cm = mod(cell, 4096.0);
  float h1 = vegHash12(cm * 0.7131 + 11.3), h2 = vegHash12(cm.yx * 1.3717 + 3.1);
  float hk = vegHash12(cm * 1.919 + 5.3), hv = vegHash12(cm * 0.513 + 17.9);
  float bi = position.z;
  float hb1 = vegHash12(cm + bi * 7.77 + 1.3), hb2 = vegHash12(cm * 1.1 + bi * 3.31 + 9.1), hb3 = vegHash12(cm * 0.9 + bi * 5.13 + 2.2);
  vec2 p = (cell + vec2(h1, h2)) * sp;
  p += (vec2(hb1, hb2) - 0.5) * sp * 0.9 * step(0.5, bi);
  float dist = length(p - uCamPos.xz);
  vec2 cuv = (p + uGHF.x) / (2.0 * uGHF.x);
  vec4 cov = texture2D(uGCover, cuv);
  float type = floor(texture2D(uGType, cuv).r * 255.0 + 0.5);
  vec2 nuv = (p - uGNoGrowRect.xy) / uGNoGrowRect.z;
  float ng = (nuv.x < 0.0 || nuv.y < 0.0 || nuv.x > 1.0 || nuv.y > 1.0) ? 0.0 : texture2D(uGNoGrow, nuv).r;
  float dens = pow(cov.r, 0.65) * (1.0 - smoothstep(0.2, 0.55, ng)) * uGRing2.y;
  float band = uGRing2.w;
  float fade = (uGRing.z > 0.0 ? smoothstep(uGRing.z - band, uGRing.z + band * 0.2, dist) : 1.0) * (1.0 - smoothstep(uGRing.w - band, uGRing.w, dist));
  if (hk < dens && fade > 0.02) {
    // blade parameters by cover type
    float hB = 0.18, wB = 0.010, lean = 0.35, stiff = 1.0;
    if (type < 0.5) { hB = 0.2; wB = 0.022; lean = 0.5; }
    else if (type < 1.5) { hB = 0.42; wB = 0.015; lean = 0.45; }
    else if (type < 2.5) { hB = 1.75; wB = 0.02; lean = 0.18; stiff = 0.6; }
    else if (type < 3.5) { hB = 0.82; wB = 0.011; lean = 0.07; stiff = 0.8; }
    else if (type < 4.5) { hB = 1.55; wB = 0.06; lean = 0.25; stiff = 0.5; }
    else { hB = 0.15; wB = 0.005; lean = 0.25; stiff = 0.2; }
    float hgt = hB * mix(0.4, 1.6, cov.b) * (0.55 + 0.9 * hb3) * fade;
    float wid = wB * uGRing2.x * (0.7 + 0.6 * hb1) * (0.4 + 0.6 * fade);
    float th = hb2 * 6.2832;
    vec3 side = vec3(cos(th), 0.0, sin(th));
    vec2 ld = normalize(vec2(hb1 - 0.5, hb3 - 0.5) + 1e-3);
    // wind
    float spd = length(uWind);
    vec2 wd = spd > 0.01 ? uWind / spd : vec2(1.0, 0.0);
    float gust = 0.55 + 0.45 * sin(dot(p, wd) * 0.21 - uTime * (1.3 + spd * 0.3)) * sin(dot(p, vec2(-wd.y, wd.x)) * 0.13 + uTime * 0.7);
    float bend = clamp((spd * 0.07 * gust + 0.03 * sin(uTime * 2.1 + hk * 30.0)) * stiff, 0.0, 0.85);
    float t = position.y;
    float tt = t * t;
    vec2 off = ld * lean * hgt * tt + wd * bend * hgt * tt;
    float up = hgt * t * (1.0 - 0.35 * (bend * bend + lean * lean * 0.5) * t);
    float g = gHeight(p);
    float w = wid * pow(max(1.0 - t, 0.0), 0.75);
    if (type > 2.5 && type < 3.5) w = wid * (t > 0.76 && t < 0.98 ? 2.6 : pow(max(1.0 - t, 0.0), 0.5));
    if (type > 3.5 && type < 4.5) w = wid * pow(sin(3.1416 * clamp(t * 0.9 + 0.1, 0.0, 1.0)), 0.6);
    grassPos = vec3(p.x + off.x, g + up - 0.02, p.y + off.y) + side * position.x * w * 0.5;
    vec3 tang = normalize(vec3(ld * lean * 2.0 * t + wd * bend * 2.0 * t, 1.0).xzy);
    vec3 nb = normalize(cross(side, tang));
    objectNormal = normalize(nb * sign(nb.y + 1e-3) * 0.45 + vec3(0.0, 1.0, 0.0) * 0.55);
    // colour
    vec3 ortho = texture2D(uGOrtho, cuv).rgb;
    float dry = cov.g;
    vec3 green = vec3(0.075, 0.135, 0.035), straw = vec3(0.34, 0.27, 0.11);
    vec3 base = mix(green, straw, clamp(dry * (0.55 + 0.7 * hv), 0.0, 1.0));
    if (type > 1.5 && type < 2.5) base = mix(vec3(0.12, 0.16, 0.05), vec3(0.30, 0.27, 0.12), dry * 0.5 + hv * 0.2);
    if (type > 2.5 && type < 3.5) base = mix(vec3(0.46, 0.35, 0.14), vec3(0.36, 0.33, 0.13), hv);
    if (type > 3.5 && type < 4.5) base = mix(vec3(0.07, 0.14, 0.035), vec3(0.11, 0.17, 0.04), hv);
    if (type > 4.5) base = mix(vec3(0.40, 0.33, 0.18), vec3(0.30, 0.25, 0.14), hv);
    base = mix(base, ortho * 1.3, 0.35);
    base *= 0.82 + 0.36 * hb3;
    vGCol = base;
    float flower = (type < 1.5 && hk < dens * 0.035 && bi < 0.5) ? 1.0 + floor(hv * 4.0) : 0.0;
    vGT = vec2(t, flower);
  } else {
    grassPos = vec3(uCamPos.x, -1000.0, uCamPos.z);
  }
}
`;

export class Grass {
  readonly group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private noGrowTex: THREE.DataTexture;
  private noGrowData: Uint8Array;
  private readonly WIN = 384;        // texels (2 m) -> 768 m window
  private readonly RES = 2;
  private rect = new THREE.Vector4(0, 0, 768, 384);
  private center = new THREE.Vector2(1e9, 1e9);
  private clears: number[][] = [];
  private rings: GrassRing[];
  private maxR = 0;

  constructor(private ctx: AppContext, private bits: Uint8Array, cover: THREE.Texture, type: THREE.Texture, ortho: THREE.Texture, quality: string, densityMul: number) {
    this.group.name = 'vegetation-grass';
    this.group.userData.noReflect = true;
    this.noGrowData = new Uint8Array(this.WIN * this.WIN);
    this.noGrowTex = new THREE.DataTexture(this.noGrowData, this.WIN, this.WIN, THREE.RedFormat, THREE.UnsignedByteType);
    this.noGrowTex.magFilter = THREE.LinearFilter;
    this.noGrowTex.minFilter = THREE.LinearFilter;
    this.noGrowTex.flipY = false;
    this.noGrowTex.needsUpdate = true;
    this.rings = grassRings(quality);
    const hf = ctx.heightfield;
    const hfTex = hf.texture;
    // match the terrain's rendered (bicubic) surface when the terrain module exposes its GLSL
    const terrainGlsl: string | undefined = ctx.get<any>('terrain')?.glsl?.heightfield;
    for (const ring of this.rings) {
      this.maxR = Math.max(this.maxR, ring.rOut);
      const N = Math.ceil((2 * ring.rOut) / ring.spacing) + 2;
      const g = bladeGeometry(ring.blades, ring.segs);
      g.instanceCount = N * N;
      const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.82, metalness: 0, envMapIntensity: 0.4 });
      const uRing = { value: new THREE.Vector4(ring.spacing, N, ring.rIn, ring.rOut) };
      const uRing2 = { value: new THREE.Vector4(ring.width, ring.density * densityMul, ring.segs, Math.max(2, ring.rOut * 0.12)) };
      protectOnBeforeCompile(mat, (shader) => {
        shader.uniforms.uTime = VU.uTime;
        shader.uniforms.uWind = VU.uWind;
        shader.uniforms.uCamPos = VU.uCamPos;
        shader.uniforms.uGCover = { value: cover };
        shader.uniforms.uGType = { value: type };
        shader.uniforms.uGOrtho = { value: ortho };
        shader.uniforms.uGNoGrow = { value: this.noGrowTex };
        shader.uniforms.uGHeight = { value: hfTex };
        shader.uniforms.uGNoGrowRect = { value: this.rect };
        shader.uniforms.uGRing = uRing;
        shader.uniforms.uGRing2 = uRing2;
        shader.uniforms.uGHF = { value: new THREE.Vector4(hf.half, hf.res, hf.n, 0) };
        shader.uniforms.uTransl = { value: 0.35 };
        if (terrainGlsl) {
          shader.uniforms.uHeight = { value: hfTex };
          shader.uniforms.uHf = { value: new THREE.Vector3(hf.n, hf.half, hf.res) };
        }
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${terrainGlsl ? `#define GRASS_TERRAIN_HF\n${terrainGlsl}\n` : ''}${GRASS_VERT_PARS}`)
          .replace('#include <beginnormal_vertex>', GRASS_VERT_MAIN)
          .replace('#include <begin_vertex>', 'vec3 transformed = grassPos;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vGCol;\nvarying vec2 vGT;`)
          .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec3 c = vGCol * mix(0.32, 1.12, pow(vGT.x, 0.8));
    c = mix(c, c * vec3(1.18, 1.1, 0.75), smoothstep(0.7, 1.0, vGT.x) * 0.5);
    if (vGT.y > 0.5 && vGT.x > 0.86) {
      vec3 fc = vGT.y < 1.5 ? vec3(0.85, 0.85, 0.8) : vGT.y < 2.5 ? vec3(0.9, 0.7, 0.05) : vGT.y < 3.5 ? vec3(0.35, 0.3, 0.8) : vec3(0.7, 0.25, 0.55);
      c = fc;
    }
    diffuseColor.rgb *= c;
  }`)
          .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
uniform float uTransl;
void RE_Direct_Grass( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float fwd = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 4.0 );
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor * uTransl * ( 0.15 + 0.9 * fwd );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Grass`)
          .replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;')
          .replace('#include <lights_physical_fragment>', LEAF_SPECULAR);
      }, terrainGlsl ? 'grass-thf' : 'grass');
      ctx.registerMaterial(mat);
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.castShadow = false;
      m.userData.noPathTrace = true;
      m.name = `veg-grass-${ring.rOut}`;
      this.meshes.push(m);
      this.group.add(m);
    }
    ctx.scene.add(this.group);
  }

  get enabled(): boolean { return this.meshes.length > 0; }

  addClear(ring: number[]): void {
    this.clears.push(ring);
    this.center.set(1e9, 1e9); // force rebuild
  }

  private rebuildWindow(cx: number, cz: number): void {
    const W = this.WIN, R = this.RES;
    const x0 = Math.round(cx / 64) * 64 - (W * R) / 2, z0 = Math.round(cz / 64) * 64 - (W * R) / 2;
    this.rect.set(x0, z0, W * R, W);
    this.center.set(x0 + (W * R) / 2, z0 + (W * R) / 2);
    const NB = 10240, rowBytes = NB / 8;
    const gx0 = Math.round((x0 + 10240) / R), gy0 = Math.round((z0 + 10240) / R);
    const out = this.noGrowData;
    for (let r = 0; r < W; r++) {
      const gy = gy0 + r;
      const o = r * W;
      if (gy < 0 || gy >= NB) { out.fill(255, o, o + W); continue; }
      const rb = gy * rowBytes;
      for (let c = 0; c < W; c++) {
        const gx = gx0 + c;
        if (gx < 0 || gx >= NB) { out[o + c] = 255; continue; }
        out[o + c] = (this.bits[rb + (gx >> 3)] >> (7 - (gx & 7))) & 1 ? 255 : 0;
      }
    }
    for (const ring of this.clears) {
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { minx = Math.min(minx, ring[i]); maxx = Math.max(maxx, ring[i]); minz = Math.min(minz, ring[i + 1]); maxz = Math.max(maxz, ring[i + 1]); }
      const c0 = Math.max(0, Math.floor((minx - x0) / R)), c1 = Math.min(W - 1, Math.ceil((maxx - x0) / R));
      const r0 = Math.max(0, Math.floor((minz - z0) / R)), r1 = Math.min(W - 1, Math.ceil((maxz - z0) / R));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        if (pointInRing(x0 + (c + 0.5) * R, z0 + (r + 0.5) * R, ring)) out[r * W + c] = 255;
      }
    }
    this.noGrowTex.needsUpdate = true;
  }

  update(): void {
    if (!this.meshes.length) return;
    const P = this.ctx.camera.position;
    const agl = P.y - this.ctx.heightfield.sample(P.x, P.z);
    const visible = agl < this.maxR * 0.9;
    this.group.visible = visible;
    if (!visible) return;
    const half = (this.WIN * this.RES) / 2;
    if (Math.abs(P.x - this.center.x) > half - this.maxR - 40 || Math.abs(P.z - this.center.y) > half - this.maxR - 40) {
      this.rebuildWindow(P.x, P.z);
    }
  }

  dispose(): void {
    for (const m of this.meshes) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.ctx.scene.remove(this.group);
    this.noGrowTex.dispose();
  }
}
