// Sun / moon key light with cascaded shadows, backdrop light, environment map
// (PMREM of the Bruneton sky incl. clouds) and CPU-side atmosphere sampling
// (sun transmittance, sky irradiance) that drives colours and exposure.
import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { Ellipsoid } from '@takram/three-geospatial';
import {
  getAltitudeCorrectionOffset,
  getECIToECEFRotationMatrix,
  getMoonDirectionECEF,
  getSunLightColor,
  IRRADIANCE_TEXTURE_HEIGHT,
  IRRADIANCE_TEXTURE_WIDTH,
  type PrecomputedTextures,
} from '@takram/three-atmosphere';
import type { AppContext } from '../../core/context';
import { CityShadow, patchShadowChunk } from './CityShadow';
import type { WorldFrame } from './frame';
import { envSkyFrag, envSkyVert } from './shaders';
import { ATMOSPHERE, atmosphereDefines, RADIANCE_SCALE, type SkyUniforms } from './uniforms';

const S = RADIANCE_SCALE;
/** Artistic boost of moonlight (physical full moon is ~2.3e-6 of the sun). */
const MOON_BOOST = 9000;
const MOON_RATIO = 2.3e-6;

function lum(c: { r: number; g: number; b: number }): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Bilinear CPU lookup into a (half) float RGBA DataTexture. */
function sampleRGBA(tex: THREE.Texture, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const img = tex.image as { data: ArrayLike<number>; width: number; height: number };
  const w = img.width, h = img.height, d = img.data;
  const stride = Math.round(d.length / (w * h));
  const half = d instanceof Uint16Array;
  const get = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(d[i] as number) : (d[i] as number));
  const x = THREE.MathUtils.clamp(u * w - 0.5, 0, w - 1);
  const y = THREE.MathUtils.clamp(v * h - 0.5, 0, h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const px = (xx: number, yy: number, c: number) => get((yy * w + xx) * stride + c);
  const r = [0, 1, 2].map((c) =>
    (px(x0, y0, c) * (1 - fx) + px(x1, y0, c) * fx) * (1 - fy) + (px(x0, y1, c) * (1 - fx) + px(x1, y1, c) * fx) * fy);
  return out.set(r[0], r[1], r[2]);
}

function texCoordFromUnit(x: number, size: number): number {
  return 0.5 / size + x * (1 - 1 / size);
}

export interface WeatherState {
  cloudCover: number;
  rain: number;
  fog: number;
}

export class SkyLighting {
  readonly sun: SunLight;
  readonly shadow: CityShadow;
  readonly backLight = new THREE.DirectionalLight(0xffffff, 1);
  /** Mirror of the key light for other modules / the path tracer (not in the scene graph). */
  readonly sunProxy = new THREE.DirectionalLight(0xffffff, 3);

  readonly sunDirECEF = new THREE.Vector3();
  readonly moonDirECEF = new THREE.Vector3();
  readonly moonDirW = new THREE.Vector3(0, 1, 0);
  /** Sun irradiance at the camera (Bruneton relative luminance, unscaled). */
  readonly sunIrr = new THREE.Color();
  readonly skyIrr = new THREE.Color();
  readonly moonIrr = new THREE.Color();
  moonPhase = 1;
  moonElevation = 0;
  exposure = 1;
  private exposureTarget = 1;
  readonly camECEF = new THREE.Vector3();

  // environment map
  private envScene = new THREE.Scene();
  private envMat: THREE.ShaderMaterial;
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvSun = new THREE.Vector3(0, -2, 0);
  private lastEnvMoon = new THREE.Vector3(0, -2, 0);
  private lastEnvWeather = '';
  private lastEnvPos = new THREE.Vector3(1e9, 0, 0);
  private lastEnvTime = -1e9;
  envDirty = true;

  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();
  private eciToECEF = new THREE.Matrix4();
  private lastDateMs = NaN;

