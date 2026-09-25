// Distance-limited instancing: all items are known up front; every few frames the ones within
// range of the camera are written into an InstancedMesh (nearest first, up to capacity).
import * as THREE from 'three';

export interface Item { x: number; y: number; z: number; rot: number; sx?: number; sy?: number; sz?: number; data?: number }

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class InstanceSet {
  readonly mesh: THREE.InstancedMesh;
  readonly items: Item[];
  minRange = 0;
  range: number;
  private lastX = Infinity;
  private lastZ = Infinity;
  private dirty = true;
  /** indices of items currently written (instance i -> item index) */
  current: number[] = [];
  onWrite: ((inst: number, item: Item, idx: number) => void) | null = null;

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], items: Item[], range: number, capacity?: number) {
    this.items = items;
    this.range = range;
    const cap = Math.max(1, Math.min(items.length, capacity ?? items.length));
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  invalidate(): void { this.dirty = true; }

  update(cam: THREE.Vector3, moveThreshold = 25): boolean {
    if (!this.dirty && Math.hypot(cam.x - this.lastX, cam.z - this.lastZ) < moveThreshold) return false;
    this.dirty = false;
    this.lastX = cam.x; this.lastZ = cam.z;
    const r2 = this.range * this.range, m2 = this.minRange * this.minRange;
    const sel: Array<[number, number]> = [];
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const d = (it.x - cam.x) ** 2 + (it.z - cam.z) ** 2;
      if (d <= r2 && d >= m2) sel.push([d, i]);
    }
    const cap = this.mesh.instanceMatrix.count;
    if (sel.length > cap) { sel.sort((a, b) => a[0] - b[0]); sel.length = cap; }
    this.current = sel.map((s) => s[1]);
    for (let k = 0; k < this.current.length; k++) {
      const it = this.items[this.current[k]];
      _p.set(it.x, it.y, it.z);
      _q.setFromAxisAngle(_up, it.rot);
      _s.set(it.sx ?? 1, it.sy ?? 1, it.sz ?? 1);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(k, _m);
      this.onWrite?.(k, it, this.current[k]);
    }
    this.mesh.count = this.current.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return true;
  }
}

/** rotation.y for a model whose local -z must face heading h (deg cw from north). */
export function rotForHeading(h: number): number {
  return (-h * Math.PI) / 180;
}

/** Spatial hash for collider queries. */
export class PointGrid<T extends { x: number; z: number }> {
  private cells = new Map<number, T[]>();
  constructor(private cell = 64) {}
  private key(i: number, j: number): number { return (i + 2000) * 8192 + (j + 2000); }
  add(p: T): void {
    const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.z / this.cell));
    let l = this.cells.get(k);
    if (!l) { l = []; this.cells.set(k, l); }
    l.push(p);
  }
  query(x: number, z: number, r: number, out: T[] = []): T[] {
    for (let i = Math.floor((x - r) / this.cell); i <= Math.floor((x + r) / this.cell); i++) {
      for (let j = Math.floor((z - r) / this.cell); j <= Math.floor((z + r) / this.cell); j++) {
        const l = this.cells.get(this.key(i, j));
        if (!l) continue;
        for (const p of l) if ((p.x - x) ** 2 + (p.z - z) ** 2 <= r * r) out.push(p);
      }
    }
    return out;
  }
}
