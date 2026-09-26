// Streams static colliders from ctx.colliderProviders (buildings, trees, landmarks, bridges,
// street furniture...) into the Rapier world around interest points. Colliders are keyed by the
// provider's stable key, created nearest-first under a per-frame time budget and removed a few
// seconds after they stop being returned by any query (hysteresis).
import earcut from 'earcut';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { StaticCollider } from '../../core/context';
import { G, groups, type Collider, type Interest, type PhysicsSystem } from './system';

interface Entry { collider: Collider | null; seen: number }
interface Pending { key: string; col: StaticCollider; d: number }

export class StaticStreamer {
  private active = new Map<string, Entry>();
  private byHandle = new Map<number, string>();
  private queue: Pending[] = [];
  private queuedKeys = new Set<string>();
  private lastRefresh = -1e9;
  private lastPts: Array<[number, number]> = [];
  private dirty = true;
  /** ms per frame spent creating colliders (outside of forced updates) */
  budgetMs = 2.5;
  failures = 0;

  constructor(private sys: PhysicsSystem) {
    sys.ctx.events.on('colliders:added', () => { this.dirty = true; });
  }

  get count(): number { return this.active.size; }
  get queued(): number { return this.queue.length; }
  keyOf(handle: number): string | undefined { return this.byHandle.get(handle); }

  invalidate(): void { this.dirty = true; }

  update(interests: readonly Interest[], force = false): void {
    const now = performance.now();
    // re-query when an interest point moved far enough, every 1.5 s, or when providers changed
    let moved = this.dirty || force || interests.length !== this.lastPts.length;
    if (!moved) {
      for (let k = 0; k < interests.length; k++) {
        const p = interests[k], q = this.lastPts[k];
        const lim = Math.max(4, p.staticR * 0.08);
        if (Math.abs(p.x - q[0]) > lim || Math.abs(p.z - q[1]) > lim) { moved = true; break; }
      }
    }
    if (moved || now - this.lastRefresh > 1500) {
      this.refresh(interests, now);
      this.lastRefresh = now;
      this.lastPts = interests.map((p) => [p.x, p.z]);
      this.dirty = false;
    }
    this.drain(force ? Infinity : this.budgetMs);
  }

  private refresh(interests: readonly Interest[], now: number): void {
    const providers = this.sys.ctx.colliderProviders;
    const fresh = new Map<string, Pending>();
    for (const p of interests) {
      if (p.staticR <= 0) continue;
      for (const prov of providers) {
        let list: StaticCollider[];
        try { list = prov.query(p.x, p.z, p.staticR) ?? []; } catch (e) { console.warn(`[physics] collider provider ${prov.id} failed`, e); continue; }
        for (const c of list) {
          if (!c || !c.key) continue;
          const e = this.active.get(c.key);
          if (e) { e.seen = now; continue; }
          const d = approxDist(c, p.x, p.z);
          const f = fresh.get(c.key);
          if (!f || d < f.d) fresh.set(c.key, { key: c.key, col: c, d });
        }
      }
    }
    // rebuild the queue: fresh colliders, nearest first
    this.queue = [...fresh.values()].sort((a, b) => b.d - a.d); // pop() from the end = nearest
    this.queuedKeys = new Set(fresh.keys());
    // remove colliders not seen for a while
    for (const [k, e] of this.active) {
      if (now - e.seen > 4000) {
        if (e.collider) {
          this.byHandle.delete(e.collider.handle);
          this.sys.kinds.delete(e.collider.handle);
          this.sys.world.removeCollider(e.collider, true);
        }
        this.active.delete(k);
      }
    }
  }