  constructor(private ctx: AppContext, private frame: WorldFrame, private tex: PrecomputedTextures, private uniforms: SkyUniforms) {
    const prof = ctx.settings.profile;
    const cascades = Math.max(1, Math.min(4, prof.shadowCascades));
    patchShadowChunk(cascades);
    ctx.renderer.shadowMap.enabled = true;
    ctx.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.sun = new SunLight(0xffffff, 3);
    this.sun.name = 'sky:sun';
    this.shadow = new CityShadow(cascades, prof.shadowMapSize);
    this.shadow.radius = 2.5;
    this.shadow.normalBias = 0.03;
    this.shadow.endDistance = prof.shadowFar;
    (this.sun as any).shadow = this.shadow;
    this.sun.castShadow = true;
    this.sun.userData.noPathTrace = true;
    ctx.scene.add(this.sun);

    this.backLight.name = 'sky:backdrop-sun';
    this.backLight.userData.noPathTrace = true;
    ctx.backdrop.scene.add(this.backLight);

    this.sunProxy.name = 'sky:sun-proxy';

    // environment map
    this.envMat = new THREE.ShaderMaterial({
      vertexShader: envSkyVert,
      fragmentShader: envSkyFrag,
      uniforms: uniforms as any,
      defines: atmosphereDefines(),
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const envSphere = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.envMat);
    envSphere.frustumCulled = false;
    this.envScene.add(envSphere);
    const envSize = ctx.settings.quality === 'low' ? 32 : 64;
    this.cubeRT = new THREE.WebGLCubeRenderTarget(envSize, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.1, 100, this.cubeRT);
    this.envScene.add(this.cubeCam);
    this.pmrem = new THREE.PMREMGenerator(ctx.renderer);
  }

  applyQuality(): void {
    const prof = this.ctx.settings.profile;
    this.shadow.endDistance = prof.shadowFar;
    if (this.shadow.mapSize.x !== prof.shadowMapSize) {
      this.shadow.mapSize.set(prof.shadowMapSize, prof.shadowMapSize);
      this.shadow.map?.dispose();
      (this.shadow as any).map = null;
    }
  }

  /** Per-frame update of the key light, colours, uniforms and exposure. */
  update(dt: number, weather: WeatherState, instant: boolean): void {
    const ctx = this.ctx;
    const env = ctx.env;
    const u = this.uniforms;
    const cam = ctx.camera;

    // ---- celestial directions
    const date = env.date;
    this.frame.dirToECEF(env.sunDirection, this.sunDirECEF);
    const ms = date.getTime();
    if (ms !== this.lastDateMs) {
      this.lastDateMs = ms;
      try {
        getMoonDirectionECEF(date, this.moonDirECEF);
        getECIToECEFRotationMatrix(date, this.eciToECEF);
      } catch {
        this.moonDirECEF.copy(this.sunDirECEF).negate();
      }
      this.frame.dirToWorld(this.moonDirECEF, this.moonDirW);
      this.moonPhase = THREE.MathUtils.clamp((1 - this.sunDirECEF.dot(this.moonDirECEF)) / 2, 0, 1);
    }
    env.moonDirection.copy(this.moonDirW);
    this.moonElevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(this.moonDirW.y, -1, 1)));

    // ---- camera in ECEF (+ altitude correction consistent with takram)
    this.frame.posToECEF(cam.position, this.camECEF);

    // ---- sun transmittance & irradiance at the camera
    getSunLightColor(this.tex.transmittanceTexture, this.camECEF, this.sunDirECEF, this.sunIrr);
    const alt = Math.max(0, cam.position.y);
    const xr = THREE.MathUtils.clamp(alt / (ATMOSPHERE.topRadius - ATMOSPHERE.bottomRadius), 0, 1);
    const up = this.frame.dirToECEF(this.tmpV2.set(0, 1, 0), this.tmpV2);
    const muS = this.sunDirECEF.dot(up);
    const irr = sampleRGBA(this.tex.irradianceTexture, texCoordFromUnit(muS * 0.5 + 0.5, IRRADIANCE_TEXTURE_WIDTH),
      texCoordFromUnit(xr, IRRADIANCE_TEXTURE_HEIGHT), this.tmpV);
    const sk = ATMOSPHERE.skyRadianceToRelativeLuminance;
    this.skyIrr.setRGB(irr.x * sk.x, irr.y * sk.y, irr.z * sk.z);

