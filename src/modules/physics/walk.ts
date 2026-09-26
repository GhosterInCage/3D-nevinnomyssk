// First-person walking: Rapier kinematic capsule + KinematicCharacterController (autostep for
// curbs and stairs, slope limits, snap-to-ground), gravity, jumping, sprinting, swimming in
// rivers/ponds (water service), pointer-lock mouse look, head bob and landing dip.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { AppContext } from '../../core/context';
import { getHeadingPitch, applyHeadingPitch, type Controller } from '../../core/controls';
import { G, groups, type PhysicsSystem, type RigidBody, type Collider, type Interest } from './system';

const RADIUS = 0.3;
const HALF = 0.6;          // capsule half height of the cylinder part -> total 1.8 m
const EYE = 1.7;           // eye height above the feet
const WALK = 2.2;          // m/s (brisk walk)
const SPRINT = 6.5;        // m/s
const SWIM = 1.3;
const JUMP_V = 4.6;        // ~1.05 m jump
const GRAVITY = 9.81;

export interface TouchInput { x: number; y: number }

export class WalkController implements Controller {
  readonly name = 'walk';
  heading = 0;
  pitch = 0;
  /** external analog input (touch joystick), -1..1, y forward */
  readonly analog: TouchInput = { x: 0, y: 0 };
  private jumpQueued = false;
  private prevSpace = false;
  body: RigidBody | null = null;
  collider: Collider | null = null;
  private kcc: RAPIER_NS.KinematicCharacterController | null = null;
  /** feet position (current step) and previous step, for interpolation */
  readonly pos = new THREE.Vector3();
  private prev = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  grounded = false;
  swimming = false;
  sprinting = false;
  crouch = 0;
  private active = false;
  private unsubPre: (() => void) | null = null;
  private unsubPost: (() => void) | null = null;
  private bobPhase = 0;
  private bobAmp = 0;
  private dip = 0;
  private dipV = 0;
  private eyeY = NaN;
  private savedFov = 55;
  private waterSvc: any = null;
  private airTime = 0;
  private lastFall = 0;
  sensitivity = 0.11;
  /** called on every footfall (surface probe position = feet) */
  onFootstep: ((x: number, y: number, z: number, swimming: boolean, strength: number) => void) | null = null;
  /** set by drive when the player gets out of the car: spawn here instead of at the camera */
  spawnHint: { x: number; y: number; z: number; heading: number } | null = null;

  constructor(private sys: PhysicsSystem) {
    sys.addInterest((out: Interest[]) => {
      if (this.active) out.push({ x: this.pos.x, z: this.pos.z, terrainR: 110, staticR: 75 });
    });
  }

