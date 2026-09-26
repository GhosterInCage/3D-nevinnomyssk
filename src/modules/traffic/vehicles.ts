// Moving road traffic: a few hundred to ~1500 vehicles simulated in a radius around the camera.
// Structure-of-arrays state, IDM car following via a spatial hash look-ahead, right-hand lanes,
// Bezier connectors through junctions, traffic-signal stop lines (roads service), yielding at
// junctions, bus / marshrutka stops, distance-based update rate, recycling out of view.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { Net, C, CLS_DENSITY, CLS_ROUTE, type NetEdge } from './net';
import { type VehicleType, paletteColor } from './models';
import { FleetRenderer, basisMatrix } from './render';
import { Rng, clamp } from './util';

const HT = 8192;
const CELL = 12;

const _p = new Float64Array(5);
const _col = new THREE.Color();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const _sph = new THREE.Sphere();

/** time-of-day traffic factor (local hours) */
export function trafficFactor(h: number): number {
  const k = [0.12, 0.07, 0.05, 0.05, 0.08, 0.2, 0.5, 0.95, 1.15, 1.0, 0.9, 0.9, 0.95, 0.95, 0.9, 0.95, 1.05, 1.2, 1.15, 0.95, 0.7, 0.5, 0.35, 0.2];
  const i = Math.floor(h) % 24, f = h - Math.floor(h);
  return k[i] * (1 - f) + k[(i + 1) % 24] * f;
}

export class Vehicles {
  cap: number;
  n = 0; // high-water mark of used slots
  // --- state (SoA)
  alive: Uint8Array;
  type: Uint8Array;
  edge: Int32Array;
  dir: Int8Array;
  lane: Uint8Array;
  s: Float32Array;
  mode: Uint8Array;       // 0 lane, 1 connector
  nEdge: Int32Array;
  nDir: Int8Array;
  nLane: Uint8Array;
  bz: Float32Array;       // bezier P0..P3 (x,z) *8
  bt: Float32Array;       // bezier t
  bBridge: Int16Array;
  v: Float32Array;
  vFac: Float32Array;
  acc: Float32Array;
  x: Float32Array; y: Float32Array; z: Float32Array;
  fx: Float32Array; fz: Float32Array;
  odo: Float32Array;
  brake: Float32Array;
  wait: Float32Array;
  dwell: Float32Array;
  lastStop: Float32Array; // s of last served stop on the current edge (+ edge id)
  lastStopEdge: Int32Array;
  lat: Float32Array;      // extra lateral shift (bus stops)
  pend: Float32Array;     // accumulated dt for LOD updates
  colr: Float32Array;
  metal: Float32Array;
  dirt: Float32Array;
  mat: Float32Array;
  camD: Float32Array;
  why: Uint8Array;
  // spatial hash
  private hKey: Int32Array;
  private hStart = new Int32Array(HT + 1);
  private hIds: Int32Array;
  // spawn table
  private spawnEdges: number[] = [];
  private spawnW: number[] = [];
  private spawnTot = 0;
  private tableX = Infinity;
  private tableZ = Infinity;
  private lastCamX = Infinity;
  private lastCamZ = Infinity;
  radius = 900;
  target = 0;
  private rng = new Rng(77);
  private typeW: number[];
  private typeTransitW: number[];
  frame = 0;
  readonly renderer: FleetRenderer;
  beams: THREE.InstancedMesh | null = null;
  glow: THREE.Points | null = null;

  constructor(private ctx: AppContext, private net: Net, private types: VehicleType[], material: THREE.Material, cap: number) {
    this.cap = cap;
    this.alive = new Uint8Array(cap); this.type = new Uint8Array(cap);
    this.edge = new Int32Array(cap); this.dir = new Int8Array(cap); this.lane = new Uint8Array(cap);
    this.s = new Float32Array(cap); this.mode = new Uint8Array(cap);
    this.nEdge = new Int32Array(cap); this.nDir = new Int8Array(cap); this.nLane = new Uint8Array(cap);
    this.bz = new Float32Array(cap * 8); this.bt = new Float32Array(cap); this.bBridge = new Int16Array(cap);
    this.v = new Float32Array(cap); this.vFac = new Float32Array(cap); this.acc = new Float32Array(cap);
    this.x = new Float32Array(cap); this.y = new Float32Array(cap); this.z = new Float32Array(cap);
    this.fx = new Float32Array(cap); this.fz = new Float32Array(cap);
    this.odo = new Float32Array(cap); this.brake = new Float32Array(cap); this.wait = new Float32Array(cap);
    this.dwell = new Float32Array(cap); this.lastStop = new Float32Array(cap); this.lastStopEdge = new Int32Array(cap).fill(-1);
    this.lat = new Float32Array(cap); this.pend = new Float32Array(cap);
    this.colr = new Float32Array(cap * 3); this.metal = new Float32Array(cap); this.dirt = new Float32Array(cap);
    this.mat = new Float32Array(cap * 16); this.camD = new Float32Array(cap); this.why = new Uint8Array(cap);
    this.hKey = new Int32Array(cap); this.hIds = new Int32Array(cap);
    this.typeW = types.map((t) => t.weight);
    this.typeTransitW = types.map((t) => (t.transit ? t.weight : 0));
    const tot = this.typeW.reduce((a, b) => a + b, 0);
    const caps = types.map((t) => {
      const share = t.weight / tot;
      const c0 = Math.ceil(cap * Math.min(1, share * 3) + 24);
      return [Math.min(cap, Math.max(40, Math.ceil(c0 * 0.3))), Math.min(cap, Math.max(60, Math.ceil(c0 * 0.6))), Math.min(cap, c0)];
    });
    this.renderer = new FleetRenderer('traffic-vehicles', { lods: types.map((t) => [t.lod0, t.lod1, t.lod2]) }, material, caps);
  }

