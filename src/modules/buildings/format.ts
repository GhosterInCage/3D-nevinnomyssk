// Binary format of public/data/buildings/buildings.bin.gz (written by
// pipeline/build_buildings.py). Shared by the main thread and the mesher worker.
//
// Header (64 bytes, little-endian):
//   0 'NBLD'  4 u32 version  8 u32 nBuildings  12 u32 nVerts  16 u32 nRings  20 u32 nParts
//  24 f32 tileSize  28 u32 tilesX  32 f32 originX  36 f32 originZ  40 u32 nTiles  44..63 reserved
// Sections (4-byte aligned, in order):
//   tileStart  u32[nTiles + 1]         buildings are sorted by tile (tile = tz * tilesX + tx)
//   records    REC_SIZE * nBuildings   (see field offsets below)
//   verts      i16[2 * nVerts]          x, z (world frame, z = south) relative to the building centre,
//                                       in cm (2 cm if FLAG_Q2). Outer ring first, then holes.
//                                       Outer rings have negative signed area in (x,z) so that the
//                                       outward wall normal of edge A->B is (-dz, dx).
//   ringLen    u16[nRings]
//   parts      PART_SIZE * nParts       roof rectangles: i16 cx, i16 cz (cm rel. centre),
//                                       u16 halfLen, u16 halfWid (cm), i16 angle (1e-4 rad, ridge
//                                       direction in world x/z: (cos a, sin a)), u16 reserved

export const REC_SIZE = 52;
export const PART_SIZE = 12;

export const R = {
  cx: 0, cz: 4, vertStart: 8, ringStart: 12, partStart: 16,
  vertCount: 20, ringCount: 22, partCount: 23,
  height: 24,      // u16 dm: wall height from floor base to eave / roof deck
  roofHeight: 26,  // u8 dm
  levels: 27, typology: 28, roofShape: 29, wallStyle: 30, roofMat: 31,
  wallRGB: 32,     // 3 x u8 sRGB
  roofRGB: 35,     // 3 x u8 sRGB
  seed: 38, flags: 39,
  entranceDir: 40, // u8 angle of the entrance wall's outward normal, a*2pi/256, n = (sin a, cos a) in (x,z)
  floorH: 41,      // u8 dm
  minHeight: 42,   // u8 m (building starts above ground, e.g. overpass/part)
  socle: 43,       // u8 dm: floor base above the highest ground point under the footprint (plinth)
  nameIdx: 44,     // u16, 0xffff = none
  roofPitch: 46,   // u8 degrees
  overhang: 47,    // u8 cm/2
  streetDir: 48,   // u8 angle of the wall facing the nearest main street (shop fronts), like entranceDir
  roofDir: 49,     // reserved
} as const;

export const FLAG = {
  Q2: 1,           // vertex quantisation 2 cm
  SHOP: 2,         // ground-floor shops on the street side (entranceDir opposite = street) - see docs
  BALCONY: 4,      // loggias / balconies
  ENTRANCE: 8,     // entranceDir valid
  OSM: 16,
  NAMED: 32,
  LABELLED: 64,    // levels came from OSM tags (not inferred)
  STREETSHOP: 128, // shops face the street direction (streetDir = entranceDir + 128)
} as const;

export enum Typ {
  House = 0, Outbuilding = 1, GarageRow = 2, Dacha = 3, Khrushchevka = 4, Panel9 = 5, Tower = 6,
  Stalinka = 7, LowriseApt = 8, School = 9, Kindergarten = 10, Public = 11, Commercial = 12,
  Mall = 13, Industrial = 14, Warehouse = 15, Agri = 16, Greenhouse = 17, Religious = 18,
  ModernApt = 19, Utility = 20, Kiosk = 21,
}

export const TYP_NAMES = [
  'house', 'outbuilding', 'garages', 'dacha', 'khrushchevka', 'panel9', 'tower', 'stalinka',
  'lowrise_apartments', 'school', 'kindergarten', 'public', 'commercial', 'mall', 'industrial',
  'warehouse', 'agricultural', 'greenhouse', 'religious', 'modern_apartments', 'utility', 'kiosk',
];

export enum Roof { Flat = 0, Gable = 1, Hip = 2, Pyramid = 3, Shed = 4 }

/** Wall facade styles (interpreted in the shader). */
export enum Wall {
  Plain = 0, HousePlaster = 1, HouseBrick = 2, Panel5 = 3, Brick5 = 4, Panel9 = 5, Stalinka = 6,
  School = 7, Commercial = 8, Industrial = 9, Garage = 10, Warehouse = 11, Glass = 12, Modern = 13,
  Public = 14, HouseSiding = 15,
}

/** Roof materials (interpreted in the shader). */
export enum RoofMat { Bitumen = 0, Gravel = 1, Corrugated = 2, MetalTile = 3, Slate = 4, Seam = 5, Glass = 6, Tiles = 7 }

export interface BuildingData {
  buf: ArrayBuffer;
  dv: DataView;
  n: number;
  nTiles: number;
  tilesX: number;
  tileSize: number;
  originX: number;
  originZ: number;
  tileStart: Uint32Array;
  recOff: number;
  verts: Int16Array;
  ringLen: Uint16Array;
  partsOff: number;
}

