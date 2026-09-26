// Loading of the sky module's static assets (public/textures/sky/).
//  atmosphere/{transmittance,scattering,irradiance}.exr : Bruneton precomputed LUTs
//      (from @takram/three-atmosphere, MIT; Earth atmosphere, half float)
//  stars.bin : Yale Bright Star Catalogue (9096 stars, J2000 ECI dirs, magnitude, colour)
//  clouds.png / noise3d.bin : procedural cloud weather + 3D detail (pipeline/build_sky.py)
import * as THREE from 'three';
import { PrecomputedTexturesLoader, type PrecomputedTextures } from '@takram/three-atmosphere';

export const SKY_TEX_BASE = `${import.meta.env.BASE_URL}textures/sky/`;

export function loadAtmosphereTextures(renderer: THREE.WebGLRenderer): Promise<PrecomputedTextures> {
  return new Promise((resolve, reject) => {
    const loader = new PrecomputedTexturesLoader({ format: 'exr', combinedScattering: true, higherOrderScattering: false });
    // Half float is enough and is linearly filterable everywhere (SwiftShader included).
    loader.type = THREE.HalfFloatType;
    let done = false;
    const timer = setTimeout(() => { if (!done) reject(new Error('atmosphere textures: timeout')); }, 60000);
    loader.load(
      `${SKY_TEX_BASE}atmosphere`,
      (tex) => {
        done = true;
        clearTimeout(timer);
        for (const t of Object.values(tex)) if (t) { (t as THREE.Texture).needsUpdate = true; }
        resolve(tex);
      },
      undefined,
      (err) => { done = true; clearTimeout(timer); reject(err); },
    );
    void renderer;
  });
}

export async function loadStars(): Promise<ArrayBuffer> {
  const res = await fetch(`${SKY_TEX_BASE}stars.bin`);
  if (!res.ok) throw new Error(`stars.bin ${res.status}`);
  return res.arrayBuffer();
}
