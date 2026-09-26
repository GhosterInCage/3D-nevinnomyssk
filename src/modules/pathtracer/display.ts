// Display of the accumulated path-traced radiance.
//
// * DepthPrepass: rasterises the path tracer's merged geometry once (the
//   camera is frozen) so the image can carry a depth buffer.
// * Denoiser: joint bilateral filter (depth + tone-compressed colour + alpha)
//   whose radius shrinks as samples accumulate (blur-on-low-samples).
// * CompositeQuad: a full-screen quad placed in ctx.scene while the sky
//   module's post pipeline renders. It outputs premultiplied radiance with
//   alpha = coverage and writes the true scene depth (converted to the main
//   camera's depth range), so the sky's aerial perspective, clouds, god rays,
//   bloom, exposure/AgX grading and anti-aliasing apply exactly as in the
//   real-time view, and the rasterised backdrop (far terrain, Caucasus) shows
//   where no path-traced geometry exists.
// * StandaloneDisplay: tone-mapped output straight to the canvas (no sky).
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export class DepthPrepass {
  readonly rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private mesh: THREE.Mesh | null = null;
  private mat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

  constructor(private renderer: THREE.WebGLRenderer, floatDepth: boolean) {
    this.rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, generateMipmaps: false });
    this.rt.depthTexture = new THREE.DepthTexture(1, 1, floatDepth ? THREE.FloatType : THREE.UnsignedIntType);
    this.rt.depthTexture.format = THREE.DepthFormat;
    this.rt.depthTexture.minFilter = THREE.NearestFilter;
    this.rt.depthTexture.magFilter = THREE.NearestFilter;
  }

  setGeometry(geo: THREE.BufferGeometry | null): void {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh = null; }
    if (!geo) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', geo.getAttribute('position'));
    g.setIndex(geo.getIndex());
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(camera: THREE.Camera, w: number, h: number): void {
    const r = this.renderer;
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevAlpha = r.getClearAlpha();
    const prevCol = new THREE.Color();
    r.getClearColor(prevCol);
    r.setRenderTarget(this.rt);
    r.setClearColor(0, 0);
    r.autoClear = false;
    r.clear(true, true, false);
    if (this.mesh) r.render(this.scene, camera);
    r.setRenderTarget(prev);
    r.autoClear = prevAuto;
    r.setClearColor(prevCol, prevAlpha);
  }

  dispose(): void {
    this.setGeometry(null);
    this.rt.depthTexture?.dispose();
    this.rt.dispose();
    this.mat.dispose();
  }
}

