// Smooth camera flights (search results, minimap clicks, intro). While a flight is
// running the active controller is paused; any user input cancels the flight.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { applyHeadingPitch, getHeadingPitch } from '../../core/controls';
import { headingOf } from '../../core/geo';

export interface FlyOptions {
  /** Distance from the camera to the target point (m). */
  distance?: number;
  /** Final pitch (deg, negative = down). */
  pitch?: number;
  /** Final heading (deg cw from north); default: keep the approach direction. */
  heading?: number;
  /** Height of the look-at point above ground (m). */
  height?: number;
  /** Flight duration override (s). */
  duration?: number;
  /** Explicit final camera position (world). Overrides distance/heading/pitch placement. */
  position?: THREE.Vector3;
  onDone?: () => void;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a: number, b: number, t: number) => {
  const x = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};

export class CameraFlight {
  active = false;
  private t = 0;
  private dur = 1;
  private p0 = new THREE.Vector3();
  private p1 = new THREE.Vector3();
  private target = new THREE.Vector3();
  private q0 = new THREE.Quaternion();
  private q1 = new THREE.Quaternion();
  private arc = 0;
  private wasPaused = false;
  private onDone?: () => void;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private startFrame = 0;
  private slerpOnly = false;

  constructor(private ctx: AppContext) {
    ctx.onUpdate((dt) => this.update(dt), -3000);
  }

  /** Fly so that the camera looks at world point (x, groundY + height, z). */
  flyTo(x: number, z: number, o: FlyOptions = {}): void {
    const ctx = this.ctx;
    const cam = ctx.camera;
    const hf = ctx.heightfield;
    const gy = hf ? hf.sample(x, z) : 0;
    const height = o.height ?? 10;
    this.target.set(x, gy + height, z);
    const cur = cam.position;
    const horiz = Math.hypot(x - cur.x, z - cur.z);
    const dist = o.distance ?? 400;
    const pitch = o.pitch ?? -28;
    let heading = o.heading ?? (horiz > 30 ? headingOf(x - cur.x, z - cur.z) : getHeadingPitch(cam).heading);
    if (!Number.isFinite(heading)) heading = 0;
    if (o.position) {
      this.p1.copy(o.position);
    } else {
      const hr = THREE.MathUtils.degToRad(heading), pr = THREE.MathUtils.degToRad(pitch);
      const fwd = new THREE.Vector3(Math.sin(hr) * Math.cos(pr), Math.sin(pr), -Math.cos(hr) * Math.cos(pr));
      this.p1.copy(this.target).addScaledVector(fwd, -dist);
    }
    if (hf) {
      // keep the destination above ground (and above nearby terrain on the way in)
      const g1 = hf.sample(this.p1.x, this.p1.z);
      if (this.p1.y < g1 + 2) this.p1.y = g1 + 2;
    }
    this.p0.copy(cur);
    this.q0.copy(cam.quaternion);
    this.tmpM.lookAt(this.p1, this.target, this.up);
    this.q1.setFromRotationMatrix(this.tmpM);
    this.slerpOnly = false;
    if (o.position && o.heading !== undefined) {
      const e = new THREE.Euler(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(-o.heading), 0, 'YXZ');
      this.q1.setFromEuler(e);
      this.slerpOnly = true;
    }
    const travel = this.p0.distanceTo(this.p1);
    this.dur = o.duration ?? THREE.MathUtils.clamp(1.1 + 1.25 * Math.log10(1 + travel / 60), 1.2, 6.5);
    this.arc = this.slerpOnly ? 0 : Math.min(travel * 0.3, 2500) * (travel > 300 ? 1 : 0);
    this.t = 0;
    this.onDone = o.onDone;
    if (!this.active) this.wasPaused = ctx.paused;
    this.active = true;
    this.startFrame = ctx.frame;
    if (ctx.controller.name !== 'fly') ctx.setController('fly');
    ctx.paused = true;
    ctx.input.consume();
  }

  /** Rotate in place to a heading/pitch. */
  rotateTo(heading: number, pitch: number, duration = 0.8): void {
    const cam = this.ctx.camera;
    const d = new THREE.Vector3();
    cam.getWorldDirection(d);
    this.flyTo(cam.position.x + d.x * 100, cam.position.z + d.z * 100, { position: cam.position.clone(), heading, pitch, duration });
  }

  /** Place the camera immediately (teleport) keeping orientation. */
  teleport(x: number, z: number, agl?: number): void {
    const ctx = this.ctx;
    this.cancel();
    const cam = ctx.camera;
    const g = ctx.heightfield ? ctx.heightfield.sample(x, z) : 0;
    const curAgl = ctx.cameraAGL;
    cam.position.set(x, g + Math.max(2, agl ?? curAgl), z);
    cam.updateMatrixWorld();
    // fly re-reads its state from the camera; walk/drive controllers listen to 'teleport'
    if (ctx.controller.name === 'fly') ctx.controller.enter(ctx);
    ctx.events.emit('teleport', { x, z });
  }

  cancel(): void {
    if (!this.active) return;
    this.finish(false);
  }

  private finish(done: boolean): void {
    const ctx = this.ctx;
    this.active = false;
    ctx.paused = this.wasPaused;
    ctx.input.consume();
    ctx.controller.enter(ctx);
    ctx.events.emit('teleport', { x: ctx.camera.position.x, z: ctx.camera.position.z });
    const cb = this.onDone;
    this.onDone = undefined;
    if (done && cb) cb();
  }

  private userInterrupt(): boolean {
    const inp = this.ctx.input;
    if (this.ctx.frame - this.startFrame < 3) return false;
    if (inp.keys.size > 0) {
      for (const k of inp.keys) if (/^(Key[WASDQEC]|Arrow|Space)/.test(k)) return true;
    }
    return (inp.buttons & 3) !== 0 && inp.mouseDelta.lengthSq() > 4;
  }

  private update(dt: number): void {
    if (!this.active) return;
    const ctx = this.ctx;
    if (this.userInterrupt()) { this.finish(false); return; }
    this.t = Math.min(1, this.t + dt / this.dur);
    const e = easeInOut(this.t);
    const cam = ctx.camera;
    cam.position.lerpVectors(this.p0, this.p1, e);
    cam.position.y += this.arc * Math.sin(Math.PI * e);
    if (ctx.heightfield) {
      const g = ctx.heightfield.sample(cam.position.x, cam.position.z);
      const minClear = this.t < 0.9 ? Math.min(40, this.p1.y - ctx.heightfield.sample(this.p1.x, this.p1.z) + 5) : 1.5;
      if (cam.position.y < g + minClear) cam.position.y = g + minClear;
    }
    if (this.slerpOnly) {
      cam.quaternion.slerpQuaternions(this.q0, this.q1, e);
    } else {
      // orientation: start -> look at target (early), which converges to the final orientation
      this.tmpM.lookAt(cam.position, this.target, this.up);
      this.tmpQ.setFromRotationMatrix(this.tmpM);
      const w = smooth(0.0, 0.45, this.t);
      cam.quaternion.copy(this.q0).slerp(this.tmpQ, w);
      if (this.t > 0.85) cam.quaternion.slerp(this.q1, smooth(0.85, 1, this.t));
    }
    // remove roll
    const hp = getHeadingPitch(cam);
    applyHeadingPitch(cam, hp.heading, hp.pitch);
    cam.updateMatrixWorld();
    if (this.t >= 1) this.finish(true);
  }
}
