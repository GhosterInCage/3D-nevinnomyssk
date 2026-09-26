// Streamed terrain collision: square Rapier heightfield tiles (64 m, 2 m cells) sampled from
// the same Catmull-Rom bicubic surface the terrain module renders, created around interest
// points (player, car, toys) and evicted when nobody needs them any more.
//
// Road carriageways are drawn ~8.5 cm above the terrain by the roads module, so vertices that
// lie on a road get that offset (wheels and feet then touch the visible asphalt).
import type { HeightField } from '../../core/heightfield';
import { G, groups, type Collider, type Interest, type PhysicsSystem } from './system';

export const TILE = 64;
const CELLS = 32; // 2 m resolution
const ROAD_LIFT = 0.085;
const GROUND_LIFT = 0.02;

interface Tile { i: number; j: number; collider: Collider; used: number }

/** Catmull-Rom bicubic height over the shared HeightField (identical to terrain/sampling.ts). */
export function bicubicHeight(hf: HeightField, x: number, z: number): number {
  const n = hf.n, d = hf.data;
  let gx = (x + hf.half) / hf.res, gz = (z + hf.half) / hf.res;
  const mx = n - 1.001;
  gx = gx < 0 ? 0 : gx > mx ? mx : gx;
  gz = gz < 0 ? 0 : gz > mx ? mx : gz;
  const fx = Math.floor(gx), fz = Math.floor(gz);
  const tx = gx - fx, tz = gz - fz;
  const tx2 = tx * tx, tx3 = tx2 * tx, tz2 = tz * tz, tz3 = tz2 * tz;
  const wx0 = -0.5 * tx3 + tx2 - 0.5 * tx, wx1 = 1.5 * tx3 - 2.5 * tx2 + 1;
  const wx2 = -1.5 * tx3 + 2 * tx2 + 0.5 * tx, wx3 = 0.5 * tx3 - 0.5 * tx2;
  const wz0 = -0.5 * tz3 + tz2 - 0.5 * tz, wz1 = 1.5 * tz3 - 2.5 * tz2 + 1;
  const wz2 = -1.5 * tz3 + 2 * tz2 + 0.5 * tz, wz3 = 0.5 * tz3 - 0.5 * tz2;
  const last = n - 1;
  const c0 = fx - 1 < 0 ? 0 : fx - 1, c1 = fx, c2 = fx + 1 > last ? last : fx + 1, c3 = fx + 2 > last ? last : fx + 2;
  let h = 0;
  const wz = [wz0, wz1, wz2, wz3];
  for (let j = 0; j < 4; j++) {
    let jj = fz - 1 + j;
    jj = jj < 0 ? 0 : jj > last ? last : jj;
    const r = jj * n;
    h += (d[r + c0] * wx0 + d[r + c1] * wx1 + d[r + c2] * wx2 + d[r + c3] * wx3) * wz[j];
  }
  return h;
}

export class TerrainTiles {
  private tiles = new Map<number, Tile>();
  private clock = 0;
  /** tiles created per frame outside of forced updates */
  budget = 3;

  constructor(private sys: PhysicsSystem) {}

  get count(): number { return this.tiles.size; }

  private key(i: number, j: number): number { return (i + 4096) * 8192 + (j + 4096); }

  /** Physics ground height (bicubic terrain + road lift). */
  heightAt(x: number, z: number): number {
    const hf = this.sys.ctx.heightfield;
    if (!hf) return 0;
    return bicubicHeight(hf, x, z) + this.lift(x, z);
  }

  private roadsApi: any = undefined;
  private lift(x: number, z: number): number {
    if (this.roadsApi === undefined || this.roadsApi === null) this.roadsApi = this.sys.ctx.get('roads') ?? null;
    const r = this.roadsApi;
    if (r && typeof r.isRoad === 'function') {
      try { return r.isRoad(x, z, 0.3, true, false) ? ROAD_LIFT : GROUND_LIFT; } catch { return GROUND_LIFT; }
    }
    return GROUND_LIFT;
  }

  update(interests: readonly Interest[], force = false): void {
    this.clock++;
    const want: Array<[number, number, number]> = []; // i, j, distance
    for (const p of interests) {
      const r = p.terrainR;
      if (r <= 0) continue;
      const i0 = Math.floor((p.x - r) / TILE), i1 = Math.floor((p.x + r) / TILE);
      const j0 = Math.floor((p.z - r) / TILE), j1 = Math.floor((p.z + r) / TILE);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          // circle / square overlap
          const cx = Math.max(i * TILE, Math.min(p.x, (i + 1) * TILE));
          const cz = Math.max(j * TILE, Math.min(p.z, (j + 1) * TILE));
          const d = Math.hypot(cx - p.x, cz - p.z);
          if (d > r) continue;
          const k = this.key(i, j);
          const t = this.tiles.get(k);
          if (t) { t.used = this.clock; continue; }
          want.push([i, j, d]);
        }
      }
    }
    if (want.length) {
      want.sort((a, b) => a[2] - b[2]);
      const n = force ? want.length : Math.min(this.budget, want.length);
      for (let k = 0; k < n; k++) {
        const [i, j] = want[k];
        const key = this.key(i, j);
        if (this.tiles.has(key)) continue;
        try {
          this.tiles.set(key, { i, j, collider: this.build(i, j), used: this.clock });
        } catch (e) {
          console.error('[physics] terrain tile failed', e);
        }
      }
    }
    // evict tiles unused for a while (hysteresis against boundary thrashing)
    if (this.clock % 30 === 0) {
      for (const [k, t] of this.tiles) {
        if (this.clock - t.used > 90) {
          this.sys.world.removeCollider(t.collider, false);
          this.sys.kinds.delete(t.collider.handle);
          this.tiles.delete(k);
        }
      }
    }
  }

  private build(i: number, j: number): Collider {
    const R = this.sys.R;
    const hf = this.sys.ctx.heightfield;
    const n1 = CELLS + 1;
    const x0 = i * TILE, z0 = j * TILE;
    const step = TILE / CELLS;
    const h = new Float32Array(n1 * n1);
    // Rapier heightfield: rows along z, columns along x, column-major (col * (nrows + 1) + row)
    for (let c = 0; c < n1; c++) {
      const x = x0 + c * step;
      for (let r = 0; r < n1; r++) {
        const z = z0 + r * step;
        h[c * n1 + r] = (hf ? bicubicHeight(hf, x, z) : 0) + this.lift(x, z);
      }
    }
    const desc = R.ColliderDesc.heightfield(CELLS, CELLS, h, { x: TILE, y: 1, z: TILE }, R.HeightFieldFlags.FIX_INTERNAL_EDGES)
      .setTranslation(x0 + TILE / 2, 0, z0 + TILE / 2)
      .setFriction(0.9)
      .setRestitution(0.05)
      .setCollisionGroups(groups(G.STATIC, G.ALL));
    const col = this.sys.world.createCollider(desc);
    this.sys.kinds.set(col.handle, 'terrain');
    return col;
  }

  /** Drop every tile (e.g. after the height field was edited). */
  clear(): void {
    for (const t of this.tiles.values()) {
      this.sys.world.removeCollider(t.collider, false);
      this.sys.kinds.delete(t.collider.handle);
    }
    this.tiles.clear();
  }
}
