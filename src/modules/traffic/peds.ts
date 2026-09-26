// Pedestrians: instanced low-poly figures (men / women in coats, dresses) with a vertex-shader walk
// cycle, walking along footways and along the sidewalks of urban streets near the camera, plus
// people waiting at bus stops. Density follows the pipeline's pedestrian-activity raster
// (apartment districts, shops, stops, the centre) and the time of day.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { loadImagePixels } from '../../core/data';
import { Builder, type MatSpec } from './geom';
import { Net, C, type NetEdge } from './net';
import { Rng, clamp } from './util';

const part = (id: number, r = 0.85): MatSpec => ({ c: [0.5, 0.5, 0.5], r, m: 0, e: id });
const TOP = part(1), BOTTOM = part(2), SKIN = part(3, 0.7), HAIR = part(4, 0.9), SHOE = part(5, 0.5);

/** tapered elliptic tube along Y (rings), bone set on the builder */
function tube(b: Builder, y0: number, y1: number, cx: number, cz: number, rx0: number, rz0: number, rx1: number, rz1: number, seg: number, m: MatSpec, capTop = false, capBot = false): void {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a: number, y: number, rx: number, rz: number): [number, number, number] => [cx + Math.cos(a) * rx, y, cz + Math.sin(a) * rz];
    const am = (a0 + a1) / 2;
    b.quad(p(a0, y0, rx0, rz0), p(a1, y0, rx0, rz0), p(a1, y1, rx1, rz1), p(a0, y1, rx1, rz1), m, [Math.cos(am), 0, Math.sin(am)]);
    if (capTop) b.tri([cx, y1 + 0.01, cz], p(a0, y1, rx1, rz1), p(a1, y1, rx1, rz1), m, [0, 1, 0]);
    if (capBot) b.tri([cx, y0, cz], p(a0, y0, rx0, rz0), p(a1, y0, rx0, rz0), m, [0, -1, 0]);
  }
}

function head(b: Builder, y: number, r: number, hairLong: boolean, scarf: boolean, cap: boolean): void {
  // ellipsoid head (slightly taller than wide), face towards +z; hair cap / headscarf / knitted hat
  const seg = 10;
  const bands = 7;
  for (let k = 0; k < bands; k++) {
    const t0 = (k / bands) * Math.PI, t1 = ((k + 1) / bands) * Math.PI;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const am = (a0 + a1) / 2, tm = (t0 + t1) / 2;
      const fz = Math.sin(am); // +1 = face
      let m: MatSpec;
      if (scarf) m = tm < 2.2 && !(fz > 0.45 && tm > 0.75) ? TOP : SKIN;
      else if (cap) m = tm < 1.25 ? BOTTOM : tm < 1.75 && fz < 0.3 ? HAIR : SKIN;
      else m = tm < 0.95 || (fz < -0.2 && tm < (hairLong ? 2.4 : 1.9)) || (fz < 0.35 && tm < 1.2) ? HAIR : SKIN;
      const P = (a: number, t: number): [number, number, number] => {
        const rr = Math.sin(t) * r * (1 + 0.08 * Math.sin(a)); // fuller face
        const yy = y + Math.cos(t) * r * 1.18;
        return [Math.cos(a) * rr, yy, Math.sin(a) * rr * 1.06];
      };
      b.quad(P(a0, t0), P(a1, t0), P(a1, t1), P(a0, t1), m, [Math.cos(am) * Math.sin(tm), Math.cos(tm), Math.sin(am) * Math.sin(tm)]);
    }
  }
  if (hairLong && !scarf) {
    // long hair falling on the back
    b.quad([-r * 0.9, y - r * 0.2, -r * 0.55], [r * 0.9, y - r * 0.2, -r * 0.55], [r * 0.8, y - r * 2.3, -r * 0.75], [-r * 0.8, y - r * 2.3, -r * 0.75], HAIR, [0, 0, -1]);
  }
  // nose
  b.tri([0, y + r * 0.05, r * 1.08], [r * 0.12, y - r * 0.3, r * 1.02], [-r * 0.12, y - r * 0.3, r * 1.02], SKIN, [0, 0, 1]);
}

