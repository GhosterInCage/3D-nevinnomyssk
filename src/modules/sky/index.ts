// PLACEHOLDER sky/lighting (to be replaced by the sky module implementation).
import * as THREE from 'three';
import type { CityModule } from '../../core/context';

const mod: CityModule = {
  id: 'sky',
  init(ctx) {
    ctx.scene.background = null;
    ctx.backdrop.scene.background = new THREE.Color(0x9ec3e6);
    ctx.scene.fog = new THREE.Fog(0xb8cde0, 2000, 30000);
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x5a5040, 1.2);
    ctx.scene.add(sun, sun.target, hemi);
    ctx.onUpdate(() => {
      const d = ctx.env.sunDirection;
      sun.position.copy(ctx.camera.position).addScaledVector(d, 5000);
      sun.target.position.copy(ctx.camera.position);
      sun.intensity = 3 * Math.max(0, d.y) ** 0.5;
    });
  },
};
export default mod;
