// Physics module: Rapier 3D world streamed around the player (terrain heightfield tiles + static
// colliders from every module's collider provider), first-person walking, a drivable Lada
// Priora-like car with a chase camera, and physics toys (F: football, G: wooden crate).
// Provides the 'physics' service and registers the 'walk' and 'drive' controllers.
// See docs/modules/physics.md.
import * as THREE from 'three';
import type { AppContext, CityModule } from '../../core/context';
import { PhysicsSystem, type RayHit } from './system';
import { WalkController } from './walk';
import { DriveController } from './drive';
import { Toys } from './toys';
import { PhysicsHud } from './hud';
import { CAR_COLORS } from './carModel';
import { CarAudio } from './audio';

export interface PhysicsService {
  RAPIER: any;
  world: any;
  system: PhysicsSystem;
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist?: number): RayHit | null;
  spawnBall(pos: THREE.Vector3, vel?: THREE.Vector3): any;
  spawnCrate(pos: THREE.Vector3, vel?: THREE.Vector3): any;
  throwBall(): void;
  dropCrate(): void;
  clearToys(): void;
  setMode(name: string): boolean;
  readonly mode: string;
  /** touch / gamepad: analog stick (-1..1, y forward); look deltas in pixels; jump */
  move(x: number, y: number): void;
  look(dx: number, dy: number): void;
  jump(): void;
  handbrake(on: boolean): void;
  readonly speed: number;
  readonly speedKmh: number;
  readonly gear: number;
  readonly rpm: number;
  readonly car: { x: number; y: number; z: number; heading: number; speedKmh: number; gear: number; rpm: number } | null;
  readonly walker: { x: number; y: number; z: number; grounded: boolean; swimming: boolean } | null;
  resetCar(): void;
  setCarColor(c: string): void;
  /** 0 chase, 1 far chase, 2 cockpit, 3 bonnet */
  setDriveCamera(mode: number): void;
  setHud(on: boolean): void;
  /** procedural engine / tyre / wind sound in drive mode */
  setAudio(on: boolean): void;
  /** scripted testing: run the simulation for `seconds` with held inputs */
  simulate(seconds: number, input?: { forward?: number; strafe?: number; sprint?: boolean; throttle?: number; brake?: number; steer?: number; handbrake?: boolean }): string;
  stats(): Record<string, number>;
}

let nearCarHint: () => void = () => undefined;
let state: { sys: PhysicsSystem; walk: WalkController; drive: DriveController; toys: Toys; hud: PhysicsHud; audio: CarAudio } | null = null;

