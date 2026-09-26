// Building mesh generation (runs inside the worker; no three.js dependency).
//
// One merged geometry per tile. Vertex layout (all consumed by the building material):
//   position f32x3 (tile-local x/z, absolute y), normal f32x3, uv f32x2
//   aA  u8x4  [kind, style, seed, levels]
//   aC  u8x4n [r, g, b, aux]            sRGB colour + aux byte
//   aW  u16x4 [wallLen cm, cellW cm, nCols | secCols<<8, flags | floorH dm << 8]
// Kinds: see K below. uv for walls: (metres along the wall, metres above the floor base);
// roofs: (metres along the eave, metres up the slope); flat roofs: tile-local (x, z).
import earcut from 'earcut';
import {
  type BuildingData, REC_SIZE, R, FLAG, Typ, Roof, Wall, RoofMat, decodeRings, decodeParts, type RoofPart, FENCE_SIZE,
} from './format';

export const K = {
  Wall: 0, RoofPitched: 1, RoofFlat: 2, Plain: 3, BalconyFront: 4, Slab: 5, Glazing: 6, Metal: 7,
  Soffit: 8, Lamp: 9, Door: 10, Fence: 11,
} as const;

/** Wall flag bits (aW.w low byte). */
export const WF = { Entrance: 1, Shop: 2, Gable: 4, Balcony: 8, Hole: 16, Parapet: 32 } as const;

export interface TileMesh {
  position: Float32Array; normal: Float32Array; uv: Float32Array;
  aA: Uint8Array; aC: Uint8Array; aW: Uint16Array; index: Uint32Array;
  /** linear albedo approximation (u8 normalised) for the path tracer / proxy materials */
  color: Uint8Array;
  bbox: [number, number, number, number, number, number];
  tris: number;
}

/** sRGB byte -> linear byte */
const LIN = new Uint8Array(256).map((_, i) => Math.round(Math.pow(i / 255, 2.2) * 255));

// ------------------------------------------------------------------ growable buffers
class Buf {
  n = 0; // vertex count
  pos: Float32Array; nor: Float32Array; uv: Float32Array;
  a: Uint8Array; c: Uint8Array; w: Uint16Array; col: Uint8Array;
  idx: Uint32Array; ni = 0;
  cap: number; icap: number;
  // current attribute state
  kind = 0; style = 0; seed = 0; levels = 0;
  cr = 200; cg = 200; cb = 200; aux = 0;
  w0 = 0; w1 = 0; w2 = 0; w3 = 0;
  minX = Infinity; minY = Infinity; minZ = Infinity; maxX = -Infinity; maxY = -Infinity; maxZ = -Infinity;

  constructor(cap = 4096) {
    this.cap = cap; this.icap = cap * 2;
    this.pos = new Float32Array(cap * 3); this.nor = new Float32Array(cap * 3); this.uv = new Float32Array(cap * 2);
    this.a = new Uint8Array(cap * 4); this.c = new Uint8Array(cap * 4); this.w = new Uint16Array(cap * 4);
    this.col = new Uint8Array(cap * 3);
    this.idx = new Uint32Array(this.icap);
  }

  private grow(nv: number, ni: number): void {
    if (this.n + nv > this.cap) {
      let c = this.cap * 2;
      while (this.n + nv > c) c *= 2;
      const g = <T extends Float32Array | Uint8Array | Uint16Array>(a: T, k: number): T => {
        const b = new (a.constructor as any)(c * k) as T; b.set(a); return b;
      };
      this.pos = g(this.pos, 3); this.nor = g(this.nor, 3); this.uv = g(this.uv, 2);
      this.a = g(this.a, 4); this.c = g(this.c, 4); this.w = g(this.w, 4); this.col = g(this.col, 3);
      this.cap = c;
    }
    if (this.ni + ni > this.icap) {
      let c = this.icap * 2;
      while (this.ni + ni > c) c *= 2;
      const b = new Uint32Array(c); b.set(this.idx); this.idx = b; this.icap = c;
    }
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const i = this.n++;
    this.pos[3 * i] = x; this.pos[3 * i + 1] = y; this.pos[3 * i + 2] = z;
    this.nor[3 * i] = nx; this.nor[3 * i + 1] = ny; this.nor[3 * i + 2] = nz;
    this.uv[2 * i] = u; this.uv[2 * i + 1] = v;
    const a = 4 * i;
    this.a[a] = this.kind; this.a[a + 1] = this.style; this.a[a + 2] = this.seed; this.a[a + 3] = this.levels;
    this.c[a] = this.cr; this.c[a + 1] = this.cg; this.c[a + 2] = this.cb; this.c[a + 3] = this.aux;
    this.w[a] = this.w0; this.w[a + 1] = this.w1; this.w[a + 2] = this.w2; this.w[a + 3] = this.w3;
    // approximate linear albedo: walls are darkened by their windows, glass is dark
    const k = this.kind === 0 ? 0.78 : this.kind === 6 ? 0.25 : 1.0;
    this.col[3 * i] = LIN[this.cr] * k; this.col[3 * i + 1] = LIN[this.cg] * k; this.col[3 * i + 2] = LIN[this.cb] * k;
    if (x < this.minX) this.minX = x; if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y; if (y > this.maxY) this.maxY = y;
    if (z < this.minZ) this.minZ = z; if (z > this.maxZ) this.maxZ = z;
    return i;
  }

  reserve(nv: number, ni: number): void { this.grow(nv, ni); }

  tri(a: number, b: number, c: number): void {
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }

  /** Quad from 4 points (counter-clockwise seen from the normal side). */
  quad(p: number[], n: [number, number, number], uv: number[]): void {
    this.grow(4, 6);
    // winding follows the declared normal (front faces are counter-clockwise)
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    const i0 = this.vert(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1]);
    const i1 = this.vert(p[3], p[4], p[5], n[0], n[1], n[2], uv[2], uv[3]);
    const i2 = this.vert(p[6], p[7], p[8], n[0], n[1], n[2], uv[4], uv[5]);
    const i3 = this.vert(p[9], p[10], p[11], n[0], n[1], n[2], uv[6], uv[7]);
    if (flip) { this.tri(i0, i2, i1); this.tri(i0, i3, i2); } else { this.tri(i0, i1, i2); this.tri(i0, i2, i3); }
  }

  /** Triangle with explicit normal and uvs; winding follows the normal. */
  triN(A: number[], B: number[], C: number[], n: [number, number, number], ua: number[], ub: number[], uc: number[]): void {
    this.grow(3, 3);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const i0 = this.vert(A[0], A[1], A[2], n[0], n[1], n[2], ua[0], ua[1]);
    const i1 = this.vert(B[0], B[1], B[2], n[0], n[1], n[2], ub[0], ub[1]);
    const i2 = this.vert(C[0], C[1], C[2], n[0], n[1], n[2], uc[0], uc[1]);
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) this.tri(i0, i2, i1); else this.tri(i0, i1, i2);
  }

  /** Axis-aligned-in-local-frame box: centre (x,y,z), half sizes along d (dir), up, and p (perp). */
  /**
   * Oriented box: centre (x,y,z), half sizes along d=(dx,dz), up, and p=(-dz,dx).
   * faces bitmask: 1 +p, 2 -p, 4 +d, 8 -d, 16 top, 32 bottom (default: all but bottom).
   */
  box(x: number, y: number, z: number, dx: number, dz: number, hl: number, hh: number, hw: number, uvScale = 1, skipBottom = true, faces = 31): void {
    if (!skipBottom) faces |= 32;
    const px = -dz, pz = dx; // perpendicular
    const cx = (sl: number, sw: number) => x + dx * hl * sl + px * hw * sw;
    const cz = (sl: number, sw: number) => z + dz * hl * sl + pz * hw * sw;
    const y0 = y - hh, y1 = y + hh;
    const L = 2 * hl * uvScale, W = 2 * hw * uvScale, H = 2 * hh * uvScale;
    if (faces & 1) this.quad([cx(1, 1), y0, cz(1, 1), cx(-1, 1), y0, cz(-1, 1), cx(-1, 1), y1, cz(-1, 1), cx(1, 1), y1, cz(1, 1)], [px, 0, pz], [0, 0, L, 0, L, H, 0, H]);
    if (faces & 2) this.quad([cx(-1, -1), y0, cz(-1, -1), cx(1, -1), y0, cz(1, -1), cx(1, -1), y1, cz(1, -1), cx(-1, -1), y1, cz(-1, -1)], [-px, 0, -pz], [0, 0, L, 0, L, H, 0, H]);
    if (faces & 4) this.quad([cx(1, -1), y0, cz(1, -1), cx(1, 1), y0, cz(1, 1), cx(1, 1), y1, cz(1, 1), cx(1, -1), y1, cz(1, -1)], [dx, 0, dz], [0, 0, W, 0, W, H, 0, H]);
    if (faces & 8) this.quad([cx(-1, 1), y0, cz(-1, 1), cx(-1, -1), y0, cz(-1, -1), cx(-1, -1), y1, cz(-1, -1), cx(-1, 1), y1, cz(-1, 1)], [-dx, 0, -dz], [0, 0, W, 0, W, H, 0, H]);
    if (faces & 16) this.quad([cx(-1, -1), y1, cz(-1, -1), cx(1, -1), y1, cz(1, -1), cx(1, 1), y1, cz(1, 1), cx(-1, 1), y1, cz(-1, 1)], [0, 1, 0], [0, 0, L, 0, L, W, 0, W]);
    if (faces & 32) this.quad([cx(-1, 1), y0, cz(-1, 1), cx(1, 1), y0, cz(1, 1), cx(1, -1), y0, cz(1, -1), cx(-1, -1), y0, cz(-1, -1)], [0, -1, 0], [0, 0, L, 0, L, W, 0, W]);
  }

  result(): TileMesh {
    const n = this.n, ni = this.ni;
    return {
      position: this.pos.slice(0, n * 3), normal: this.nor.slice(0, n * 3), uv: this.uv.slice(0, n * 2),
      aA: this.a.slice(0, n * 4), aC: this.c.slice(0, n * 4), aW: this.w.slice(0, n * 4),
      color: this.col.slice(0, n * 3),
      index: this.idx.slice(0, ni),
      bbox: n ? [this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ] : [0, 0, 0, 0, 0, 0],
      tris: ni / 3,
    };
  }
}

