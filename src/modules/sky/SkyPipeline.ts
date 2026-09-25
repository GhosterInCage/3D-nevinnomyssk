// The sky module's render pipeline (installed with ctx.setPipeline):
//
//   CompositePass   backdrop + main scene -> HDR buffer, combined depth, stars
//   N8AOPostPass    screen-space ambient occlusion (quality >= medium)
//   [clouds]        volumetric clouds (@takram/three-clouds, quality high+) -> overlay texture
//   Atmosphere      sky, aerial perspective, cloud layers, fog, night sky
//   Bloom + Grade   bloom (threshold follows exposure), exposure, vignette, AgX
//   SMAA            anti-aliasing, sRGB output
import * as THREE from 'three';
import {
  BloomEffect,
  EdgeDetectionMode,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  Pass,
  SMAAEffect,
  SMAAPreset,
} from 'postprocessing';
// @ts-ignore - n8ao ships without type declarations
import { N8AOPostPass } from 'n8ao';
import type { AppContext, RenderPipeline } from '../../core/context';
import { AP_FAR, AP_NEAR, CompositePass } from './CompositePass';
import { AtmosphereEffect, GradeEffect } from './effects';
import { SkyBuffersPass, type BufferConfig } from './SkyBuffersPass';
import type { SkyUniforms } from './uniforms';

export interface PipelineHooks {
  /** Called right before the atmosphere pass (volumetric clouds render their buffers here). */
  beforeAtmosphere?: (renderer: THREE.WebGLRenderer, dt: number) => void;
}

export class SkyPipeline implements RenderPipeline {
  readonly composer: EffectComposer;
  readonly apCamera = new THREE.PerspectiveCamera(55, 1, AP_NEAR, AP_FAR);
  readonly composite: CompositePass;
  readonly atmosphere: AtmosphereEffect;
  readonly grade = new GradeEffect();
  readonly bloom: BloomEffect;
  readonly smaa: SMAAEffect | null = null;
  readonly fxaa: FXAAEffect | null = null;
  readonly soft: boolean;
  n8ao: any = null;
  private atmospherePass: EffectPass;
  private postPass: EffectPass;
  private smaaPass: EffectPass;
  private hookPass: HookPass;
  readonly buffers: SkyBuffersPass;
  exposure = 1;
  bloomThreshold = 1.4; // in display units (after exposure)
  private disposed = false;

  constructor(private ctx: AppContext, shared: SkyUniforms, hooks: PipelineHooks = {}) {
    const r = ctx.renderer;
    this.soft = SkyPipeline.softwareGL(r);
    this.composer = new EffectComposer(r, {
      frameBufferType: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      multisampling: 0,
    });
    this.syncCamera();
    this.composite = new CompositePass(ctx, this.apCamera);
    this.composer.addPass(this.composite);

    const prof = ctx.settings.profile;
    if (prof.ao) this.addAO();

    this.hookPass = new HookPass(hooks);
    this.composer.addPass(this.hookPass);

    this.buffers = new SkyBuffersPass(this.apCamera, shared, SkyPipeline.bufferConfig(ctx));
    this.composer.addPass(this.buffers);

    this.atmosphere = new AtmosphereEffect(this.apCamera, shared);
    this.atmosphere.skApLut.value = this.buffers.lut.texture;
    this.atmosphere.skCloudBuf.value = this.buffers.cloudColor;
    this.atmosphere.skCloudDist.value = this.buffers.cloudDist;
    this.atmosphere.skCloudTexel.value = this.buffers.cloudTexel;
    this.atmospherePass = new EffectPass(this.apCamera, this.atmosphere);
    this.composer.addPass(this.atmospherePass);

    this.bloom = new BloomEffect({
      mipmapBlur: true,
      intensity: 0.55,
      luminanceThreshold: 1.0,
      luminanceSmoothing: 0.25,
      radius: 0.7,
      levels: this.soft ? 4 : 7,
    });
    this.bloom.blendMode.opacity.value = prof.bloom ? 1 : 0;
    this.postPass = new EffectPass(this.apCamera, this.bloom, this.grade);
    this.postPass.dithering = true;
    this.composer.addPass(this.postPass);

    if (this.soft) {
      // software GL: one-pass FXAA instead of 3-pass SMAA
      this.fxaa = new FXAAEffect();
      this.smaaPass = new EffectPass(this.apCamera, this.fxaa);
    } else {
      this.smaa = new SMAAEffect({ preset: SMAAPreset.HIGH, edgeDetectionMode: EdgeDetectionMode.COLOR });
      this.smaaPass = new EffectPass(this.apCamera, this.smaa);
    }
    this.composer.addPass(this.smaaPass);
  }