const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class Denoiser {
  readonly rt: THREE.WebGLRenderTarget;
  private quad: FullScreenQuad;
  readonly material: THREE.ShaderMaterial;

  constructor(private renderer: THREE.WebGLRenderer, floatOK: boolean) {
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: floatOK ? THREE.FloatType : THREE.HalfFloatType, format: THREE.RGBAFormat,
      depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uSigma: { value: 0 },
        uRange: { value: 0.1 },
        uNF: { value: new THREE.Vector2(0.1, 1e5) },
        uExposure: { value: 1 },
      },
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 uTexel;
        uniform float uSigma;
        uniform float uRange;
        uniform vec2 uNF;
        uniform float uExposure;
        varying vec2 vUv;
        float linZ(float d) { return d >= 1.0 ? 1e6 : -perspectiveDepthToViewZ(d, uNF.x, uNF.y); }
        vec3 tm(vec3 c) { c *= uExposure; return c / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
        void main() {
          vec4 c0 = texture2D(tColor, vUv);
          if (uSigma < 0.05) { gl_FragColor = c0; return; }
          float z0 = linZ(texture2D(tDepth, vUv).r);
          vec3 t0 = tm(c0.a > 1e-4 ? c0.rgb / c0.a : c0.rgb);
          vec4 acc = vec4(0.0);
          float wsum = 0.0;
          float inv2s2 = 1.0 / (2.0 * uSigma * uSigma);
          float inv2r2 = 1.0 / (2.0 * uRange * uRange);
          float R = min(6.0, ceil(2.0 * uSigma));
          for (int j = -6; j <= 6; j++) {
            for (int i = -6; i <= 6; i++) {
              vec2 o = vec2(float(i), float(j));
              if (abs(o.x) > R || abs(o.y) > R) continue;
              vec2 uv = vUv + o * uTexel;
              vec4 c = texture2D(tColor, uv);
              float z = linZ(texture2D(tDepth, uv).r);
              vec3 t = tm(c.a > 1e-4 ? c.rgb / c.a : c.rgb);
              vec3 dt = t - t0;
              float dz = (z - z0) / (0.02 * z0 + 0.05);
              float w = exp(-dot(o, o) * inv2s2 - dot(dt, dt) * inv2r2 - dz * dz) * (1.0 - abs(c.a - c0.a));
              acc += c * w;
              wsum += w;
            }
          }
          gl_FragColor = wsum > 1e-6 ? acc / wsum : c0;
        }`,
      depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** Filter `src` into this.rt; sigma = spatial radius in pixels (0 = copy). */
  render(src: THREE.Texture, depth: THREE.Texture | null, w: number, h: number, sigma: number, range: number, near: number, far: number, exposure: number): THREE.Texture {
    const r = this.renderer;
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const u = this.material.uniforms;
    u.tColor.value = src;
    u.tDepth.value = depth;
    u.uTexel.value.set(1 / w, 1 / h);
    u.uSigma.value = depth ? sigma : 0;
    u.uRange.value = range;
    u.uNF.value.set(near, far);
    u.uExposure.value = exposure;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    this.quad.render(r);
    r.setRenderTarget(prev);
    return this.rt.texture;
  }

  dispose(): void {
    this.quad.dispose();
    this.material.dispose();
    this.rt.dispose();
  }
}

/** Full-screen quad living in ctx.scene during composite rendering. */
export class CompositeQuad {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uNF: { value: new THREE.Vector4(0.1, 1e5, 0.5, 8e4) },
        uScale: { value: 1 },
      },
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec4 uNF;   // pt near/far, main camera near/far
        uniform float uScale;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tColor, vUv);
          float d = texture2D(tDepth, vUv).r;
          float depth = 1.0;
          if (c.a > 0.5 && d < 1.0) {
            float vz = perspectiveDepthToViewZ(d, uNF.x, uNF.y);
            vz = min(vz, -uNF.z * 1.001);
            depth = clamp(viewZToPerspectiveDepth(vz, uNF.z, uNF.w), 0.0, 0.9999999);
          }
          gl_FragColor = vec4(max(c.rgb * uScale, vec3(0.0)), clamp(c.a, 0.0, 1.0));
          gl_FragDepth = depth;
        }`,
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
      transparent: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'pathtracer-composite';
    this.mesh.userData.noPathTrace = true;
    this.mesh.userData.noReflect = true;
    this.mesh.userData.noSkyPatch = true;
    this.mesh.renderOrder = -1e9;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** Tone-mapped path tracer output directly to the canvas (no sky pipeline). */
export class StandaloneDisplay {
  private quad: FullScreenQuad;
  readonly material: THREE.ShaderMaterial;
  constructor(private renderer: THREE.WebGLRenderer) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null } },
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tColor, vUv);
          gl_FragColor = vec4(max(c.rgb, vec3(0.0)), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false, toneMapped: true, blending: THREE.NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(tex: THREE.Texture): void {
    const r = this.renderer;
    this.material.uniforms.tColor.value = tex;
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.setRenderTarget(null);
    r.autoClear = false;
    this.quad.render(r);
    r.autoClear = prevAuto;
    r.setRenderTarget(prev);
  }
  dispose(): void { this.quad.dispose(); this.material.dispose(); }
}
