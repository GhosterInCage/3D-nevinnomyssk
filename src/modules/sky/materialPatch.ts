// Non-destructive material patch: cloud shadows on sun/moon light.
//
// Every material registered with ctx.registerMaterial (plus lit materials found
// in the scenes) gets an onBeforeCompile hook that multiplies the directional
// (sun/moon) light by the transmittance of the cloud layer above the fragment.
// The hook chains with the material's own onBeforeCompile - also one assigned
// *after* registration - via a property accessor, and keeps a distinct program
// cache key per user hook so different customised materials never share a
// program. Cascaded shadows need no patch (three's SunLight handles them).
import * as THREE from 'three';
import type { SkyUniforms } from './uniforms';

const PATCH_TAG = '/*sky-cs-v2*/';

const cloudShadowGlsl = /* glsl */ `
uniform sampler2D skCloudTex;
uniform vec4 skCloudP0;
uniform vec4 skCloudP1;
uniform vec3 skSunDirW;
uniform float skCloudShadowOn;
const mat2 SKP_ROT = mat2(0.8660254, 0.5, -0.5, 0.8660254);
float skpCloudShadow(const vec3 pW) {
  if (skCloudShadowOn < 0.5 || skCloudP0.x <= 0.001) return 1.0;
  float alt = skCloudP1.x + skCloudP1.y * 0.5;
  float t = (alt - pW.y) / max(skSunDirW.y, 0.05);
  vec2 q = pW.xz + skSunDirW.xz * t;
  vec2 uv = (q + skCloudP0.zw) * skCloudP0.y;
  float r = texture2D(skCloudTex, uv).r;
  float large = texture2D(skCloudTex, SKP_ROT * uv * 0.37 + 0.21).a;
  float cov = clamp(skCloudP0.x + (large - 0.5) * skCloudP1.w * (1.0 - skCloudP0.x) * 2.0, 0.0, 1.0);
  float d = clamp((r - (1.0 - cov * 1.35)) / 0.35, 0.0, 1.0);
  return exp(-d * skCloudP1.z * 0.45);
}
`;

export class MaterialPatcher {
  private patched = new WeakSet<THREE.Material>();
  private lightsChunk: string | null = null;
  readonly cloudShadowOn = new THREE.Uniform(1);
  count = 0;

  constructor(private shared: SkyUniforms) {}

  static isLit(m: THREE.Material): boolean {
    const x = m as any;
    return !!(x.isMeshStandardMaterial || x.isMeshPhysicalMaterial || x.isMeshLambertMaterial || x.isMeshPhongMaterial || x.isMeshToonMaterial || (x.isShaderMaterial && x.lights));
  }

  private expandedLightsChunk(): string | null {
    if (this.lightsChunk !== null) return this.lightsChunk;
    const src = THREE.ShaderChunk.lights_fragment_begin;
    let out = src;
    const sunCall = 'getSunLightInfo( sunLight, directLight );';
    const dirCall = 'getDirectionalLightInfo( directionalLight, directLight );';
    if (out.includes(sunCall)) out = out.replace(sunCall, `${sunCall}\n\t\tdirectLight.color *= skpCS;`);
    if (out.includes(dirCall)) out = out.replace(dirCall, `${dirCall}\n\t\tdirectLight.color *= skpCS;`);
    if (out === src) { this.lightsChunk = ''; return null; }
    this.lightsChunk = `float skpCS = skpCloudShadow( ( vec4( -vViewPosition - viewMatrix[3].xyz, 0.0 ) * viewMatrix ).xyz );\n${out}`;
    return this.lightsChunk;
  }

  private inject(shader: THREE.WebGLProgramParametersWithUniforms): void {
    const fs = shader.fragmentShader;
    if (!fs.includes('#include <lights_fragment_begin>') || !fs.includes('#include <lights_pars_begin>')) return;
    if (!fs.includes('vViewPosition')) return;
    const chunk = this.expandedLightsChunk();
    if (!chunk) return;
    const s = this.shared;
    shader.uniforms.skCloudTex = s.skCloudTex;
    shader.uniforms.skCloudP0 = s.skCloudP0;
    shader.uniforms.skCloudP1 = s.skCloudP1;
    shader.uniforms.skSunDirW = s.skCloudKeyDirW;
    shader.uniforms.skCloudShadowOn = this.cloudShadowOn;
    shader.fragmentShader = fs
      .replace('#include <lights_pars_begin>', `#include <lights_pars_begin>\n${cloudShadowGlsl}`)
      .replace('#include <lights_fragment_begin>', chunk);
  }

  patch(mat: THREE.Material): boolean {
    if (!mat || this.patched.has(mat) || !MaterialPatcher.isLit(mat)) return false;
    if ((mat as any).userData?.noSkyPatch) return false;
    this.patched.add(mat);
    const self = this;
    const baseProto = THREE.Material.prototype.onBeforeCompile;
    const state: { user: ((this: any, shader: any, renderer: THREE.WebGLRenderer) => void) | null } = {
      user: mat.onBeforeCompile && mat.onBeforeCompile !== baseProto ? mat.onBeforeCompile : null,
    };
    const wrapper = function (this: any, shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) {
      if (state.user) state.user.call(this, shader, renderer);
      try { self.inject(shader); } catch (e) { console.warn('[sky] material patch failed', e); }
    };
    wrapper.toString = () => (state.user ? String(state.user) : 'default') + PATCH_TAG;
    try {
      Object.defineProperty(mat, 'onBeforeCompile', {
        configurable: true,
        enumerable: true,
        get: () => wrapper,
        set: (fn) => { state.user = fn && fn !== baseProto ? fn : null; mat.needsUpdate = true; },
      });
    } catch (e) {
      console.warn('[sky] cannot patch material', e);
      return false;
    }
    mat.needsUpdate = true;
    this.count++;
    return true;
  }

  /** Patch lit materials of every mesh in a scene graph (catches unregistered materials). */
  scan(root: THREE.Object3D): number {
    let n = 0;
    root.traverse((o: any) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) { for (const x of m) if (this.patch(x)) n++; }
      else if (this.patch(m)) n++;
    });
    return n;
  }
}
