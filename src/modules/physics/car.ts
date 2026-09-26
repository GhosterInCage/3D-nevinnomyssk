// The player's car: Rapier dynamic chassis + DynamicRayCastVehicleController with a simple but
// physically grounded drivetrain (VAZ-21126 1.6 16V torque curve, 5-speed gearbox with automatic
// shifting, FWD, aero drag, rolling resistance, engine braking), front-biased brakes, handbrake,
// speed-sensitive steering, anti-roll bars, a mild yaw-stability assist, water drag/buoyancy,
// flip recovery, render interpolation and tyre skid marks.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { AppContext } from '../../core/context';
import { G, groups, type PhysicsSystem, type RigidBody, type Interest } from './system';
import { buildCarModel, CAR_COLORS, type CarModel } from './carModel';
import { DIM } from './carShape';
import { SkidMarks } from './skid';

const MASS = 1150;
const HARD_Y = 0.52;
const REST = 0.30;
const GEARS = [-3.53, 0, 3.636, 1.95, 1.357, 0.941, 0.784]; // R, N, 1..5
const FINAL = 3.7;
const EFF = 0.9;
const IDLE = 850, REDLINE = 6200;
const TORQUE: Array<[number, number]> = [[0, 80], [800, 95], [1500, 118], [2500, 134], [3500, 142], [4000, 145], [5000, 141], [5600, 134], [6200, 118], [6600, 0]];

function torqueAt(rpm: number): number {
  for (let i = 0; i < TORQUE.length - 1; i++) {
    const [r0, t0] = TORQUE[i], [r1, t1] = TORQUE[i + 1];
    if (rpm <= r1) return t0 + (t1 - t0) * Math.max(0, (rpm - r0) / (r1 - r0));
  }
  return 0;
}

export interface CarInput { throttle: number; brake: number; steer: number; handbrake: boolean }

export class Car {
  readonly body: RigidBody;
  readonly vehicle: RAPIER_NS.DynamicRayCastVehicleController;
  readonly model: CarModel;
  readonly input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** -1 reverse, 0 neutral, 1..5 */
  gear = 1;
  rpm = IDLE;
  speed = 0;            // m/s along the car's forward axis
  steer = 0;            // current road-wheel angle (rad)
  braking = 0;
  reversing = false;
  lights = false;
  driven = false;       // someone is at the wheel
  /** max tyre slip of the last step (0..1), for audio / effects */
  slip = 0;
  /** effective throttle after the reverse logic (0..1) */
  throttleOut = 0;
  /** strongest collision jolt since last read (m/s of velocity change in one step) */
  impact = 0;
  private lastLin = new THREE.Vector3();
  private shiftTimer = 0;
  private reverseHold = 0;
  private upsideDown = 0;
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  private wheelPrev: number[] = [0, 0, 0, 0];
  private wheelCur: number[] = [0, 0, 0, 0];
  private suspPrev: number[] = [REST, REST, REST, REST];
  private suspCur: number[] = [REST, REST, REST, REST];
  private steerPrev = 0;
  private waterSvc: any = null;
  readonly skids: SkidMarks;
  private unsub: Array<() => void> = [];
  submerged = 0;
  /** filtered accelerations in the car frame (m/s^2): x = left, z = forward -> cosmetic body roll/pitch */
  private accL = 0;
  private accF = 0;
  private lastVel = new THREE.Vector3();
  private rollPrev = 0; private rollCur = 0; private pitchPrev = 0; private pitchCur = 0;
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpV2 = new THREE.Vector3();

