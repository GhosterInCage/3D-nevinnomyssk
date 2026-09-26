// Birds: flocks of feral pigeons circling low over squares and streets, and rooks / jackdaws (very
// common in Stavropol Krai) wheeling higher up. Instanced tiny meshes with wing flapping in the
// vertex shader; flock centres drift with the wind around the camera. Hidden at night.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { Builder, type MatSpec } from './geom';
import { Rng } from './util';

interface Flock {
  kind: number; cx: number; cz: number; y: number; r: number; w: number; n: number;
  birds: Array<{ ph: number; dr: number; dy: number; flap: number; glide: number; sp: number }>;
  vx: number; vz: number; t: number;
}

function birdGeometry(span: number, len: number): THREE.BufferGeometry {
  const b = new Builder();
  const m: MatSpec = { c: [1, 1, 1], r: 0.8, m: 0 };
  // body (diamond)
  b.bone = 0;
  const hw = len * 0.12;
  const pts: Array<[number, number, number]> = [[0, 0, len * 0.55], [hw, 0, 0], [0, hw, 0], [-hw, 0, 0], [0, -hw * 0.8, 0], [0, 0, -len * 0.45]];
  const tris = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4]];
  for (const t of tris) b.tri(pts[t[0]], pts[t[1]], pts[t[2]], m, [(pts[t[0]][0] + pts[t[1]][0] + pts[t[2]][0]), (pts[t[0]][1] + pts[t[1]][1] + pts[t[2]][1]) + 0.001, (pts[t[0]][2] + pts[t[1]][2] + pts[t[2]][2])]);
  // tail
  b.tri([0, 0, -len * 0.35], [len * 0.12, 0, -len * 0.7], [-len * 0.12, 0, -len * 0.7], m, [0, 1, 0]);
  // wings (bone 1 = +x, 2 = -x), hinge along the body axis
  for (const [bone, s] of [[1, 1], [2, -1]] as const) {
    b.bone = bone;
    const h = span / 2;
    b.quad([s * hw * 0.5, 0, len * 0.18], [s * h * 0.55, 0, len * 0.12], [s * h * 0.55, 0, -len * 0.12], [s * hw * 0.5, 0, -len * 0.15], m, [0, 1, 0]);
    b.quad([s * h * 0.55, 0, len * 0.12], [s * h, 0, -len * 0.02], [s * h * 0.95, 0, -len * 0.14], [s * h * 0.55, 0, -len * 0.12], m, [0, 1, 0]);
  }
  b.bone = 0;
  return b.build(20, true);
}

export class Birds {
  meshes: THREE.InstancedMesh[] = [];
  flocks: Flock[] = [];
  private rng = new Rng(555);
  private lastX = Infinity; private lastZ = Infinity;
  private cap = 400;