  // ------------------------------------------------------------------------------ spawning
  private rebuildTable(cx: number, cz: number): void {
    const R = this.radius;
    this.spawnEdges = [];
    this.spawnW = [];
    let tot = 0;
    let dens = 0;
    const grid = this.net.edgeGrid();
    for (const ei of grid.query(cx, cz, R)) {
      const e = this.net.edges[ei];
      if (!e.drive) continue;
      const d = Math.hypot(e.cx - cx, e.cz - cz);
      if (d > R) continue;
      const usable = e.len - e.trimA - e.trimB;
      if (usable < 6) continue;
      const nd = e.dir === 0 ? 2 : 1;
      const lanes = this.net.lanesInDir(e);
      const w = usable * CLS_DENSITY[e.cls] * nd * Math.min(2, 0.6 + 0.4 * lanes);
      if (w <= 0) continue;
      this.spawnEdges.push(ei);
      this.spawnW.push(w);
      tot += w;
      dens += w;
    }
    this.spawnTot = tot;
    this.tableX = cx; this.tableZ = cz;
    const tf = trafficFactor(this.ctx.env.hours);
    this.target = Math.min(this.cap, Math.round(dens * tf));
  }

  private freeSlot(): number {
    for (let i = 0; i < this.n; i++) if (!this.alive[i]) return i;
    if (this.n < this.cap) return this.n++;
    return -1;
  }

  private pickType(transitEdge: boolean): number {
    const r = this.rng;
    if (transitEdge && r.next() < 0.1) return r.weighted(this.typeTransitW);
    return r.weighted(this.typeW);
  }

  /** Spawn one vehicle somewhere in the table. hidden: prefer positions out of view / far. */
  private spawnOne(camX: number, camZ: number, hidden: boolean): boolean {
    if (!this.spawnEdges.length) return false;
    const i = this.freeSlot();
    if (i < 0) return false;
    const r = this.rng;
    for (let attempt = 0; attempt < 6; attempt++) {
      let k = 0;
      let u = r.next() * this.spawnTot;
      for (k = 0; k < this.spawnW.length - 1; k++) { u -= this.spawnW[k]; if (u <= 0) break; }
      const ei = this.spawnEdges[k];
      const e = this.net.edges[ei];
      const dir = e.dir !== 0 ? e.dir : (r.next() < 0.5 ? 1 : -1);
      const s0 = this.net.laneStart(e, dir), s1 = this.net.laneEnd(e, dir);
      if (s1 - s0 < 4) continue;
      const s = s0 + 2 + r.next() * Math.max(0.1, s1 - s0 - 4);
      const t = this.pickType(e.cls <= C.tertiary);
      const ty = this.types[t];
      if (ty.kind !== 'car' && e.cls >= C.living && r.next() < 0.85) continue;
      const lane = r.int(this.net.lanesInDir(e));
      this.net.pos(e, dir, s, this.net.laneOffset(e, lane), _p);
      const px = _p[0], pz = _p[1];
      const dcx = px - camX, dcz = pz - camZ;
      const dist = Math.hypot(dcx, dcz);
      if (dist > this.radius) continue;
      if (hidden && dist < this.radius * 0.55 && this.inView(px, pz, 0)) continue;
      if (this.occupied(px, pz, ty.L * 0.5 + 5)) continue;
      this.alive[i] = 1;
      this.type[i] = t;
      this.edge[i] = ei; this.dir[i] = dir; this.lane[i] = lane; this.s[i] = s; this.mode[i] = 0;
      this.vFac[i] = 0.85 + r.next() * 0.3;
      this.v[i] = Math.min(e.speed, ty.vmax) * this.vFac[i] * (0.6 + r.next() * 0.3);
      this.acc[i] = 0; this.wait[i] = 0; this.dwell[i] = 0; this.lat[i] = 0; this.brake[i] = 0;
      this.lastStopEdge[i] = -1; this.pend[i] = 0; this.fx[i] = 0; this.fz[i] = 0;
      this.odo[i] = r.next() * 100;
      const metal = paletteColor(ty.palette, r.next(), _col);
      this.colr[i * 3] = _col.r; this.colr[i * 3 + 1] = _col.g; this.colr[i * 3 + 2] = _col.b;
      this.metal[i] = metal;
      this.dirt[i] = clamp(ty.dirt * (0.4 + r.next() * 0.9), 0, 1);
      this.planNext(i);
      this.place(i, true);
      return true;
    }
    return false;
  }

