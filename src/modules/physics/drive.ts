// Drive mode: spawns (or re-enters) the player's car on the nearest road, maps keyboard / touch
// input to the car, and runs a smooth chase camera with collision avoidance (plus a far chase and
// a cockpit and a bonnet camera, V to cycle).
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { getHeadingPitch, type Controller } from '../../core/controls';
import { G, groups, type PhysicsSystem } from './system';
import { Car } from './car';
import type { WalkController } from './walk';

const CAMS = [
  { dist: 5.4, height: 1.25, pitch: 11 },
  { dist: 9.0, height: 2.1, pitch: 13 },
  { dist: 0, height: 0, pitch: 0 }, // cockpit (driver's eyes)
  { dist: 0, height: 0, pitch: 0 }, // bonnet
];
/** driver's eye in the car frame (+x = left / driver side, +z forward) and the bonnet camera */
const EYE_COCKPIT = new THREE.Vector3(0.36, 1.2, -0.22);
const EYE_BONNET = new THREE.Vector3(0, 1.13, 0.98);

export class DriveController implements Controller {
  readonly name = 'drive';
  car: Car | null = null;
  camMode = 0;
  readonly analog = { x: 0, y: 0 };
  private throttle = 0;
  private brake = 0;
  private active = false;
  private camYaw = 0;
  private camPitchOff = 0;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private orbitIdle = 0;
  private camPos = new THREE.Vector3();
  private camInit = false;
  private savedFov = 55;
  private prevKeys = new Set<string>();
  private hoodQ = new THREE.Quaternion();

  constructor(private sys: PhysicsSystem, private ctx: AppContext, private walk: WalkController) {}

  get isActive(): boolean { return this.active; }

  enter(ctx: AppContext): void {
    const cam = ctx.camera;
    const hp = getHeadingPitch(cam);
    // where is "the player"? (walker feet if we came from walking, else the camera)
    const px = this.walk.isActive ? this.walk.pos.x : cam.position.x;
    const pz = this.walk.isActive ? this.walk.pos.z : cam.position.z;
    let reuse = false;
    if (this.car) {
      const d = Math.hypot(this.car.pos.x - px, this.car.pos.z - pz);
      reuse = d < 60 && this.car.up.y > 0.5;
    }
    if (!reuse) this.spawn(px, pz, hp.heading, cam.position.y);
    const car = this.car!;
    car.driven = true;
    car.body.wakeUp();
    this.active = true;
    this.throttle = this.brake = 0;
    this.camYaw = car.yaw;
    this.orbitYaw = this.orbitPitch = 0;
    this.camInit = false;
    this.savedFov = cam.fov;
    if (document.pointerLockElement) document.exitPointerLock();
    this.writeCamera(ctx, 0);
  }

  exit(ctx: AppContext): void {
    this.active = false;
    const car = this.car;
    if (car) {
      car.driven = false;
      car.input.throttle = car.input.brake = car.input.steer = 0;
      // the driver gets out on the left (driver's) side
      const door = new THREE.Vector3(1.35, 0.4, 0.15).applyQuaternion(car.quat).add(car.pos);
      const f = car.forward;
      this.walk.spawnHint = { x: door.x, y: door.y, z: door.z, heading: (THREE.MathUtils.radToDeg(Math.atan2(f.x, -f.z)) + 360) % 360 };
    }
    const cam = ctx.camera;
    cam.fov = this.savedFov || 55;
    cam.updateProjectionMatrix();
    this.analog.x = this.analog.y = 0;
  }

