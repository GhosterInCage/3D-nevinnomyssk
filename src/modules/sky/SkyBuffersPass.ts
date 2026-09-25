// Renders the low-resolution buffers the atmosphere effect composites:
//  * aerial-perspective froxel LUT (3D texture, screen aligned, exponential
//    depth slices from 8 m to 400 km; in-scatter in the first half of the
//    slices, transmittance in the second half)
//  * half-resolution cloud buffer (MRT: premultiplied radiance + alpha, distance)
// This keeps the full-resolution atmosphere pass to a handful of texture
// fetches per pixel (important for software GL and low-end GPUs).
import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { apLutFrag, cloudPassFrag, fullscreenVert } from './shaders';
import { atmosphereDefines, type SkyUniforms } from './uniforms';

export interface BufferConfig {
  lutW: number;
  lutH: number;
  lutD: number;
  /** cloud buffer resolution divisor (2 = half resolution) */
  cloudDiv: number;
}

export const LUT_D0 = 8;
export const LUT_DMAX = 400000;

export class SkyBuffersPass extends Pass {
  lut!: THREE.WebGL3DRenderTarget;
  readonly cloudRT: THREE.WebGLRenderTarget;
  private lutMat: THREE.ShaderMaterial;
  private cloudMat: THREE.ShaderMaterial;
  private quadScene = new THREE.Scene();
  private quad: THREE.Mesh;
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly skInvView: THREE.Uniform<THREE.Matrix4>;
  readonly skInvProj: THREE.Uniform<THREE.Matrix4>;
  readonly lutTex = new THREE.Uniform<THREE.Texture | null>(null);
  cloudsEnabled = true;
  private width = 1;
  private height = 1;

  constructor(private cam: THREE.PerspectiveCamera, shared: SkyUniforms, private cfg: BufferConfig) {
    super('SkyBuffersPass');
    this.needsSwap = false;
    this.skInvView = new THREE.Uniform(new THREE.Matrix4());
    this.skInvProj = new THREE.Uniform(new THREE.Matrix4());
    this.makeLut();
    shared.skLut.value.set(LUT_D0, Math.log(LUT_DMAX / LUT_D0), cfg.lutD, 0);

    const common = { ...shared, skInvView: this.skInvView, skInvProj: this.skInvProj } as Record<string, THREE.IUniform>;
    this.lutMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: apLutFrag,
      uniforms: { ...common, uSlice: { value: 0 }, uLutSize: { value: new THREE.Vector2(cfg.lutW, cfg.lutH) } },
      defines: atmosphereDefines(),
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.cloudRT = new THREE.WebGLRenderTarget(1, 1, {
      count: 2,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.cloudRT.textures[0].name = 'sky.clouds.color';
    this.cloudRT.textures[1].name = 'sky.clouds.dist';
    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: cloudPassFrag,
      uniforms: { ...common, uSize: { value: new THREE.Vector2(1, 1) }, skApLut: this.lutTex },
      defines: atmosphereDefines(),
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.lutMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  private makeLut(): void {
    const { lutW, lutH, lutD } = this.cfg;
    this.lut?.dispose();
    this.lut = new THREE.WebGL3DRenderTarget(lutW, lutH, lutD * 2, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.lut.texture.wrapS = this.lut.texture.wrapT = THREE.ClampToEdgeWrapping;
    (this.lut.texture as THREE.Data3DTexture).wrapR = THREE.ClampToEdgeWrapping;
    this.lut.texture.name = 'sky.apLut';
    this.lutTex.value = this.lut.texture;
  }

  setConfig(cfg: BufferConfig): void {
    const lutChanged = cfg.lutW !== this.cfg.lutW || cfg.lutH !== this.cfg.lutH || cfg.lutD !== this.cfg.lutD;
    this.cfg = cfg;
    if (lutChanged) {
      this.makeLut();
      (this.lutMat.uniforms.uLutSize.value as THREE.Vector2).set(cfg.lutW, cfg.lutH);
      const u = this.lutMat.uniforms.skLut.value as THREE.Vector4;
      u.z = cfg.lutD;
    }
    this.setSize(this.width, this.height);
  }

  get cloudColor(): THREE.Texture { return this.cloudRT.textures[0]; }
  get cloudDist(): THREE.Texture { return this.cloudRT.textures[1]; }

  override setSize(width: number, height: number): void {
    this.width = width; this.height = height;
    const w = Math.max(1, Math.ceil(width / this.cfg.cloudDiv));
    const h = Math.max(1, Math.ceil(height / this.cfg.cloudDiv));
    this.cloudRT.setSize(w, h);
    (this.cloudMat.uniforms.uSize.value as THREE.Vector2).set(w, h);
  }

  override render(renderer: THREE.WebGLRenderer): void {
    const c = this.cam;
    this.skInvView.value.copy(c.matrixWorld);
    this.skInvProj.value.copy(c.projectionMatrixInverse);
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    // --- AP LUT, one layer per draw
    this.quad.material = this.lutMat;
    const D2 = this.cfg.lutD * 2;
    for (let i = 0; i < D2; i++) {
      this.lutMat.uniforms.uSlice.value = i;
      renderer.setRenderTarget(this.lut, i);
      renderer.render(this.quadScene, this.quadCam);
    }
    // --- clouds
    if (this.cloudsEnabled) {
      this.quad.material = this.cloudMat;
      renderer.setRenderTarget(this.cloudRT);
      renderer.render(this.quadScene, this.quadCam);
    }
    renderer.setRenderTarget(null);
    renderer.autoClear = prevAuto;
  }

  dispose(): void {
    this.lut.dispose();
    this.cloudRT.dispose();
    this.lutMat.dispose();
    this.cloudMat.dispose();
  }
}