  private occupied(x: number, z: number, rad: number): boolean {
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const dx = this.x[i] - x, dz = this.z[i] - z;
      if (dx * dx + dz * dz < rad * rad) return true;
    }
    return false;
  }

  private inView(x: number, z: number, y: number): boolean {
    _sph.center.set(x, y || this.ctx.camera.position.y - 20, z);
    _sph.radius = 12;
    return _frustum.intersectsSphere(_sph);
  }

  private kill(i: number): void {
    this.alive[i] = 0;
    while (this.n > 0 && !this.alive[this.n - 1]) this.n--;
  }

  // ------------------------------------------------------------------------------ routing
  /** choose the next edge/dir/lane at the end of the current lane */
  private planNext(i: number): void {
    const net = this.net;
    const e = net.edges[this.edge[i]];
    const dir = this.dir[i];
    const node = net.endNode(e, dir);
    const [inX, inZ] = net.outDir(this.edge[i], dir > 0 ? 1 : 0); // leaving the node backwards along e
    const ix = -inX, iz = -inZ; // arrival direction
    const ty = this.types[this.type[i]];
    let tot = 0;
    const opts: Array<[number, number, number, number]> = []; // edge, dir, weight, turn(sign)
    for (let pass = 0; pass < 2 && !opts.length; pass++) for (let k = net.incStart[node]; k < net.incStart[node + 1]; k++) {
      const ref = net.inc[k];
      const ei = ref >> 1, end = ref & 1;
      if (ei === this.edge[i]) continue;
      const e2 = net.edges[ei];
      if (!e2.drive) continue;
      const d2 = end === 0 ? 1 : -1;
      // second pass: ignore one-way restrictions rather than getting stuck (broken dual carriageways)
      if (pass === 0 && !net.allowed(e2, d2)) continue;
      if (net.laneEnd(e2, d2) - net.laneStart(e2, d2) < 1) continue;
      const [ox, oz] = net.outDir(ei, end);
      const dot = ix * ox + iz * oz;
      const cross = ix * oz - iz * ox; // >0 = right turn (x east, z south)
      let w = CLS_ROUTE[e2.cls];
      if (ty.kind !== 'car' && e2.cls >= C.residential) w *= 0.25;
      if (ty.transit && e2.cls >= C.living) w *= 0.1;
      w *= dot > 0.8 ? 1.4 : dot > -0.2 ? 0.55 : 0.08;
      if (w <= 0) continue;
      opts.push([ei, d2, w, cross]);
      tot += w;
    }
    if (!opts.length) {
      // dead end: U-turn on the same edge (turning around at the end of the street)
      if (net.laneEnd(e, -dir) - net.laneStart(e, -dir) > 1) {
        this.nEdge[i] = this.edge[i]; this.nDir[i] = -dir as -1 | 1; this.nLane[i] = 0;
      } else {
        this.nEdge[i] = -1;
      }
      return;
    }
    let u = this.rng.next() * tot, pick = opts[0];
    for (const o of opts) { u -= o[2]; if (u <= 0) { pick = o; break; } }
    const e2 = net.edges[pick[0]];
    const nl = net.lanesInDir(e2);
    let lane = Math.min(this.lane[i], nl - 1);
    if (pick[3] > 0.5) lane = 0; else if (pick[3] < -0.5) lane = nl - 1;
    this.nEdge[i] = pick[0]; this.nDir[i] = pick[1]; this.nLane[i] = lane;
  }

  /** Build the junction connector from the current lane end to the planned next lane start. */
  private enterConnector(i: number): boolean {
    const net = this.net;
    const ne = this.nEdge[i];
    if (ne < 0) return false;
    const e = net.edges[this.edge[i]], e2 = net.edges[ne];
    const dir = this.dir[i], d2 = this.nDir[i];
    const off0 = net.laneOffset(e, this.lane[i]), off1 = net.laneOffset(e2, this.nLane[i]);
    net.pos(e, dir, net.laneEnd(e, dir), off0, _p);
    const x0 = _p[0], z0 = _p[1], t0x = _p[2], t0z = _p[3];
    net.pos(e2, d2, net.laneStart(e2, d2), off1, _p);
    const x3 = _p[0], z3 = _p[1], t1x = _p[2], t1z = _p[3];
    const d = Math.hypot(x3 - x0, z3 - z0);
    const uturn = t0x * t1x + t0z * t1z < -0.8;
    const k = uturn ? Math.max(3.5, d * 0.8) : Math.max(0.5, d * 0.42);
    const b = this.bz, o = i * 8;
    b[o] = x0; b[o + 1] = z0;
    b[o + 2] = x0 + t0x * k; b[o + 3] = z0 + t0z * k;
    b[o + 4] = x3 - t1x * k; b[o + 5] = z3 - t1z * k;
    b[o + 6] = x3; b[o + 7] = z3;
    this.bt[i] = 0;
    this.bBridge[i] = e.bridge === e2.bridge ? e.bridge : -1;
    this.mode[i] = 1;
    return true;
  }

  private bez(i: number, t: number, out: Float64Array): void {
    const b = this.bz, o = i * 8;
    const u = 1 - t;
    const a0 = u * u * u, a1 = 3 * u * u * t, a2 = 3 * u * t * t, a3 = t * t * t;
    out[0] = a0 * b[o] + a1 * b[o + 2] + a2 * b[o + 4] + a3 * b[o + 6];
    out[1] = a0 * b[o + 1] + a1 * b[o + 3] + a2 * b[o + 5] + a3 * b[o + 7];
    const d0 = 3 * u * u, d1 = 6 * u * t, d2 = 3 * t * t;
    const dx = d0 * (b[o + 2] - b[o]) + d1 * (b[o + 4] - b[o + 2]) + d2 * (b[o + 6] - b[o + 4]);
    const dz = d0 * (b[o + 3] - b[o + 1]) + d1 * (b[o + 5] - b[o + 3]) + d2 * (b[o + 7] - b[o + 5]);
    const l = Math.hypot(dx, dz);
    out[2] = dx / (l || 1); out[3] = dz / (l || 1);
    // speed of the parameterisation (m per unit t)
    out[4] = l;
  }

  /** remaining straight-line length of the connector (approx) */
  private connLen(i: number): number {
    const b = this.bz, o = i * 8;
    return Math.hypot(b[o + 2] - b[o], b[o + 3] - b[o + 1]) + Math.hypot(b[o + 4] - b[o + 2], b[o + 5] - b[o + 3]) + Math.hypot(b[o + 6] - b[o + 4], b[o + 7] - b[o + 5]);
  }

  // ------------------------------------------------------------------------------ simulation
  private buildHash(): void {
    const cnt = this.hStart;
    cnt.fill(0);
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) { this.hKey[i] = -1; continue; }
      const h = hashCell(Math.floor(this.x[i] / CELL), Math.floor(this.z[i] / CELL));
      this.hKey[i] = h;
      cnt[h + 1]++;
    }
    for (let k = 0; k < HT; k++) cnt[k + 1] += cnt[k];
    const fill = new Int32Array(HT);
    for (let i = 0; i < this.n; i++) {
      const h = this.hKey[i];
      if (h < 0) continue;
      this.hIds[cnt[h] + fill[h]++] = i;
    }
  }

  /** Nearest obstacle ahead: returns gap (m) and its speed along our direction. */
  private leader(i: number, out: { gap: number; v: number; cross: boolean; j: number }): void {
    const x = this.x[i], z = this.z[i], fx = this.fx[i], fz = this.fz[i];
    const vi = this.v[i];
    const Li = this.types[this.type[i]].L;
    const D = clamp(8 + vi * 2.4, 12, 50);
    const cx = x + fx * D * 0.5, cz = z + fz * D * 0.5;
    const R = D * 0.5 + 4;
    out.gap = Infinity; out.v = 0; out.cross = false; out.j = -1;
    const inConn = this.mode[i] === 1;
    const aggressive = this.wait[i] > 7;
    const gx0 = Math.floor((cx - R) / CELL), gx1 = Math.floor((cx + R) / CELL);
    const gz0 = Math.floor((cz - R) / CELL), gz1 = Math.floor((cz + R) / CELL);
    const myCls = this.net.edges[this.edge[i]].cls;
    if (this.player) {
      // the player (walking / driving camera) is an obstacle
      const rx = this.px - x, rz = this.pz - z;
      const along = rx * fx + rz * fz;
      if (along > 0.3 && along < D + 4 && Math.abs(rx * fz - rz * fx) < 1.9) {
        out.gap = along - Li * 0.5 - 1.2; out.v = 0; out.cross = false;
      }
    }
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const h = hashCell(gx, gz);
        for (let k = this.hStart[h]; k < this.hStart[h + 1]; k++) {
          const j = this.hIds[k];
          if (j === i) continue;
          const rx = this.x[j] - x, rz = this.z[j] - z;
          const along = rx * fx + rz * fz;
          if (along <= 0.3 || along > D + 8) continue;
          const lat = Math.abs(rx * fz - rz * fx);
          const hd = fx * this.fx[j] + fz * this.fz[j];
          const Lj = this.types[this.type[j]].L;
          if (hd > 0.55) {
            if (lat > 1.5 + along * 0.035) continue;
            // merging streams: if I am (at least as far) ahead in j's frame, j follows me, not vice versa
            const back = -(rx * this.fx[j] + rz * this.fz[j]);
            if (back > 0.3 && (back > along || (Math.abs(back - along) < 0.05 && i < j))) continue;
            const gap = along - (Li + Lj) * 0.5;
            if (gap < out.gap) { out.gap = gap; out.v = this.v[j] * hd; out.cross = false; out.j = j; }
          } else if (hd > -0.55) {
            // crossing traffic near a junction
            if (lat > 3.2 || along > 18) continue;
            if (aggressive) continue;
            const jConn = this.mode[j] === 1;
            let yieldTo: boolean;
            if (inConn && !jConn) yieldTo = false;
            else if (!inConn && jConn) yieldTo = true;
            else if (inConn && jConn) yieldTo = this.bt[j] > this.bt[i] || (this.bt[j] === this.bt[i] && j < i);
            else {
              const jCls = this.net.edges[this.edge[j]].cls;
              if (jCls !== myCls) yieldTo = jCls < myCls; // lower class id = more important road
              else yieldTo = rx * -fz + rz * fx > 0; // priority to the right
            }
            if (!yieldTo) continue;
            const gap = along - Li * 0.5 - 2.0;
            if (gap < out.gap) { out.gap = gap; out.v = 0; out.cross = true; out.j = j; }
          }
        }
      }
    }
  }

  private readonly lead = { gap: Infinity, v: 0, cross: false, j: -1 };
  private player = false;
  private px = 0;
  private pz = 0;

  private step(i: number, dt: number, t: number): void {
    const net = this.net;
    const ty = this.types[this.type[i]];
    const e = net.edges[this.edge[i]];
    const dir = this.dir[i];
    let vDes = Math.min(e.speed * this.vFac[i], ty.vmax);
    let v = this.v[i];
    // obstacles
    this.leader(i, this.lead);
    let gap = this.lead.gap, vl = this.lead.v;
    let why = gap < Infinity ? (this.lead.cross ? 2 : 1) : 0;
    if (this.mode[i] === 0) {
      const end = net.laneEnd(e, dir);
      const dEnd = end - this.s[i];
      // turn speed for the upcoming connector
      const ne = this.nEdge[i];
      if (ne >= 0 && dEnd < 60) {
        const [ax, az] = net.outDir(this.edge[i], dir > 0 ? 1 : 0);
        const e2 = net.edges[ne];
        const [bx, bz] = net.outDir(ne, this.nDir[i] > 0 ? 0 : 1);
        const dot = -(ax * bx + az * bz);
        const vTurn = dot > 0.9 ? 30 : dot > 0.5 ? 9 : dot > -0.3 ? 5.5 : 3;
        vDes = Math.min(vDes, Math.sqrt(vTurn * vTurn + 2 * 2.0 * Math.max(0, dEnd - 3)));
        // signal at the end of this lane
        const ref = this.edge[i] * 2 + (dir > 0 ? 1 : 0);
        if (net.signals.size && net.signalRed(ref, t, dEnd - ty.L * 0.5, v)) {
          const g = dEnd - ty.L * 0.5 - 0.3;
          if (g < gap) { gap = g; vl = 0; why = 3; }
        }
        // minor road entering a major one: slow down at the give-way line
        if (e2.cls < e.cls - 1 && e.cls >= C.residential && dot < 0.9) vDes = Math.min(vDes, Math.sqrt(9 + 2 * 1.5 * Math.max(0, dEnd - 2)));
      } else if (ne < 0) {
        const g = dEnd - ty.L * 0.5;
        if (g < gap) { gap = g; vl = 0; why = 4; }
      }
      // bus stops
      if (ty.transit && e.stops) {
        for (let k = 0; k < e.stops.length; k += 2) {
          const sAB = e.stops[k], side = e.stops[k + 1];
          if (side !== dir) continue; // stop must be on the right of travel
          const sT = dir > 0 ? sAB : e.len - sAB;
          const dS = sT - this.s[i];
          if (this.lastStopEdge[i] === this.edge[i] && Math.abs(this.lastStop[i] - sT) < 1) continue;
          if (dS > -3 && dS < 70) {
            if (this.dwell[i] > 0) { gap = Math.min(gap, 0); vl = 0; break; }
            if (dS < 25) this.lat[i] = Math.min(1, this.lat[i] + dt * 0.6);
            if (dS < 1.5 && v < 0.6) {
              this.dwell[i] = 8 + this.rng.next() * 18;
              this.lastStopEdge[i] = this.edge[i]; this.lastStop[i] = sT;
            } else if (dS + 2 < gap) { gap = dS + 2.0; vl = 0; why = 5; }
            break;
          }
        }
      }
    }
    if (this.dwell[i] > 0) {
      this.dwell[i] -= dt;
      gap = 0; vl = 0; v = 0;
      if (this.dwell[i] <= 0) this.dwell[i] = 0;
    } else if (this.lat[i] > 0 && (this.lastStopEdge[i] === this.edge[i] || this.mode[i] === 1)) {
      this.lat[i] = Math.max(0, this.lat[i] - dt * 0.35);
    }
    // IDM
    const a = ty.accel, b = 2.4, T = 1.25, s0 = 2.0;
    let accel = a * (1 - Math.pow(v / Math.max(0.5, vDes), 4));
    if (gap < Infinity) {
      const sStar = s0 + Math.max(0, v * T + (v * (v - vl)) / (2 * Math.sqrt(a * b)));
      accel -= a * (sStar / Math.max(0.2, gap)) ** 2;
    }
    accel = clamp(accel, -9, a);
    v = Math.max(0, v + accel * dt);
    if (gap < 0.3 && vl < 0.5) v = Math.min(v, Math.max(0, gap) * 0.5);
    this.v[i] = v;
    this.acc[i] = accel;
    this.brake[i] = accel < -0.8 || v < 0.3 ? 1 : 0;
    this.wait[i] = v < 0.4 && this.dwell[i] <= 0 ? this.wait[i] + dt : Math.max(0, this.wait[i] - dt * 2);
    this.why[i] = why;
    const ds = v * dt;
    this.odo[i] += ds;
    // advance along lane / connector
    let rem = ds;
    for (let guard = 0; guard < 4 && rem > 0; guard++) {
      if (this.mode[i] === 0) {
        const cur = net.edges[this.edge[i]];
        const end = net.laneEnd(cur, this.dir[i]);
        const ns = this.s[i] + rem;
        if (ns < end) { this.s[i] = ns; rem = 0; break; }
        rem = ns - end;
        this.s[i] = end;
        if (!this.enterConnector(i)) {
          this.v[i] = 0; rem = 0;
          if (this.camD[i] > 80 || !this.inView(this.x[i], this.z[i], this.y[i])) this.kill(i);
          return;
        }
      } else {
        this.bez(i, this.bt[i], _p);
        const sp = Math.max(0.2, _p[4]);
        const nt = this.bt[i] + rem / sp;
        if (nt < 1) { this.bt[i] = nt; rem = 0; break; }
        // arrive at the next lane
        const used = (1 - this.bt[i]) * sp;
        rem = Math.max(0, rem - used);
        this.edge[i] = this.nEdge[i]; this.dir[i] = this.nDir[i]; this.lane[i] = this.nLane[i];
        const e2 = net.edges[this.edge[i]];
        this.s[i] = net.laneStart(e2, this.dir[i]);
        this.mode[i] = 0;
        this.planNext(i);
      }
    }
  }

  /** compute position/orientation/matrix; full = with pitch from axle heights */
  private place(i: number, full: boolean): void {
    const net = this.net;
    const ty = this.types[this.type[i]];
    let bridge: number;
    if (this.mode[i] === 0) {
      const e = net.edges[this.edge[i]];
      const off = net.laneOffset(e, this.lane[i]) + this.lat[i] * Math.max(0, e.width * 0.5 - ty.W * 0.5 - 0.35 - net.laneOffset(e, this.lane[i]));
      net.pos(e, this.dir[i], this.s[i], off, _p);
      bridge = e.bridge;
    } else {
      this.bez(i, this.bt[i], _p);
      bridge = this.bBridge[i];
    }
    const x = _p[0], z = _p[1];
    let fx = _p[2], fz = _p[3];
    // smooth heading changes a bit
    if (this.fx[i] !== 0 || this.fz[i] !== 0) {
      fx = this.fx[i] * 0.35 + fx * 0.65; fz = this.fz[i] * 0.35 + fz * 0.65;
      const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
    }
    this.x[i] = x; this.z[i] = z; this.fx[i] = fx; this.fz[i] = fz;
    const hw = ty.wb * 0.5;
    let y: number, fy = 0;
    if (full) {
      const yf = net.surfaceY(x + fx * hw, z + fz * hw, bridge);
      const yr = net.surfaceY(x - fx * hw, z - fz * hw, bridge);
      y = (yf + yr) * 0.5;
      fy = (yf - yr) / Math.max(1, ty.wb);
    } else {
      y = net.surfaceY(x, z, bridge);
    }
    this.y[i] = y;
    basisMatrix(this.mat, i * 16, x, y, z, fx, fy, fz);
  }

  // ------------------------------------------------------------------------------ frame
  update(dt: number): void {
    const ctx = this.ctx;
    const cam = ctx.camera.position;
    this.frame++;
    _pm.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const agl = Math.max(0, ctx.cameraAGL);
    const q = ctx.settings.quality;
    const baseR = q === 'low' ? 600 : q === 'medium' ? 850 : 1100;
    this.radius = clamp(baseR + agl * 2.2, baseR, baseR * 2.2);
    const jump = Math.hypot(cam.x - this.lastCamX, cam.z - this.lastCamZ);
    const teleport = jump > 250;
    this.lastCamX = cam.x; this.lastCamZ = cam.z;
    if (teleport) {
      for (let i = 0; i < this.n; i++) this.alive[i] = 0;
      this.n = 0;
    }
    if (teleport || Math.hypot(cam.x - this.tableX, cam.z - this.tableZ) > this.radius * 0.2 || this.frame % 300 === 0) this.rebuildTable(cam.x, cam.z);
    // population control
    let alive = 0;
    for (let i = 0; i < this.n; i++) alive += this.alive[i];
    if (alive < this.target) {
      const k = teleport || alive === 0 ? this.target - alive : Math.min(8, this.target - alive);
      for (let j = 0; j < k; j++) this.spawnOne(cam.x, cam.z, !(teleport || alive === 0));
    }
    // recycle far vehicles
    const R2 = (this.radius * 1.12) ** 2;
    let over = alive - Math.round(this.target * 1.1);
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const dx = this.x[i] - cam.x, dz = this.z[i] - cam.z;
      const d2 = dx * dx + dz * dz;
      this.camD[i] = Math.sqrt(d2);
      if (d2 > R2 || (over > 0 && d2 > (this.radius * 0.7) ** 2 && !this.inView(this.x[i], this.z[i], this.y[i]))) {
        this.kill(i); over--;
      } else if (this.wait[i] > 40 && this.camD[i] > 120 && !this.inView(this.x[i], this.z[i], this.y[i])) {
        this.kill(i);
      }
    }
    this.buildHash();
    this.player = ctx.controller?.name !== 'fly' && agl < 4;
    this.px = cam.x; this.pz = cam.z;
    const t = ctx.env.elapsed;
    const h = Math.min(dt, 0.1);
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const d = this.camD[i];
      const every = d < 180 ? 1 : d < 450 ? 2 : 4;
      this.pend[i] += h;
      if ((this.frame + i) % every !== 0 && !teleport) continue;
      let sdt = this.pend[i];
      this.pend[i] = 0;
      // sub-step long intervals for stability
      while (sdt > 0 && this.alive[i]) {
        const st = Math.min(sdt, 0.12);
        this.step(i, st, t);
        sdt -= st;
      }
      if (this.alive[i]) this.place(i, d < 350);
    }
    this.draw();
  }

  private draw(): void {
    const R = this.renderer;
    const q = this.ctx.settings.quality;
    const lod0 = q === 'low' ? 55 : q === 'medium' ? 90 : 120;
    const lod1 = q === 'low' ? 160 : q === 'medium' ? 260 : 340;
    R.begin();
    let nb = 0;
    const beams = this.beams;
    const night = this.ctx.env.night;
    const barr = beams ? (beams.instanceMatrix.array as Float32Array) : null;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const d = this.camD[i];
      _sph.center.set(this.x[i], this.y[i] + 1.5, this.z[i]);
      _sph.radius = 8;
      if (!_frustum.intersectsSphere(_sph) && d > 30) continue;
      const ty = this.types[this.type[i]];
      const lod = d < lod0 ? 0 : d < lod1 ? 1 : 2;
      const ang = this.odo[i] / ty.r;
      R.push(this.type[i], lod, this.mat, i * 16, this.colr[i * 3], this.colr[i * 3 + 1], this.colr[i * 3 + 2], ang % (Math.PI * 2), this.brake[i], this.metal[i], this.dirt[i]);
      if (barr && night > 0.05 && d < 320 && nb < beams!.instanceMatrix.count) {
        // beam quad: car matrix translated to the front bumper
        const m = this.mat, o = i * 16, b = nb * 16;
        for (let k = 0; k < 12; k++) barr[b + k] = m[o + k];
        const zf = ty.lod0.boundingBox ? ty.lod0.boundingBox.max.z - 0.1 : ty.L * 0.5;
        barr[b + 12] = m[o + 12] + m[o + 8] * zf;
        barr[b + 13] = m[o + 13] + m[o + 9] * zf + 0.05;
        barr[b + 14] = m[o + 14] + m[o + 10] * zf;
        barr[b + 15] = 1;
        const ib = beams!.geometry.getAttribute('iBeam') as THREE.InstancedBufferAttribute;
        (ib.array as Float32Array)[nb * 4] = clamp(1.4 - d / 260, 0, 1) * (ty.kind === 'car' ? 1 : 1.3);
        nb++;
      }
    }
    R.end();
    // glow sprites (night): 2 head + 2 tail lamps per vehicle beyond ~25 m
    const glow = this.glow;
    if (glow) {
      let ng = 0;
      if (night > 0.05) {
        const pa = glow.geometry.getAttribute('position') as THREE.BufferAttribute;
        const ca = glow.geometry.getAttribute('color') as THREE.BufferAttribute;
        const P = pa.array as Float32Array, Cc = ca.array as Float32Array;
        const capG = P.length / 3;
        for (let i = 0; i < this.n && ng + 4 <= capG; i++) {
          if (!this.alive[i] || this.camD[i] < 22) continue;
          const ty = this.types[this.type[i]];
          const bb = ty.lod0.boundingBox!;
          const m = this.mat, o = i * 16;
          const hy = ty.kind === 'car' ? 0.68 : 0.8, ty0 = ty.kind === 'car' ? 0.8 : 0.9;
          const hx = ty.W * 0.36;
          for (const [lz, ly, br, rr, gg, bl] of [[bb.max.z + 0.05, hy, 1, 1.0, 0.9, 0.75], [bb.min.z - 0.05, ty0, 1, 0.9, 0.03, 0.01]] as const) {
            const k = lz > 0 ? 1.0 : 0.45 + this.brake[i] * 0.8;
            for (const sx of [-hx, hx]) {
              P[ng * 3] = m[o] * sx + m[o + 4] * ly + m[o + 8] * lz + m[o + 12];
              P[ng * 3 + 1] = m[o + 1] * sx + m[o + 5] * ly + m[o + 9] * lz + m[o + 13];
              P[ng * 3 + 2] = m[o + 2] * sx + m[o + 6] * ly + m[o + 10] * lz + m[o + 14];
              Cc[ng * 3] = rr * k * br; Cc[ng * 3 + 1] = gg * k * br; Cc[ng * 3 + 2] = bl * k * br;
              ng++;
            }
          }
        }
        pa.clearUpdateRanges(); pa.addUpdateRange(0, ng * 3); pa.needsUpdate = true;
        ca.clearUpdateRanges(); ca.addUpdateRange(0, ng * 3); ca.needsUpdate = true;
      }
      glow.geometry.setDrawRange(0, ng);
      glow.visible = ng > 0;
    }
    if (beams) {
      beams.count = nb;
      beams.visible = nb > 0;
      if (nb) {
        beams.instanceMatrix.clearUpdateRanges(); beams.instanceMatrix.addUpdateRange(0, nb * 16); beams.instanceMatrix.needsUpdate = true;
        const ib = beams.geometry.getAttribute('iBeam') as THREE.InstancedBufferAttribute;
        ib.clearUpdateRanges(); ib.addUpdateRange(0, nb * 4); ib.needsUpdate = true;
      }
    }
  }

  /** debug statistics */
  stats(): Record<string, number> {
    let alive = 0, stopped = 0, stuck = 0, conn = 0, dwell = 0;
    const why = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      alive++;
      if (this.v[i] < 0.3) stopped++;
      if (this.wait[i] > 75) { stuck++; why[this.why[i]]++; }
      if (this.mode[i] === 1) conn++;
      if (this.dwell[i] > 0) dwell++;
    }
    return { alive, target: this.target, stopped, stuck, inJunction: conn, atBusStop: dwell, drawn: this.renderer.count, radius: Math.round(this.radius),
      stuckFree: why[0], stuckFollow: why[1], stuckCross: why[2], stuckSignal: why[3], stuckEnd: why[4], stuckStop: why[5] };
  }

  /** debug: stuck vehicles with their blocking leader */
  stuckList(minWait = 75): string {
    const out: string[] = [];
    const L = { gap: 0, v: 0, cross: false, j: -1 };
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i] || this.wait[i] < minWait) continue;
      this.leader(i, L);
      out.push(`#${i} ${this.types[this.type[i]].name.slice(0, 8)} at ${this.x[i].toFixed(1)},${this.z[i].toFixed(1)} f ${this.fx[i].toFixed(2)},${this.fz[i].toFixed(2)} m${this.mode[i]} e${this.edge[i]}/${this.dir[i]} cls${this.net.edges[this.edge[i]].cls} s${this.s[i].toFixed(1)}/${this.net.laneEnd(this.net.edges[this.edge[i]], this.dir[i]).toFixed(1)} t${this.bt[i].toFixed(2)} why${this.why[i]} lead ${L.j} gap ${L.gap.toFixed(1)} ${L.cross ? 'X' : ''}`);
    }
    return out.join('\n');
  }

  get aliveCount(): number {
    let a = 0;
    for (let i = 0; i < this.n; i++) a += this.alive[i];
    return a;
  }

  /** nearest vehicle info (for the UI / debugging) */
  nearest(x: number, z: number): { type: string; speed: number; x: number; z: number } | null {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const d = Math.hypot(this.x[i] - x, this.z[i] - z);
      if (d < bd) { bd = d; best = i; }
    }
    return best < 0 ? null : { type: this.types[this.type[best]].name, speed: this.v[best] * 3.6, x: this.x[best], z: this.z[best] };
  }

  edgeOf(i: number): NetEdge { return this.net.edges[this.edge[i]]; }
}

function hashCell(ix: number, iz: number): number {
  return ((Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) >>> 0) & (HT - 1);
}

/** Beam (headlight pool) geometry: trapezoid in the car frame starting at the front bumper. */
export function beamGeometry(cap: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const len = 14;
  const P = [-1.0, 0, 0, 1.0, 0, 0, 4.2, 0, len, -4.2, 0, len];
  const U = [0, 0, 1, 0, 1, 1, 0, 1];
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  const ib = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  ib.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('iBeam', ib);
  return g;
}