  private ensureBody(): void {
    if (this.body) return;
    const R = this.sys.R;
    const w = this.sys.world;
    this.body = w.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -1000, 0));
    this.collider = w.createCollider(
      R.ColliderDesc.capsule(HALF, RADIUS).setCollisionGroups(groups(G.PLAYER, G.STATIC | G.CAR | G.TOY)).setFriction(0.0),
      this.body,
    );
    this.sys.kinds.set(this.collider.handle, 'player');
    const k = w.createCharacterController(0.02);
    k.setUp({ x: 0, y: 1, z: 0 });
    k.setSlideEnabled(true);
    k.enableAutostep(0.42, 0.22, false);
    k.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(50));
    k.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(42));
    k.enableSnapToGround(0.45);
    k.setApplyImpulsesToDynamicBodies(true);
    k.setCharacterMass(80);
    this.kcc = k;
    this.body.setEnabled(false);
  }

  enter(ctx: AppContext): void {
    this.ensureBody();
    this.waterSvc = ctx.get('water') ?? null;
    const cam = ctx.camera;
    const hp = getHeadingPitch(cam);
    this.heading = hp.heading;
    this.pitch = THREE.MathUtils.clamp(hp.pitch, -35, 35);
    if (Math.abs(hp.pitch) > 50) this.pitch = -4;
    let x = cam.position.x, z = cam.position.z, yHint = cam.position.y;
    if (this.spawnHint) {
      x = this.spawnHint.x; z = this.spawnHint.z; yHint = this.spawnHint.y;
      this.heading = this.spawnHint.heading;
      this.pitch = -3;
      this.spawnHint = null;
    }
    this.placeAt(x, z, yHint);
    this.savedFov = cam.fov;
    cam.fov = 70;
    cam.updateProjectionMatrix();
    this.active = true;
    this.body!.setEnabled(true);
    if (!this.unsubPre) this.unsubPre = this.sys.onPreStep((dt) => this.step(dt));
    if (!this.unsubPost) this.unsubPost = this.sys.onPostStep(() => { /* nothing: pos tracked in step */ });
    this.eyeY = NaN;
    this.writeCamera(ctx, 0);
  }

  exit(ctx: AppContext): void {
    this.active = false;
    this.unsubPre?.(); this.unsubPre = null;
    this.unsubPost?.(); this.unsubPost = null;
    if (this.body) {
      this.body.setNextKinematicTranslation({ x: 0, y: -1000, z: 0 });
      this.body.setTranslation({ x: 0, y: -1000, z: 0 }, false);
      this.body.setEnabled(false);
    }
    const cam = ctx.camera;
    cam.fov = this.savedFov || 55;
    cam.updateProjectionMatrix();
    this.analog.x = this.analog.y = 0;
  }

  get isActive(): boolean { return this.active; }

  /** Teleport the walker to (x, z) (ground level, nearest free spot). */
  placeAt(x: number, z: number, yHint?: number): void {
    const sys = this.sys;
    sys.ensureNow(x, z, 70, 45);
    const ground = sys.groundAt(x, z);
    let feet = ground;
    if (yHint !== undefined && yHint - ground < 30) {
      // at street level (or on a bridge deck / roof right under the camera) keep that surface
      feet = sys.surfaceBelow(x, yHint + 0.3, z, 60);
      if (feet < ground - 0.5) feet = ground;
    }
    const spot = this.findFree(x, feet, z);
    this.pos.set(spot[0], spot[1], spot[2]);
    this.prev.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.grounded = true;
    this.body?.setTranslation({ x: this.pos.x, y: this.pos.y + RADIUS + HALF, z: this.pos.z }, true);
    this.body?.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + RADIUS + HALF, z: this.pos.z });
  }

  private findFree(x: number, feet: number, z: number): [number, number, number] {
    const sys = this.sys;
    const water = this.waterSvc;
    const ok = (px: number, py: number, pz: number) => {
      if (!sys.capsuleFree(px, py + 0.02, pz, RADIUS, HALF)) return false;
      if (water) {
        try { const l = water.levelAt(px, pz); if (l !== null && l - py > 1.0) return false; } catch { /* ignore */ }
      }
      return true;
    };
    if (ok(x, feet, z)) return [x, feet, z];
    for (let r = 1.5; r <= 60; r += 1.5) {
      const n = Math.max(8, Math.round(r * 2.5));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        const py = sys.groundAt(px, pz);
        if (Math.abs(py - feet) > 6 && r < 40) continue;
        if (ok(px, py, pz)) return [px, py, pz];
      }
    }
    return [x, sys.groundAt(x, z), z];
  }

  // ------------------------------------------------------------------ input
  jump(): void { this.jumpQueued = true; }
  look(dx: number, dy: number): void {
    this.heading = (this.heading + dx * this.sensitivity + 360) % 360;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * this.sensitivity, -85, 85);
  }

  private readInput(ctx: AppContext): { fx: number; fz: number; sprint: boolean; crouch: boolean } {
    const inp = ctx.input;
    let f = 0, s = 0;
    if (inp.down('KeyW', 'ArrowUp')) f += 1;
    if (inp.down('KeyS', 'ArrowDown')) f -= 1;
    if (inp.down('KeyD', 'ArrowRight')) s += 1;
    if (inp.down('KeyA', 'ArrowLeft')) s -= 1;
    f += this.analog.y; s += this.analog.x;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    const h = THREE.MathUtils.degToRad(this.heading);
    const fwx = Math.sin(h), fwz = -Math.cos(h);
    const rx = -fwz, rz = fwx;
    const space = inp.down('Space');
    if (space && !this.prevSpace) this.jumpQueued = true;
    this.prevSpace = space;
    return { fx: fwx * f + rx * s, fz: fwz * f + rz * s, sprint: inp.down('ShiftLeft', 'ShiftRight'), crouch: inp.down('KeyC', 'ControlLeft') };
  }

  private cmd = { fx: 0, fz: 0, sprint: false, crouch: false };

  /** Scripted input (tests): forward/strafe in -1..1 relative to the current heading. */
  setCommand(forward: number, strafe: number, sprint: boolean): void {
    const h = THREE.MathUtils.degToRad(this.heading);
    const fwx = Math.sin(h), fwz = -Math.cos(h);
    this.cmd = { fx: fwx * forward - fwz * strafe, fz: fwz * forward + fwx * strafe, sprint, crouch: false };
  }

  syncCamera(ctx: AppContext, dt: number): void { this.writeCamera(ctx, dt); }

  // ------------------------------------------------------------------ per frame
  update(dt: number, ctx: AppContext): void {
    if (!this.body) return;
    const { dx, dy } = ctx.input.consume();
    const locked = document.pointerLockElement === ctx.canvas;
    if (locked || ctx.input.buttons & 1 || ctx.input.buttons & 2) this.look(dx, dy);
    this.cmd = this.readInput(ctx);
    this.sys.update(dt);
    this.writeCamera(ctx, dt);
  }

  /** One fixed physics step of the character. */
  private step(dt: number): void {
    const kcc = this.kcc, col = this.collider, body = this.body;
    if (!kcc || !col || !body || !this.active) return;
    this.prev.copy(this.pos);
    const c = this.cmd;
    // water
    let level: number | null = null;
    const w = this.waterSvc;
    if (w) { try { level = w.levelAt(this.pos.x, this.pos.z); } catch { level = null; } }
    const depth = level !== null ? level - this.pos.y : 0;
    this.swimming = level !== null && depth > 1.25;
    this.sprinting = c.sprint && !this.swimming;
    this.crouch += ((c.crouch ? 1 : 0) - this.crouch) * Math.min(1, dt * 10);
    const speed = this.swimming ? (c.sprint ? SWIM * 1.6 : SWIM) : (c.sprint ? SPRINT : WALK) * (1 - 0.45 * this.crouch) * (level !== null && depth > 0.5 ? 0.6 : 1);
    const tx = c.fx * speed, tz = c.fz * speed;
    const accel = this.swimming ? 3 : this.grounded ? (Math.hypot(tx, tz) > 0.1 ? 14 : 18) : 2.5;
    const k = Math.min(1, accel * dt / Math.max(0.001, Math.hypot(tx - this.vel.x, tz - this.vel.z)));
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.z += (tz - this.vel.z) * k;
    if (this.swimming) {
      // float with the head above water
      const target = level! - 1.45;
      this.vel.y += ((target - this.pos.y) * 3 - this.vel.y) * Math.min(1, dt * 4);
      if (this.jumpQueued) { this.vel.y = 1.2; }
      this.jumpQueued = false;
      // drift with the current
      const f = w?.flowAt?.(this.pos.x, this.pos.z);
      if (f) { this.vel.x += f.x * dt * 0.8; this.vel.z += f.z * dt * 0.8; }
    } else if (this.grounded) {
      if (this.jumpQueued && this.crouch < 0.5) { this.vel.y = JUMP_V; this.grounded = false; }
      else this.vel.y = -0.1; // (a strong downward push breaks Rapier's autostep; snap-to-ground keeps us down)
      this.jumpQueued = false;
    } else {
      this.vel.y = Math.max(-55, this.vel.y - GRAVITY * dt);
      if (this.airTime > 0.25) this.jumpQueued = false;
    }
    const desired = { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt };
    kcc.computeColliderMovement(col, desired, this.sys.R.QueryFilterFlags.EXCLUDE_SENSORS, groups(G.PLAYER, G.STATIC | G.CAR | G.TOY));
    const mv = kcc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = kcc.computedGrounded() || (this.swimming && false);
    this.pos.x += mv.x; this.pos.y += mv.y; this.pos.z += mv.z;
    if (this.vel.y > 0 && mv.y < desired.y * 0.5) this.vel.y = 0; // head bump
    if (this.grounded) {
      if (!wasGrounded && this.lastFall < -3) this.dipV -= Math.min(2.2, -this.lastFall * 0.16);
      this.airTime = 0;
    } else {
      this.airTime += dt;
      this.lastFall = this.vel.y;
    }
    // safety: never below the terrain (tile not streamed yet, tunnelling)
    const g = this.sys.groundAt(this.pos.x, this.pos.z);
    if (this.pos.y < g - 1.0) { this.pos.y = g; this.vel.y = 0; }
    body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + RADIUS + HALF, z: this.pos.z });
    // head bob phase advances with distance walked on the ground
    const hs = Math.hypot(mv.x, mv.z) / dt;
    if (this.grounded || this.swimming) {
      const before = Math.floor(this.bobPhase / Math.PI);
      this.bobPhase += (Math.hypot(mv.x, mv.z) / (this.sprinting ? 1.05 : 0.72)) * Math.PI;
      if (Math.floor(this.bobPhase / Math.PI) !== before && this.onFootstep) {
        try { this.onFootstep(this.pos.x, this.pos.y, this.pos.z, this.swimming, Math.min(1, 0.45 + hs / SPRINT)); } catch { /* ignore */ }
      }
    }
    if (!wasGrounded && this.grounded && this.lastFall < -2.5 && this.onFootstep) {
      try { this.onFootstep(this.pos.x, this.pos.y, this.pos.z, false, 1); } catch { /* ignore */ }
    }
    const targetAmp = this.swimming ? 0.02 : this.grounded ? Math.min(1, hs / WALK) * (this.sprinting ? 0.06 : 0.032) : 0;
    this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 6);
  }

  private tmpE = new THREE.Euler(0, 0, 0, 'YXZ');

  private writeCamera(ctx: AppContext, dt: number): void {
    const cam = ctx.camera;
    const a = this.sys.alpha;
    const px = this.prev.x + (this.pos.x - this.prev.x) * a;
    const py = this.prev.y + (this.pos.y - this.prev.y) * a;
    const pz = this.prev.z + (this.pos.z - this.prev.z) * a;
    // landing dip spring
    this.dipV += (-this.dip * 90 - this.dipV * 14) * Math.min(dt, 0.05);
    this.dip += this.dipV * Math.min(dt, 0.05);
    this.dip = THREE.MathUtils.clamp(this.dip, -0.35, 0.1);
    const eye = EYE - 0.55 * this.crouch;
    let target = py + eye;
    // smooth autostep jumps of the eye (not jumps / falls)
    if (!Number.isFinite(this.eyeY) || !this.grounded || Math.abs(target - this.eyeY) > 0.6) this.eyeY = target;
    else this.eyeY += (target - this.eyeY) * (1 - Math.exp(-dt * 16));
    target = this.eyeY;
    const s = Math.sin(this.bobPhase);
    const bobY = this.bobAmp * (Math.abs(s) - 0.6);
    const bobX = this.bobAmp * 0.45 * Math.sin(this.bobPhase * 0.5 + 0.3);
    const h = THREE.MathUtils.degToRad(this.heading);
    const rx = Math.cos(h), rz = Math.sin(h);
    cam.position.set(px + rx * bobX, target + bobY + this.dip, pz + rz * bobX);
    this.tmpE.set(THREE.MathUtils.degToRad(this.pitch), THREE.MathUtils.degToRad(-this.heading), -bobX * 0.35, 'YXZ');
    cam.quaternion.setFromEuler(this.tmpE);
    if (dt === 0) applyHeadingPitch(cam, this.heading, this.pitch);
  }

  /** Current horizontal speed (m/s). */
  get speed(): number { return Math.hypot(this.vel.x, this.vel.z); }
}