  /** Spawn the car on the nearest drivable road to (x, z), facing roughly `headingDeg`. */
  spawn(x: number, z: number, headingDeg: number, camY?: number): void {
    const ctx = this.ctx, sys = this.sys;
    const h = THREE.MathUtils.degToRad(headingDeg);
    const cfx = Math.sin(h), cfz = -Math.cos(h);
    const roads = ctx.get<any>('roads');
    let px = x, pz = z, py = NaN, fx = cfx, fz = cfz;
    const place = (qx: number, qz: number): boolean => {
      let n: RoadPick | null = null;
      try { n = pickRoad(roads, qx, qz, 400); } catch (e) { console.warn('[physics] road pick failed', e); }
      if (!n) return false;
      let dx = n.dirX, dz = n.dirZ;
      if (dx * fx + dz * fz < 0) { dx = -dx; dz = -dz; }
      const e = roads.graph?.edges?.[n.edge];
      const oneway = !!e?.oneway;
      if (oneway && e && (e.dir === 1 || e.dir === -1)) {
        // one-way: face the allowed direction (dir +1: along the edge's point order)
        dx = n.dirX * e.dir; dz = n.dirZ * e.dir;
      }
      const off = oneway ? 0 : Math.min(2.2, Math.max(0, n.width / 4));
      // keep right
      px = n.x - dz * off; pz = n.z + dx * off;
      py = n.y;
      fx = dx; fz = dz;
      return true;
    };
    let ok = place(x, z);
    const yaw0 = () => Math.atan2(fx, fz);
    sys.ensureNow(px, pz, 120, 70);
    const ground = () => (Number.isFinite(py) ? Math.max(py + 0.09, sys.groundAt(px, pz)) : sys.groundAt(px, pz));
    const free = () => sys.boxFree(px, ground() + 0.85, pz, 0.9, 0.6, 2.3, yaw0(), groups(G.CAR, G.STATIC | G.PLAYER));
    if (ok && !free()) {
      ok = false;
      const bx = px, bz = pz, bfx = fx, bfz = fz;
      for (const k of [8, -8, 16, -16, 25, -25, 40, -40, 60, -60, 90, -90]) {
        fx = bfx; fz = bfz;
        if (place(bx + bfx * k, bz + bfz * k)) {
          sys.ensureNow(px, pz, 60, 40);
          if (free()) { ok = true; break; }
        }
      }
      if (!ok) { px = bx; pz = bz; fx = bfx; fz = bfz; }
    }
    if (!roads) {
      // no roads module: spawn where the camera looks down, facing the camera heading
      py = camY !== undefined && camY - sys.groundAt(x, z) < 30 ? sys.surfaceBelow(x, camY + 0.5, z) : sys.groundAt(x, z);
    }
    const y = ground() + 0.18;
    const yaw = yaw0();
    if (this.car) this.car.teleport(px, y, pz, yaw);
    else this.car = new Car(sys, ctx, px, y, pz, yaw);
    // settle onto the suspension (deterministic, also for screenshots)
    this.car.driven = false;
    sys.simulate(0.6);
  }