// ------------------------------------------------------------------ helpers
function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function signedArea(r: Float64Array): number {
  let s = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) s += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return s / 2;
}

function reverseRing(r: Float64Array): Float64Array {
  const n = r.length / 2;
  const o = new Float64Array(r.length);
  for (let i = 0; i < n; i++) { o[2 * i] = r[2 * (n - 1 - i)]; o[2 * i + 1] = r[2 * (n - 1 - i) + 1]; }
  return o;
}

function dirToVec(b: number): [number, number] {
  const a = (b / 256) * Math.PI * 2;
  return [Math.sin(a), Math.cos(a)];
}

/** Window bay width (m) per facade style. */
export function cellWidth(style: number, seed: number): number {
  const j = (seed % 7) / 7;
  switch (style) {
    case Wall.HousePlaster: case Wall.HouseBrick: case Wall.HouseSiding: return 3.2 + j * 1.2;
    case Wall.Panel5: return 3.2;
    case Wall.Brick5: return 3.0 + j * 0.4;
    case Wall.Panel9: return 3.0 + (seed % 2) * 0.6;
    case Wall.Stalinka: return 3.3 + j * 0.5;
    case Wall.School: return 3.0;
    case Wall.Commercial: return 4.5 + j * 1.5;
    case Wall.Industrial: return 6.0;
    case Wall.Garage: return 3.3;
    case Wall.Warehouse: return 6.0;
    case Wall.Glass: return 1.0;
    case Wall.Modern: return 3.2 + j * 0.6;
    case Wall.Public: return 3.3 + j * 0.6;
    default: return 3.5;
  }
}

function sectionLen(typ: number): number {
  switch (typ) {
    case Typ.Khrushchevka: return 17;
    case Typ.Panel9: return 24;
    case Typ.Tower: return 60;
    case Typ.Stalinka: return 22;
    case Typ.LowriseApt: return 18;
    case Typ.ModernApt: return 24;
    case Typ.School: case Typ.Kindergarten: case Typ.Public: return 45;
    default: return 0;
  }
}

const isApt = (t: number) => t === Typ.Khrushchevka || t === Typ.Panel9 || t === Typ.Tower || t === Typ.Stalinka || t === Typ.LowriseApt || t === Typ.ModernApt;

// ------------------------------------------------------------------ building mesher

export interface GroundInfo {
  /** per building: [gMin, gMax] */
  ground: Float32Array;
}

interface Ctx {
  d: BuildingData;
  ox: number; oz: number;
  base: Buf;       // walls + roofs (all LODs)
  det: Buf | null; // detail geometry (near LOD only)
}

/**
 * Build the merged mesh for one or more data tiles, relative to (ox, oz).
 * detail=false: base mesh only (walls + roofs); detail=true: also the near-LOD detail mesh.
 */
export function buildTiles(d: BuildingData, tiles: number[], ox: number, oz: number, ground: Float32Array, hidden: Uint8Array, detail: boolean, fground?: Float32Array | null): { base: TileMesh; det: TileMesh | null; count: number } {
  const c: Ctx = { d, ox, oz, base: new Buf(8192), det: detail ? new Buf(8192) : null };
  let count = 0;
  for (const tile of tiles) {
    if (c.det && fground && d.nFences) {
      try { fences(c.det, d, tile, ox, oz, fground); } catch (err) { console.warn('[buildings] fences failed', tile, err); }
    }
    const s = d.tileStart[tile], e = d.tileStart[tile + 1];
    for (let i = s; i < e; i++) {
      if (hidden[i]) continue;
      try {
        building(c, i, ground[2 * i], ground[2 * i + 1]);
        count++;
      } catch (err) {
        // never let one bad footprint break a tile
        if (count < 3) console.warn('[buildings] mesh failed for', i, err);
      }
    }
  }
  return { base: c.base.result(), det: c.det ? c.det.result() : null, count };
}

export function buildTile(d: BuildingData, tile: number, ground: Float32Array, hidden: Uint8Array, detail: boolean, fground?: Float32Array | null): { base: TileMesh; det: TileMesh | null; count: number } {
  const tx = tile % d.tilesX, tz = Math.floor(tile / d.tilesX);
  return buildTiles(d, [tile], d.originX + (tx + 0.5) * d.tileSize, d.originZ + (tz + 0.5) * d.tileSize, ground, hidden, detail, fground);
}

/** World-space endpoints of fence f (x0, z0, x1, z1). */
export function fenceEnds(d: BuildingData, f: number, tile: number): [number, number, number, number] {
  const o = d.fenceOff + f * FENCE_SIZE;
  const tx = tile % d.tilesX, tz = Math.floor(tile / d.tilesX);
  const cx = d.originX + (tx + 0.5) * d.tileSize, cz = d.originZ + (tz + 0.5) * d.tileSize;
  const dv = d.dv;
  return [cx + dv.getInt16(o, true) * 0.01, cz + dv.getInt16(o + 2, true) * 0.01, cx + dv.getInt16(o + 4, true) * 0.01, cz + dv.getInt16(o + 6, true) * 0.01];
}

