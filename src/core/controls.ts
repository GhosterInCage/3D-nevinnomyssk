// Camera controllers. The core ships the free-flight controller; other modules
// (physics: walk/drive) register additional controllers via ctx.registerController.
import * as THREE from 'three';
import type { AppContext } from './context';

export interface Controller {
  readonly name: string;
  /** Called when this controller becomes active. */
  enter(ctx: AppContext): void;
  /** Called when another controller takes over. */
  exit(ctx: AppContext): void;
  update(dt: number, ctx: AppContext): void;
}

/** Tracks keyboard + pointer state for controllers. */
export class Input {
  readonly keys = new Set<string>();
  readonly mouseDelta = new THREE.Vector2();
  wheel = 0;
  buttons = 0;
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('pointerdown', (e) => { this.buttons = e.buttons; el.setPointerCapture?.(e.pointerId); });
    el.addEventListener('pointerup', (e) => { this.buttons = e.buttons; });
    el.addEventListener('pointermove', (e) => {
      this.buttons = e.buttons;
      if (e.buttons || document.pointerLockElement === el) this.mouseDelta.x += e.movementX, this.mouseDelta.y += e.movementY;
    });
    el.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Consume accumulated mouse/wheel deltas (call once per frame). */
  consume(): { dx: number; dy: number; wheel: number } {
    const r = { dx: this.mouseDelta.x, dy: this.mouseDelta.y, wheel: this.wheel };
    this.mouseDelta.set(0, 0);
    this.wheel = 0;
    return r;
  }

  get element(): HTMLElement { return this.el; }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

/** Heading/pitch camera orientation helper (heading deg cw from north, pitch deg up). */
export function applyHeadingPitch(camera: THREE.Camera, headingDeg: number, pitchDeg: number): void {
  const e = new THREE.Euler(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(-headingDeg), 0, 'YXZ');
  camera.quaternion.setFromEuler(e);
}

export function getHeadingPitch(camera: THREE.Camera): { heading: number; pitch: number } {
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  return { heading: (THREE.MathUtils.radToDeg(-e.y) + 360) % 360, pitch: THREE.MathUtils.radToDeg(e.x) };
}

/**
 * Free flight: WASD/arrows move, Q/E or Space/C down/up, Shift = fast, Alt = slow,
 * drag with mouse to look, wheel changes speed. Speed scales with height above ground.
 */
export class FlyController implements Controller {
  readonly name = 'fly';
  heading = 0;
  pitch = -20;
  speedFactor = 1;
  private vel = new THREE.Vector3();

  enter(ctx: AppContext): void {
    const hp = getHeadingPitch(ctx.camera);
    this.heading = hp.heading;
    this.pitch = hp.pitch;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  exit(): void { /* nothing */ }

  update(dt: number, ctx: AppContext): void {
    const { input, camera, heightfield } = ctx;
    const { dx, dy, wheel } = input.consume();
    if (input.buttons & 1 || input.buttons & 2 || document.pointerLockElement) {
      this.heading = (this.heading + dx * 0.15 + 360) % 360;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.15, -89, 89);
    }
    if (wheel) this.speedFactor = THREE.MathUtils.clamp(this.speedFactor * Math.pow(1.25, -wheel), 0.05, 50);
    const ground = heightfield ? heightfield.sample(camera.position.x, camera.position.z) : 0;
    const agl = Math.max(1, camera.position.y - ground);
    let speed = THREE.MathUtils.clamp(agl * 1.2, 8, 3000) * this.speedFactor;
    if (input.down('ShiftLeft', 'ShiftRight')) speed *= 4;
    if (input.down('AltLeft', 'AltRight')) speed *= 0.2;

    const fwd = new THREE.Vector3(Math.sin(THREE.MathUtils.degToRad(this.heading)), 0, -Math.cos(THREE.MathUtils.degToRad(this.heading)));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const look = new THREE.Vector3();
    camera.getWorldDirection(look);
    const move = new THREE.Vector3();
    if (input.down('KeyW', 'ArrowUp')) move.add(look);
    if (input.down('KeyS', 'ArrowDown')) move.sub(look);
    if (input.down('KeyD', 'ArrowRight')) move.add(right);
    if (input.down('KeyA', 'ArrowLeft')) move.sub(right);
    if (input.down('KeyE', 'Space')) move.y += 1;
    if (input.down('KeyQ', 'KeyC')) move.y -= 1;
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);
    // critically damped velocity smoothing
    this.vel.lerp(move, 1 - Math.exp(-dt * 6));
    camera.position.addScaledVector(this.vel, dt);
    applyHeadingPitch(camera, this.heading, this.pitch);
    if (heightfield) {
      const g = heightfield.sample(camera.position.x, camera.position.z);
      if (camera.position.y < g + 1.7) camera.position.y = g + 1.7;
    }
    camera.position.y = Math.min(camera.position.y, 40000);
  }
}
