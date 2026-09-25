// Sky module: physically based atmosphere (Bruneton precomputed scattering via
// @takram/three-atmosphere), sun/moon lighting with cascaded shadows, image
// based lighting from the sky, cloud layers + cloud shadows, fog, stars,
// weather (clouds / rain / fog) and the post-processing pipeline (AO, aerial
// perspective, bloom, AgX grading, SMAA). See docs/modules/sky.md.
import * as THREE from 'three';
import type { AppContext, CityModule } from '../../core/context';
import { loadAtmosphereTextures, loadStars, SKY_TEX_BASE } from './assets';
import { WorldFrame } from './frame';
import { SkyLighting, type WeatherState } from './lighting';
import { MaterialPatcher } from './materialPatch';
import { SkyPipeline } from './SkyPipeline';
import { createSkyUniforms, type SkyUniforms } from './uniforms';
import { Rain } from './rain';

/** Cloud texture tile size in metres. */
const CLOUD_TILE = 10000;

export interface SkyService {
  /** Key light mirror (sun by day, moon by night). Not part of the scene graph; clone it for path tracing. */
  sunLight: THREE.DirectionalLight;
  /** The actual SunLight (three/addons) in ctx.scene with cascaded shadows. */
  keyLight: THREE.Light;
  setTime(hours: number): void;
  setWeather(w: Partial<WeatherState> & { cirrus?: number }): void;
  getWeather(): WeatherState & { cirrus: number };
  /** Screenshot mode renders on demand; call after changing materials/uniforms that the sky cannot detect. */
  requestRender(): void;
  /** Current exposure multiplier applied before AgX tone mapping. */
  readonly exposure: number;
  /** Radiance scale: Bruneton relative luminance -> scene units (noon sun ≈ 3). */
  readonly radianceScale: number;
  /** Cloud transmittance for the sun at a world position (0..1, CPU approximation). */
  cloudShadowAt(x: number, y: number, z: number): number;
  moonDirection: THREE.Vector3;
  readonly moonIntensity: number;
  readonly envMap: THREE.Texture | null;
  pipeline: SkyPipeline | null;
  uniforms: SkyUniforms | null;
}

const PRESETS: Record<string, WeatherState & { cirrus: number }> = {
  clear: { cloudCover: 0.0, rain: 0, fog: 0, cirrus: 0.15 },
  fair: { cloudCover: 0.32, rain: 0, fog: 0, cirrus: 0.3 },
  cloudy: { cloudCover: 0.62, rain: 0, fog: 0, cirrus: 0.2 },
  overcast: { cloudCover: 0.95, rain: 0, fog: 0.1, cirrus: 0 },
  rain: { cloudCover: 1.0, rain: 0.8, fog: 0.25, cirrus: 0 },
  storm: { cloudCover: 1.0, rain: 1.0, fog: 0.35, cirrus: 0 },
  fog: { cloudCover: 0.5, rain: 0, fog: 0.8, cirrus: 0.1 },
  haze: { cloudCover: 0.15, rain: 0, fog: 0.3, cirrus: 0.35 },
};

function loadCloudTexture(renderer: THREE.WebGLRenderer): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(`${SKY_TEX_BASE}clouds.png`).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  });
}

function weatherFromParams(ctx: AppContext): WeatherState & { cirrus: number } {
  const p = ctx.settings.params;
  const preset = PRESETS[(p.get('weather') || '').toLowerCase()] ?? {
    cloudCover: ctx.env.cloudCover ?? 0.3, rain: ctx.env.rain ?? 0, fog: ctx.env.fog ?? 0, cirrus: 0.3,
  };
  const w = { ...preset };
  const num = (k: string) => { const v = p.get(k); return v !== null && Number.isFinite(+v) ? THREE.MathUtils.clamp(+v, 0, 1) : null; };
  const c = num('clouds'); if (c !== null) w.cloudCover = c;
  const r = num('rain'); if (r !== null) { w.rain = r; if (r > 0 && c === null) w.cloudCover = Math.max(w.cloudCover, 0.9); }
  const f = num('fog'); if (f !== null) w.fog = f;
  const ci = num('cirrus'); if (ci !== null) w.cirrus = ci;
  return w;
}

class SkySystem {
  readonly frame = new WorldFrame();
  lighting!: SkyLighting;
  pipeline: SkyPipeline | null = null;
  patcher!: MaterialPatcher;
  uniforms!: SkyUniforms;
  rain: Rain | null = null;
  weather: WeatherState & { cirrus: number };
  target: WeatherState & { cirrus: number };
  private cloudOffset = new THREE.Vector2(0, 0);
  private soft: boolean | null = null;
  private scanTimer = 0;
  private cloudTex!: THREE.Texture;