/** Plot fences of one data tile (near LOD only). fground: [h0, h1] per fence. */
function fences(b: Buf, d: BuildingData, tile: number, ox: number, oz: number, fground: Float32Array): void {
  const s = d.fenceStart[tile], e = d.fenceStart[tile + 1];
  const dv = d.dv;
  for (let f = s; f < e; f++) {
    const o = d.fenceOff + f * FENCE_SIZE;
    const [wx0, wz0, wx1, wz1] = fenceEnds(d, f, tile);
    const x0 = wx0 - ox, z0 = wz0 - oz, x1 = wx1 - ox, z1 = wz1 - oz;
    const type = dv.getUint8(o + 8);
    const h = dv.getUint8(o + 9) / 10;
    const r = dv.getUint8(o + 10), g = dv.getUint8(o + 11), bl = dv.getUint8(o + 12);
    const seed = dv.getUint8(o + 13);
    const g0 = fground[2 * f], g1 = fground[2 * f + 1];
    const dx = x1 - x0, dz = z1 - z0;
    const L = Math.hypot(dx, dz);
    if (L < 0.3) continue;
    const tx = dx / L, tz = dz / L;
    const nx = -tz, nz = tx;
    const clear = type === 1 ? 0.25 : 0.05; // brick plinth / gap above ground
    b.kind = K.Fence; b.style = type; b.seed = seed; b.levels = 0;
    b.cr = r; b.cg = g; b.cb = bl; b.aux = seed;
    b.w0 = Math.round(L * 100); b.w1 = 0; b.w2 = 0; b.w3 = 0;
    const yb0 = g0 - 0.25, yb1 = g1 - 0.25, yt0 = g0 + h, yt1 = g1 + h;
    // both faces (fences are seen from the street and from the yard)
    b.quad([x0, yb0, z0, x1, yb1, z1, x1, yt1, z1, x0, yt0, z0], [nx, 0, nz], [0, -0.25, L, -0.25, L, h, 0, h]);
    b.quad([x1, yb1, z1, x0, yb0, z0, x0, yt0, z0, x1, yt1, z1], [-nx, 0, -nz], [L, -0.25, 0, -0.25, 0, h, L, h]);
    if (type === 1) {
      // brick pillar at the start + low brick plinth
      b.kind = K.Wall; b.style = Wall.HouseBrick; b.cr = 150; b.cg = 76; b.cb = 54; b.aux = 0;
      b.w0 = 40; b.w1 = 300; b.w2 = 0; b.w3 = WF.Parapet;
      b.box(x0, g0 + (h + 0.2) / 2 - 0.1, z0, tx, tz, 0.2, (h + 0.2) / 2 + 0.1, 0.2, 1);
      b.kind = K.Metal; b.cr = 90; b.cg = 90; b.cb = 90; b.aux = 0;
      b.box(x0, g0 + h + 0.15, z0, tx, tz, 0.24, 0.03, 0.24);
      b.kind = K.Wall; b.style = Wall.HouseBrick; b.cr = 150; b.cg = 76; b.cb = 54; b.w0 = Math.round(L * 100); b.w3 = WF.Parapet;
      b.box((x0 + x1) / 2, (g0 + g1) / 2 + clear / 2 - 0.1, (z0 + z1) / 2, tx, tz, L / 2, clear / 2 + 0.1, 0.1, 1, true, 1 | 2 | 16);
    } else {
      // steel posts
      b.kind = K.Metal; b.cr = 60; b.cg = 60; b.cb = 60; b.aux = 0;
      b.box(x0 + nx * 0.04, g0 + h / 2, z0 + nz * 0.04, tx, tz, 0.03, h / 2 + 0.05, 0.03, 1, true, 1 | 2 | 4 | 8);
    }
  }
}

/** Floor base (ground floor level) for a building given ground range under it. */
export function floorBase(gMin: number, gMax: number, socle: number): number {
  return Math.max(gMin, gMax - 1.2) + socle;
}

function building(c: Ctx, i: number, gMin: number, gMax: number): void {
  const d = c.d;
  const o = d.recOff + i * REC_SIZE;
  const dv = d.dv;
  const height = dv.getUint16(o + R.height, true) / 10;
  const levels = dv.getUint8(o + R.levels);
  const typ = dv.getUint8(o + R.typology);
  const roofShape = dv.getUint8(o + R.roofShape);
  const style = dv.getUint8(o + R.wallStyle);
  const rmat = dv.getUint8(o + R.roofMat);
  const wr = dv.getUint8(o + R.wallRGB), wg = dv.getUint8(o + R.wallRGB + 1), wb = dv.getUint8(o + R.wallRGB + 2);
  const rr = dv.getUint8(o + R.roofRGB), rg = dv.getUint8(o + R.roofRGB + 1), rb = dv.getUint8(o + R.roofRGB + 2);
  const seed = dv.getUint8(o + R.seed);
  const flags = dv.getUint8(o + R.flags);
  const entB = dv.getUint8(o + R.entranceDir);
  const streetB = dv.getUint8(o + R.streetDir);
  const floorH = Math.max(2, dv.getUint8(o + R.floorH) / 10);
  const minH = dv.getUint8(o + R.minHeight);
  const socle = dv.getUint8(o + R.socle) / 10;
  const pitchDeg = dv.getUint8(o + R.roofPitch);
  const overhang = dv.getUint8(o + R.overhang) / 200;

  const rings = decodeRings(d, i, c.ox, c.oz);
  if (!rings.length || rings[0].length < 6) return;
  // orientation: outer ring negative signed area (x,z), holes positive
  if (signedArea(rings[0]) > 0) rings[0] = reverseRing(rings[0]);
  for (let k = 1; k < rings.length; k++) if (signedArea(rings[k]) < 0) rings[k] = reverseRing(rings[k]);

  const fb = floorBase(gMin, gMax, socle);
  const bottom = minH > 0 ? fb + minH : gMin - 1.0;
  const top = fb + height;
  const b = c.base;
  const ent = flags & FLAG.ENTRANCE ? dirToVec(entB) : null;
  const street = flags & FLAG.SHOP ? dirToVec(streetB) : null;
  const cellW0 = cellWidth(style, seed);
  const secLen = sectionLen(typ);
  const apt = isApt(typ);

  // ---------------------------------------------------------------- walls
  b.kind = K.Wall; b.style = style; b.seed = seed; b.levels = levels;
  b.cr = wr; b.cg = wg; b.cb = wb; b.aux = typ;
  const fhdm = Math.min(255, Math.round(floorH * 10));
  const wallsInfo: Array<{ ax: number; az: number; bx: number; bz: number; L: number; nx: number; nz: number; nCols: number; cellW: number; margin: number; secCols: number; entrance: boolean; shop: boolean; hole: boolean }> = [];
  // longest outer wall: end walls (torets) of elongated slab blocks are mostly blank
  let longest = 0;
  {
    const r0 = rings[0], n0 = r0.length / 2;
    for (let k = 0; k < n0; k++) {
      const L = Math.hypot(r0[2 * ((k + 1) % n0)] - r0[2 * k], r0[2 * ((k + 1) % n0) + 1] - r0[2 * k + 1]);
      if (L > longest) longest = L;
    }
  }
  const slab = (typ === Typ.Khrushchevka || typ === Typ.Panel9 || typ === Typ.LowriseApt || typ === Typ.ModernApt) && longest > 30;
  const endWallMode = hash(seed, 77) < 0.5 ? 0 : 1; // 0 blank, 1 two corner-room windows
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const n = ring.length / 2;
    for (let k = 0; k < n; k++) {
      const ax = ring[2 * k], az = ring[2 * k + 1];
      const bx = ring[2 * ((k + 1) % n)], bz = ring[2 * ((k + 1) % n) + 1];
      const dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 0.05) continue;
      const nx = -dz / L, nz = dx / L;
      let cellW = cellW0;
      let nCols = Math.floor((L - 0.8) / cellW);
      if (nCols < 1) { nCols = L > 2.0 && style !== Wall.Plain ? 1 : 0; cellW = Math.min(cellW, L - 0.4); }
      if (slab && r === 0 && L < 16.5 && L < longest * 0.4) {
        if (endWallMode === 0) nCols = 0;
        else { nCols = 2; cellW = Math.min(L / 2 - 0.3, 5.5); }
      }
      // stretch cells slightly to fill the wall evenly
      if (nCols >= 2) {
        const want = (L - 1.2) / nCols;
        if (Math.abs(want - cellW) < 0.35) cellW = want;
      }
      const margin = (L - nCols * cellW) / 2;
      let secCols = 0;
      const entrance = !!ent && r === 0 && nx * ent[0] + nz * ent[1] > 0.8 && L > 8;
      const shop = !!street && r === 0 && nx * street[0] + nz * street[1] > 0.8 && L > 6;
      if (secLen > 0 && nCols >= 3) {
        const nSec = Math.max(1, Math.round(L / secLen));
        secCols = Math.max(2, Math.min(15, Math.round(nCols / nSec)));
      }
      let wf = 0;
      if (entrance) wf |= WF.Entrance;
      if (shop) wf |= WF.Shop;
      if (r > 0) wf |= WF.Hole;
      if (flags & FLAG.BALCONY) wf |= WF.Balcony;
      b.w0 = Math.min(65535, Math.round(L * 100));
      b.w1 = Math.min(65535, Math.round(cellW * 100));
      b.w2 = Math.min(255, nCols) | (secCols << 8);
      b.w3 = wf | (fhdm << 8);
      const v0 = bottom - fb, v1 = top - fb;
      b.quad([ax, bottom, az, bx, bottom, bz, bx, top, bz, ax, top, az], [nx, 0, nz], [0, v0, L, v0, L, v1, 0, v1]);
      wallsInfo.push({ ax, az, bx, bz, L, nx, nz, nCols, cellW, margin, secCols, entrance, shop, hole: r > 0 });
    }
  }

  // ---------------------------------------------------------------- roof
  const parts = roofShape !== Roof.Flat ? decodeParts(d, i, c.ox, c.oz) : [];
  if (parts.length === 0) {
    flatRoof(b, rings, top, rr, rg, rb, rmat, seed, typ);
  } else {
    const pitch = (Math.max(3, pitchDeg) * Math.PI) / 180;
    for (const p of parts) {
      pitchedRoof(c, p, roofShape, pitch, overhang, top, fb, { style, seed, levels, wr, wg, wb, typ, fhdm }, { rr, rg, rb, rmat });
    }
  }

  // ---------------------------------------------------------------- details (near LOD)
  if (c.det) {
    const det = c.det;
    det.seed = seed; det.levels = levels;
    if (parts.length === 0 && typ !== Typ.Greenhouse) parapet(det, rings, top, typ, style, seed, wr, wg, wb, levels, fhdm);
    if (apt || typ === Typ.School || typ === Typ.Kindergarten || typ === Typ.Public || typ === Typ.Commercial || typ === Typ.Mall) {
      facadeDetails(det, i, wallsInfo, fb, top, floorH, levels, typ, style, seed, flags, wr, wg, wb);
    }
    try { gasPipes(det, i, wallsInfo, fb, gMin, floorH, levels, typ); } catch { /* cosmetic */ }
    if (parts.length === 0) roofEquipment(det, i, rings, wallsInfo, top, typ, seed, levels);
    else houseDetails(det, i, parts, roofShape, top, fb, gMin, overhang, (Math.max(3, pitchDeg) * Math.PI) / 180, typ, seed, rings, rr, rg, rb, wallsInfo);
  }
}