  static bufferConfig(ctx: AppContext): BufferConfig {
    const q = ctx.settings.quality;
    const soft = SkyPipeline.softwareGL(ctx.renderer);
    if (soft) return { lutW: 32, lutH: 18, lutD: 16, cloudDiv: 3, cloudSubs: 3 };
    return {
      lutW: q === 'low' ? 48 : 64,
      lutH: q === 'low' ? 27 : 36,
      lutD: q === 'low' ? 24 : 32,
      cloudDiv: q === 'ultra' ? 1 : q === 'low' ? 3 : 2,
      cloudSubs: q === 'low' ? 1 : q === 'medium' ? 2 : 3,
    };
  }

  static softwareGL(r: THREE.WebGLRenderer): boolean {
    const force = new URLSearchParams(location.search).get('skysoft');
    if (force === '0') return false;
    if (force === '1') return true;
    try {
      const gl = r.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      return /swiftshader|llvmpipe|software|basic render/i.test(name);
    } catch { return false; }
  }

  private addAO(): void {
    try {
      const n8 = new N8AOPostPass(new THREE.Scene(), this.apCamera, this.ctx.width, this.ctx.height);
      n8.autoDetectTransparency = false;
      n8.configuration.transparencyAware = false;
      n8.configuration.gammaCorrection = false;
      n8.autosetGamma = false;
      n8.configuration.aoRadius = 2.5;
      n8.configuration.distanceFalloff = 1.0;
      n8.configuration.intensity = 2.2;
      n8.configuration.halfRes = this.ctx.settings.quality !== 'ultra';
      n8.configuration.depthAwareUpsampling = true;
      n8.configuration.accumulate = false;
      n8.setQualityMode(this.soft ? 'Performance' : this.ctx.settings.quality === 'medium' ? 'Low' : 'Medium');
      this.composer.addPass(n8, 1);
      this.n8ao = n8;
    } catch (e) {
      console.warn('[sky] N8AO unavailable', e);
      this.n8ao = null;
    }
  }

  applyQuality(): void {
    const prof = this.ctx.settings.profile;
    if (prof.ao && !this.n8ao) this.addAO();
    else if (!prof.ao && this.n8ao) {
      this.composer.removePass(this.n8ao);
      this.n8ao.dispose?.();
      this.n8ao = null;
    }
    if (this.n8ao) {
      this.n8ao.configuration.halfRes = this.ctx.settings.quality !== 'ultra';
    }
    this.bloom.blendMode.opacity.value = prof.bloom ? 1 : 0;
    this.buffers.setConfig(SkyPipeline.bufferConfig(this.ctx));
    this.atmosphere.skApLut.value = this.buffers.lut.texture;
    this.setSize(this.ctx.width, this.ctx.height);
  }

  syncCamera(): void {
    const c = this.ctx.camera;
    const a = this.apCamera;
    a.position.copy(c.position);
    a.quaternion.copy(c.quaternion);
    if (a.fov !== c.fov || a.aspect !== c.aspect || a.zoom !== c.zoom || a.filmOffset !== c.filmOffset) {
      a.fov = c.fov; a.aspect = c.aspect; a.zoom = c.zoom; a.filmOffset = c.filmOffset;
      a.updateProjectionMatrix();
    }
    a.updateMatrixWorld(true);
  }