/** kind 0 man (jacket + trousers), 1 woman (coat + skirt), 2 older woman (long coat, headscarf) */
function figure(kind: number): THREE.BufferGeometry {
  const b = new Builder();
  const woman = kind >= 1;
  // legs (bones 1 left +x, 2 right -x); pivot at the hip y = 0.92
  for (const [bone, sx] of [[1, 1], [2, -1]] as const) {
    b.bone = bone;
    const x = sx * 0.092;
    const legM = woman ? (kind === 2 ? BOTTOM : SHOE) : BOTTOM;
    tube(b, 0.1, 0.5, x, 0, woman ? 0.05 : 0.062, woman ? 0.055 : 0.068, woman ? 0.065 : 0.074, woman ? 0.07 : 0.08, 7, legM);
    tube(b, 0.5, 0.94, x, 0, woman ? 0.065 : 0.074, woman ? 0.07 : 0.08, 0.088, 0.095, 7, legM);
    // shoe
    tube(b, 0.0, 0.1, x, 0.035, 0.05, 0.11, 0.048, 0.09, 7, SHOE, true, true);
  }
  b.bone = 0;
  if (woman) {
    // skirt / coat hem (A-line)
    tube(b, kind === 2 ? 0.34 : 0.5, 1.0, 0, 0, kind === 2 ? 0.25 : 0.23, kind === 2 ? 0.21 : 0.19, 0.165, 0.12, 10, kind === 2 ? TOP : BOTTOM);
  } else {
    tube(b, 0.84, 1.0, 0, 0, 0.17, 0.11, 0.175, 0.115, 10, BOTTOM);
  }
  // torso (jacket / coat): waist -> chest -> shoulders
  tube(b, 0.96, 1.16, 0, 0, woman ? 0.155 : 0.175, 0.115, woman ? 0.15 : 0.19, 0.12, 10, TOP);
  tube(b, 1.16, 1.38, 0, 0.005, woman ? 0.15 : 0.19, 0.12, woman ? 0.175 : 0.205, 0.125, 10, TOP);
  tube(b, 1.38, 1.47, 0, 0, woman ? 0.175 : 0.205, 0.125, 0.07, 0.065, 10, TOP);
  tube(b, 1.46, 1.55, 0, 0.01, 0.048, 0.05, 0.045, 0.048, 7, kind === 2 ? TOP : SKIN);
  head(b, 1.655, 0.1, kind === 1, kind === 2, kind === 0 && false);
  // arms (bones 3 left, 4 right), pivot at the shoulder y = 1.38
  for (const [bone, sx] of [[3, 1], [4, -1]] as const) {
    b.bone = bone;
    const x = sx * (woman ? 0.2 : 0.228);
    tube(b, 1.1, 1.43, x, 0, 0.05, 0.055, 0.062, 0.066, 7, TOP, true);
    tube(b, 0.84, 1.1, x, 0.01, 0.045, 0.048, 0.05, 0.055, 7, TOP);
    tube(b, 0.74, 0.84, x, 0.012, 0.03, 0.04, 0.036, 0.042, 6, SKIN, false, true);
  }
  b.bone = 0;
  return b.build(45, true);
}

const CLOTHES_TOP = [0x1d1f24, 0x2b2f38, 0x3b3b3b, 0x4a3b2d, 0x6b5a45, 0x1f3050, 0x2c4a3a, 0x7a1f26, 0x8a8e93, 0xc8c3b8, 0x2a2a2a, 0x5d4a6b, 0xb3802a, 0x356a8a, 0xd6d2c8, 0x9a3b2a];
const CLOTHES_BOTTOM = [0x16181c, 0x1f2633, 0x2a3446, 0x3a3a3c, 0x4a4238, 0x25231f, 0x55493b, 0x1b1b1b, 0x6d6a66];

interface Walker {
  edge: number; side: number; dir: number; u: number; off: number; speed: number; kind: number; idle: boolean;
  x: number; y: number; z: number; hx: number; hz: number; phase: number; scale: number;
  top: THREE.Color; bottom: THREE.Color; seed: number; life: number; demo?: boolean;
}

const _p = new Float64Array(5);

export class Pedestrians {
  meshes: THREE.InstancedMesh[] = [];
  walkers: Walker[] = [];
  private dens: { w: number; h: number; data: Uint8ClampedArray } | null = null;
  private cand: number[] = [];
  private candW: number[] = [];
  private candTot = 0;
  private tableX = Infinity; private tableZ = Infinity;
  private rng = new Rng(99);
  radius = 220;
  target = 0;
  private cap: number;
  private buildings: any;
  private water: any;
  private stops: Array<[number, number]> = [];
  private frame = 0;
  private lastCamX = Infinity; private lastCamZ = Infinity;