  constructor(private ctx: AppContext) {
    this.weather = weatherFromParams(ctx);
    this.target = { ...this.weather };
  }

  async init(): Promise<void> {
    const ctx = this.ctx;
    const [tex, cloudTex, stars] = await Promise.all([
      loadAtmosphereTextures(ctx.renderer),
      loadCloudTexture(ctx.renderer),
      loadStars().catch((e) => { console.warn('[sky] stars unavailable', e); return null; }),
    ]);
    this.cloudTex = cloudTex;
    this.uniforms = createSkyUniforms(tex, cloudTex);
    this.uniforms.skCloudP0.value.y = 1 / CLOUD_TILE;
    this.lighting = new SkyLighting(ctx, this.frame, tex, this.uniforms);
    this.patcher = new MaterialPatcher(this.uniforms);
    for (const m of ctx.materials) this.patcher.patch(m);
    ctx.events.on('material:added', (m: THREE.Material) => this.patcher.patch(m));

    ctx.scene.fog = null;
    ctx.scene.background = null;
    ctx.backdrop.scene.background = null;

    this.pipeline = new SkyPipeline(ctx, this.uniforms);
    this.pipeline.syncFrames = ctx.settings.shot;
    this.pipeline.onDemand = ctx.settings.shot && ctx.settings.params.get('skyondemand') !== '0';
    this.pipeline.debugLog = ctx.settings.params.get('skylog') === '1';
    if (stars) this.pipeline.composite.setStars(stars);
    if (ctx.settings.params.get('skypipe') !== '0') ctx.setPipeline(this.pipeline);

    try { this.rain = new Rain(ctx); } catch (e) { console.warn('[sky] rain unavailable', e); }

    ctx.events.on('settings', () => this.applyQuality());
    ctx.events.on('pipeline', (p: unknown) => {
      // keep the renderer exposure in sync for other pipelines (path tracer)
      if (p !== this.pipeline) ctx.renderer.toneMappingExposure = this.lighting.exposure;
    });
    ctx.events.on('time', () => { this.lighting.envDirty = true; });

    // first frame state (deterministic for screenshots)
    this.update(0, true);
    this.lighting.updateEnvironment(this.weatherKey(), true);
  }

  applyQuality(): void {
    try {
      this.lighting.applyQuality();
      this.pipeline?.applyQuality();
      this.rain?.applyQuality();
    } catch (e) { console.error('[sky] quality change', e); }
  }

  weatherKey(): string {
    const w = this.weather;
    return `${w.cloudCover.toFixed(2)}|${w.rain.toFixed(2)}|${w.fog.toFixed(2)}|${w.cirrus.toFixed(2)}`;
  }

  setWeather(w: Partial<WeatherState> & { cirrus?: number }): void {
    const t = this.target;
    if (w.cloudCover !== undefined) t.cloudCover = THREE.MathUtils.clamp(w.cloudCover, 0, 1);
    if (w.rain !== undefined) t.rain = THREE.MathUtils.clamp(w.rain, 0, 1);
    if (w.fog !== undefined) t.fog = THREE.MathUtils.clamp(w.fog, 0, 1);
    if (w.cirrus !== undefined) t.cirrus = THREE.MathUtils.clamp(w.cirrus, 0, 1);
    if (this.ctx.settings.shot) Object.assign(this.weather, t);
  }