    // moon: sun-like transmittance towards the moon, scaled by phase & boost
    getSunLightColor(this.tex.transmittanceTexture, this.camECEF, this.moonDirECEF, this.moonIrr);
    const phaseBright = Math.pow(this.moonPhase, 2.2) * 0.92 + this.moonPhase * 0.08;
    const moonScale = MOON_RATIO * MOON_BOOST * phaseBright;
    this.moonIrr.multiplyScalar(moonScale);

    const sunEl = env.sunElevation;
    const nightK = THREE.MathUtils.smoothstep(-sunEl, 3, 9); // 0 when sun > -3°, 1 below -9°
    const moonUp = THREE.MathUtils.smoothstep(this.moonElevation, -1, 4);

    // ---- key light: sun by day, moon by night
    const cc = THREE.MathUtils.clamp(weather.cloudCover, 0, 1);
    const overcast = THREE.MathUtils.smoothstep(cc, 0.75, 1.0);
    const useMoon = sunEl < -3;
    const keyDir = useMoon ? this.moonDirW : env.sunDirection;
    const keyCol = this.tmpC.copy(useMoon ? this.moonIrr : this.sunIrr).multiplyScalar(S);
    if (useMoon) keyCol.multiplyScalar(nightK * moonUp);
    // a full overcast deck removes most direct light (cloud shadow term does the rest)
    keyCol.multiplyScalar(1 - 0.55 * overcast);
    const keyMax = Math.max(keyCol.r, keyCol.g, keyCol.b, 1e-6);
    this.sun.position.copy(keyDir);
    this.sun.color.setRGB(keyCol.r / keyMax, keyCol.g / keyMax, keyCol.b / keyMax);
    this.sun.intensity = keyMax;
    this.sun.visible = keyMax > 1e-5;
    this.sun.castShadow = keyMax > 1e-4;
    this.sun.updateMatrixWorld();
    this.backLight.position.copy(keyDir);
    this.backLight.color.copy(this.sun.color);
    this.backLight.intensity = this.sun.intensity;

    this.sunProxy.color.copy(this.sun.color);
    this.sunProxy.intensity = this.sun.intensity;
    this.sunProxy.position.copy(cam.position).addScaledVector(keyDir, 5000);
    this.sunProxy.target.position.copy(cam.position);
    this.sunProxy.updateMatrixWorld();
    this.sunProxy.target.updateMatrixWorld();

    // env: sun-only suggestion for other modules (0 at night)
    const sunCol = this.tmpC.copy(this.sunIrr).multiplyScalar(S);
    const sunMax = Math.max(sunCol.r, sunCol.g, sunCol.b, 1e-6);
    env.sunColor.setRGB(sunCol.r / sunMax, sunCol.g / sunMax, sunCol.b / sunMax);
    env.sunIntensity = sunMax * (1 - 0.55 * overcast);
    env.cloudCover = cc;
    env.rain = weather.rain;
    env.fog = weather.fog;

    // ---- shadow distances adapt to altitude
    const agl = Math.max(0, ctx.cameraAGL);
    const prof = ctx.settings.profile;
    this.shadow.startDistance = Math.max(cam.near, agl * 0.55);
    this.shadow.endDistance = Math.max(prof.shadowFar, this.shadow.startDistance + prof.shadowFar);
    this.shadow.casterCeiling = 320;