  /** Put the car back on its wheels on the nearest road. */
  reset(): void {
    const car = this.car;
    if (!car) return;
    const f = car.forward;
    const hd = THREE.MathUtils.radToDeg(Math.atan2(f.x, -f.z));
    this.spawn(car.pos.x, car.pos.z, hd);
    car.driven = this.active;
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number, ctx: AppContext): void {
    const car = this.car;
    if (!car) return;
    const inp = ctx.input;
    const { dx, dy, wheel } = inp.consume();
    const pressed = (code: string) => inp.keys.has(code) && !this.prevKeys.has(code);
    if (pressed('KeyV')) { this.camMode = (this.camMode + 1) % CAMS.length; this.camInit = false; }
    if (pressed('KeyR')) this.reset();
    this.prevKeys = new Set(inp.keys);
    if (wheel && this.camMode < 2) CAMS[this.camMode].dist = THREE.MathUtils.clamp(CAMS[this.camMode].dist * Math.pow(1.12, wheel), 3.5, 25);
    // mouse orbit around the car
    if (inp.buttons & 1 || inp.buttons & 2 || document.pointerLockElement) {
      if (dx || dy) {
        this.orbitYaw -= dx * 0.005;
        this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + dy * 0.004, -0.2, 1.1);
        this.orbitIdle = 0;
      }
    }
    this.orbitIdle += dt;
    if (this.orbitIdle > 1.6 && Math.abs(car.speed) > 1) {
      const k = 1 - Math.exp(-dt * 2.5);
      this.orbitYaw -= this.orbitYaw * k;
      this.orbitPitch -= this.orbitPitch * k;
    }
    // driving input (keyboard + analog)
    let t = inp.down('KeyW', 'ArrowUp') ? 1 : 0;
    let b = inp.down('KeyS', 'ArrowDown') ? 1 : 0;
    let s = (inp.down('KeyD', 'ArrowRight') ? 1 : 0) - (inp.down('KeyA', 'ArrowLeft') ? 1 : 0);
    if (this.analog.y > 0.05) t = Math.max(t, this.analog.y);
    if (this.analog.y < -0.05) b = Math.max(b, -this.analog.y);
    if (Math.abs(this.analog.x) > 0.05) s = THREE.MathUtils.clamp(s + this.analog.x, -1, 1);
    this.throttle += (t - this.throttle) * Math.min(1, dt * (t > this.throttle ? 5 : 10));
    this.brake += (b - this.brake) * Math.min(1, dt * (b > this.brake ? 8 : 12));
    car.input.throttle = this.throttle;
    car.input.brake = this.brake;
    car.input.steer = s;
    car.input.handbrake = inp.down('Space');
    this.sys.update(dt);
    this.writeCamera(ctx, dt);
  }

  private tmp = new THREE.Vector3();

  syncCamera(ctx: AppContext, dt: number): void { if (this.car) this.writeCamera(ctx, dt); }

  private writeCamera(ctx: AppContext, dt: number): void {
    const car = this.car!;
    car.render(this.sys.alpha);
    const cam = ctx.camera;
    const root = car.model.root;
    const p = root.position;
    const cfg = CAMS[this.camMode];
    const kmh = car.speedKmh;
    if (this.camMode >= 2) {
      // cockpit / bonnet camera: rigidly attached, with softened pitch/roll (head stabilisation)
      const cockpit = this.camMode === 2;
      const local = this.tmp.copy(cockpit ? EYE_COCKPIT : EYE_BONNET);
      if (cockpit) {
        // follow the cosmetic body roll / pitch so the cabin does not slide around the eye
        const b = car.model.body;
        local.applyEuler(b.rotation).add(b.position);
      }
      const eye = local.applyQuaternion(root.quaternion).add(p);
      cam.position.copy(eye);
      const target = root.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      if (!this.camInit || dt === 0) this.hoodQ.copy(target); else this.hoodQ.slerp(target, 1 - Math.exp(-dt * (cockpit ? 10 : 14)));
      // mouse look (head turn) in the cockpit
      const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(cockpit ? -5 : -4) - (cockpit ? this.orbitPitch * 0.8 : 0),
        cockpit ? THREE.MathUtils.clamp(this.orbitYaw, -1.9, 1.9) : 0, 0, 'YXZ'));
      cam.quaternion.copy(this.hoodQ).multiply(look);
      this.camInit = true;
      const fov = (cockpit ? 68 : 66) + Math.min(1, kmh / 160) * (cockpit ? 5 : 8);
      if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = fov; cam.updateProjectionMatrix(); }
      return;
    }
    // chase camera
    const f = car.forward;
    let yawT = Math.atan2(f.x, f.z);
    // follow the direction of travel when sliding forwards
    const lv = car.body.linvel();
    const hs = Math.hypot(lv.x, lv.z);
    if (hs > 4 && car.speed > 0) {
      const vy = Math.atan2(lv.x, lv.z);
      yawT = yawT + wrap(vy - yawT) * 0.35;
    }
    if (!this.camInit || dt === 0) this.camYaw = yawT;
    else this.camYaw += wrap(yawT - this.camYaw) * (1 - Math.exp(-dt * 3.2));
    const yaw = this.camYaw + this.orbitYaw;
    const pitch = THREE.MathUtils.degToRad(cfg.pitch) + this.orbitPitch;
    const pivot = new THREE.Vector3(p.x, p.y + 1.15, p.z);
    const dist = cfg.dist * (1 + Math.min(1, kmh / 140) * 0.12);
    const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch) + cfg.height / dist * 0.35, -Math.cos(yaw) * Math.cos(pitch)).normalize();
    // collision avoidance: pull in in front of walls / trees
    let d = dist;
    const hit = this.sys.raycast(pivot, dir, dist + 0.4, groups(G.ALL, G.STATIC), car.body);
    if (hit && hit.kind !== 'heightfield') d = Math.max(1.2, Math.min(d, hit.distance - 0.35));
    const want = pivot.clone().addScaledVector(dir, d);
    const g = this.sys.groundAt(want.x, want.z);
    if (want.y < g + 0.45) want.y = g + 0.45;
    if (!this.camInit || dt === 0) this.camPos.copy(want);
    else this.camPos.lerp(want, 1 - Math.exp(-dt * 14));
    this.camInit = true;
    cam.position.copy(this.camPos);
    const look = new THREE.Vector3(p.x + Math.sin(this.camYaw) * 1.6, p.y + 0.95, p.z + Math.cos(this.camYaw) * 1.6);
    cam.up.set(0, 1, 0);
    cam.lookAt(look);
    const fov = 60 + Math.min(1, kmh / 150) * 9;
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }
}