  update(dt: number, instant = false): void {
    const ctx = this.ctx;
    const shot = ctx.settings.shot;
    instant = instant || shot;
    // weather transitions
    const k = instant ? 1 : 1 - Math.exp(-dt / 4);
    const w = this.weather, t = this.target;
    w.cloudCover += (t.cloudCover - w.cloudCover) * k;
    w.rain += (t.rain - w.rain) * k;
    w.fog += (t.fog - w.fog) * k;
    w.cirrus += (t.cirrus - w.cirrus) * k;

    // clouds drift with the wind (~2.5x surface wind at cloud level); frozen in shot mode
    if (!shot) this.cloudOffset.addScaledVector(ctx.env.wind, -dt * 2.5);

    this.lighting.update(dt, w, instant);
    const u = this.uniforms;
    const rainy = w.rain;
    u.skCloudP0.value.set(w.cloudCover, 1 / CLOUD_TILE, this.cloudOffset.x, this.cloudOffset.y);
    // base ~1500 m above the Kuban valley (≈ 1.9 km ASL); lower and thicker when raining
    const base = THREE.MathUtils.lerp(1900, 1300, THREE.MathUtils.smoothstep(w.cloudCover, 0.7, 1.0) * 0.6 + rainy * 0.4);
    const thick = THREE.MathUtils.lerp(650, 1600, THREE.MathUtils.smoothstep(w.cloudCover, 0.5, 1.0));
    const tau = THREE.MathUtils.lerp(12, 30, THREE.MathUtils.smoothstep(w.cloudCover, 0.4, 1.0)) * (1 + rainy * 0.8);
    u.skCloudP1.value.set(base, thick, tau, 0.55);
    u.skCloudP2.value.set(9500, w.cirrus * (1 - THREE.MathUtils.smoothstep(w.cloudCover, 0.6, 0.95)), 0.7, rainy);
    u.skCloudP3.value.set(this.cloudSteps(), 32000, 1.0, 0.55);
    // fog: haze (fog 0.3) to thick valley fog (fog 1), plus rain haze
    const fogAmt = Math.max(w.fog, rainy * 0.45);
    const dens = fogAmt <= 0.001 ? 0 : 3.912 / THREE.MathUtils.lerp(30000, 350, Math.pow(fogAmt, 0.7));
    u.skFog.value.set(dens, 300, THREE.MathUtils.lerp(900, 180, fogAmt), 80000);

    if (this.pipeline) {
      this.pipeline.exposure = this.lighting.exposure;
      this.pipeline.atmosphere.skCloudsOn.value = w.cloudCover > 0.001 || w.cirrus > 0.001 ? 1 : 0;
      this.pipeline.composite.starRot.copy(this.lighting.starRot);
      this.pipeline.composite.starIntensity = this.lighting.starIntensity;
      this.pipeline.sigExtra = this.weatherKey();
    }
    ctx.renderer.toneMappingExposure = this.lighting.exposure;

    this.lighting.updateEnvironment(this.weatherKey());
    this.rain?.update(dt, w.rain, this.uniforms.skFogAmb.value);

    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = 2.0;
      try { this.patcher.scan(ctx.scene); this.patcher.scan(ctx.backdrop.scene); } catch { /* ignore */ }
    }
  }

  cloudSteps(): number {
    const q = this.ctx.settings.quality;
    if (this.soft === null) this.soft = SkyPipeline.softwareGL(this.ctx.renderer);
    if (this.soft) return 9;
    return q === 'low' ? 6 : q === 'medium' ? 10 : q === 'high' ? 14 : 20;
  }

  cloudShadowAt(x: number, y: number, z: number): number {
    // CPU mirror of skpCloudShadow (coarse; texture not read back -> uses coverage only)
    void x; void y; void z;
    const cc = this.weather.cloudCover;
    return 1 - 0.8 * cc * cc;
  }
}

function installFallback(ctx: AppContext): void {
  // Minimal lighting if the atmosphere assets could not be loaded.
  ctx.backdrop.scene.background = new THREE.Color(0x9ec3e6);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x5a5040, 1.2);
  ctx.scene.add(sun, sun.target, hemi);
  ctx.onUpdate(() => {
    const d = ctx.env.sunDirection;
    sun.position.copy(ctx.camera.position).addScaledVector(d, 5000);
    sun.target.position.copy(ctx.camera.position);
    sun.intensity = 3 * Math.max(0, d.y) ** 0.5;
  });
}

const mod: CityModule = {
  id: 'sky',
  async init(ctx) {
    const sys = new SkySystem(ctx);
    const service: SkyService = {
      sunLight: new THREE.DirectionalLight(0xffffff, 3),
      keyLight: new THREE.DirectionalLight(0xffffff, 3),
      setTime: (h: number) => { ctx.env.hours = ((h % 24) + 24) % 24; ctx.events.emit('time', ctx.env.hours); },
      setWeather: (w) => sys.setWeather(w),
      getWeather: () => ({ ...sys.weather }),
      requestRender: () => sys.pipeline?.invalidate(),
      get exposure() { return sys.lighting ? sys.lighting.exposure : 1; },
      radianceScale: 2,
      cloudShadowAt: (x, y, z) => sys.cloudShadowAt(x, y, z),
      moonDirection: ctx.env.moonDirection,
      get moonIntensity() { return sys.lighting ? sys.lighting.moonIrr.r * 2 : 0; },
      get envMap() { return sys.lighting ? sys.lighting.envTexture : null; },
      pipeline: null,
      uniforms: null,
    };
    const work = (async () => {
      try {
        await sys.init();
        service.sunLight = sys.lighting.sunProxy;
        service.keyLight = sys.lighting.sun;
        service.pipeline = sys.pipeline;
        service.uniforms = sys.uniforms;
        ctx.onUpdate((dt) => {
          try { sys.update(dt); } catch (e) { console.error('[sky] update', e); }
        }, -1000);
      } catch (e) {
        console.error('[sky] init failed, using fallback lighting', e);
        installFallback(ctx);
      }
      ctx.provide('sky', service);
    })();
    await ctx.pending(work);
  },
};
export default mod;