// ------------------------------------------------------------------ flat roof
function flatRoof(b: Buf, rings: Float64Array[], y: number, rr: number, rg: number, rb: number, rmat: number, seed: number, typ: number): void {
  const flat: number[] = [];
  const holes: number[] = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holes.push(flat.length / 2);
    const ring = rings[r];
    for (let k = 0; k < ring.length; k++) flat.push(ring[k]);
  }
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  if (!tris.length) return;
  b.kind = K.RoofFlat; b.style = rmat; b.seed = seed;
  b.cr = rr; b.cg = rg; b.cb = rb; b.aux = typ;
  b.w0 = 0; b.w1 = 0; b.w2 = 0; b.w3 = 0;
  const nv = flat.length / 2;
  b.reserve(nv, tris.length);
  const base = b.n;
  for (let k = 0; k < nv; k++) b.vert(flat[2 * k], y, flat[2 * k + 1], 0, 1, 0, flat[2 * k], flat[2 * k + 1]);
  // earcut output winding follows the input; our outer ring is CW in (x,z) which is CCW seen from +y? ensure up-facing
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k], bb = tris[k + 1], cc = tris[k + 2];
    // cross product y component of (b-a) x (c-a) using x,z: positive means CCW when viewed from +y in a right-handed (x, -z) sense
    const ax = flat[2 * a], az = flat[2 * a + 1];
    const cr = (flat[2 * bb] - ax) * (flat[2 * cc + 1] - az) - (flat[2 * bb + 1] - az) * (flat[2 * cc] - ax);
    if (cr < 0) b.tri(base + a, base + bb, base + cc); else b.tri(base + a, base + cc, base + bb);
  }
}

// ------------------------------------------------------------------ pitched roofs
interface WallAttr { style: number; seed: number; levels: number; wr: number; wg: number; wb: number; typ: number; fhdm: number }
interface RoofAttr { rr: number; rg: number; rb: number; rmat: number }

/** Emit one sloped face (polygon, 3 or 4 points) with roof UVs. */
function roofFace(b: Buf, pts: number[][], yE: number, sinP: number): void {
  // normal from first three points
  const [p0, p1, p2] = pts;
  const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
  const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  let flip = false;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; flip = true; }
  // eave direction e (horizontal, perpendicular to the slope)
  const hl = Math.hypot(nx, nz) || 1;
  const ex = -nz / hl, ez = nx / hl;
  b.reserve(pts.length, (pts.length - 2) * 3);
  const base = b.n;
  // slope length (eave -> ridge) for ridge caps in the shader
  let yTop = -Infinity;
  for (const p of pts) yTop = Math.max(yTop, p[1]);
  const w0 = b.w0;
  b.w0 = Math.min(65535, Math.round(((yTop - yE) / Math.max(0.05, sinP)) * 100));
  for (const p of pts) b.vert(p[0], p[1], p[2], nx, ny, nz, p[0] * ex + p[2] * ez, (p[1] - yE) / Math.max(0.05, sinP));
  b.w0 = w0;
  for (let k = 1; k + 1 < pts.length; k++) {
    if (flip) b.tri(base, base + k + 1, base + k); else b.tri(base, base + k, base + k + 1);
  }
}

function soffit(b: Buf, pts: number[][]): void {
  // underside: reversed winding, normal down
  b.reserve(pts.length, (pts.length - 2) * 3);
  const base = b.n;
  for (const p of pts) b.vert(p[0], p[1], p[2], 0, -1, 0, p[0], p[2]);
  // orientation: choose so that face is visible from below (normal -y)
  const [p0, p1, p2] = pts;
  const cy = (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]);
  for (let k = 1; k + 1 < pts.length; k++) {
    if (cy < 0) b.tri(base, base + k, base + k + 1); else b.tri(base, base + k + 1, base + k);
  }
}