/** Extra "distance" (m) added per road class when choosing where to put the car. */
const CLASS_PENALTY: Record<string, number> = {
  motorway: 0, trunk: 0, primary: 0, secondary: 0, tertiary: 0, residential: 0, unclassified: 5, living_street: 10,
  service: 45, track: 80,
};

export interface RoadPick { x: number; z: number; dirX: number; dirZ: number; width: number; edge: number; y: number; cls: string; dist: number }

/**
 * Nearest point on a drivable road, preferring real streets over parking aisles / driveways
 * (service) and dirt tracks, and avoiding the ends of edges (junction interiors).
 * Falls back to roads.nearest() when the graph is not available.
 */
export function pickRoad(roads: any, x: number, z: number, maxDist = 400): RoadPick | null {
  const edges: any[] | undefined = roads?.graph?.edges;
  if (!edges || !edges.length) {
    const n = roads?.nearest?.(x, z, maxDist);
    return n ? { x: n.x, z: n.z, dirX: n.dirX, dirZ: n.dirZ, width: n.width, edge: n.edge ?? -1, y: n.y, cls: n.cls, dist: n.dist ?? 0 } : null;
  }
  let best: RoadPick | null = null, bestScore = Infinity;
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const pen = CLASS_PENALTY[e.cls];
    if (pen === undefined || e.tunnel) continue;
    const p: Float32Array = e.points;
    const np = p.length >> 1;
    if (np < 2) continue;
    // quick reject by the edge's first point (edges are short: split at every connector)
    if (Math.abs(p[0] - x) > maxDist + 1500 || Math.abs(p[1] - z) > maxDist + 1500) continue;
    let total = 0;
    for (let k = 0; k < np - 1; k++) total += Math.hypot(p[k * 2 + 2] - p[k * 2], p[k * 2 + 3] - p[k * 2 + 1]);
    if (total < 12) continue; // junction stubs
    let acc = 0;
    for (let k = 0; k < np - 1; k++) {
      const ax = p[k * 2], az = p[k * 2 + 1], bx = p[k * 2 + 2], bz = p[k * 2 + 3];
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz;
      const L = Math.sqrt(L2);
      if (L < 1e-3) continue;
      let t = ((x - ax) * dx + (z - az) * dz) / L2;
      // keep 6 m away from the edge ends (junctions), when the edge is long enough
      const s0 = Math.min(6, total / 2 - 0.5);
      const tMin = (s0 - acc) / L, tMax = (total - s0 - acc) / L;
      t = Math.max(t, 0, tMin);
      t = Math.min(t, 1, tMax);
      if (t < 0 || t > 1) { acc += L; continue; }
      const qx = ax + dx * t, qz = az + dz * t;
      const d = Math.hypot(qx - x, qz - z);
      const score = d + pen + (e.link ? 10 : 0);
      if (d <= maxDist && score < bestScore) {
        bestScore = score;
        const y = e.y && e.y.length === np ? e.y[k] + (e.y[k + 1] - e.y[k]) * t : NaN;
        best = { x: qx, z: qz, dirX: dx / L, dirZ: dz / L, width: e.width, edge: ei, y, cls: e.cls, dist: d };
      }
      acc += L;
    }
  }
  return best;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
