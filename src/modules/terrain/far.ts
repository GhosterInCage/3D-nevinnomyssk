// Far terrain: +-184 km around the city (Greater Caucasus with Elbrus, Stavropol upland,
// steppe) as a static RTIN mesh in the backdrop scene. Earth curvature (with refraction) is
// applied in the vertex shader relative to the camera; aerial perspective uses an exponential
// Rayleigh + Mie atmosphere integrated along the view ray.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { dataUrl, fetchBuffer, fetchJSON } from '../../core/data';
import { lockOnBeforeCompile } from './material';

interface FarTile { x0: number; z0: number; size: number; nv: number; ni: number; offV: number; offI: number }
interface FarMeta {
  half: number; size: number; n: number; res: number; hMin: number; hScale: number; regionHalf: number;
  maxHeight: number; tiles: FarTile[]; vertices: number; indices: number; color: string; normal: string; mesh: string;
}

const EARTH_R = 6371000;
const REFRACTION_K = 0.13;

const VERT_PARS = /* glsl */ `
uniform vec3 uCam;
uniform float uRegionHalf;
uniform float uEffR;
uniform float uFarHalf;
varying vec3 vFarW;
varying vec2 vFarUv;
float tDrop(float d) { return d * d / (2.0 * uEffR); }
`;

const VERT_MAIN = /* glsl */ `
vec3 transformed = vec3(position);
{
  vec2 dxz = transformed.xz - uCam.xz;
  float d = length(dxz);
  vec2 dir = dxz / max(d, 1e-3);
  // the detailed region is rendered flat: curvature starts at the region boundary so the
  // far surface meets the detailed terrain edge
  float tExit = 0.0;
  if (abs(uCam.x) < uRegionHalf && abs(uCam.z) < uRegionHalf) {
    vec2 ad = max(abs(dir), vec2(1e-6));
    vec2 tt = (uRegionHalf - uCam.xz * sign(dir)) / ad;
    tExit = min(tt.x, tt.y);
  }
  float dSeam = min(tExit, d);
  transformed.y -= tDrop(d) - tDrop(dSeam);
  vFarW = transformed;
  vFarUv = (transformed.xz + uFarHalf) / (2.0 * uFarHalf);
}
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uColor;
uniform sampler2D uNormal;
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform vec3 uHazeCol;      // in-scattered radiance at infinity (horizon)
uniform vec3 uBetaR;        // Rayleigh extinction at sea level (1/m)
uniform float uBetaM;       // Mie extinction at sea level (1/m)
uniform vec2 uScaleH;       // (Rayleigh, Mie) scale heights (m)
uniform float uSunGlow;
uniform float uHazeOn;      // own aerial perspective (only without the sky pipeline)
varying vec3 vFarW;
varying vec2 vFarUv;
float odPath(float beta, float H, float h0, float h1, float len) {
  float a = exp(-max(h0, -200.0) / H), b = exp(-max(h1, -200.0) / H);
  float dh = h1 - h0;
  float avg = abs(dh) < 1.0 ? a : H * (a - b) / dh;
  return beta * len * avg;
}
vec3 farNormalW;
`;

const FRAG_MAP = /* glsl */ `
diffuseColor.rgb *= texture2D(uColor, vFarUv).rgb;
{
  vec2 nn = texture2D(uNormal, vFarUv).rg * 2.0 - 1.0;
  farNormalW = normalize(vec3(nn.x, sqrt(max(1.0 - dot(nn, nn), 0.0)), nn.y));
}
`;

const FRAG_HAZE = /* glsl */ `
if (uHazeOn > 0.5) {
  vec3 v = vFarW - uCam;
  float len = length(v);
  vec3 odR = uBetaR * odPath(1.0, uScaleH.x, uCam.y, vFarW.y, len);
  float odM = odPath(uBetaM, uScaleH.y, uCam.y, vFarW.y, len);
  vec3 T = exp(-(odR + vec3(odM)));
  float mu = dot(v / max(len, 1.0), uSunDir);
  vec3 haze = uHazeCol * (1.0 + uSunGlow * pow(max(mu, 0.0), 8.0));
  gl_FragColor.rgb = gl_FragColor.rgb * T + haze * (1.0 - T);
}
#include <tonemapping_fragment>
`;


export class FarTerrain {
  readonly group = new THREE.Group();
  meta!: FarMeta;
  material!: THREE.MeshStandardMaterial;
  uniforms!: Record<string, THREE.IUniform>;
  /** Horizontal visibility (km) on a clear day; scaled down by env.fog. */
  visibilityKm = 170;
  private hazeOverride: THREE.Color | null = null;
  private triangles = 0;

  constructor(private ctx: AppContext) {
    this.group.name = 'terrain-far';
  }

