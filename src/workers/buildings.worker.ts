// Mesher worker for the buildings module: builds merged per-tile geometry.
// Protocol:
//   in  {type:'init', buf: ArrayBuffer, ground: Float32Array, hidden: Uint8Array}
//   in  {type:'hidden', hidden: Uint8Array}
//   in  {type:'build', id, tile, detail: boolean}
//   out {type:'built', id, tile, detail, base, det, count, ms}   (typed arrays transferred)
//   out {type:'error', id, message}
import { parseBuildings, type BuildingData } from '../modules/buildings/format';
import { buildTile, type TileMesh } from '../modules/buildings/mesher';

let data: BuildingData | null = null;
let ground: Float32Array | null = null;
let hidden: Uint8Array | null = null;

function transferables(m: TileMesh | null): ArrayBuffer[] {
  if (!m) return [];
  return [m.position.buffer, m.normal.buffer, m.uv.buffer, m.aA.buffer, m.aC.buffer, m.aW.buffer, m.index.buffer] as ArrayBuffer[];
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      data = parseBuildings(msg.buf);
      ground = msg.ground;
      hidden = msg.hidden;
      (self as any).postMessage({ type: 'ready' });
    } else if (msg.type === 'hidden') {
      hidden = msg.hidden;
    } else if (msg.type === 'build') {
      if (!data || !ground || !hidden) throw new Error('worker not initialised');
      const t0 = performance.now();
      const r = buildTile(data, msg.tile, ground, hidden, !!msg.detail);
      const base = msg.detail ? null : r.base; // detail requests only need the detail mesh
      const out = { type: 'built', id: msg.id, tile: msg.tile, detail: !!msg.detail, base, det: r.det, count: r.count, ms: performance.now() - t0 };
      (self as any).postMessage(out, [...transferables(base), ...transferables(r.det)]);
    }
  } catch (err: any) {
    (self as any).postMessage({ type: 'error', id: msg?.id, message: String(err?.stack || err) });
  }
};
