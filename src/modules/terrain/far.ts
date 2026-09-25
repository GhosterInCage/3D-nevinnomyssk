// Far terrain: +-184 km around the city (Greater Caucasus with Elbrus, Stavropol upland,
// steppe) as a static RTIN mesh in the backdrop scene. Earth curvature (with refraction) is
// applied in the vertex shader relative to the camera; aerial perspective uses an exponential
// Rayleigh + Mie atmosphere integrated along the view ray.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { dataUrl, fetchBuffer, fetchJSON } from '../../core/data';
import { lockOnBeforeCompile } from './material';
import { HAZE_PARS } from './shaders';
import type { Haze } from './haze';

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
${HAZE_PARS}
uniform vec3 uNightLight;   // settlement light radiance at full built-up fraction (0 by day)
uniform float uRegionHalfF;
varying vec3 vFarW;
varying vec2 vFarUv;
vec3 farNormalW;
float farBuilt;
float fHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

const FRAG_MAP = /* glsl */ `
diffuseColor.rgb *= texture2D(uColor, vFarUv).rgb;
{
  vec3 ns = texture2D(uNormal, vFarUv).rgb;
  vec2 nn = ns.rg * 2.0 - 1.0;
  farNormalW = normalize(vec3(nn.x, sqrt(max(1.0 - dot(nn, nn), 0.0)), nn.y));
  farBuilt = ns.b;
}
`;

const FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
if (uNightLight.r > 0.0) {
  // settlements outside the detailed region glow at night (clustered, not uniform)
  bool outside = abs(vFarW.x) > uRegionHalfF || abs(vFarW.z) > uRegionHalfF;
  vec2 cell = floor(vFarW.xz / 350.0);
  float cl = 0.35 + 0.65 * fHash(cell) * fHash(cell.yx + 7.0);
  totalEmissiveRadiance += outside ? uNightLight * farBuilt * farBuilt * cl * 2.0 : vec3(0.0);
}
`;

const FRAG_HAZE = /* glsl */ `
if (uHazeOn > 0.5) gl_FragColor.rgb = hzApply(gl_FragColor.rgb, uCam, vFarW);
#include <tonemapping_fragment>
`;


export class FarTerrain {
  readonly group = new THREE.Group();
  meta!: FarMeta;
  material!: THREE.MeshStandardMaterial;
  uniforms!: Record<string, THREE.IUniform>;
  /** Settlement light radiance at night (sodium orange, scaled by the built-up fraction). */
  nightLights = 0.5;
  private triangles = 0;

  constructor(private ctx: AppContext, private haze: Haze) {
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
      ...this.haze.uniforms,
      uNightLight: { value: new THREE.Vector3() },
      uRegionHalfF: { value: meta.regionHalf },
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
        .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
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

  update(): void {
    if (!this.material) return;
    const ctx = this.ctx, u = this.uniforms;
    (u.uCam.value as THREE.Vector3).copy(ctx.camera.position);
    (u.uNightLight.value as THREE.Vector3).set(1.0, 0.58, 0.26).multiplyScalar(this.nightLights * ctx.env.night);
  }

  /** Stand-alone haze parameters (ignored while the sky module renders aerial perspective). */
  setAtmosphere(opts: { hazeColor?: THREE.Color | null; visibilityKm?: number }): void {
    if (opts.hazeColor !== undefined) this.haze.hazeOverride = opts.hazeColor ? opts.hazeColor.clone() : null;
    if (opts.visibilityKm !== undefined) this.haze.visibilityKm = opts.visibilityKm;
  }

  stats(): Record<string, number> {
    return { tiles: this.group.children.length, triangles: this.triangles };
  }
}
