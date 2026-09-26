// Instanced rendering of vehicle fleets: one InstancedMesh per (type, LOD) with per-instance
// iColor / iData attributes; the base geometry buffers are shared between fleets.
import * as THREE from 'three';

export interface ModelSet {
  lods: THREE.BufferGeometry[][]; // [type][lod]
}

/** New geometry sharing the base attribute buffers of g (so several fleets can instance it). */
export function shareGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const s = new THREE.BufferGeometry();
  for (const k of Object.keys(g.attributes)) s.setAttribute(k, g.attributes[k]);
  if (g.index) s.setIndex(g.index);
  s.boundingSphere = g.boundingSphere?.clone() ?? null;
  s.boundingBox = g.boundingBox?.clone() ?? null;
  return s;
}

interface Slot {
  mesh: THREE.InstancedMesh;
  col: THREE.InstancedBufferAttribute;
  data: THREE.InstancedBufferAttribute;
  n: number;
  cap: number;
}

export class FleetRenderer {
  readonly group = new THREE.Group();
  private slots: Slot[][] = [];
  castShadowLod = 1; // lods <= this cast shadows

  constructor(name: string, models: ModelSet, material: THREE.Material, caps: number[][], opts: { shadows?: boolean; noPathTrace?: boolean } = {}) {
    this.group.name = name;
    models.lods.forEach((lods, t) => {
      const row: Slot[] = [];
      lods.forEach((g, l) => {
        const cap = Math.max(1, caps[t]?.[l] ?? 16);
        const geo = shareGeometry(g);
        const col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        const data = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
        col.setUsage(THREE.DynamicDrawUsage);
        data.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('iColor', col);
        geo.setAttribute('iData', data);
        const mesh = new THREE.InstancedMesh(geo, material, cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = opts.shadows !== false && l <= this.castShadowLod;
        mesh.receiveShadow = true;
        mesh.visible = false;
        mesh.name = `${name}-${t}-${l}`;
        if (opts.noPathTrace) mesh.userData.noPathTrace = true;
        this.group.add(mesh);
        row.push({ mesh, col, data, n: 0, cap });
      });
      this.slots.push(row);
    });
  }

  begin(): void {
    for (const row of this.slots) for (const s of row) s.n = 0;
  }

  /** Append an instance; m = 16 floats (column-major) at offset mo. Returns false when full. */
  push(type: number, lod: number, m: Float32Array, mo: number, r: number, g: number, b: number, d0: number, d1: number, d2: number, d3: number): boolean {
    const s = this.slots[type]?.[lod];
    if (!s || s.n >= s.cap) return false;
    const i = s.n++;
    const arr = s.mesh.instanceMatrix.array as Float32Array;
    for (let k = 0; k < 16; k++) arr[i * 16 + k] = m[mo + k];
    const c = s.col.array as Float32Array;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    const d = s.data.array as Float32Array;
    d[i * 4] = d0; d[i * 4 + 1] = d1; d[i * 4 + 2] = d2; d[i * 4 + 3] = d3;
    return true;
  }

  end(): void {
    for (const row of this.slots) {
      for (const s of row) {
        s.mesh.count = s.n;
        s.mesh.visible = s.n > 0;
        if (s.n > 0) {
          const im = s.mesh.instanceMatrix;
          im.clearUpdateRanges(); im.addUpdateRange(0, s.n * 16); im.needsUpdate = true;
          s.col.clearUpdateRanges(); s.col.addUpdateRange(0, s.n * 3); s.col.needsUpdate = true;
          s.data.clearUpdateRanges(); s.data.addUpdateRange(0, s.n * 4); s.data.needsUpdate = true;
        }
      }
    }
  }

  get count(): number {
    let n = 0;
    for (const row of this.slots) for (const s of row) n += s.n;
    return n;
  }

  setShadows(on: boolean): void {
    this.slots.forEach((row) => row.forEach((s, l) => { s.mesh.castShadow = on && l <= this.castShadowLod; }));
  }
}

/** Column-major matrix from position + forward (fx,fy,fz, need not be unit) with world-up roll-free basis. */
export function basisMatrix(out: Float32Array, o: number, x: number, y: number, z: number, fx: number, fy: number, fz: number, scale = 1): void {
  let l = Math.hypot(fx, fy, fz) || 1;
  fx /= l; fy /= l; fz /= l;
  // right = up x f  (up = +Y)
  let rx = fz, rz = -fx;
  l = Math.hypot(rx, rz) || 1;
  rx /= l; rz /= l;
  // up' = f x right
  const ux = fy * rz - fz * 0, uy = fz * rx - fx * rz, uz = fx * 0 - fy * rx;
  out[o] = rx * scale; out[o + 1] = 0; out[o + 2] = rz * scale; out[o + 3] = 0;
  out[o + 4] = ux * scale; out[o + 5] = uy * scale; out[o + 6] = uz * scale; out[o + 7] = 0;
  out[o + 8] = fx * scale; out[o + 9] = fy * scale; out[o + 10] = fz * scale; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}
