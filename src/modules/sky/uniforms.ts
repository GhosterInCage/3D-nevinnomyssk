// Uniform objects shared (by reference) between the atmosphere post effect,
// the environment-map sky material and the cloud-shadow material patch.
import * as THREE from 'three';
import {
  AtmosphereParameters,
  IRRADIANCE_TEXTURE_HEIGHT,
  IRRADIANCE_TEXTURE_WIDTH,
  METER_TO_LENGTH_UNIT,
  SCATTERING_TEXTURE_MU_S_SIZE,
  SCATTERING_TEXTURE_MU_SIZE,
  SCATTERING_TEXTURE_NU_SIZE,
  SCATTERING_TEXTURE_R_SIZE,
  TRANSMITTANCE_TEXTURE_HEIGHT,
  TRANSMITTANCE_TEXTURE_WIDTH,
  type PrecomputedTextures,
} from '@takram/three-atmosphere';

export const ATMOSPHERE = AtmosphereParameters.DEFAULT;

/** Radiance scale from Bruneton relative luminance to our scene units (noon sun ~3). */
export const RADIANCE_SCALE = 2.0;

export function atmosphereDefines(): Record<string, string> {
  return {
    TRANSMITTANCE_TEXTURE_WIDTH: TRANSMITTANCE_TEXTURE_WIDTH.toFixed(0),
    TRANSMITTANCE_TEXTURE_HEIGHT: TRANSMITTANCE_TEXTURE_HEIGHT.toFixed(0),
    SCATTERING_TEXTURE_R_SIZE: SCATTERING_TEXTURE_R_SIZE.toFixed(0),
    SCATTERING_TEXTURE_MU_SIZE: SCATTERING_TEXTURE_MU_SIZE.toFixed(0),
    SCATTERING_TEXTURE_MU_S_SIZE: SCATTERING_TEXTURE_MU_S_SIZE.toFixed(0),
    SCATTERING_TEXTURE_NU_SIZE: SCATTERING_TEXTURE_NU_SIZE.toFixed(0),
    IRRADIANCE_TEXTURE_WIDTH: IRRADIANCE_TEXTURE_WIDTH.toFixed(0),
    IRRADIANCE_TEXTURE_HEIGHT: IRRADIANCE_TEXTURE_HEIGHT.toFixed(0),
    METER_TO_LENGTH_UNIT: METER_TO_LENGTH_UNIT.toFixed(7),
    COMBINED_SCATTERING_TEXTURES: '1',
    GROUND: '1',
  };
}

export type SkyUniforms = ReturnType<typeof createSkyUniforms>;

export function createSkyUniforms(tex: PrecomputedTextures, cloudTex: THREE.Texture) {
  return {
    ATMOSPHERE: ATMOSPHERE.toUniform(),
    SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: new THREE.Uniform(ATMOSPHERE.sunRadianceToRelativeLuminance),
    SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: new THREE.Uniform(ATMOSPHERE.skyRadianceToRelativeLuminance),
    transmittance_texture: new THREE.Uniform<THREE.Texture | null>(tex.transmittanceTexture),
    scattering_texture: new THREE.Uniform<THREE.Texture | null>(tex.scatteringTexture),
    irradiance_texture: new THREE.Uniform<THREE.Texture | null>(tex.irradianceTexture),
    single_mie_scattering_texture: new THREE.Uniform<THREE.Texture | null>(null),
    higher_order_scattering_texture: new THREE.Uniform<THREE.Texture | null>(null),

    skWorldToECEF: new THREE.Uniform(new THREE.Matrix4()),
    skCamWorld: new THREE.Uniform(new THREE.Vector3()),
    skCamECEF: new THREE.Uniform(new THREE.Vector3()),
    skSunDirECEF: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
    skMoonDirECEF: new THREE.Uniform(new THREE.Vector3(0, 0, 1)),
    skSunDirW: new THREE.Uniform(new THREE.Vector3(0, 1, 0)),
    skMoonDirW: new THREE.Uniform(new THREE.Vector3(0, 1, 0)),
    skRadianceScale: new THREE.Uniform(RADIANCE_SCALE),
    skMoonLight: new THREE.Uniform(0),
    skCosSunRadius: new THREE.Uniform(Math.cos(ATMOSPHERE.sunAngularRadius)),
    skSunDiscScale: new THREE.Uniform(0.2),
    skMoonAngularRadius: new THREE.Uniform(0.0045),
    skLunarScale: new THREE.Uniform(4.0),
    skTime: new THREE.Uniform(0),

    skCloudTex: new THREE.Uniform<THREE.Texture>(cloudTex),
    skNoise3D: new THREE.Uniform<THREE.Texture | null>(null),
    skCloudP0: new THREE.Uniform(new THREE.Vector4(0.25, 1 / 20000, 0, 0)),
    skCloudP1: new THREE.Uniform(new THREE.Vector4(1900, 700, 16, 0.6)),
    skCloudP2: new THREE.Uniform(new THREE.Vector4(9000, 0.25, 0.6, 0)),
    skMoonIrr: new THREE.Uniform(new THREE.Vector3()),
    skCityGlow: new THREE.Uniform(new THREE.Vector3()),
    skNightZenith: new THREE.Uniform(new THREE.Vector3()),
    skNightHorizon: new THREE.Uniform(new THREE.Vector3()),
    skFog: new THREE.Uniform(new THREE.Vector4(0, 300, 250, 60000)),
    skFogSun: new THREE.Uniform(new THREE.Vector3()),
    skFogAmb: new THREE.Uniform(new THREE.Vector3()),
    skGroundAlbedo: new THREE.Uniform(new THREE.Vector3(0.1, 0.11, 0.08)),
    skCloudKeyDirW: new THREE.Uniform(new THREE.Vector3(0, 1, 0)),
    skCloudKey: new THREE.Uniform(new THREE.Vector3(1, 1, 1)),
    skCloudAmb: new THREE.Uniform(new THREE.Vector3(0.2, 0.2, 0.25)),
    skCloudGnd: new THREE.Uniform(new THREE.Vector3(0.05, 0.05, 0.05)),
    skCloudP3: new THREE.Uniform(new THREE.Vector4(24, 30000, 1, 0.5)),
    skLut: new THREE.Uniform(new THREE.Vector4(8, Math.log(400000 / 8), 32, 0)),
  };
}