function pitchedRoof(c: Ctx, p: RoofPart, shape: number, pitch: number, o: number, top: number, fb: number, wa: WallAttr, ra: RoofAttr): void {
  const b = c.base;
  const t = Math.tan(pitch), sinP = Math.sin(pitch);
  const dx = Math.cos(p.angle), dz = Math.sin(p.angle);
  const px = -dz, pz = dx;
  const hl = p.hl, hw = p.hw;
  const E = hl + o, Wd = hw + o;
  const yE = top - o * t;
  const at = (sl: number, sw: number, y: number): number[] => [p.cx + dx * sl + px * sw, y, p.cz + dz * sl + pz * sw];
  b.kind = K.RoofPitched; b.style = ra.rmat; b.seed = wa.seed; b.levels = wa.levels;
  b.cr = ra.rr; b.cg = ra.rg; b.cb = ra.rb; b.aux = wa.typ;
  b.w0 = 0; b.w1 = 0; b.w2 = 0; b.w3 = 0;
  const gableWall = (sl: number, yApex: number, sw0: number, sw1: number, y0: number, y1: number) => {
    // vertical wall panel at ridge-direction offset sl, spanning sw0..sw1 from y0 (at both) to apex/heights
    b.kind = K.Wall; b.style = wa.style; b.cr = wa.wr; b.cg = wa.wg; b.cb = wa.wb; b.aux = wa.typ;
    const L = Math.abs(sw1 - sw0);
    b.w0 = Math.round(L * 100); b.w1 = 300; b.w2 = 0; b.w3 = WF.Gable | (wa.fhdm << 8);
    const A = at(sl, sw0, y0), B = at(sl, sw1, y0);
    const nx = sl > 0 ? dx : -dx, nz = sl > 0 ? dz : -dz;
    const M = at(sl, (sw0 + sw1) / 2, yApex);
    b.triN(A, B, M, [nx, 0, nz], [0, A[1] - fb], [L, B[1] - fb], [L / 2, M[1] - fb]);
    void y1;
    b.kind = K.RoofPitched; b.style = ra.rmat; b.cr = ra.rr; b.cg = ra.rg; b.cb = ra.rb;
    b.w0 = 0; b.w1 = 0; b.w2 = 0; b.w3 = 0;
  };
  const det = c.det;
  if (shape === Roof.Shed) {
    const yLow = yE;
    const yHigh = top + (2 * hw + o) * t;
    const P1 = at(-E, -Wd, yLow), P2 = at(E, -Wd, yLow), P3 = at(E, Wd, yHigh), P4 = at(-E, Wd, yHigh);
    roofFace(b, [P1, P2, P3, P4], yLow, sinP);
    // high wall (+p side) and triangular side walls
    const yTopHigh = top + 2 * hw * t;
    b.kind = K.Wall; b.style = wa.style; b.cr = wa.wr; b.cg = wa.wg; b.cb = wa.wb; b.aux = wa.typ;
    const A = at(hl, hw, top), B = at(-hl, hw, top);
    b.w0 = Math.round(2 * hl * 100); b.w1 = 300; b.w2 = 0; b.w3 = WF.Gable | (wa.fhdm << 8);
    b.quad([A[0], top, A[2], B[0], top, B[2], B[0], yTopHigh, B[2], A[0], yTopHigh, A[2]], [px, 0, pz], [0, top - fb, 2 * hl, top - fb, 2 * hl, yTopHigh - fb, 0, yTopHigh - fb]);
    for (const sl of [-hl, hl]) {
      const nx = sl > 0 ? dx : -dx, nz = sl > 0 ? dz : -dz;
      const Q0 = at(sl, -hw, top), Q1 = at(sl, hw, top), Q2 = at(sl, hw, yTopHigh);
      b.w0 = Math.round(2 * hw * 100);
      b.triN(Q0, Q1, Q2, [nx, 0, nz], [0, top - fb], [2 * hw, top - fb], [2 * hw, yTopHigh - fb]);
    }
    if (det) { det.kind = K.Soffit; det.cr = 120; det.cg = 110; det.cb = 100; soffit(det, [P1, P2, P3, P4].map((q) => [q[0], q[1] - 0.12, q[2]])); }
    return;
  }
  const yR = top + hw * t;
  const P1 = at(-E, -Wd, yE), P2 = at(E, -Wd, yE), P3 = at(E, Wd, yE), P4 = at(-E, Wd, yE);
  if (shape === Roof.Gable) {
    const R1 = at(-E, 0, yR), R2 = at(E, 0, yR);
    roofFace(b, [P1, P2, R2, R1], yE, sinP);
    roofFace(b, [P3, P4, R1, R2], yE, sinP);
    gableWall(hl, yR, -hw, hw, top, yR);
    gableWall(-hl, yR, -hw, hw, top, yR);
    if (det) {
      det.kind = K.Soffit; det.cr = 110; det.cg = 100; det.cb = 90;
      const off = 0.1;
      soffit(det, [P1, P2, R2, R1].map((q) => [q[0], q[1] - off, q[2]]));
      soffit(det, [P3, P4, R1, R2].map((q) => [q[0], q[1] - off, q[2]]));
      // gable-end barge boards: thin vertical faces under the verge overhang
      det.kind = K.Plain; det.cr = 90; det.cg = 80; det.cb = 70;
      for (const sl of [-E, E]) {
        const A = at(sl, -Wd, yE), B = at(sl, 0, yR), C = at(sl, Wd, yE);
        const nx = sl > 0 ? dx : -dx, nz = sl > 0 ? dz : -dz;
        for (const [U, V] of [[A, B], [B, C]]) {
          det.quad([U[0], U[1] - 0.18, U[2], V[0], V[1] - 0.18, V[2], V[0], V[1], V[2], U[0], U[1], U[2]], [nx, 0, nz], [0, 0, 1, 0, 1, 0.2, 0, 0.2]);
        }
      }
    }
  } else if (shape === Roof.Pyramid || hl - hw < 0.05) {
    const A = [p.cx, yR, p.cz];
    roofFace(b, [P1, P2, A], yE, sinP);
    roofFace(b, [P2, P3, A], yE, sinP);
    roofFace(b, [P3, P4, A], yE, sinP);
    roofFace(b, [P4, P1, A], yE, sinP);
    if (det) { det.kind = K.Soffit; det.cr = 110; det.cg = 100; det.cb = 90; soffit(det, [P1, P2, P3, P4].map((q) => [q[0], q[1] - 0.02, q[2]])); }
  } else {
    const rl = hl - hw;
    const R1 = at(-rl, 0, yR), R2 = at(rl, 0, yR);
    roofFace(b, [P1, P2, R2, R1], yE, sinP);
    roofFace(b, [P3, P4, R1, R2], yE, sinP);
    roofFace(b, [P2, P3, R2], yE, sinP);
    roofFace(b, [P4, P1, R1], yE, sinP);
    if (det) { det.kind = K.Soffit; det.cr = 110; det.cg = 100; det.cb = 90; soffit(det, [P1, P2, P3, P4].map((q) => [q[0], q[1] - 0.02, q[2]])); }
  }
  // fascia boards along the eaves (near LOD)
  if (det && o > 0.1) {
    det.kind = K.Plain; det.cr = 96; det.cg = 90; det.cb = 84; det.aux = 0;
    const fh = 0.18;
    const edges: Array<[number[], number[], number, number]> = [[P1, P2, -px, -pz], [P3, P4, px, pz]];
    if (shape !== Roof.Gable) edges.push([P2, P3, dx, dz], [P4, P1, -dx, -dz]);
    for (const [A, B, nx, nz] of edges) {
      det.quad([A[0], A[1] - fh, A[2], B[0], B[1] - fh, B[2], B[0], B[1], B[2], A[0], A[1], A[2]].map((v, k) => v), [nx, 0, nz], [0, 0, 1, 0, 1, fh, 0, fh]);
      // gutter: small box along the eave
      det.kind = K.Metal; det.cr = 150; det.cg = 150; det.cb = 150;
      const mx = (A[0] + B[0]) / 2 + nx * 0.07, mz = (A[2] + B[2]) / 2 + nz * 0.07;
      const ex = B[0] - A[0], ez = B[2] - A[2];
      const el = Math.hypot(ex, ez) || 1;
      det.box(mx, A[1] - 0.12, mz, ex / el, ez / el, el / 2, 0.06, 0.07);
      det.kind = K.Plain; det.cr = 96; det.cg = 90; det.cb = 84;
    }
  }
}

// ------------------------------------------------------------------ parapets (flat roofs, near LOD)
function insetRing(ring: Float64Array, t: number): Float64Array | null {
  const n = ring.length / 2;
  const out = new Float64Array(ring.length);
  for (let k = 0; k < n; k++) {
    const pk = (k + n - 1) % n, nk = (k + 1) % n;
    const x0 = ring[2 * pk], z0 = ring[2 * pk + 1];
    const x1 = ring[2 * k], z1 = ring[2 * k + 1];
    const x2 = ring[2 * nk], z2 = ring[2 * nk + 1];
    let d0x = x1 - x0, d0z = z1 - z0; const l0 = Math.hypot(d0x, d0z) || 1; d0x /= l0; d0z /= l0;
    let d1x = x2 - x1, d1z = z2 - z1; const l1 = Math.hypot(d1x, d1z) || 1; d1x /= l1; d1z /= l1;
    // outward normals (-dz, dx); inset = move against them
    const n0x = -d0z, n0z = d0x, n1x = -d1z, n1z = d1x;
    let mx = n0x + n1x, mz = n0z + n1z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-3) { mx = n0x; mz = n0z; } else { mx /= ml; mz /= ml; }
    const cosh = mx * n0x + mz * n0z;
    const s = t / Math.max(0.35, cosh);
    out[2 * k] = x1 - mx * s;
    out[2 * k + 1] = z1 - mz * s;
  }
  return out;
}