  constructor(private ctx: AppContext, material: THREE.Material) {
    const geos = [birdGeometry(0.65, 0.32), birdGeometry(0.9, 0.45)];
    geos.forEach((g, k) => {
      g.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iData', new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
      const m = new THREE.InstancedMesh(g, material, this.cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.count = 0;
      m.name = `traffic-birds-${k}`;
      m.userData.noPathTrace = true;
      this.meshes.push(m);
    });
  }

  private reset(cx: number, cz: number, groundY: number): void {
    this.flocks = [];
    const r = this.rng;
    const nf = 5;
    for (let f = 0; f < nf; f++) {
      const kind = f < 3 ? 0 : 1;
      const a = r.next() * Math.PI * 2, d = 40 + r.next() * 320;
      const n = kind === 0 ? 10 + r.int(20) : 20 + r.int(40);
      const birds: Flock['birds'] = [];
      for (let i = 0; i < n; i++) birds.push({ ph: r.next() * Math.PI * 2, dr: (r.next() - 0.5) * (kind ? 30 : 10), dy: (r.next() - 0.5) * (kind ? 18 : 5), flap: r.next() * 6.28, glide: r.next() * 10, sp: 0.9 + r.next() * 0.2 });
      this.flocks.push({
        kind, cx: cx + Math.cos(a) * d, cz: cz + Math.sin(a) * d, y: groundY + (kind ? 45 + r.next() * 60 : 10 + r.next() * 18),
        r: kind ? 45 + r.next() * 50 : 14 + r.next() * 16, w: (r.next() < 0.5 ? 1 : -1) * (kind ? 0.12 : 0.35), n, birds,
        vx: (r.next() - 0.5) * 1.5, vz: (r.next() - 0.5) * 1.5, t: r.next() * 100,
      });
    }
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const cam = ctx.camera.position;
    const on = ctx.env.night < 0.6 && ctx.env.rain < 0.6;
    for (const m of this.meshes) m.visible = on;
    if (!on) return;
    const g = ctx.heightfield.sample(cam.x, cam.z);
    if (Math.hypot(cam.x - this.lastX, cam.z - this.lastZ) > 600 || !this.flocks.length) {
      this.reset(cam.x, cam.z, g);
      this.lastX = cam.x; this.lastZ = cam.z;
    }
    const h = Math.min(dt, 0.1);
    const counts = [0, 0];
    const m4 = new THREE.Matrix4();
    const wind = ctx.env.wind;
    for (const f of this.flocks) {
      f.t += h;
      f.cx += (f.vx + wind.x * 0.2) * h;
      f.cz += (f.vz + wind.y * 0.2) * h;
      // keep the flock near the camera
      const dx = f.cx - cam.x, dz = f.cz - cam.z;
      if (dx * dx + dz * dz > 700 * 700) { f.cx = cam.x - dx * 0.5; f.cz = cam.z - dz * 0.5; }
      const gy = ctx.heightfield.sample(f.cx, f.cz);
      const baseY = Math.max(f.y, gy + (f.kind ? 35 : 8));
      const mesh = this.meshes[f.kind];
      const col = mesh.geometry.getAttribute('iColor') as THREE.InstancedBufferAttribute;
      const dat = mesh.geometry.getAttribute('iData') as THREE.InstancedBufferAttribute;
      for (const b of f.birds) {
        const i = counts[f.kind];
        if (i >= this.cap) break;
        counts[f.kind]++;
        const a = f.t * f.w * b.sp + b.ph;
        const R = f.r + b.dr + Math.sin(f.t * 0.3 + b.ph * 3) * 4;
        const x = f.cx + Math.cos(a) * R, z = f.cz + Math.sin(a) * R;
        const y = baseY + b.dy + Math.sin(f.t * 0.7 + b.ph) * 2.5;
        // tangent direction of the circle
        const s = Math.sign(f.w) || 1;
        let hx = -Math.sin(a) * s, hz = Math.cos(a) * s;
        const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
        const bank = -0.35 * s;
        const cb = Math.cos(bank), sb = Math.sin(bank);
        // right = (hz, 0, -hx) rolled by bank around forward
        const rx = hz * cb, ry = -sb, rz = -hx * cb;
        const ux = hz * sb, uy = cb, uz = -hx * sb;
        m4.set(rx, ux, hx, x, ry, uy, 0, y, rz, uz, hz, z, 0, 0, 0, 1);
        mesh.setMatrixAt(i, m4);
        const flapping = Math.sin(f.t * 0.4 + b.glide) > -0.3 ? 1 : 0.15;
        b.flap += h * (f.kind ? 9 : 14) * (flapping > 0.5 ? 1 : 0.2);
        dat.setXYZW(i, b.flap, flapping, 0, 0);
        if (f.kind === 0) col.setXYZ(i, 0.26, 0.27, 0.3); else col.setXYZ(i, 0.025, 0.025, 0.03);
      }
    }
    this.meshes.forEach((mesh, k) => {
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.geometry.getAttribute('iColor') as THREE.InstancedBufferAttribute).needsUpdate = true;
      (mesh.geometry.getAttribute('iData') as THREE.InstancedBufferAttribute).needsUpdate = true;
    });
  }
}
