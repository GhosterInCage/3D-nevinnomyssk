// Physics system: owns the Rapier world, the fixed-timestep loop with render interpolation,
// collision groups, the streamed static world (terrain tiles + provider colliders) and the
// set of "interest points" (player, car, awake toys) around which the static world is kept.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { AppContext } from '../../core/context';
import { TerrainTiles } from './terrain';
import { StaticStreamer } from './statics';

export type RapierAPI = typeof RAPIER_NS;
export type World = RAPIER_NS.World;
export type RigidBody = RAPIER_NS.RigidBody;
export type Collider = RAPIER_NS.Collider;

/** Collision group bits (membership / filter). */
export const G = { STATIC: 1, PLAYER: 2, CAR: 4, TOY: 8, ALL: 0xffff } as const;
export const groups = (member: number, filter: number): number => (((member & 0xffff) << 16) | (filter & 0xffff)) >>> 0;

/** A place around which the static world (terrain + colliders) must exist. */
export interface Interest {
  x: number;
  z: number;
  /** terrain heightfield radius (m) */
  terrainR: number;
  /** static collider radius (m) */
  staticR: number;
}

export interface RayHit {
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  collider: Collider | null;
  /** 'terrain' | 'static' | 'car' | 'player' | 'toy' | 'heightfield' */
  kind: string;
  /** collider key for streamed statics (e.g. 'bld:123') */
  key?: string;
}

export class PhysicsSystem {
  readonly world: World;
  /** fixed simulation step (s) */
  readonly dt = 1 / 60;
  /** interpolation factor between the previous and the current step, for rendering */
  alpha = 1;
  simTime = 0;
  steps = 0;
  readonly terrain: TerrainTiles;
  readonly statics: StaticStreamer;
  /** hooks run before / after every fixed step */
  private pre = new Set<(dt: number) => void>();
  private post = new Set<(dt: number) => void>();
  /** interest providers, polled every frame */
  private interestFns = new Set<(out: Interest[]) => void>();
  private acc = 0;
  private lastFrame = -1;
  private interests: Interest[] = [];
  /** collider handle -> kind, for ray hits */
  readonly kinds = new Map<number, string>();
  maxStepsPerFrame = 6;
  /** time (ms) spent in the last update, for stats */
  lastMs = 0;

  constructor(readonly ctx: AppContext, readonly R: RapierAPI) {
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.dt;
    this.terrain = new TerrainTiles(this);
    this.statics = new StaticStreamer(this);
  }

  onPreStep(fn: (dt: number) => void): () => void { this.pre.add(fn); return () => this.pre.delete(fn); }
  onPostStep(fn: (dt: number) => void): () => void { this.post.add(fn); return () => this.post.delete(fn); }
  addInterest(fn: (out: Interest[]) => void): () => void { this.interestFns.add(fn); return () => this.interestFns.delete(fn); }

  /** Current interest points (recomputed each update). */
  get interestPoints(): readonly Interest[] { return this.interests; }

  /**
   * Advance the simulation by a frame's worth of time (fixed steps + interpolation alpha).
   * Safe to call several times per frame: only the first call of a frame does work.
   */
  update(frameDt: number): void {
    const ctx = this.ctx;
    if (ctx.frame === this.lastFrame) return;
    this.lastFrame = ctx.frame;
    const t0 = performance.now();
    this.gatherInterests();
    this.terrain.update(this.interests);
    this.statics.update(this.interests);
    this.acc += Math.min(frameDt, this.dt * this.maxStepsPerFrame);
    let n = 0;
    while (this.acc >= this.dt && n < this.maxStepsPerFrame) {
      this.acc -= this.dt;
      this.step();
      n++;
    }
    if (n === this.maxStepsPerFrame) this.acc = Math.min(this.acc, this.dt);
    this.alpha = THREE.MathUtils.clamp(this.acc / this.dt, 0, 1);
    this.lastMs = performance.now() - t0;
  }

  /** Run n fixed steps immediately (used by scripted tests and spawning). */
  simulate(seconds: number): void {
    const n = Math.max(1, Math.round(seconds / this.dt));
    for (let i = 0; i < n; i++) {
      if (i % 15 === 0) {
        this.gatherInterests();
        this.terrain.update(this.interests, true);
        this.statics.update(this.interests, true);
      }
      this.step();
    }
    this.acc = 0;
    this.alpha = 1;
  }