  /** Screenshot mode: skip re-rendering identical frames so the (software) GPU stays idle. */
  onDemand = false;
  private lastSig = '';
  private stableCount = 0;
  private lastRenderWall = 0;

  private signature(): string {
    const c = this.ctx.camera;
    const e = c.matrixWorld.elements;
    let s = '';
    for (let i = 0; i < 16; i++) s += e[i].toFixed(3) + ',';
    s += `${c.fov}|${c.aspect}|${this.ctx.env.hours.toFixed(4)}|${this.ctx.width}x${this.ctx.height}`;
    const m = this.ctx.renderer.info.memory;
    s += `|${m.geometries}|${m.textures}`;
    let n = 0;
    this.ctx.scene.traverseVisible((o: any) => { if (o.isMesh || o.isPoints || o.isLine || o.isSprite) n++; });
    this.ctx.backdrop.scene.traverseVisible((o: any) => { if (o.isMesh) n++; });
    s += `|${n}|${this.sigExtra}`;
    return s;
  }
  /** Extra state that must trigger a re-render in on-demand mode (weather etc.). */
  sigExtra = '';
  /** Force the next frames to render (on-demand/screenshot mode). */
  invalidate(): void { this.lastSig = ''; }

  render(dt: number): void {
    if (this.disposed) return;
    let t0 = 0;
    if (this.onDemand) {
      const sig = this.signature();
      const now = performance.now();
      if (sig !== this.lastSig) {
        if (this.debugLog && this.renders < 60) console.info(`[sky] sig change: ${diffSig(this.lastSig, sig)}`);
        this.lastSig = sig; this.stableCount = 0;
      } else if (this.stableCount >= 1 && now - this.lastRenderWall < 60000) return;
      else this.stableCount++;
      this.lastRenderWall = now;
      t0 = now;
    }
    this.syncCamera();
    this.grade.exposure = this.exposure;
    this.bloom.luminanceMaterial.threshold = this.bloomThreshold / Math.max(1e-4, this.exposure);
    this.composer.render(dt);
    if (this.syncFrames) {
      // Software GL (screenshot harness): finish the frame before returning so
      // queued GPU work never piles up behind the compositor / screenshot.
      const gl = this.ctx.renderer.getContext();
      this.ctx.renderer.setRenderTarget(null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
    }
    this.renders++;
    if (this.onDemand && this.debugLog && this.renders < 60) console.info(`[sky] render #${this.renders} ${Math.round(performance.now() - t0)} ms`);
  }
  renders = 0;
  debugLog = false;
  private px = new Uint8Array(4);
  /** Block until the GPU finished each frame (enabled in shot mode). */
  syncFrames = false;

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.syncCamera();
  }

  dispose(): void {
    this.disposed = true;
    this.composite.dispose();
    this.composer.dispose();
  }
}

/** A no-op pass that lets the module render extra buffers (volumetric clouds) at the right time. */
class HookPass extends Pass {
  constructor(private hooks: PipelineHooks) {
    super('SkyHookPass');
    this.needsSwap = false;
  }
  override render(renderer: THREE.WebGLRenderer, _in: THREE.WebGLRenderTarget, _out: THREE.WebGLRenderTarget, dt?: number): void {
    try { this.hooks.beforeAtmosphere?.(renderer, dt ?? 0); } catch (e) { console.error('[sky] hook', e); }
  }
}

function diffSig(a: string, b: string): string {
  const x = a.split('|'), y = b.split('|');
  const out: string[] = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(`${i}:${(x[i] ?? '').slice(0, 24)}->${(y[i] ?? '').slice(0, 24)}`);
  return out.join(' ');
}