  constructor(private sys: PhysicsSystem, private ctx: AppContext, x: number, y: number, z: number, yaw: number) {
    const R = sys.R;
    const w = sys.world;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setCanSleep(true)
      .setCcdEnabled(true)
      .setLinearDamping(0)
      .setAngularDamping(0.2)
      .setAdditionalMassProperties(MASS, { x: 0, y: 0.45, z: 0.3 }, { x: 2000, y: 2080, z: 460 }, { x: 0, y: 0, z: 0, w: 1 });
    this.body = w.createRigidBody(desc);
    const cg = groups(G.CAR, G.STATIC | G.PLAYER | G.TOY | G.CAR);
    const lower = w.createCollider(R.ColliderDesc.roundCuboid(0.78, 0.2, 2.05, 0.06).setTranslation(0, 0.52, 0).setDensity(0).setFriction(0.35).setRestitution(0.15).setCollisionGroups(cg), this.body);
    const cabin = w.createCollider(R.ColliderDesc.roundCuboid(0.58, 0.18, 0.95, 0.06).setTranslation(0, 1.12, -0.35).setDensity(0).setFriction(0.35).setRestitution(0.15).setCollisionGroups(cg), this.body);
    sys.kinds.set(lower.handle, 'car');
    sys.kinds.set(cabin.handle, 'car');

    const v = w.createVehicleController(this.body);
    v.indexUpAxis = 1;
    v.setIndexForwardAxis = 2;
    const wp: Array<[number, number]> = [[DIM.trackF / 2, DIM.frontAxle], [-DIM.trackF / 2, DIM.frontAxle], [DIM.trackR / 2, DIM.rearAxle], [-DIM.trackR / 2, DIM.rearAxle]];
    wp.forEach(([wx, wz], i) => {
      v.addWheel({ x: wx, y: HARD_Y, z: wz }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, REST, DIM.tyreR);
      v.setWheelSuspensionStiffness(i, 30);
      v.setWheelSuspensionCompression(i, 2.4);
      v.setWheelSuspensionRelaxation(i, 3.1);
      v.setWheelMaxSuspensionTravel(i, 0.2);
      v.setWheelMaxSuspensionForce(i, 40000);
      v.setWheelFrictionSlip(i, i < 2 ? 1.08 : 1.2);
      v.setWheelSideFrictionStiffness(i, 1.0);
    });
    this.vehicle = v;

    this.model = buildCarModel(ctx, CAR_COLORS[ctx.settings.params.get('carcolor') ?? ''] ?? ctx.settings.params.get('carcolor')?.replace(/^(?=[0-9a-f]{6}$)/i, '#') ?? CAR_COLORS.cherry);
    ctx.scene.add(this.model.root);
    ctx.scene.add(this.model.shadow);
    this.skids = new SkidMarks(ctx);

    this.readState();
    this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat);
    this.unsub.push(sys.onPreStep((dt) => this.preStep(dt)));
    this.unsub.push(sys.onPostStep((dt) => this.postStep(dt)));
    this.unsub.push(sys.addInterest((out: Interest[]) => {
      if (this.driven) {
        const lv = this.body.linvel();
        const s = Math.hypot(lv.x, lv.z);
        // look ahead along the velocity so the world is ready before we get there
        const ax = this.pos.x + lv.x * 1.5, az = this.pos.z + lv.z * 1.5;
        out.push({ x: ax, z: az, terrainR: 150 + s * 3, staticR: 110 + s * 3 });
      } else if (!this.body.isSleeping()) {
        out.push({ x: this.pos.x, z: this.pos.z, terrainR: 40, staticR: 30 });
      } else {
        out.push({ x: this.pos.x, z: this.pos.z, terrainR: 12, staticR: 0 });
      }
    }));
    this.waterSvc = ctx.get('water') ?? null;
  }

  private readState(): void {
    const t = this.body.translation(), r = this.body.rotation();
    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
  }

  get forward(): THREE.Vector3 { return new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat); }
  get up(): THREE.Vector3 { return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat); }
  get speedKmh(): number { return Math.abs(this.speed) * 3.6; }

  /** Place the car at (x, y, z) facing yaw (rad about +y, 0 = +z), at rest. */
  teleport(x: number, y: number, z: number, yaw: number): void {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.readState();
    this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat);
    this.gear = 1; this.rpm = IDLE; this.steer = 0; this.upsideDown = 0;
    this.lastLin.set(0, 0, 0); this.impact = 0; this.slip = 0;
    this.skids.breakAll();
  }

  /** Yaw of the car (rad about +y; 0 = facing +z / south). */
  get yaw(): number {
    const f = this.forward;
    return Math.atan2(f.x, f.z);
  }

  // ------------------------------------------------------------------ simulation
  private preStep(dt: number): void {
    const v = this.vehicle, body = this.body;
    const inp = this.driven ? this.input : { throttle: 0, brake: 0, steer: 0, handbrake: true };
    if (this.driven && body.isSleeping()) body.wakeUp();
    if (body.isSleeping()) return;
    this.speed = v.currentVehicleSpeed();
    const sp = this.speed, asp = Math.abs(sp);

    // --- gear selection (automatic) + reverse logic
    let throttle = inp.throttle, brake = inp.brake;
    if (this.gear >= 1) {
      if (brake > 0.1 && asp < 0.8 && inp.throttle < 0.1) {
        this.reverseHold += dt;
        if (this.reverseHold > 0.25) { this.gear = -1; this.reverseHold = 0; }
      } else this.reverseHold = 0;
    } else if (this.gear === -1) {
      // in reverse: S drives backwards, W brakes / selects first
      const t = throttle; throttle = brake; brake = t;
      if (brake > 0.1 && asp < 0.8) { this.gear = 1; brake = 0; throttle = inp.throttle; }
    }
    this.reversing = this.gear === -1 && throttle > 0.05;
    this.braking = brake;
    this.throttleOut = throttle;

    // --- engine
    const ratio = GEARS[this.gear + 1] ?? 0;
    const wheelRpm = (asp / DIM.tyreR) * (60 / (2 * Math.PI));
    let rpm = Math.abs(wheelRpm * ratio * FINAL);
    // clutch slip at launch keeps the engine in its torque band
    const launch = IDLE + throttle * 2600;
    if (rpm < launch && (this.gear === 1 || this.gear === -1)) rpm = rpm + (launch - rpm) * Math.min(1, 1 - asp / 9);
    rpm = Math.max(IDLE, rpm);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.gear >= 1 && this.shiftTimer === 0) {
      const up = throttle > 0.6 ? 5900 : 3000 + 2400 * throttle;
      if (rpm > up && this.gear < 5) { this.gear++; this.shiftTimer = 0.28; }
      else if (this.gear > 1 && rpm < (throttle > 0.6 ? 2600 : 1500)) { this.gear--; this.shiftTimer = 0.2; }
    }
    this.rpm += (Math.min(rpm, REDLINE + 150) - this.rpm) * Math.min(1, dt * 12);
    let drive = 0;
    if (ratio !== 0 && this.shiftTimer === 0 && this.submerged < 0.7) {
      const tq = rpm > REDLINE ? 0 : torqueAt(rpm);
      drive = tq * ratio * FINAL * EFF / DIM.tyreR * throttle; // total at the contact patches (signed by ratio)
    }
    // engine braking when off throttle
    const engineBrake = throttle < 0.05 && ratio !== 0 ? 260 + 0.06 * rpm : 0;

    // --- brakes (N), front biased; handbrake on the rear
    const BRAKE = MASS * 9.2;
    const bf = brake * BRAKE * 0.33, br = brake * BRAKE * 0.17;
    const hb = inp.handbrake ? 2600 : 0;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      v.setWheelEngineForce(i, front ? drive / 2 : 0);
      let b = front ? bf : br + hb;
      if (front) b += engineBrake / 2;
      // parked: hold firmly
      if (!this.driven) b = 4000;
      v.setWheelBrake(i, b * dt);
      v.setWheelSideFrictionStiffness(i, !front && inp.handbrake && asp > 3 ? 0.45 : 1.0);
    }

    // --- steering: speed sensitive, rate limited
    // limit the lock to what the tyres can hold (~1 g of lateral demand), so keyboard steering
    // at speed understeers gently instead of spinning the car
    const maxSteer = Math.min(0.6 / (1 + asp / 30), Math.atan((DIM.wheelbase * 10.5) / Math.max(1, asp * asp)));
    const target = -inp.steer * maxSteer; // +steer input = right; positive wheel angle = left
    const back = target === 0 || Math.abs(target) < Math.abs(this.steer);
    const rate = back ? 3.0 : 2.4 / (1 + asp / 12);
    this.steer += THREE.MathUtils.clamp(target - this.steer, -rate * dt, rate * dt);
    v.setWheelSteering(0, this.steer);
    v.setWheelSteering(1, this.steer);

    v.updateVehicle(dt, this.sys.R.QueryFilterFlags.EXCLUDE_SENSORS, groups(G.CAR, G.STATIC), (c) => c.parent()?.handle !== body.handle);

    // --- anti-roll bars, aero drag, rolling resistance, stability assist
    const lv = body.linvel();
    const vel = this.tmpV.set(lv.x, lv.y, lv.z);
    const spd = vel.length();
    const rot = body.rotation();
    const q = this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    const upW = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    for (const [a, b, k] of [[0, 1, 17000], [2, 3, 11000]] as Array<[number, number, number]>) {
      if (!v.wheelIsInContact(a) && !v.wheelIsInContact(b)) continue;
      const la = v.wheelSuspensionLength(a) ?? REST, lb = v.wheelSuspensionLength(b) ?? REST;
      const f = (la - lb) * k * dt; // positive: wheel a is more extended -> push a side down, b side up
      const pa = v.wheelHardPoint(a), pb = v.wheelHardPoint(b);
      if (pa && pb) {
        body.applyImpulseAtPoint({ x: -upW.x * f, y: -upW.y * f, z: -upW.z * f }, pa, true);
        body.applyImpulseAtPoint({ x: upW.x * f, y: upW.y * f, z: upW.z * f }, pb, true);
      }
    }
    if (spd > 0.05) {
      const drag = 0.41 * spd * spd + (this.grounded() ? 0.013 * MASS * 9.81 : 0) * Math.min(1, spd);
      const s = -drag * dt / spd;
      body.applyImpulse({ x: vel.x * s, y: vel.y * s, z: vel.z * s }, true);
      // light downforce keeps it planted over crests
      const df = 0.25 * spd * spd * dt;
      body.applyImpulse({ x: -upW.x * df, y: -upW.y * df, z: -upW.z * df }, true);
    }
    const av = body.angvel();
    const yawRate = av.x * upW.x + av.y * upW.y + av.z * upW.z;
    if (this.grounded() && asp > 4 && !inp.handbrake) {
      const expected = (sp * Math.tan(this.steer)) / DIM.wheelbase;
      const err = yawRate - expected;
      const tq = -err * 3800 * dt;
      body.applyTorqueImpulse({ x: upW.x * tq, y: upW.y * tq, z: upW.z * tq }, true);
    }

    // --- water: buoyancy + heavy drag
    this.submerged = 0;
    const w = this.waterSvc ?? (this.waterSvc = this.ctx.get('water') ?? null);
    if (w) {
      let lvl: number | null = null;
      try { lvl = w.levelAt(this.pos.x, this.pos.z); } catch { lvl = null; }
      if (lvl !== null) {
        const depth = lvl - (this.pos.y + 0.25);
        if (depth > 0) {
          this.submerged = Math.min(1.2, depth);
          const bu = Math.min(1.0, depth / 1.1) * MASS * 9.81 * 0.85 * dt;
          body.applyImpulse({ x: 0, y: bu, z: 0 }, true);
          const k = Math.min(1, 1.6 * dt * Math.min(1, depth));
          body.applyImpulse({ x: -vel.x * MASS * k, y: -vel.y * MASS * k * 0.5, z: -vel.z * MASS * k }, true);
        }
      }
    }
  }

  private grounded(): boolean {
    const v = this.vehicle;
    return v.wheelIsInContact(0) || v.wheelIsInContact(1) || v.wheelIsInContact(2) || v.wheelIsInContact(3);
  }

  private postStep(dt: number): void {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.readState();
    {
      const lv = this.body.linvel();
      const dv = Math.hypot(lv.x - this.lastLin.x, lv.y - this.lastLin.y, lv.z - this.lastLin.z);
      this.lastLin.set(lv.x, lv.y, lv.z);
      if (dv > 1.2) this.impact = Math.max(this.impact, dv);
    }
    const v = this.vehicle;
    for (let i = 0; i < 4; i++) {
      this.wheelPrev[i] = this.wheelCur[i];
      this.wheelCur[i] = v.wheelRotation(i) ?? 0;
      this.suspPrev[i] = this.suspCur[i];
      this.suspCur[i] = v.wheelSuspensionLength(i) ?? REST;
    }
    this.steerPrev = this.steer;
    // cosmetic body roll / dive / squat from the chassis acceleration (the rigid raycast model
    // barely rolls): ~2 deg per g of lateral and ~1.2 deg per g of longitudinal acceleration
    {
      const lv = this.body.linvel();
      const ax = (lv.x - this.lastVel.x) / dt, az = (lv.z - this.lastVel.z) / dt;
      this.lastVel.set(lv.x, lv.y, lv.z);
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat);
      const l = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat);
      const k = 1 - Math.exp(-dt * 6);
      this.accL += (THREE.MathUtils.clamp(ax * l.x + az * l.z, -15, 15) - this.accL) * k;
      this.accF += (THREE.MathUtils.clamp(ax * f.x + az * f.z, -15, 15) - this.accF) * k;
      this.rollPrev = this.rollCur; this.pitchPrev = this.pitchCur;
      this.rollCur = this.grounded() ? this.accL * 0.0036 : this.rollCur * 0.95;
      this.pitchCur = this.grounded() ? -this.accF * 0.0021 : this.pitchCur * 0.95;
    }
    // flip recovery
    const upY = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat).y;
    if (upY < 0.3 && Math.abs(this.speed) < 2) this.upsideDown += dt; else this.upsideDown = 0;
    if (this.upsideDown > 2.5) {
      const yaw = this.yaw;
      this.teleport(this.pos.x, this.sys.surfaceBelow(this.pos.x, this.pos.y + 3, this.pos.z) + 0.6, this.pos.z, yaw);
    }
    // fell through the world (tile not streamed / tunnelled)
    const g = this.sys.groundAt(this.pos.x, this.pos.z);
    if (this.pos.y < g - 3) this.teleport(this.pos.x, g + 0.8, this.pos.z, this.yaw);
    // skid marks
    if (this.driven || !this.body.isSleeping()) this.emitSkids();
  }

  private emitSkids(): void {
    const v = this.vehicle, body = this.body;
    let maxSlip = 0;
    const lv = body.linvel(), av = body.angvel();
    const com = body.translation();
    const inp = this.input;
    for (let i = 0; i < 4; i++) {
      if (!v.wheelIsInContact(i)) { this.skids.lift(i); continue; }
      const cp = v.wheelContactPoint(i);
      if (!cp) { this.skids.lift(i); continue; }
      // contact point velocity
      const rx = cp.x - com.x, ry = cp.y - com.y, rz = cp.z - com.z;
      const vx = lv.x + (av.y * rz - av.z * ry), vz = lv.z + (av.x * ry - av.y * rx);
      // wheel axes in world
      const steer = i < 2 ? this.steer : 0;
      const f = new THREE.Vector3(Math.sin(steer), 0, Math.cos(steer)).applyQuaternion(this.quat);
      const side = Math.abs(vx * f.z - vz * f.x);
      const along = Math.abs(vx * f.x + vz * f.z);
      let slip = THREE.MathUtils.smoothstep(side, 1.6, 4.5);
      if (this.driven) {
        if (inp.brake > 0.85 && along > 6 && this.gear >= 1) slip = Math.max(slip, 0.55);
        if (i >= 2 && inp.handbrake && along > 2) slip = Math.max(slip, 0.8);
        if (i < 2 && inp.throttle > 0.9 && this.gear === 1 && along < 7) slip = Math.max(slip, 0.5 * (1 - along / 7));
      }
      if (slip > maxSlip) maxSlip = slip;
      const n = v.wheelContactNormal(i);
      if (slip > 0.15) this.skids.add(i, cp.x, cp.y, cp.z, n ? n.x : 0, n ? n.y : 1, n ? n.z : 0, f.x, f.z, slip);
      else this.skids.lift(i);
    }
    this.slip = maxSlip;
  }

  // ------------------------------------------------------------------ rendering
  /** Write interpolated transforms to the model (call once per frame). */
  render(alpha: number): void {
    const m = this.model;
    const p = this.tmpV.copy(this.prevPos).lerp(this.pos, alpha);
    const q = this.tmpQ.copy(this.prevQuat).slerp(this.quat, alpha);
    m.root.position.copy(p);
    m.root.quaternion.copy(q);
    const steer = this.steerPrev + (this.steer - this.steerPrev) * alpha;
    {
      const roll = this.rollPrev + (this.rollCur - this.rollPrev) * alpha;
      const pitch = this.pitchPrev + (this.pitchCur - this.pitchPrev) * alpha;
      const b = m.body;
      b.rotation.set(pitch, 0, roll, 'XYZ');
      // rotate about a pivot near the roll centre
      const pv = this.tmpV2.set(0, 0.35, 0.2);
      const rp = pv.clone().applyEuler(b.rotation);
      b.position.set(pv.x - rp.x, pv.y - rp.y, pv.z - rp.z);
    }
    m.steeringWheel.rotation.z = -steer * 14; // ~16:1 steering ratio, a little less for readability
    for (let i = 0; i < 4; i++) {
      const w = m.wheels[i];
      const susp = this.suspPrev[i] + (this.suspCur[i] - this.suspPrev[i]) * alpha;
      w.root.position.y = HARD_Y - susp;
      w.root.rotation.y = i < 2 ? steer : 0;
      const rot = this.wheelPrev[i] + (this.wheelCur[i] - this.wheelPrev[i]) * alpha;
      w.spin.rotation.x = w.side > 0 ? rot : -rot;
    }
    // contact shadow on the ground under the car
    const sh = m.shadow;
    const gy = this.sys.groundAt(p.x, p.z);
    const hgt = p.y - gy;
    sh.visible = hgt < 3;
    if (sh.visible) {
      sh.position.set(p.x, gy + 0.03, p.z);
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      sh.rotation.set(0, Math.atan2(f.x, f.z), 0);
      (sh.material as THREE.MeshBasicMaterial).opacity = 0.5 * Math.max(0, 1 - hgt / 3) * (1 - 0.6 * this.ctx.env.night);
    }
    const env = this.ctx.env;
    const lowBeam = this.driven ? (env.night > 0.25 || env.fog > 0.4 || env.rain > 0.3 || this.lights) : false;
    m.setLights(env.night, this.driven ? this.braking : 0, this.reversing, lowBeam);
    this.skids.update();
  }

  setVisible(v: boolean): void {
    this.model.root.visible = v;
    this.model.shadow.visible = v && this.model.shadow.visible;
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.ctx.scene.remove(this.model.root, this.model.shadow);
    this.model.dispose();
    this.skids.dispose();
    this.sys.world.removeVehicleController(this.vehicle);
    this.sys.world.removeRigidBody(this.body);
  }
}