function parapet(b: Buf, rings: Float64Array[], top: number, typ: number, style: number, seed: number, wr: number, wg: number, wb: number, levels: number, fhdm: number): void {
  let h = 0.9, t = 0.3;
  if (typ === Typ.GarageRow || typ === Typ.Outbuilding || typ === Typ.Utility || typ === Typ.Kiosk) { h = 0.15; t = 0.12; }
  else if (typ === Typ.House || typ === Typ.Dacha) { h = 0.3; t = 0.2; }
  else if (typ === Typ.Commercial || typ === Typ.Mall) { h = 0.8; t = 0.25; }
  else if (typ === Typ.Industrial || typ === Typ.Warehouse) { h = 0.6; t = 0.3; }
  const y1 = top + h;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const inner = insetRing(ring, t);
    if (!inner) continue;
    const n = ring.length / 2;
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      const ax = ring[2 * k], az = ring[2 * k + 1], bx = ring[2 * k2], bz = ring[2 * k2 + 1];
      const ix = inner[2 * k], iz = inner[2 * k + 1], jx = inner[2 * k2], jz = inner[2 * k2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      // outer face continues the facade (wall kind, flagged parapet so no windows)
      b.kind = K.Wall; b.style = style; b.seed = seed; b.levels = levels; b.cr = wr; b.cg = wg; b.cb = wb; b.aux = typ;
      b.w0 = Math.round(L * 100); b.w1 = 300; b.w2 = 0; b.w3 = WF.Parapet | (fhdm << 8);
      const vb = 100; // keep v large so the shader treats it as parapet band
      b.quad([ax, top, az, bx, top, bz, bx, y1, bz, ax, y1, az], [nx, 0, nz], [0, vb, L, vb, L, vb + h, 0, vb + h]);
      // cap
      b.kind = K.Plain; b.cr = 150; b.cg = 148; b.cb = 142; b.aux = 1;
      b.quad([ax, y1, az, ix, y1, iz, jx, y1, jz, bx, y1, bz], [0, 1, 0], [0, 0, 0, t, L, t, L, 0]);
      // inner face (faces inward)
      b.kind = K.Plain; b.cr = Math.round(wr * 0.8); b.cg = Math.round(wg * 0.8); b.cb = Math.round(wb * 0.8); b.aux = 2;
      b.quad([jx, top, jz, ix, top, iz, ix, y1, iz, jx, y1, jz], [-nx, 0, -nz], [0, 0, L, 0, L, h, 0, h]);
    }
  }
}

// ------------------------------------------------------------------ facade details (balconies, canopies, AC units)
function facadeDetails(b: Buf, bi: number, walls: Array<any>, fb: number, top: number, floorH: number, levels: number, typ: number, style: number, seed: number, flags: number, wr: number, wg: number, wb: number): void {
  const balc = !!(flags & FLAG.BALCONY);
  for (let wi = 0; wi < walls.length; wi++) {
    const w = walls[wi];
    if (w.hole || w.nCols < 1) continue;
    const tx = (w.bx - w.ax) / w.L, tz = (w.bz - w.az) / w.L; // along wall
    const nx = w.nx, nz = w.nz;
    const colU = (col: number) => w.margin + (col + 0.5) * w.cellW;
    const stairCol = (col: number) => w.secCols > 0 && col % w.secCols === Math.floor(w.secCols / 2);
    // --- entrance canopies + lamps
    if (w.entrance && w.secCols > 0 && typ !== Typ.Commercial) {
      for (let col = 0; col < w.nCols; col++) {
        if (!stairCol(col)) continue;
        const u = colU(col);
        const x = w.ax + tx * u, z = w.az + tz * u;
        const yC = fb + 2.45;
        b.kind = K.Slab; b.cr = 176; b.cg = 172; b.cb = 164; b.aux = 0;
        b.box(x + nx * 0.7, yC, z + nz * 0.7, tx, tz, 1.25, 0.08, 0.72, 1, false);
        // lamp above the door
        b.kind = K.Lamp; b.cr = 255; b.cg = 220; b.cb = 170;
        b.box(x + nx * 0.06, yC + 0.35, z + nz * 0.06, tx, tz, 0.12, 0.08, 0.06);
        // steps
        b.kind = K.Slab; b.cr = 150; b.cg = 148; b.cb = 144;
        b.box(x + nx * 0.9, fb - 0.25, z + nz * 0.9, tx, tz, 1.3, 0.25, 0.9);
      }
    }
    // --- balconies / loggias
    const balconyWall = balc && w.L > 10 && (typ !== Typ.Stalinka || !w.entrance) && levels >= 2;
    if (balconyWall && isApt(typ)) {
      const every = typ === Typ.Panel9 || typ === Typ.Tower ? 2 : 3;
      const glazeP = 0.55 + 0.3 * hash(seed, 7);
      const deep = typ === Typ.Stalinka ? 0.8 : 1.1;
      for (let col = 0; col < w.nCols; col++) {
        if (w.entrance && stairCol(col)) continue;
        if (w.secCols > 0) {
          const inSec = col % w.secCols;
          if ((inSec + (seed & 1)) % every !== 0) continue;
        } else if ((col + (seed & 1)) % every !== 0) continue;
        const u = colU(col);
        const bw = Math.min(w.cellW * 0.92, 3.1) / 2;
        const x = w.ax + tx * u, z = w.az + tz * u;
        for (let row = 1; row < levels; row++) {
          const h = hash(bi * 131 + col, row * 17 + wi);
          const yb = fb + row * floorH; // floor level of this storey
          // slab (front, sides, top, bottom; the back touches the wall)
          b.kind = K.Slab; b.cr = 168; b.cg = 166; b.cb = 160; b.aux = 0;
          b.box(x + nx * deep / 2, yb - 0.08, z + nz * deep / 2, tx, tz, bw, 0.08, deep / 2, 1, false, 1 | 4 | 8 | 16);
          // front parapet (1.0 m): outer face + cap
          const pc = Math.floor(h * 6);
          const pal = [[214, 212, 206], [196, 194, 188], [220, 216, 200], [150, 160, 170], [206, 196, 176], [120, 130, 120]][pc];
          b.kind = K.BalconyFront; b.cr = pal[0]; b.cg = pal[1]; b.cb = pal[2]; b.aux = Math.floor(h * 997) % 4;
          b.box(x + nx * (deep - 0.04), yb + 0.5, z + nz * (deep - 0.04), tx, tz, bw, 0.5, 0.04, 1, true, 1 | 16);
          // side parapets: outward face + cap (box axis along the wall normal; +p = -tangent)
          for (const s of [-1, 1]) {
            b.box(x + tx * s * (bw - 0.03) + nx * deep / 2, yb + 0.5, z + tz * s * (bw - 0.03) + nz * deep / 2, nx, nz, deep / 2, 0.5, 0.03, 1, true, (s > 0 ? 2 : 1) | 16);
          }
          // glazing (upper part) - irregular: some glazed, some open
          if (hash(bi * 7 + col * 3, row) < glazeP) {
            b.kind = K.Glazing; b.cr = 255; b.cg = 255; b.cb = 255; b.aux = Math.floor(hash(col + 11 * row, bi) * 4); // frame type
            const gh = floorH - 1.05 - 0.12;
            const gy = yb + 1.0 + gh / 2;
            b.box(x + nx * (deep - 0.05), gy, z + nz * (deep - 0.05), tx, tz, bw, gh / 2, 0.03, 1, true, 1);
            for (const s of [-1, 1]) {
              b.box(x + tx * s * (bw - 0.03) + nx * deep / 2, gy, z + tz * s * (bw - 0.03) + nz * deep / 2, nx, nz, deep / 2 - 0.03, gh / 2, 0.02, 1, true, s > 0 ? 2 : 1);
            }
          }
        }
        // roof slab over the top balcony (panel blocks have it at the roof level)
        b.kind = K.Slab; b.cr = 160; b.cg = 158; b.cb = 152; b.aux = 0;
        b.box(x + nx * deep / 2, fb + levels * floorH - 0.08, z + nz * deep / 2, tx, tz, bw, 0.08, deep / 2, 1, false, 1 | 4 | 8 | 16);
      }
    }
    // --- air conditioner outdoor units (random windows)
    if ((isApt(typ) || typ === Typ.Public || typ === Typ.Commercial || typ === Typ.School) && !w.entrance && w.L > 6) {
      const pAC = typ === Typ.Commercial ? 0.25 : 0.1;
      for (let col = 0; col < w.nCols; col++) {
        for (let row = 0; row < Math.min(levels, 16); row++) {
          if (hash(bi * 53 + col * 7 + wi, row * 29 + 3) > pAC) continue;
          if (row === 0 && typ !== Typ.Commercial) continue;
          const side = hash(col, row + bi) < 0.5 ? -1 : 1;
          const u = colU(col) + side * (w.cellW * 0.5 - 0.5);
          if (u < 0.6 || u > w.L - 0.6) continue;
          const x = w.ax + tx * u, z = w.az + tz * u;
          const y = fb + row * floorH + 0.45;
          b.kind = K.Metal; b.cr = 232; b.cg = 232; b.cb = 228; b.aux = 1;
          b.box(x + nx * 0.2, y, z + nz * 0.2, tx, tz, 0.4, 0.28, 0.16);
        }
        // satellite dishes (Tricolor TV) on a few balconies / window piers
        for (let row = 1; row < Math.min(levels, 16); row++) {
          if (!isApt(typ) || hash(bi * 71 + col * 5 + wi, row * 31 + 9) > 0.045) continue;
          const u = colU(col) + (w.cellW * 0.5 - 0.35) * (hash(col, row * 3 + bi) < 0.5 ? -1 : 1);
          if (u < 0.5 || u > w.L - 0.5) continue;
          const x = w.ax + tx * u, z = w.az + tz * u;
          const y = fb + row * floorH + 1.6;
          b.kind = K.Metal; b.cr = 218; b.cg = 218; b.cb = 214; b.aux = 0;
          b.box(x + nx * 0.42, y, z + nz * 0.42, tx, tz, 0.27, 0.25, 0.04);
          b.cr = 90; b.cg = 90; b.cb = 90;
          b.box(x + nx * 0.2, y - 0.05, z + nz * 0.2, tx, tz, 0.02, 0.02, 0.2, 1, true, 1 | 2 | 16);
        }
      }
    }
    // --- shop signage over ground-floor shops
    if (w.shop && w.L > 6) {
      const segs = Math.max(1, Math.floor(w.L / 12));
      for (let s = 0; s < segs; s++) {
        if (hash(bi + s, 91) < 0.35) continue;
        const u0 = (w.L / segs) * s + 0.8, u1 = (w.L / segs) * (s + 1) - 0.8;
        const u = (u0 + u1) / 2;
        const x = w.ax + tx * u, z = w.az + tz * u;
        const pc = Math.floor(hash(bi * 3 + s, 5) * 7);
        const pal = [[200, 30, 40], [30, 90, 170], [240, 200, 30], [30, 140, 70], [230, 120, 20], [240, 240, 240], [120, 30, 110]][pc];
        b.kind = K.Lamp; b.cr = pal[0]; b.cg = pal[1]; b.cb = pal[2]; b.aux = 1; // sign board (emissive at night)
        b.box(x + nx * 0.12, fb + floorH - 0.35, z + nz * 0.12, tx, tz, (u1 - u0) / 2, 0.35, 0.1);
      }
    }
  }
  void top; void style; void wr; void wg; void wb;
}

