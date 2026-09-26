// Crepuscular rays (god rays): screen-space radial blur of the sun's visibility
// (sky pixels not covered by clouds or geometry, weighted around the sun) at a
// quarter resolution. Composited additively by the atmosphere effect with the
// sun's in-scatter colour, so light shafts appear through cloud gaps, between
// buildings and trees, strongest at low sun.
import * as THREE from 'three';

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const maskFrag = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tClouds;
uniform vec2 sunUv;
uniform float aspect;
varying vec2 vUv;
void main() {
  float d = texture2D(tDepth, vUv).r;
  float sky = d >= 1.0 - 1e-7 ? 1.0 : 0.0;
  float ca = texture2D(tClouds, vUv).a;
  sky *= clamp(1.0 - ca * 1.15, 0.0, 1.0);
  vec2 dv = (vUv - sunUv) * vec2(aspect, 1.0);
  float r = length(dv);
  float w = exp(-r * 3.2) + 0.25 * exp(-r * 0.9);
  gl_FragColor = vec4(sky * w, 0.0, 0.0, 1.0);
}
`;

const blurFrag = /* glsl */ `
uniform sampler2D tMask;
uniform vec2 sunUv;
uniform float density;
uniform float decay;
varying vec2 vUv;
#define SAMPLES 40
void main() {
  vec2 delta = (vUv - sunUv) * density / float(SAMPLES);
  vec2 c = vUv;
  float illum = 1.0;
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    c -= delta;
    float m = texture2D(tMask, clamp(c, vec2(0.001), vec2(0.999))).r;
    sum += m * illum;
    wsum += illum;
    illum *= decay;
  }
  gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}
`;

export class GodRays {
  readonly maskRT: THREE.WebGLRenderTarget;
  readonly raysRT: THREE.WebGLRenderTarget;
  private maskMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private quad: THREE.Mesh;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly sunUv = new THREE.Vector2(0.5, 0.5);
  /** 0 when the sun is far off-screen / below the horizon */
  visibility = 0;
  private tmp = new THREE.Vector3();

  constructor() {
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
    this.maskRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.raysRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.maskMat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: maskFrag,
      uniforms: { tDepth: { value: null }, tClouds: { value: null }, sunUv: { value: this.sunUv }, aspect: { value: 1 } },
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: blurFrag,
      uniforms: { tMask: { value: this.maskRT.texture }, sunUv: { value: this.sunUv }, density: { value: 0.9 }, decay: { value: 0.965 } },
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.maskMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setSize(w: number, h: number): void {
    const qw = Math.max(1, Math.ceil(w / 4)), qh = Math.max(1, Math.ceil(h / 4));
    this.maskRT.setSize(qw, qh);
    this.raysRT.setSize(qw, qh);
    this.maskMat.uniforms.aspect.value = w / Math.max(1, h);
  }

  /** Returns false (and renders nothing) when the sun cannot produce visible shafts. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, sunDirW: THREE.Vector3, depth: THREE.Texture | null, clouds: THREE.Texture): boolean {
    this.visibility = 0;
    if (!depth || sunDirW.y < -0.03) return false;
    const p = this.tmp.copy(camera.position).addScaledVector(sunDirW, 1e5).project(camera);
    // behind the camera: project() flips; test with the view direction
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    if (fwd.dot(sunDirW) < 0.05) return false;
    this.sunUv.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    const off = Math.max(Math.abs(p.x), Math.abs(p.y));
    this.visibility = THREE.MathUtils.clamp(1.6 - off * 0.8, 0, 1);
    if (this.visibility <= 0) return false;
    this.maskMat.uniforms.tDepth.value = depth;
    this.maskMat.uniforms.tClouds.value = clouds;
    this.quad.material = this.maskMat;
    renderer.setRenderTarget(this.maskRT);
    renderer.render(this.scene, this.cam);
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.raysRT);
    renderer.render(this.scene, this.cam);
    return true;
  }

  dispose(): void {
    this.maskRT.dispose();
    this.raysRT.dispose();
    this.maskMat.dispose();
    this.blurMat.dispose();
  }
}
