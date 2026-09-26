// Tyre skid marks: a ring buffer of thin quads laid on the contact points of slipping wheels.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';

const MAX = 3000; // segments
const WIDTH = 0.17;

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private col: Float32Array;
  private head = 0;
  private last: Array<{ x: number; y: number; z: number; lx: number; lz: number; a: number } | null> = [null, null, null, null];
  private dirty = false;
  private drawn = 0;

  constructor(private ctx: AppContext) {
    this.pos = new Float32Array(MAX * 4 * 3);
    this.col = new Float32Array(MAX * 4 * 4);
    const idx = new Uint32Array(MAX * 6);
    for (let s = 0; s < MAX; s++) {
      const v = s * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], s * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX * 4 * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    const mat = ctx.registerMaterial(new THREE.MeshStandardMaterial({
      name: 'physics-skid', color: 0x070707, roughness: 0.75, metalness: 0, vertexColors: true, transparent: true,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
    }));
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'physics-skidmarks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
    this.mesh.userData.noPathTrace = true;
    ctx.scene.add(this.mesh);
  }

  /** Wheel i is slipping at (x, y, z) with ground normal n, rolling along (fx, fz). */
  add(i: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, fx: number, fz: number, slip: number): void {
    const lift = 0.02;
    x += nx * lift; y += ny * lift; z += nz * lift;
    const l = this.last[i];
    // lateral (width) direction: perpendicular to the rolling direction in the ground plane
    let lx = -fz, lz = fx;
    const ll = Math.hypot(lx, lz) || 1;
    lx /= ll; lz /= ll;
    const a = Math.min(0.85, 0.25 + slip * 0.7);
    if (!l) { this.last[i] = { x, y, z, lx, lz, a }; return; }
    const d = Math.hypot(x - l.x, z - l.z);
    if (d > 4) { this.last[i] = { x, y, z, lx, lz, a }; return; }
    if (d < 0.2) return;
    const s = this.head;
    this.head = (this.head + 1) % MAX;
    this.drawn = Math.min(MAX, this.drawn + 1);
    const p = this.pos, c = this.col, v = s * 4, hw = WIDTH / 2;
    const put = (k: number, px: number, py: number, pz: number, alpha: number) => {
      p[(v + k) * 3] = px; p[(v + k) * 3 + 1] = py; p[(v + k) * 3 + 2] = pz;
      c[(v + k) * 4] = 1; c[(v + k) * 4 + 1] = 1; c[(v + k) * 4 + 2] = 1; c[(v + k) * 4 + 3] = alpha;
    };
    put(0, l.x - l.lx * hw, l.y, l.z - l.lz * hw, l.a);
    put(1, l.x + l.lx * hw, l.y, l.z + l.lz * hw, l.a);
    put(2, x - lx * hw, y, z - lz * hw, a);
    put(3, x + lx * hw, y, z + lz * hw, a);
    this.last[i] = { x, y, z, lx, lz, a };
    this.dirty = true;
  }

  lift(i: number): void { this.last[i] = null; }
  breakAll(): void { this.last = [null, null, null, null]; }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const g = this.mesh.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    g.setDrawRange(0, this.drawn * 6);
  }

  clear(): void {
    this.pos.fill(0); this.col.fill(0);
    this.drawn = 0; this.head = 0; this.dirty = true;
    this.breakAll();
  }

  dispose(): void {
    this.ctx.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
  }
}
