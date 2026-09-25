// PLACEHOLDER terrain (to be replaced by the terrain module implementation):
// a single displaced grid with the Sentinel-2 ortho as albedo.
import * as THREE from 'three';
import type { CityModule } from '../../core/context';
import { dataUrl } from '../../core/data';

const mod: CityModule = {
  id: 'terrain',
  async init(ctx) {
    const hf = ctx.heightfield;
    const seg = 512;
    const g = new THREE.PlaneGeometry(hf.size, hf.size, seg, seg);
    g.rotateX(-Math.PI / 2); // plane now in XZ, row 0 at z = -half (north)
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, hf.sample(pos.getX(i), pos.getZ(i)));
    g.computeVertexNormals();
    const tex = await new THREE.TextureLoader().loadAsync(dataUrl(ctx.manifest.terrain.ortho));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = ctx.registerMaterial(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'terrain-placeholder';
    mesh.receiveShadow = true;
    ctx.scene.add(mesh);
  },
};
export default mod;