  async load(): Promise<void> {
    const meta = await fetchJSON<FarMeta>('terrain/far.json');
    this.meta = meta;
    const [buf, color, normal] = await Promise.all([
      fetchBuffer(meta.mesh),
      new THREE.TextureLoader().loadAsync(dataUrl(meta.color)),
      new THREE.TextureLoader().loadAsync(dataUrl(meta.normal)),
    ]);
    for (const t of [color, normal]) {
      t.flipY = false;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = 4;
      t.needsUpdate = true;
    }
    color.colorSpace = THREE.SRGBColorSpace;
    normal.colorSpace = THREE.NoColorSpace;
    const u16 = new Uint16Array(buf);
    this.uniforms = {
      uColor: { value: color },
      uNormal: { value: normal },
      uCam: { value: new THREE.Vector3() },
      uRegionHalf: { value: meta.regionHalf },
      uEffR: { value: EARTH_R / (1 - REFRACTION_K) },
      uFarHalf: { value: meta.half },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uHazeCol: { value: new THREE.Vector3(0.5, 0.6, 0.75) },
      uBetaR: { value: new THREE.Vector3(5.8e-6, 13.5e-6, 33.1e-6) },
      uBetaM: { value: 8e-6 },
      uScaleH: { value: new THREE.Vector2(8000, 1300) },
      uSunGlow: { value: 1.5 },
      uHazeOn: { value: 1 },
    };
    const uniforms = this.uniforms;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0 });
    mat.name = 'terrain-far';
    lockOnBeforeCompile(mat, (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', VERT_MAIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', FRAG_MAP)
        .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(farNormalW, 0.0)).xyz);')
        .replace('#include <tonemapping_fragment>', FRAG_HAZE);
    });
    mat.customProgramCacheKey = () => 'terrain-far-v1';
    this.material = this.ctx.registerMaterial(mat);
    const vEnd = meta.vertices * 3;
    for (const t of meta.tiles) {
      const pos = new Float32Array(t.nv * 3);
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < t.nv; i++) {
        const o = (t.offV + i) * 3;
        const y = meta.hMin + u16[o + 2] * meta.hScale;
        pos[i * 3] = t.x0 + (u16[o] / 65535) * t.size;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = t.z0 + (u16[o + 1] / 65535) * t.size;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const idx = new Uint16Array(u16.buffer, u16.byteOffset + (vEnd + t.offI) * 2, t.ni).slice();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      // generous bounds: the curvature drop moves vertices down by up to ~3 km
      const c = new THREE.Vector3(t.x0 + t.size / 2, (minY + maxY) / 2 - 1500, t.z0 + t.size / 2);
      g.boundingSphere = new THREE.Sphere(c, Math.hypot(t.size / 2, t.size / 2, (maxY - minY) / 2 + 3000));
      const m = new THREE.Mesh(g, this.material);
      m.renderOrder = 5;
      m.name = 'terrain-far-tile';
      m.userData.noPathTrace = true;
      this.group.add(m);
      this.triangles += t.ni / 3;
    }
    this.ctx.backdrop.scene.add(this.group);
  }

  /** Override the haze colour (linear radiance) and/or visibility; pass null to use scene fog. */
  setAtmosphere(opts: { hazeColor?: THREE.Color | null; visibilityKm?: number }): void {
    if (opts.hazeColor !== undefined) this.hazeOverride = opts.hazeColor ? opts.hazeColor.clone() : null;
    if (opts.visibilityKm !== undefined) this.visibilityKm = opts.visibilityKm;
  }

  update(): void {
    if (!this.material) return;
    const ctx = this.ctx, env = ctx.env, u = this.uniforms;
    (u.uCam.value as THREE.Vector3).copy(ctx.camera.position);
    (u.uSunDir.value as THREE.Vector3).copy(env.sunDirection);
    // with the sky module the post-processing pipeline applies aerial perspective to the
    // backdrop (combined depth); otherwise we apply our own
    const skyAP = !!ctx.get('sky');
    u.uHazeOn.value = skyAP ? 0 : 1;
    if (skyAP) return;
    const hz = u.uHazeCol.value as THREE.Vector3;
    const fog = ctx.scene.fog as THREE.Fog | THREE.FogExp2 | null;
    const day = Math.max(0.02, Math.min(1, env.sunDirection.y * 3 + 0.15));
    if (this.hazeOverride) hz.set(this.hazeOverride.r, this.hazeOverride.g, this.hazeOverride.b);
    else if (fog) hz.set(fog.color.r, fog.color.g, fog.color.b).multiplyScalar(day);
    else hz.set(0.62, 0.72, 0.86).multiplyScalar(day);
    // visibility -> Mie extinction at sea level (Koschmieder: beta = 3.912 / V)
    const vis = this.visibilityKm * (1 - 0.9 * Math.min(1, env.fog)) * (1 - 0.5 * Math.min(1, env.rain));
    const betaTotal = 3.912 / (Math.max(5, vis) * 1000);
    u.uBetaM.value = Math.max(1e-6, betaTotal - 1.2e-5);
  }

  stats(): Record<string, number> {
    return { tiles: this.group.children.length, triangles: this.triangles };
  }
}