// ------------------------------------------------------------------ yellow gas pipes (very characteristic in the region)
/**
 * Low-pressure gas pipes run on the outside of private houses and low-rise blocks:
 * a yellow pipe along the street / entrance facade under the eaves (houses) or just
 * above the ground-floor windows (blocks), with vertical drops to the ground and a
 * meter box on houses.
 */
function gasPipes(b: Buf, bi: number, walls: Array<any>, fb: number, gMin: number, floorH: number, levels: number, typ: number): void {
  const house = typ === Typ.House || typ === Typ.Dacha;
  const block = typ === Typ.Khrushchevka || typ === Typ.LowriseApt || typ === Typ.Stalinka;
  if (!house && !block) return;
  if (typ === Typ.Dacha && hash(bi, 43) < 0.6) return; // many dachas are not connected
  if (hash(bi, 41) > (house ? 0.85 : 0.75)) return;
  const r = 0.028;
  for (const w of walls) {
    if (!w.entrance || w.hole || w.L < 4) continue;
    const tx = (w.bx - w.ax) / w.L, tz = (w.bz - w.az) / w.L;
    const off = 0.14;
    const y = house ? fb + Math.min(2.5, Math.max(2.0, floorH - 0.35)) : fb + floorH + 0.12;
    const u0 = 0.3, u1 = w.L - 0.3;
    const at = (u: number): [number, number] => [w.ax + tx * u + w.nx * off, w.az + tz * u + w.nz * off];
    b.kind = K.Metal; b.cr = 222; b.cg = 180; b.cb = 36; b.aux = 3;
    b.w0 = 0; b.w1 = 0; b.w2 = 0; b.w3 = 0;
    const [mx, mz] = at((u0 + u1) / 2);
    b.box(mx, y, mz, tx, tz, (u1 - u0) / 2, r, r, 1, false, 1 | 2 | 16 | 32);
    // vertical drop(s) to the ground
    const drops = house ? [hash(bi, 45) < 0.5 ? u0 : u1] : [u0, u1];
    for (const u of drops) {
      const [x, z] = at(u);
      const y0 = gMin - 0.05;
      b.box(x, (y + y0) / 2, z, tx, tz, r, (y - y0) / 2 + r, r, 1, true, 1 | 2 | 4 | 8);
      if (house) {
        // gas meter box (grey steel) on the drop
        b.cr = 150; b.cg = 152; b.cb = 150;
        b.box(x - tx * 0.25 * Math.sign(u - w.L / 2), fb + 1.0, z - tz * 0.25 * Math.sign(u - w.L / 2), tx, tz, 0.2, 0.25, 0.12);
        b.cr = 222; b.cg = 180; b.cb = 36;
      }
    }
    // small support brackets every ~3 m
    b.cr = 90; b.cg = 90; b.cb = 90;
    for (let u = u0 + 1.5; u < u1 - 0.5; u += 3) {
      const [x, z] = at(u);
      b.box(x - w.nx * off / 2, y - r * 1.5, z - w.nz * off / 2, tx, tz, 0.015, 0.015, off / 2, 1, false, 1 | 2 | 16 | 32);
    }
    void levels;
    break; // one facade
  }
}