  private step(): void {
    const dt = this.dt;
    for (const f of this.pre) {
      try { f(dt); } catch (e) { console.error('[physics] pre-step', e); }
    }
    this.world.step();
    this.simTime += dt;
    this.steps++;
    for (const f of this.post) {
      try { f(dt); } catch (e) { console.error('[physics] post-step', e); }
    }
  }

  gatherInterests(): void {
    const out: Interest[] = [];
    for (const f of this.interestFns) {
      try { f(out); } catch (e) { console.error('[physics] interest', e); }
    }
    this.interests = out;
  }

  /** Make sure terrain + static colliders exist around (x, z) right now (spawning). */
  ensureNow(x: number, z: number, terrainR = 48, staticR = 40): void {
    const extra: Interest = { x, z, terrainR, staticR };
    this.gatherInterests();
    const list = [...this.interests, extra];
    this.terrain.update(list, true);
    this.statics.update(list, true);
    this.refreshQueries();
  }

  /**
   * Scene queries (ray casts, shape tests, the character controller) only see colliders
   * added since the last step after the broad phase ran: a zero-length step does that
   * without moving any body.
   */
  refreshQueries(): void {
    const w = this.world;
    w.timestep = 0;
    try { w.step(); } finally { w.timestep = this.dt; }
  }

  // ------------------------------------------------------------------ queries
  private tmpRay: RAPIER_NS.Ray | null = null;

  /**
   * Ray cast against everything currently in the physics world. When nothing is hit (the
   * static world is only streamed near the player), falls back to the terrain height field.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist = 1000, filterGroups?: number, exclude?: RigidBody | null): RayHit | null {
    const R = this.R;
    const d = dir.clone().normalize();
    if (!this.tmpRay) this.tmpRay = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const ray = this.tmpRay;
    ray.origin = { x: origin.x, y: origin.y, z: origin.z };
    ray.dir = { x: d.x, y: d.y, z: d.z };
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filterGroups, undefined, exclude ?? undefined);
    if (hit) {
      const p = origin.clone().addScaledVector(d, hit.timeOfImpact);
      const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      const h = hit.collider.handle;
      return { distance: hit.timeOfImpact, point: p, normal: n, collider: hit.collider, kind: this.kinds.get(h) ?? 'unknown', key: this.statics.keyOf(h) };
    }
    const hf = this.ctx.heightfield;
    if (!hf) return null;
    const t = hf.raycast(origin, d, maxDist);
    if (t < 0) return null;
    const p = origin.clone().addScaledVector(d, t);
    return { distance: t, point: p, normal: hf.normal(p.x, p.z), collider: null, kind: 'heightfield' };
  }

  /** Is a capsule standing at (x, feetY, z) free of static / dynamic obstacles? */
  capsuleFree(x: number, feetY: number, z: number, radius = 0.3, halfHeight = 0.6, filter = groups(G.PLAYER, G.STATIC | G.CAR)): boolean {
    const R = this.R;
    const shape = new R.Capsule(halfHeight, radius);
    const c = this.world.intersectionWithShape({ x, y: feetY + radius + halfHeight + 0.05, z }, { x: 0, y: 0, z: 0, w: 1 }, shape, undefined, filter);
    return !c;
  }

  /** Is an oriented box free (used to place the car)? */
  boxFree(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number, filter = groups(G.CAR, G.STATIC | G.PLAYER | G.CAR)): boolean {
    const R = this.R;
    const shape = new R.Cuboid(hx, hy, hz);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const c = this.world.intersectionWithShape({ x, y, z }, { x: q.x, y: q.y, z: q.z, w: q.w }, shape, undefined, filter);
    return !c;
  }

  /** Ground height used by the physics (terrain surface incl. road offset). */
  groundAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /** Highest static surface below (x, y, z): roofs, bridge decks... or the terrain. */
  surfaceBelow(x: number, y: number, z: number, maxDrop = 400): number {
    const hit = this.raycast(new THREE.Vector3(x, y, z), new THREE.Vector3(0, -1, 0), maxDrop, groups(G.ALL, G.STATIC));
    return hit ? hit.point.y : this.groundAt(x, z);
  }

  stats(): Record<string, number> {
    let bodies = 0, colliders = 0;
    this.world.forEachRigidBody(() => { bodies++; });
    this.world.forEachCollider(() => { colliders++; });
    return {
      bodies, colliders, terrainTiles: this.terrain.count, statics: this.statics.count, queued: this.statics.queued,
      steps: this.steps, ms: Math.round(this.lastMs * 100) / 100,
    };
  }
}