export function parseBuildings(buf: ArrayBuffer): BuildingData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'NBLD') throw new Error('buildings.bin: bad magic ' + magic);
  const n = dv.getUint32(8, true);
  const nVerts = dv.getUint32(12, true);
  const nRings = dv.getUint32(16, true);
  const nParts = dv.getUint32(20, true);
  const tileSize = dv.getFloat32(24, true);
  const tilesX = dv.getUint32(28, true);
  const originX = dv.getFloat32(32, true);
  const originZ = dv.getFloat32(36, true);
  const nTiles = dv.getUint32(40, true);
  let o = 64;
  const tileStart = new Uint32Array(buf, o, nTiles + 1);
  o += 4 * (nTiles + 1);
  const recOff = o;
  o += REC_SIZE * n;
  const verts = new Int16Array(buf, o, 2 * nVerts);
  o += 4 * nVerts;
  const ringLen = new Uint16Array(buf, o, nRings);
  o += 2 * nRings;
  o = (o + 3) & ~3;
  const partsOff = o;
  o += PART_SIZE * nParts;
  if (o > buf.byteLength) throw new Error('buildings.bin: truncated');
  return { buf, dv, n, nTiles, tilesX, tileSize, originX, originZ, tileStart, recOff, verts, ringLen, partsOff };
}

/** Lightweight accessor for one building record. */
export class Rec {
  private o = 0;
  constructor(private d: BuildingData) {}
  at(i: number): this { this.o = this.d.recOff + i * REC_SIZE; return this; }
  f32(off: number): number { return this.d.dv.getFloat32(this.o + off, true); }
  u32(off: number): number { return this.d.dv.getUint32(this.o + off, true); }
  u16(off: number): number { return this.d.dv.getUint16(this.o + off, true); }
  u8(off: number): number { return this.d.dv.getUint8(this.o + off); }
  get cx(): number { return this.f32(R.cx); }
  get cz(): number { return this.f32(R.cz); }
  get height(): number { return this.u16(R.height) / 10; }
  get roofHeight(): number { return this.u8(R.roofHeight) / 10; }
  get levels(): number { return this.u8(R.levels); }
  get typology(): number { return this.u8(R.typology); }
  get roofShape(): number { return this.u8(R.roofShape); }
  get flags(): number { return this.u8(R.flags); }
  get socle(): number { return this.u8(R.socle) / 10; }
  get minHeight(): number { return this.u8(R.minHeight); }
  get nameIdx(): number { return this.u16(R.nameIdx); }
}

/**
 * Decode the rings of building i into world coordinates (x,z interleaved).
 * Returns an array of rings; ring 0 is the outer ring.
 */
export function decodeRings(d: BuildingData, i: number, offX = 0, offZ = 0): Float64Array[] {
  const o = d.recOff + i * REC_SIZE;
  const dv = d.dv;
  const cx = dv.getFloat32(o + R.cx, true) - offX;
  const cz = dv.getFloat32(o + R.cz, true) - offZ;
  const vs = dv.getUint32(o + R.vertStart, true);
  const rs = dv.getUint32(o + R.ringStart, true);
  const rc = dv.getUint8(o + R.ringCount);
  const q = dv.getUint8(o + R.flags) & FLAG.Q2 ? 0.02 : 0.01;
  const out: Float64Array[] = [];
  let v = vs;
  for (let r = 0; r < rc; r++) {
    const len = d.ringLen[rs + r];
    const a = new Float64Array(len * 2);
    for (let k = 0; k < len; k++) {
      a[2 * k] = cx + d.verts[2 * (v + k)] * q;
      a[2 * k + 1] = cz + d.verts[2 * (v + k) + 1] * q;
    }
    v += len;
    out.push(a);
  }
  return out;
}

export interface RoofPart { cx: number; cz: number; hl: number; hw: number; angle: number }

export function decodeParts(d: BuildingData, i: number, offX = 0, offZ = 0): RoofPart[] {
  const o = d.recOff + i * REC_SIZE;
  const dv = d.dv;
  const cx = dv.getFloat32(o + R.cx, true) - offX;
  const cz = dv.getFloat32(o + R.cz, true) - offZ;
  const ps = dv.getUint32(o + R.partStart, true);
  const pc = dv.getUint8(o + R.partCount);
  const out: RoofPart[] = [];
  for (let k = 0; k < pc; k++) {
    const po = d.partsOff + (ps + k) * PART_SIZE;
    out.push({
      cx: cx + dv.getInt16(po, true) * 0.01,
      cz: cz + dv.getInt16(po + 2, true) * 0.01,
      hl: dv.getUint16(po + 4, true) * 0.01,
      hw: dv.getUint16(po + 6, true) * 0.01,
      angle: dv.getInt16(po + 8, true) * 1e-4,
    });
  }
  return out;
}

export function tileOf(d: BuildingData, x: number, z: number): number {
  const tx = Math.floor((x - d.originX) / d.tileSize);
  const tz = Math.floor((z - d.originZ) / d.tileSize);
  if (tx < 0 || tz < 0 || tx >= d.tilesX || tz >= d.tilesX) return -1;
  return tz * d.tilesX + tx;
}