// ------------------------------------------------------------------ roof equipment (flat roofs)
function roofEquipment(b: Buf, bi: number, rings: Float64Array[], walls: Array<any>, top: number, typ: number, seed: number, levels: number): void {
  if (typ === Typ.GarageRow || typ === Typ.Outbuilding || typ === Typ.Kiosk || typ === Typ.Greenhouse) return;
  // longest outer wall defines the building axis
  let best: any = null;
  for (const w of walls) if (!w.hole && (!best || w.L > best.L)) best = w;
  if (!best) return;
  const tx = (best.bx - best.ax) / best.L, tz = (best.bz - best.az) / best.L;
  // centroid of the outer ring
  const r0 = rings[0];
  let cx = 0, cz = 0;
  const n = r0.length / 2;
  for (let k = 0; k < n; k++) { cx += r0[2 * k]; cz += r0[2 * k + 1]; }
  cx /= n; cz /= n;
  // depth of the building (inward from the longest wall)
  const depth = Math.abs((cx - best.ax) * best.nx + (cz - best.az) * best.nz) * 2;
  const along = (cx - best.ax) * tx + (cz - best.az) * tz;
  const inX = -best.nx, inZ = -best.nz;
  const axisX = best.ax + tx * along + inX * depth / 2, axisZ = best.az + tz * along + inZ * depth / 2;
  const apt = isApt(typ);
  if (apt && levels >= 9) {
    // elevator machine rooms per section (on the entrance line)
    const nSec = Math.max(1, Math.round(best.L / 24));
    for (let s = 0; s < nSec; s++) {
      const u = (s + 0.5) / nSec * best.L - best.L / 2;
      const x = axisX + tx * u, z = axisZ + tz * u;
      b.kind = K.Wall; b.style = Wall.Plain; b.cr = 190; b.cg = 188; b.cb = 182; b.aux = typ;
      b.w0 = 500; b.w1 = 300; b.w2 = 0; b.w3 = WF.Parapet;
      b.box(x, top + 1.5, z, tx, tz, 2.6, 1.5, 1.9, 1);
      b.kind = K.RoofFlat; b.style = RoofMat.Bitumen; b.cr = 70; b.cg = 70; b.cb = 70;
      b.box(x, top + 3.05, z, tx, tz, 2.7, 0.05, 2.0);
    }
  }
  if ((typ === Typ.Industrial || typ === Typ.Warehouse) && best.L > 30 && depth > 18) {
    // roof monitors (clerestory lanterns) along the hall axis
    const nMon = Math.max(1, Math.min(4, Math.floor(depth / 22)));
    const mw = Math.min(6, depth * 0.25) / 2;
    const ml = best.L * 0.4;
    const mh = 1.8;
    for (let m = 0; m < nMon; m++) {
      const v = (m + 0.5) / nMon * depth - depth / 2;
      const x = axisX + inX * v, z = axisZ + inZ * v;
      b.kind = K.Glazing; b.cr = 255; b.cg = 255; b.cb = 255; b.aux = 3;
      b.box(x, top + mh / 2, z, tx, tz, ml, mh / 2, mw, 1, true, 1 | 2 | 4 | 8);
      b.kind = K.RoofFlat; b.style = RoofMat.Bitumen; b.cr = 82; b.cg = 82; b.cb = 84; b.aux = typ;
      b.box(x, top + mh + 0.08, z, tx, tz, ml + 0.3, 0.08, mw + 0.3, 1, false);
    }
  }
  if (apt || typ === Typ.School || typ === Typ.Public || typ === Typ.Kindergarten || typ === Typ.Commercial || typ === Typ.Mall || typ === Typ.Industrial) {
    // ventilation stacks, exits, antennas
    const count = Math.min(40, Math.floor(best.L / 6) + 1);
    for (let k = 0; k < count; k++) {
      const h1 = hash(bi * 17 + k, 3), h2 = hash(bi * 5 + k, 11);
      const u = (h1 - 0.5) * (best.L - 3);
      const v = (h2 - 0.5) * Math.max(0, depth - 3);
      const x = axisX + tx * u + inX * v, z = axisZ + tz * u + inZ * v;
      const kind = hash(k, bi) ;
      if (kind < 0.55) {
        b.kind = K.Plain; b.cr = 150; b.cg = 146; b.cb = 140; b.aux = 3;
        b.box(x, top + 0.5, z, tx, tz, 0.35 + 0.3 * h1, 0.5, 0.35);
      } else if (kind < 0.8 && apt) {
        // TV antenna: mast + cross bars
        b.kind = K.Metal; b.cr = 110; b.cg = 110; b.cb = 110; b.aux = 2;
        const hh = 2.0 + h2 * 2.5;
        b.box(x, top + hh / 2, z, tx, tz, 0.03, hh / 2, 0.03);
        for (let q = 0; q < 3; q++) b.box(x, top + hh - 0.25 - q * 0.35, z, tz, -tx, 0.6 - q * 0.12, 0.012, 0.012);
      } else {
        b.kind = K.Metal; b.cr = 170; b.cg = 172; b.cb = 174; b.aux = 1;
        b.box(x, top + 0.35, z, tx, tz, 0.5, 0.35, 0.35);
      }
    }
  }
  void seed; void rings;
}

// ------------------------------------------------------------------ private house details
function houseDetails(b: Buf, bi: number, parts: RoofPart[], shape: number, top: number, fb: number, gMin: number, o: number, pitch: number, typ: number, seed: number, rings: Float64Array[], rr: number, rg: number, rb: number, walls: Array<any>): void {
  if (!parts.length) return;
  const p = parts[0];
  const dx = Math.cos(p.angle), dz = Math.sin(p.angle);
  const px = -dz, pz = dx;
  const t = Math.tan(pitch);
  const houseLike = typ === Typ.House || typ === Typ.Dacha || typ === Typ.Stalinka || typ === Typ.LowriseApt || typ === Typ.Khrushchevka;
  if (houseLike && shape !== Roof.Shed) {
    // chimney near the ridge
    const s = (hash(bi, 1) - 0.5) * Math.max(0, p.hl - p.hw) * 1.4 + (hash(bi, 2) - 0.5) * 1.0;
    const w = (hash(bi, 3) - 0.5) * p.hw * 0.6;
    const x = p.cx + dx * s + px * w, z = p.cz + dz * s + pz * w;
    const ySurf = top + (p.hw - Math.abs(w)) * t;
    const hh = Math.max(0.8, (p.hw * t - (p.hw - Math.abs(w)) * t) + 0.9);
    b.kind = K.Wall; b.style = Wall.HouseBrick; b.seed = seed; b.cr = 140; b.cg = 70; b.cb = 52; b.aux = typ;
    b.w0 = 60; b.w1 = 300; b.w2 = 0; b.w3 = WF.Parapet;
    b.box(x, ySurf + hh / 2 - 0.3, z, dx, dz, 0.28, hh / 2 + 0.3, 0.28, 1);
    b.kind = K.Metal; b.cr = 90; b.cg = 90; b.cb = 90; b.aux = 0;
    b.box(x, ySurf + hh + 0.04, z, dx, dz, 0.34, 0.04, 0.34);
    // TV antenna / satellite dish on some houses
    if (hash(bi, 9) < 0.35) {
      b.kind = K.Metal; b.cr = 120; b.cg = 120; b.cb = 120;
      b.box(x + dx * 0.4, ySurf + hh + 1.0, z + dz * 0.4, dx, dz, 0.025, 1.2, 0.025);
      b.box(x + dx * 0.4, ySurf + hh + 1.9, z + dz * 0.4, px, pz, 0.5, 0.01, 0.01);
    }
  }
  // downpipes at the outer ring's corners (houses, stalinkas)
  if (houseLike && o > 0.2) {
    const r0 = rings[0];
    const n = r0.length / 2;
    b.kind = K.Metal; b.cr = 160; b.cg = 160; b.cb = 158; b.aux = 0;
    let placed = 0;
    for (let k = 0; k < n && placed < 4; k++) {
      if (hash(bi, 20 + k) < 0.4) continue;
      const x = r0[2 * k], z = r0[2 * k + 1];
      // push slightly outward along the corner bisector
      const pk = (k + n - 1) % n, nk = (k + 1) % n;
      let bx = (x - r0[2 * pk]) + (x - r0[2 * nk]), bz = (z - r0[2 * pk + 1]) + (z - r0[2 * nk + 1]);
      const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
      const hh = top - gMin;
      b.box(x + bx * 0.12, gMin + hh / 2, z + bz * 0.12, dx, dz, 0.05, hh / 2, 0.05);
      placed++;
    }
  }
  void fb; void rr; void rg; void rb; void walls;
}