const mod: CityModule = {
  id: 'physics',
  async init(ctx: AppContext) {
    const t0 = performance.now();
    const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
    const t1 = performance.now();
    await RAPIER.init();
    const t2 = performance.now();
    const sys = new PhysicsSystem(ctx, RAPIER);
    const walk = new WalkController(sys);
    const drive = new DriveController(sys, ctx, walk);
    const toys = new Toys(sys, ctx);
    const hud = new PhysicsHud(ctx);
    const audio = new CarAudio(!ctx.settings.shot && ctx.settings.params.get('audio') !== '0');
    state = { sys, walk, drive, toys, hud, audio };
    // footsteps: hard on roads / paving / structures, soft on grass and soil
    walk.onFootstep = (x, y, z, swimming, strength) => {
      if (swimming) { audio.footstep('water', strength); return; }
      let hard = false;
      const g = sys.terrain.terrainY(x, z);
      if (y > g + 0.25) hard = true; // on a bridge deck, roof, steps...
      else {
        const roads = ctx.get<any>('roads');
        try { if (roads?.isRoad?.(x, z, 0.4, true, true)) hard = true; } catch { /* ignore */ }
        if (!hard) {
          const t = ctx.get<any>('terrain');
          let kind = '';
          try { kind = t?.groundTypeAt?.(x, z) ?? ''; } catch { /* ignore */ }
          hard = kind === 'urban' || kind === 'rock' || kind === 'gravel' || kind === 'pebbles';
        }
      }
      audio.footstep(hard ? 'hard' : 'soft', strength);
    };
    ctx.registerController(walk);
    ctx.registerController(drive);

    const cam = ctx.camera;
    const baseVel = (): THREE.Vector3 => {
      if (walk.isActive) return walk.vel.clone();
      if (drive.isActive && drive.car) { const v = drive.car.body.linvel(); return new THREE.Vector3(v.x, v.y, v.z); }
      return new THREE.Vector3();
    };
    const throwBall = () => {
      const dir = cam.getWorldDirection(new THREE.Vector3());
      const pos = cam.position.clone().addScaledVector(dir, 0.45);
      pos.y -= 0.15;
      const v = dir.clone().multiplyScalar(17).add(new THREE.Vector3(0, 1.8, 0)).add(baseVel());
      toys.spawnBall(pos, v);
    };
    const dropCrate = () => {
      const dir = cam.getWorldDirection(new THREE.Vector3());
      const h = new THREE.Vector3(dir.x, 0, dir.z);
      if (h.lengthSq() < 1e-4) h.set(0, 0, -1);
      h.normalize();
      const d = drive.isActive ? 4.5 : 2.2;
      const pos = cam.position.clone().addScaledVector(h, d).add(new THREE.Vector3(0, drive.isActive ? 1.5 : 0.6, 0));
      const g = sys.groundAt(pos.x, pos.z);
      if (pos.y < g + 0.5) pos.y = g + 0.5;
      toys.spawnCrate(pos, baseVel().multiplyScalar(0.8).add(h.clone().multiplyScalar(1.2)));
    };

    /** the walker stands next to the (upright) car */
    const nearCar = (): boolean => {
      const c = drive.car;
      if (!c || !walk.isActive) return false;
      return Math.hypot(c.pos.x - walk.pos.x, c.pos.z - walk.pos.z) < 4.5 && Math.abs(c.pos.y - walk.pos.y) < 2 && c.up.y > 0.5;
    };
    let nearShown = false;
    nearCarHint = () => {
      const n = nearCar();
      if (n && !nearShown) hud.showHint(ctx.settings.shot ? '' : 'E — сесть в машину', 3);
      nearShown = n;
    };

    const api: PhysicsService = {
      RAPIER, world: sys.world, system: sys,
      raycast: (o, d, m = 1000) => sys.raycast(o, d, m),
      spawnBall: (p, v) => toys.spawnBall(p, v),
      spawnCrate: (p, v) => toys.spawnCrate(p, v),
      throwBall, dropCrate,
      clearToys: () => toys.clear(),
      setMode: (name) => ctx.setController(name),
      get mode() { return ctx.controller.name; },
      move(x, y) {
        walk.analog.x = x; walk.analog.y = y;
        drive.analog.x = x; drive.analog.y = y;
      },
      look(dx, dy) {
        if (walk.isActive) walk.look(dx, dy);
        else { ctx.input.mouseDelta.x += dx; ctx.input.mouseDelta.y += dy; }
      },
      jump() { if (walk.isActive) walk.jump(); },
      handbrake(on) { if (on) ctx.input.keys.add('Space'); else ctx.input.keys.delete('Space'); },
      get speed() { return drive.isActive && drive.car ? Math.abs(drive.car.speed) : walk.isActive ? walk.speed : 0; },
      get speedKmh() { return this.speed * 3.6; },
      get gear() { return drive.car ? drive.car.gear : 0; },
      get rpm() { return drive.car ? drive.car.rpm : 0; },
      get car() {
        const c = drive.car;
        if (!c) return null;
        const f = c.forward;
        return { x: c.pos.x, y: c.pos.y, z: c.pos.z, heading: (THREE.MathUtils.radToDeg(Math.atan2(f.x, -f.z)) + 360) % 360, speedKmh: c.speedKmh, gear: c.gear, rpm: c.rpm };
      },
      get walker() {
        return walk.isActive ? { x: walk.pos.x, y: walk.pos.y, z: walk.pos.z, grounded: walk.grounded, swimming: walk.swimming } : null;
      },
      resetCar: () => drive.reset(),
      setCarColor: (c) => drive.car?.model.setColor(CAR_COLORS[c] ?? c),
      setDriveCamera: (m) => { drive.camMode = Math.max(0, Math.min(3, m | 0)); },
      setHud: (on) => hud.setEnabled(on),
      setAudio: (on) => audio.setEnabled(on),
      simulate(seconds, input = {}) {
        const n = Math.max(1, Math.round(seconds * 30));
        const dt = 1 / 30;
        // hold the given inputs for the duration (keyboard state is bypassed)
        for (let i = 0; i < n; i++) {
          if (walk.isActive) {
            walk.setCommand(input.forward ?? 0, input.strafe ?? 0, !!input.sprint);
            sys.simulate(dt);
          } else if (drive.isActive && drive.car) {
            const car = drive.car;
            car.input.throttle = input.throttle ?? 0;
            car.input.brake = input.brake ?? 0;
            car.input.steer = input.steer ?? 0;
            car.input.handbrake = !!input.handbrake;
            sys.simulate(dt);
          } else sys.simulate(dt);
          sys.alpha = 1;
          if (walk.isActive) walk.syncCamera(ctx, dt);
          else if (drive.isActive) drive.syncCamera(ctx, dt);
        }
        if (drive.car) { drive.car.input.throttle = drive.car.input.brake = drive.car.input.steer = 0; drive.car.input.handbrake = false; }
        walk.setCommand(0, 0, false);
        toys.render(1);
        const c = api.car, w = api.walker;
        return JSON.stringify({ mode: ctx.controller.name, car: c && { x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2), heading: +c.heading.toFixed(1), kmh: +c.speedKmh.toFixed(1), gear: c.gear, rpm: Math.round(c.rpm) }, walker: w && { x: +w.x.toFixed(2), y: +w.y.toFixed(2), z: +w.z.toFixed(2), grounded: w.grounded, swimming: w.swimming }, stats: sys.stats() });
      },
      stats: () => ({ ...sys.stats(), toys: toys.count }),
    };
    ctx.provide('physics', api);
    (window as any).__physics = state;

    // ---------------------------------------------------------------- input
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.repeat && (e.code === 'KeyF' || e.code === 'KeyG')) return;
      try {
        if (e.code === 'KeyF' && !e.shiftKey) throwBall();
        else if (e.code === 'KeyG' && !e.shiftKey) dropCrate();
        else if (e.code === 'KeyE' && !e.repeat && (walk.isActive || drive.isActive)) {
          // get in / out of the car
          if (drive.isActive) ctx.setController('walk');
          else if (nearCar()) ctx.setController('drive');
        }
        else if (!ctx.get('ui') && /^Digit[123]$/.test(e.code)) ctx.setController(['fly', 'walk', 'drive'][+e.code.slice(5) - 1]);
      } catch (err) {
        console.error('[physics] key action failed', err);
      }
    });
    ctx.canvas.addEventListener('click', () => {
      if (ctx.settings.shot || ctx.controller !== walk || document.pointerLockElement === ctx.canvas) return;
      try {
        const r: any = ctx.canvas.requestPointerLock?.();
        if (r && typeof r.catch === 'function') r.catch(() => undefined);
      } catch { /* ignore */ }
    });
    ctx.events.on('teleport', (p: { x: number; z: number }) => {
      try {
        if (walk.isActive) walk.placeAt(p.x, p.z);
        else if (drive.isActive) drive.spawn(p.x, p.z, 0), drive.car && (drive.car.driven = true);
      } catch (e) { console.error('[physics] teleport', e); }
    });
    ctx.events.on('controller', (name: string) => {
      if (name !== 'walk') walk.spawnHint = null;
      if (name === 'walk') hud.showHint(ctx.settings.shot ? '' : 'WASD — идти · Shift — бег · Space — прыжок · F — мяч · G — ящик · клик — мышь');
      if (name === 'drive') hud.showHint(ctx.settings.shot ? '' : 'W/S — газ/тормоз · A/D — руль · Space — ручник · V — камера · R — на дорогу · E — выйти');
    });
    // roads give the terrain its asphalt lift: rebuild tiles once they appear
    const rebuildGround = () => { sys.terrain.resetSources(); sys.terrain.clear(); };
    ctx.events.on('service:roads', rebuildGround);
    ctx.events.on('service:terrain', rebuildGround);
    ctx.events.once('ready', () => {
      const m = ctx.settings.params.get('mode');
      if (m && (m === 'walk' || m === 'drive') && ctx.controller.name !== m) {
        try { ctx.setController(m); } catch (e) { console.error('[physics] initial mode', e); }
      }
    });
    console.info(`[physics] Rapier ${RAPIER.version?.() ?? ''} ready (import ${Math.round(t1 - t0)} ms, wasm init ${Math.round(t2 - t1)} ms, setup ${Math.round(performance.now() - t2)} ms)`);
  },

  update(dt: number, ctx: AppContext) {
    const s = state;
    if (!s) return;
    const { sys, walk, drive, toys, hud, audio } = s;
    const car = drive.car;
    const ours = ctx.controller === walk || ctx.controller === drive;
    if (!ours && (toys.anyAwake || (car && !car.body.isSleeping()))) sys.update(dt);
    toys.render(sys.alpha);
    if (car && !drive.isActive) {
      const d = Math.hypot(car.pos.x - ctx.camera.position.x, car.pos.z - ctx.camera.position.z);
      const vis = d < 2500;
      car.setVisible(vis);
      if (vis) car.render(sys.alpha);
    } else if (car) car.setVisible(true);
    hud.update(dt, ctx.controller.name, drive.isActive && car ? { kmh: car.speedKmh, rpm: car.rpm, gear: car.gear } : null);
    if (walk.isActive && car && (ctx.frame & 7) === 0) nearCarHint();
    try {
      const on = drive.isActive && !!car;
      audio.keepAlive = walk.isActive;
      if (car && car.impact > 0) { if (on) audio.impact((car.impact - 1.2) / 6); car.impact = 0; }
      audio.update(dt, on, on && car ? { rpm: car.rpm, throttle: car.throttleOut, speed: Math.abs(car.speed), slip: car.slip, submerged: car.submerged } : null);
    } catch { /* audio is optional */ }
  },
};
export default mod;
