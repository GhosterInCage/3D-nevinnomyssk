// Renders the low-resolution buffers the atmosphere effect composites:
//  * aerial-perspective froxel LUT (3D texture, screen aligned, exponential
//    depth slices from 8 m to 400 km; in-scatter in the first half of the
//    slices, transmittance in the second half)
//  * half-resolution cloud buffer (MRT: premultiplied radiance + alpha, distance)
// This keeps the full-resolution atmosphere pass to a handful of texture
// fetches per pixel (important for software GL and low-end GPUs).
import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { apLutFrag, cloudPassFrag, cloudResolveFrag, fullscreenVert } from './shaders';
import { GodRays } from './godrays';
import { atmosphereDefines, type SkyUniforms } from './uniforms';

export interface BufferConfig {
  lutW: number;
  lutH: number;
  lutD: number;
  /** cloud buffer resolution divisor (2 = half resolution) */
  cloudDiv: number;
  /** jittered sub-samples accumulated per frame */
  cloudSubs: number;
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
  private prevClear = new THREE.Color();
  readonly godRays = new GodRays();
  godRaysEnabled = true;
  /** true when the god-ray buffer was rendered this frame */
  godRaysActive = false;
  private depthTex: THREE.Texture | null = null;
  private sunDirW: THREE.Vector3;
  // temporal accumulation (interactive only)
  temporal = false;
  private hist: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private resolveMat: THREE.ShaderMaterial;
  private prevViewProj = new THREE.Matrix4();
  private frameIdx = 0;
  private hasHistory = false;
  /** uniform of the consumer (atmosphere effect) that must point at the final cloud colour */
  outUniform: THREE.Uniform<THREE.Texture | null> | null = null;
  private width = 1;
  private height = 1;

  constructor(private cam: THREE.PerspectiveCamera, shared: SkyUniforms, private cfg: BufferConfig) {
    super('SkyBuffersPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.sunDirW = shared.skSunDirW.value;
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
      uniforms: { ...common, uSize: { value: new THREE.Vector2(1, 1) }, skApLut: this.lutTex, uSub: { value: 0 }, uSubCount: { value: 1 }, uFrameJitter: { value: 0 } },
      defines: atmosphereDefines(),
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    const hopts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
    this.hist = [new THREE.WebGLRenderTarget(1, 1, hopts), new THREE.WebGLRenderTarget(1, 1, hopts)];
    this.resolveMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: cloudResolveFrag,
      uniforms: {
        tCur: { value: null }, tCurDist: { value: null }, tHist: { value: null },
        invView: { value: new THREE.Matrix4() }, invProj: { value: new THREE.Matrix4() },
        prevViewProj: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() },
        blend: { value: 0.88 }, texel: { value: new THREE.Vector2(1, 1) },
      },
      depthTest: false, depthWrite: false, toneMapped: false,
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
  readonly cloudTexel = new THREE.Vector2(1, 1);
  get cloudDist(): THREE.Texture { return this.cloudRT.textures[1]; }

  override setDepthTexture(depthTexture: THREE.Texture): void {
    this.depthTex = depthTexture;
  }

  override setSize(width: number, height: number): void {
    this.width = width; this.height = height;
    this.godRays.setSize(width, height);
    const w = Math.max(1, Math.ceil(width / this.cfg.cloudDiv));
    const h = Math.max(1, Math.ceil(height / this.cfg.cloudDiv));
    this.cloudRT.setSize(w, h);
    this.cloudTexel.set(1 / w, 1 / h);
    this.hist[0].setSize(w, h);
    this.hist[1].setSize(w, h);
    this.hasHistory = false;
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
      renderer.getClearColor(this.prevClear);
      const prevAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setClearColor(this.prevClear, prevAlpha);
      const n = Math.max(1, this.cfg.cloudSubs | 0);
      this.cloudMat.uniforms.uSubCount.value = n;
      this.frameIdx++;
      this.cloudMat.uniforms.uFrameJitter.value = this.temporal ? (this.frameIdx * 0.618034) % 1 : 0;
      for (let k = 0; k < n; k++) {
        this.cloudMat.uniforms.uSub.value = k;
        renderer.render(this.quadScene, this.quadCam);
      }
      // temporal resolve
      let out: THREE.Texture = this.cloudRT.textures[0];
      if (this.temporal) {
        const [read, write] = this.hist;
        const u = this.resolveMat.uniforms;
        u.tCur.value = this.cloudRT.textures[0];
        u.tCurDist.value = this.cloudRT.textures[1];
        u.tHist.value = read.texture;
        u.invView.value.copy(c.matrixWorld);
        u.invProj.value.copy(c.projectionMatrixInverse);
        u.prevViewProj.value.copy(this.prevViewProj);
        u.camPos.value.copy(c.position);
        u.blend.value = this.hasHistory ? 0.88 : 0;
        u.texel.value.copy(this.cloudTexel);
        this.quad.material = this.resolveMat;
        renderer.setRenderTarget(write);
        renderer.render(this.quadScene, this.quadCam);
        this.hist = [write, read];
        this.hasHistory = true;
        out = write.texture;
      } else {
        this.hasHistory = false;
      }
      this.prevViewProj.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
      if (this.outUniform) this.outUniform.value = out;
    }
    // --- crepuscular rays
    this.godRaysActive = false;
    if (this.godRaysEnabled) {
      try {
        this.godRaysActive = this.godRays.render(renderer, this.cam, this.sunDirW, this.depthTex, this.cloudRT.textures[0]);
      } catch (e) { console.warn('[sky] god rays', e); this.godRaysEnabled = false; }
    }
    renderer.setRenderTarget(null);
    renderer.autoClear = prevAuto;
  }

  dispose(): void {
    this.godRays.dispose();
    this.hist[0].dispose();
    this.hist[1].dispose();
    this.resolveMat.dispose();
    this.lut.dispose();
    this.cloudRT.dispose();
    this.lutMat.dispose();
    this.cloudMat.dispose();
  }
}