    // ---- shared shader uniforms
    u.skWorldToECEF.value.copy(this.frame.worldToECEF);
    u.skCamWorld.value.copy(cam.position);
    // altitude correction: identical to takram's getAltitudeCorrectionOffset (sphere osculating the ellipsoid)
    u.skCamECEF.value.copy(this.camECEF).add(this.altitudeCorrection(this.camECEF, this.tmpV)).multiplyScalar(0.001);
    u.skSunDirECEF.value.copy(this.sunDirECEF);
    u.skMoonDirECEF.value.copy(this.moonDirECEF);
    u.skSunDirW.value.copy(env.sunDirection);
    u.skMoonDirW.value.copy(this.moonDirW);
    u.skMoonLight.value = moonScale * nightK * moonUp;
    u.skMoonIrr.value.set(this.moonIrr.r, this.moonIrr.g, this.moonIrr.b).multiplyScalar(nightK * moonUp);
    u.skTime.value = env.elapsed;

    // night sky: airglow + light pollution (app units), city glow on cloud bases
    const nk = nightK;
    const cloudBoost = 1 + 2.5 * cc;
    u.skNightZenith.value.set(0.00035, 0.00055, 0.0011).multiplyScalar(nk * (1 + cc));
    u.skNightHorizon.value.set(0.0045, 0.0030, 0.0017).multiplyScalar(nk * cloudBoost);
    u.skCityGlow.value.set(0.020, 0.013, 0.0075).multiplyScalar(nk);

    // fog lighting (app units)
    const skyH = lum(this.skyIrr) * S;
    const sunH = Math.max(0, env.sunDirection.y);
    u.skFogSun.value.set(this.sunIrr.r, this.sunIrr.g, this.sunIrr.b).multiplyScalar(S * (1 - 0.8 * overcast) / (4 * Math.PI) * 4 * 0.9);
    u.skFogAmb.value.set(this.skyIrr.r, this.skyIrr.g, this.skyIrr.b).multiplyScalar(S * 0.9 / Math.PI)
      .addScaledVector(new THREE.Vector3(this.sunIrr.r, this.sunIrr.g, this.sunIrr.b), S * sunH * 0.25 * overcast / Math.PI)
      .addScaledVector(new THREE.Vector3(0.02, 0.013, 0.0075), nk * 0.6)
      .addScaledVector(new THREE.Vector3(this.moonIrr.r, this.moonIrr.g, this.moonIrr.b), S * nightK * moonUp * 0.15);

    // ---- cloud lighting (at cloud mid altitude above the camera; luminance, unscaled)
    const cloudAlt = u.skCloudP1.value.x + u.skCloudP1.value.y * 0.5;
    const pCloud = this.frame.posToECEF(this.tmpV.set(cam.position.x, cloudAlt, cam.position.z), this.tmpV);
    const keyIrr = this.tmpC2;
    if (useMoon) {
      getSunLightColor(this.tex.transmittanceTexture, pCloud, this.moonDirECEF, keyIrr);
      keyIrr.multiplyScalar(moonScale * nightK * moonUp);
      u.skCloudKeyDirW.value.copy(this.moonDirW);
    } else {
      getSunLightColor(this.tex.transmittanceTexture, pCloud, this.sunDirECEF, keyIrr);
      u.skCloudKeyDirW.value.copy(env.sunDirection);
    }
    u.skCloudKey.value.set(keyIrr.r, keyIrr.g, keyIrr.b);
    const xrc = THREE.MathUtils.clamp(cloudAlt / (ATMOSPHERE.topRadius - ATMOSPHERE.bottomRadius), 0, 1);
    const irc = sampleRGBA(this.tex.irradianceTexture, texCoordFromUnit(muS * 0.5 + 0.5, IRRADIANCE_TEXTURE_WIDTH),
      texCoordFromUnit(xrc, IRRADIANCE_TEXTURE_HEIGHT), this.tmpV);
    u.skCloudAmb.value.set(irc.x * sk.x, irc.y * sk.y, irc.z * sk.z)
      .add(this.tmpV2.set(0.0012, 0.0014, 0.0022).multiplyScalar(nightK)); // faint night-sky/airglow ambient
    const ga = 0.12;
    u.skCloudGnd.value.set(this.sunIrr.r, this.sunIrr.g, this.sunIrr.b).multiplyScalar(ga * sunH * (1 - 0.7 * overcast))
      .addScaledVector(this.tmpV2.set(this.skyIrr.r, this.skyIrr.g, this.skyIrr.b), ga)
      .addScaledVector(u.skCityGlow.value, 1 / S);

