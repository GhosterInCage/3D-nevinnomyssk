// Data loading for the roads module (formats written by pipeline/build_roads.py).
import { fetchBuffer, fetchJSON } from '../../core/data';

export type ArrRec = [string, number, number]; // dtype, byteOffset, count

export interface TileRec { i: number; j: number; v0: number; nv: number; i0: number; ni: number }

export interface RoadsMeta {
  version: number;
  tile: number;
  half: number;
  nt: number;
  qs: number;
  surfaces: string[];
  raised: Record<string, number>;
  kinds: string[];
  markStyles: Array<{ name: string; dash: number; gap: number; color: string }>;
  tiles: TileRec[];
  arrays: Record<string, ArrRec>;
  names: string[];
  graph: Record<string, any>;
  bridges: number;
}

export interface BridgeRec {
  id: number;
  empty?: boolean;
  kind: 'road' | 'rail' | 'foot';
  axis: number[];
  L: number;
  range: [number, number];
  cross: Array<[number, number]>;
  wet: number[];
  v: [number, number];
  i: [number, number];
  outline: Array<{ p: number[]; outRight: boolean }>;
  piers: Array<{ s: number; x: number; z: number; nx: number; nz: number; w0: number; w1: number }>;
  name?: string | null;
  rail: boolean;
  road: boolean;
  foot: boolean;
}

export interface RailTrack { p: number[]; el: number; dis: number; g: number; sup: Array<[number, number]> }

export interface RoadsObjects {
  bridges: BridgeRec[];
  rail: { tracks: RailTrack[]; portals: number[][]; crossings: number[][] };
  furniture: {
    lights: number[];
    chains: number[][];
    signals: number[][];
    stops: number[][];
    stopNames: string[];
    benches: number[][];
    signs: number[][];
    crossings: number[][];
  };
  power: { towers: number[]; lines: Array<{ v: number; c: number; b: number; t: number[] }> };
}

export type Typed = Float32Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Uint8Array | Int8Array;

export function view(buf: ArrayBuffer, rec: ArrRec | undefined): Typed {
  if (!rec) return new Float32Array(0);
  const [dt, off, n] = rec;
  switch (dt) {
    case 'f32': return new Float32Array(buf, off, n);
    case 'u16': return new Uint16Array(buf, off, n);
    case 'i16': return new Int16Array(buf, off, n);
    case 'u32': return new Uint32Array(buf, off, n);
    case 'i32': return new Int32Array(buf, off, n);
    case 'u8': return new Uint8Array(buf, off, n);
    case 'i8': return new Int8Array(buf, off, n);
  }
  throw new Error('unknown dtype ' + dt);
}

export interface PolyRec {
  tile: number; kind: number; style: number; width: number; group: number;
  /** world x,z pairs */
  pts: Float32Array;
}

export interface RoadsData {
  meta: RoadsMeta;
  ground: ArrayBuffer;
  graphBuf: ArrayBuffer;
  objects: RoadsObjects;
  polys: PolyRec[];
}

export async function loadRoadsData(): Promise<RoadsData> {
  const [meta, ground, graphBuf, objects] = await Promise.all([
    fetchJSON<RoadsMeta>('roads/meta.json'),
    fetchBuffer('roads/ground.bin.gz'),
    fetchBuffer('roads/graph.bin.gz'),
    fetchJSON<RoadsObjects>('roads/objects.json.gz'),
  ]);
  // decode polyline pool
  const lpos = view(ground, meta.arrays.lpos) as Uint16Array;
  const lrec = view(ground, meta.arrays.lrec) as Int32Array;
  const polys: PolyRec[] = [];
  const { tile: T, half: H, nt: NT, qs: QS } = meta;
  for (let r = 0; r + 6 < lrec.length; r += 7) {
    const tile = lrec[r], kind = lrec[r + 1], style = lrec[r + 2], width = lrec[r + 3] / 100, group = lrec[r + 4];
    const start = lrec[r + 5], count = lrec[r + 6];
    const ti = tile % NT, tj = Math.floor(tile / NT);
    const ox = -H + ti * T - T / 2, oz = -H + tj * T - T / 2;
    const pts = new Float32Array(count * 2);
    for (let k = 0; k < count; k++) {
      pts[k * 2] = ox + lpos[(start + k) * 2] / QS;
      pts[k * 2 + 1] = oz + lpos[(start + k) * 2 + 1] / QS;
    }
    polys.push({ tile, kind, style, width, group, pts });
  }
  return { meta, ground, graphBuf, objects, polys };
}