  constructor(private ctx: AppContext, private net: Net, private material: THREE.Material, cap: number, stops: number[][]) {
    this.cap = cap;
    this.stops = (stops ?? []).map((s) => [s[0], s[1]]);
    for (let k = 0; k < 3; k++) {
      const g = figure(k);
      g.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iColor2', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iData', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
      const m = new THREE.InstancedMesh(g, material, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = 0;
      m.name = `traffic-peds-${k}`;
      m.userData.noPathTrace = true;
      this.meshes.push(m);
    }
  }

  async load(): Promise<void> {
    try {
      const img = await loadImagePixels('traffic/density.png');
      this.dens = { w: img.width, h: img.height, data: img.data };
    } catch (e) {
      console.warn('[traffic] pedestrian density raster unavailable', e);
    }
  }

  /** 0..1 channel (0 R pedestrians, 1 G apartment, 2 B private) */
  density(x: number, z: number, ch = 0): number {
    const d = this.dens;
    if (!d) return ch === 0 ? 0.3 : 0.3;
    const i = clamp(Math.floor(((x + 10240) / 20480) * d.w), 0, d.w - 1);
    const j = clamp(Math.floor(((z + 10240) / 20480) * d.h), 0, d.h - 1);
    return d.data[(j * d.w + i) * 4 + ch] / 255;
  }

  private walkable(e: NetEdge): number {
    if (e.foot) return e.cls === C.steps ? 0.3 : 1.2;
    if (!e.drive) return 0;
    if (e.cls === C.track || e.cls === C.service || e.cls === C.motorway) return 0.15;
    return 1;
  }

  private rebuildTable(cx: number, cz: number): void {
    this.cand = []; this.candW = []; this.candTot = 0;
    let want = 0;
    for (const ei of this.net.edgeGrid().query(cx, cz, this.radius)) {
      const e = this.net.edges[ei];
      const wk = this.walkable(e);
      if (wk <= 0 || e.len < 8) continue;
      if (Math.hypot(e.cx - cx, e.cz - cz) > this.radius + e.r) continue;
      const d = this.density(e.cx, e.cz, 0);
      const w = e.len * wk * (0.03 + d * d * 1.2) * (e.foot ? 1.5 : 1);
      if (d < 0.05 && !e.foot) continue;
      this.cand.push(ei); this.candW.push(w); this.candTot += w;
      want += w * 0.05;
    }
    this.tableX = cx; this.tableZ = cz;
    const h = this.ctx.env.hours;
    const tod = h < 6 ? 0.05 : h < 8 ? 0.5 : h < 20 ? 1 : h < 22 ? 0.5 : 0.15;
    this.target = Math.min(this.cap, Math.round(want * tod));
  }

  private blocked(x: number, z: number): boolean {
    try {
      if (this.buildings?.infoAt?.(x, z)) return true;
      if (this.water?.isWater?.(x, z)) return true;
    } catch { /* ignore */ }
    return false;
  }

  private spawn(camX: number, camZ: number, hidden: boolean): boolean {
    const r = this.rng;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!this.cand.length) return false;
      const k = r.weighted(this.candW, this.candTot);
      const ei = this.cand[k];
      const e = this.net.edges[ei];
      const side = r.next() < 0.5 ? 1 : -1;
      const apart = this.density(e.cx, e.cz, 1);
      const off = e.foot ? (r.next() - 0.5) * Math.min(1.2, e.width * 0.6) : e.width / 2 + (apart > 0.3 ? 2.4 : 1.4) + r.next() * 1.2;
      const u = r.next() * e.len;
      this.net.pos(e, 1, u, off * side, _p);
      const x = _p[0], z = _p[1];
      const d = Math.hypot(x - camX, z - camZ);
      if (d > this.radius) continue;
      if (hidden && d < this.radius * 0.6) continue;
      if (this.blocked(x, z)) continue;
      this.walkers.push(this.makeWalker(ei, side, u, off, false, x, z));
      return true;
    }
    return false;
  }

  private makeWalker(ei: number, side: number, u: number, off: number, idle: boolean, x: number, z: number): Walker {
    const r = this.rng;
    const kind = r.next() < 0.45 ? 0 : r.next() < 0.75 ? 1 : 2;
    const top = new THREE.Color(CLOTHES_TOP[r.int(CLOTHES_TOP.length)]);
    const bottom = new THREE.Color(kind === 1 && r.next() < 0.5 ? CLOTHES_TOP[r.int(CLOTHES_TOP.length)] : CLOTHES_BOTTOM[r.int(CLOTHES_BOTTOM.length)]);
    return {
      edge: ei, side, dir: r.next() < 0.5 ? 1 : -1, u, off, speed: kind === 2 ? 0.9 + r.next() * 0.3 : 1.15 + r.next() * 0.45,
      kind, idle, x, y: 0, z, hx: 0, hz: 1, phase: r.next() * 6.28, scale: (kind === 0 ? 1.0 : 0.94) * (0.94 + r.next() * 0.12),
      top, bottom, seed: r.next(), life: 60 + r.next() * 240,
    };
  }

  private spawnStops(camX: number, camZ: number): void {
    // a few people waiting at bus stops near the camera
    for (const [sx, sz] of this.stops) {
      if (Math.hypot(sx - camX, sz - camZ) > this.radius) continue;
      const n = Math.floor(this.rng.next() * 4 * (0.3 + this.density(sx, sz, 0)));
      for (let k = 0; k < n; k++) {
        const x = sx + (this.rng.next() - 0.5) * 5, z = sz + (this.rng.next() - 0.5) * 2.5;
        const w = this.makeWalker(-1, 1, 0, 0, true, x, z);
        const a = this.rng.next() * 6.28;
        w.hx = Math.sin(a); w.hz = Math.cos(a);
        this.walkers.push(w);
      }
    }
  }

  private groundY(x: number, z: number): number {
    const r = this.net.roads as any;
    if (r?.groundHeight) {
      try { return r.groundHeight(x, z) + 0.13; } catch { /* ignore */ }
    }
    return this.ctx.heightfield.sample(x, z) + 0.05;
  }

  update(dt: number): void {
    const ctx = this.ctx;
    this.frame++;
    this.buildings ??= ctx.get('buildings');
    this.water ??= ctx.get('water');
    const cam = ctx.camera.position;
    const agl = Math.max(0, ctx.cameraAGL);
    this.radius = clamp(170 + agl * 0.8, 170, 380);
    const jump = Math.hypot(cam.x - this.lastCamX, cam.z - this.lastCamZ);
    this.lastCamX = cam.x; this.lastCamZ = cam.z;
    const teleport = jump > 150;
    if (teleport) this.walkers = this.walkers.filter((w) => w.demo);
    if (teleport || Math.hypot(cam.x - this.tableX, cam.z - this.tableZ) > 40) {
      this.rebuildTable(cam.x, cam.z);
      if (teleport) this.spawnStops(cam.x, cam.z);
    }
    if (agl > 700) { for (const m of this.meshes) m.visible = false; return; }
    const walking = this.walkers.filter((w) => !w.idle).length;
    if (walking < this.target) {
      const k = teleport || walking === 0 ? this.target - walking : Math.min(4, this.target - walking);
      for (let i = 0; i < k; i++) this.spawn(cam.x, cam.z, !(teleport || walking === 0));
    }
    const h = Math.min(dt, 0.1);
    const R2 = (this.radius * 1.1) ** 2;
    const net = this.net;
    const keep: Walker[] = [];
    for (const w of this.walkers) {
      const dx = w.x - cam.x, dz = w.z - cam.z;
      if (dx * dx + dz * dz > R2 && !w.demo) continue;
      w.life -= h;
      if (w.idle) {
        w.phase += h * (w.demo ? 5 : 0.3);
      } else {
        const e = net.edges[w.edge];
        w.u += w.dir * w.speed * h;
        if (w.u < 0 || w.u > e.len) {
          // pick the next edge at this node
          const node = w.u < 0 ? e.a : e.b;
          const opts: number[] = [];
          for (let k = net.incStart[node]; k < net.incStart[node + 1]; k++) {
            const ref = net.inc[k];
            if ((ref >> 1) === w.edge) continue;
            const e2 = net.edges[ref >> 1];
            if (this.walkable(e2) <= 0.2) continue;
            if (!e2.foot && this.density(e2.cx, e2.cz, 0) < 0.05) continue;
            opts.push(ref);
          }
          if (!opts.length || w.life < 0) {
            if (w.life < 0 && dx * dx + dz * dz > 60 * 60) continue; // retire out of sight
            w.dir = -w.dir;
            w.u = clamp(w.u, 0, e.len);
          } else {
            const ref = opts[this.rng.int(opts.length)];
            const e2 = net.edges[ref >> 1];
            w.edge = ref >> 1;
            w.dir = (ref & 1) === 0 ? 1 : -1;
            w.u = w.dir > 0 ? 0 : e2.len;
            const apart = this.density(e2.cx, e2.cz, 1);
            w.off = e2.foot ? (this.rng.next() - 0.5) * Math.min(1.2, e2.width * 0.6) : e2.width / 2 + (apart > 0.3 ? 2.4 : 1.4) + this.rng.next() * 1.2;
          }
        }
        const e3 = net.edges[w.edge];
        net.pos(e3, 1, clamp(w.u, 0, e3.len), w.off * w.side, _p);
        const nx = _p[0], nz = _p[1];
        const mx = nx - w.x, mz = nz - w.z;
        const ml = Math.hypot(mx, mz);
        if (ml > 0.01 && ml < 3) { w.hx = w.hx * 0.8 + (mx / ml) * 0.2; w.hz = w.hz * 0.8 + (mz / ml) * 0.2; }
        else if (ml >= 3) { w.hx = _p[2] * w.dir; w.hz = _p[3] * w.dir; }
        w.x = nx; w.z = nz;
        w.phase += h * w.speed * 5.2 / w.scale;
      }
      w.y = this.groundY(w.x, w.z);
      keep.push(w);
    }
    this.walkers = keep;
    this.draw();
  }

  private draw(): void {
    const counts = [0, 0, 0];
    const m4 = new THREE.Matrix4();
    const cam = this.ctx.camera.position;
    for (const mesh of this.meshes) mesh.visible = true;
    for (const w of this.walkers) {
      const mesh = this.meshes[w.kind];
      const i = counts[w.kind];
      if (i >= this.cap) continue;
      counts[w.kind]++;
      const hl = Math.hypot(w.hx, w.hz) || 1;
      const fx = w.hx / hl, fz = w.hz / hl;
      const s = w.scale;
      // basis: x = right (fz, 0, -fx), y = up, z = forward
      m4.set(fz * s, 0, fx * s, w.x, 0, s, 0, w.y, -fx * s, 0, fz * s, w.z, 0, 0, 0, 1);
      mesh.setMatrixAt(i, m4);
      const g = mesh.geometry;
      const c1 = g.getAttribute('iColor') as THREE.InstancedBufferAttribute;
      const c2 = g.getAttribute('iColor2') as THREE.InstancedBufferAttribute;
      const dd = g.getAttribute('iData') as THREE.InstancedBufferAttribute;
      c1.setXYZ(i, w.top.r, w.top.g, w.top.b);
      c2.setXYZ(i, w.bottom.r, w.bottom.g, w.bottom.b);
      const far = Math.hypot(w.x - cam.x, w.z - cam.z) > 150;
      dd.setXYZW(i, w.phase, w.demo ? 1 : w.idle ? 0 : far ? 0.6 : 1, 0, w.seed);
    }
    this.meshes.forEach((mesh, k) => {
      mesh.count = counts[k];
      mesh.visible = counts[k] > 0;
      mesh.instanceMatrix.needsUpdate = true;
      for (const a of ['iColor', 'iColor2', 'iData']) (mesh.geometry.getAttribute(a) as THREE.InstancedBufferAttribute).needsUpdate = true;
    });
  }

  get count(): number { return this.walkers.length; }

  /** debug: a row of figures (walking in place) facing +z towards heading */
  showcase(x: number, z: number, heading: number, n = 9): void {
    const h = (heading * Math.PI) / 180;
    for (let k = 0; k < n; k++) {
      const w = this.makeWalker(-1, 1, 0, 0, true, x + (k - (n - 1) / 2) * 1.2, z);
      w.kind = k % 3;
      w.hx = Math.sin(h); w.hz = -Math.cos(h);
      w.demo = true;
      w.phase = k * 0.7;
      this.walkers.push(w);
    }
  }
}