  private drain(budgetMs: number): void {
    if (!this.queue.length) return;
    const t0 = performance.now();
    const now = t0;
    while (this.queue.length) {
      const p = this.queue.pop()!;
      this.queuedKeys.delete(p.key);
      if (this.active.has(p.key)) continue;
      let col: Collider | null = null;
      try {
        col = this.create(p.col);
      } catch (e) {
        this.failures++;
        if (this.failures < 5) console.warn('[physics] static collider failed', p.key, e);
      }
      this.active.set(p.key, { collider: col, seen: now });
      if (col) {
        this.byHandle.set(col.handle, p.key);
        this.sys.kinds.set(col.handle, 'static');
      }
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  private create(c: StaticCollider): Collider | null {
    const R = this.sys.R;
    let desc: RAPIER_NS.ColliderDesc | null = null;
    switch (c.kind) {
      case 'box': {
        const [hx, hy, hz] = c.halfExtents;
        if (!(hx > 0 && hy > 0 && hz > 0)) return null;
        const a = (c.rotationY || 0) / 2;
        desc = R.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(c.center[0], c.center[1], c.center[2])
          .setRotation({ x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) });
        break;
      }
      case 'cylinder': {
        if (!(c.radius > 0 && c.halfHeight > 0)) return null;
        desc = R.ColliderDesc.cylinder(c.halfHeight, c.radius).setTranslation(c.center[0], c.center[1], c.center[2]);
        break;
      }
      case 'trimesh': {
        if (!c.vertices?.length || !c.indices?.length) return null;
        desc = R.ColliderDesc.trimesh(c.vertices, c.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES);
        break;
      }
      case 'prism': {
        desc = prismDesc(R, c.ring, c.minY, c.maxY);
        break;
      }
    }
    if (!desc) return null;
    desc.setFriction(0.7).setRestitution(0.1).setCollisionGroups(groups(G.STATIC, G.ALL));
    return this.sys.world.createCollider(desc);
  }

  clear(): void {
    for (const e of this.active.values()) {
      if (e.collider) {
        this.sys.kinds.delete(e.collider.handle);
        this.sys.world.removeCollider(e.collider, true);
      }
    }
    this.active.clear();
    this.byHandle.clear();
    this.queue = [];
    this.queuedKeys.clear();
    this.dirty = true;
  }
}

function approxDist(c: StaticCollider, x: number, z: number): number {
  switch (c.kind) {
    case 'box': case 'cylinder': return Math.hypot(c.center[0] - x, c.center[2] - z);
    case 'prism': {
      let best = Infinity;
      const r = c.ring;
      for (let i = 0; i + 1 < r.length; i += 2) best = Math.min(best, (r[i] - x) ** 2 + (r[i + 1] - z) ** 2);
      return Math.sqrt(best);
    }
    case 'trimesh': {
      const v = c.vertices;
      return v.length >= 3 ? Math.hypot(v[0] - x, v[2] - z) : 0;
    }
  }
  return 0;
}

/** Extruded footprint: convex hull when the ring is convex, otherwise a closed trimesh. */
function prismDesc(R: typeof RAPIER_NS, ringIn: ArrayLike<number>, minY: number, maxY: number): RAPIER_NS.ColliderDesc | null {
  if (!(maxY > minY) || !ringIn || ringIn.length < 6) return null;
  // copy, drop closing duplicate and near-duplicate vertices
  const pts: number[] = [];
  for (let i = 0; i + 1 < ringIn.length; i += 2) {
    const x = ringIn[i], z = ringIn[i + 1];
    const n = pts.length;
    if (n >= 2 && Math.abs(pts[n - 2] - x) < 0.02 && Math.abs(pts[n - 1] - z) < 0.02) continue;
    pts.push(x, z);
  }
  if (pts.length >= 4 && Math.abs(pts[0] - pts[pts.length - 2]) < 0.02 && Math.abs(pts[1] - pts[pts.length - 1]) < 0.02) pts.length -= 2;
  const n = pts.length / 2;
  if (n < 3) return null;
  // orientation + convexity
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  if (Math.abs(area) < 0.5) return null;
  const sgn = Math.sign(area);
  let convex = true;
  for (let i = 0; i < n && convex; i++) {
    const a = (i + n - 1) % n, b = (i + 1) % n;
    const ax = pts[i * 2] - pts[a * 2], az = pts[i * 2 + 1] - pts[a * 2 + 1];
    const bx = pts[b * 2] - pts[i * 2], bz = pts[b * 2 + 1] - pts[i * 2 + 1];
    const cr = ax * bz - az * bx;
    if (cr * sgn < -1e-3 * Math.hypot(ax, az) * Math.hypot(bx, bz)) convex = false;
  }
  // local coordinates around the centroid keep f32 precision high
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; }
  cx /= n; cz /= n;
  const cy = (minY + maxY) / 2, hy = (maxY - minY) / 2;
  if (convex && n <= 64) {
    const v = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2] - cx, z = pts[i * 2 + 1] - cz;
      v.set([x, -hy, z, x, hy, z], i * 6);
    }
    const d = R.ColliderDesc.convexHull(v);
    if (d) return d.setTranslation(cx, cy, cz);
  }
  // concave: walls + earcut caps
  const v = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2] - cx, z = pts[i * 2 + 1] - cz;
    v[i * 3] = x; v[i * 3 + 1] = -hy; v[i * 3 + 2] = z;
    v[(n + i) * 3] = x; v[(n + i) * 3 + 1] = hy; v[(n + i) * 3 + 2] = z;
  }
  const flat: number[] = [];
  for (let i = 0; i < n; i++) flat.push(pts[i * 2] - cx, pts[i * 2 + 1] - cz);
  const tri = earcut(flat);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, j, n + j, i, n + j, n + i);
  }
  for (let k = 0; k < tri.length; k += 3) {
    idx.push(tri[k], tri[k + 2], tri[k + 1]);           // bottom
    idx.push(n + tri[k], n + tri[k + 1], n + tri[k + 2]); // top
  }
  return R.ColliderDesc.trimesh(v, new Uint32Array(idx), R.TriMeshFlags.FIX_INTERNAL_EDGES).setTranslation(cx, cy, cz);
}
