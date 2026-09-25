// Stand-alone aerial perspective shared by the near and far terrain. Only active when the sky
// module (whose post-processing applies aerial perspective to the combined depth) is absent.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';

export class Haze {
  readonly uniforms: Record<string, THREE.IUniform> = {
    uHazeOn: { value: 0 },
    uHazeCol: { value: new THREE.Vector3(0.5, 0.6, 0.75) },
    uBetaR: { value: new THREE.Vector3(5.8e-6, 13.5e-6, 33.1e-6) },   // Rayleigh extinction at sea level (1/m)
    uBetaM: { value: 8e-6 },                                          // Mie extinction at sea level (1/m)
    uScaleH: { value: new THREE.Vector2(8000, 1300) },                // scale heights (m)
    uSunGlow: { value: 1.5 },
    uHazeSun: { value: new THREE.Vector3(0, 1, 0) },
  };
  /** Horizontal visibility (km) on a clear day; reduced by env.fog / env.rain. */
  visibilityKm = 170;
  hazeOverride: THREE.Color | null = null;

  update(ctx: AppContext): void {
    const u = this.uniforms, env = ctx.env;
    const on = !ctx.get('sky');
    u.uHazeOn.value = on ? 1 : 0;
    if (!on) return;
    (u.uHazeSun.value as THREE.Vector3).copy(env.sunDirection);
    const day = Math.max(0.015, Math.min(1, env.sunDirection.y * 3 + 0.15));
    const hz = u.uHazeCol.value as THREE.Vector3;
    if (this.hazeOverride) hz.set(this.hazeOverride.r, this.hazeOverride.g, this.hazeOverride.b);
    else hz.set(0.56, 0.66, 0.82).multiplyScalar(day);
    // Koschmieder: total extinction 3.912 / V; the Rayleigh part is ~1.2e-5 at sea level
    const vis = this.visibilityKm * (1 - 0.9 * Math.min(1, env.fog)) * (1 - 0.5 * Math.min(1, env.rain));
    u.uBetaM.value = Math.max(1e-6, 3.912 / (Math.max(5, vis) * 1000) - 1.2e-5);
  }
}