    // ---- exposure (deterministic time-of-day curve with partial adaptation)
    const sunKeyH = lum(this.sunIrr) * S * sunH * (1 - 0.75 * overcast) * (1 - 0.35 * THREE.MathUtils.smoothstep(cc, 0.3, 0.75));
    const moonH = lum(this.moonIrr) * S * Math.max(0, this.moonDirW.y) * nightK * moonUp;
    const nightFloor = 0.03 * nk + 0.004;
    const L = sunKeyH + skyH * (1 - 0.35 * overcast) + moonH + nightFloor;
    const Lref = 3.2;
    this.exposureTarget = THREE.MathUtils.clamp(1.05 * Math.pow(Lref / L, 0.6), 0.55, 9.0);
    if (instant) this.exposure = this.exposureTarget;
    else this.exposure += (this.exposureTarget - this.exposure) * (1 - Math.exp(-dt * 1.5));

    // stars rotation (ECI -> ECEF -> world)
    this.starRot.setFromMatrix4(this.tmpM4.copy(this.frame.ecefToWorld).setPosition(0, 0, 0).multiply(this.eciToECEF));
    this.starIntensity = THREE.MathUtils.smoothstep(-sunEl, 7, 14) * (1 - cc * 0.9) * 0.35;
  }

  readonly starRot = new THREE.Matrix3();
  starIntensity = 0;
  private tmpM4 = new THREE.Matrix4();

  private altitudeCorrection(posECEF: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    // same as takram's AerialPerspectiveEffect: -(centre of the sphere osculating the ellipsoid)
    return getAltitudeCorrectionOffset(posECEF, ATMOSPHERE.bottomRadius, Ellipsoid.WGS84, out);
  }

  /** Re-render the environment cube map + PMREM when the sky changed noticeably. */
  updateEnvironment(weatherKey: string, force = false): void {
    const ctx = this.ctx;
    const sunMoved = this.lastEnvSun.angleTo(ctx.env.sunDirection) > 0.004;
    const moonMoved = this.lastEnvMoon.angleTo(this.moonDirW) > 0.02;
    const moved = this.lastEnvPos.distanceTo(ctx.camera.position) > 3000;
    const t = ctx.env.elapsed;
    const stale = t - this.lastEnvTime > 20;
    if (!force && !this.envDirty && !sunMoved && !moonMoved && !moved && !stale && weatherKey === this.lastEnvWeather) return;
    this.envDirty = false;
    this.lastEnvSun.copy(ctx.env.sunDirection);
    this.lastEnvMoon.copy(this.moonDirW);
    this.lastEnvWeather = weatherKey;
    this.lastEnvPos.copy(ctx.camera.position);
    this.lastEnvTime = t;
    const r = ctx.renderer;
    const prevTarget = r.getRenderTarget();
    try {
      this.cubeCam.position.set(0, 0, 0);
      this.cubeCam.update(r, this.envScene);
      const rt = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT as any);
      if (this.envRT !== rt) {
        const old = this.envRT;
        this.envRT = rt;
        ctx.scene.environment = rt.texture;
        ctx.backdrop.scene.environment = rt.texture;
        old?.dispose();
      }
      ctx.scene.environmentIntensity = 1;
      ctx.backdrop.scene.environmentIntensity = 1;
    } catch (e) {
      console.error('[sky] environment update failed', e);
    }
    r.setRenderTarget(prevTarget);
  }

  get envTexture(): THREE.Texture | null { return this.envRT?.texture ?? null; }
}
