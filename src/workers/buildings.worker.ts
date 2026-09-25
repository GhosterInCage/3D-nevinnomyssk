// Mesher worker for the buildings module: builds merged per-tile geometry.
// Protocol:
//   in  {type:'fetch', id, url}  -> out {type:'fetched', id, buf}   (gunzipped data file)
//   in  {type:'init', buf: ArrayBuffer, ground: Float32Array, hidden: Uint8Array}
//   in  {type:'hidden', hidden: Uint8Array}
//   in  {type:'build', id, jobs: [{key, tiles: number[], ox, oz, detail: boolean}]}
//   out {type:'built', id, results: [{key, mesh, count}], ms}   (typed arrays transferred)
//   out {type:'error', id, message}
import { parseBuildings, type BuildingData } from '../modules/buildings/format';
import { buildTiles, type TileMesh } from '../modules/buildings/mesher';

let data: BuildingData | null = null;
let ground: Float32Array | null = null;
let hidden: Uint8Array | null = null;
let fground: Float32Array | null = null;

function transferables(m: TileMesh | null): ArrayBuffer[] {
  if (!m) return [];
  return [m.position.buffer, m.normal.buffer, m.uv.buffer, m.aA.buffer, m.aC.buffer, m.aW.buffer, m.color.buffer, m.index.buffer] as ArrayBuffer[];
}

async function fetchData(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  let buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (u8.length === 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(stream).arrayBuffer();
  }
  return buf;
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'fetch') {
    // load + gunzip off the main thread (the main thread may be busy rendering for seconds per frame)
    fetchData(msg.url)
      .then((buf) => (self as any).postMessage({ type: 'fetched', id: msg.id, buf }, [buf]))
      .catch((err) => (self as any).postMessage({ type: 'error', id: msg.id, message: String(err?.stack || err) }));
    return;
  }
  try {
    if (msg.type === 'init') {
      data = parseBuildings(msg.buf);
      ground = msg.ground;
      hidden = msg.hidden;
      fground = msg.fground ?? null;
      (self as any).postMessage({ type: 'ready' });
    } else if (msg.type === 'hidden') {
      hidden = msg.hidden;
    } else if (msg.type === 'build') {
      // a batch of chunks -> one reply (the main thread may only get one task per rendered frame)
      if (!data || !ground || !hidden) throw new Error('worker not initialised');
      const t0 = performance.now();
      const results: any[] = [];
      const tr: ArrayBuffer[] = [];
      for (const job of msg.jobs as Array<{ key: string; tiles: number[]; ox: number; oz: number; detail: boolean }>) {
        const r = buildTiles(data, job.tiles, job.ox, job.oz, ground, hidden, !!job.detail, fground);
        const mesh = job.detail ? r.det : r.base; // detail requests only need the detail mesh
        results.push({ key: job.key, mesh, count: r.count });
        tr.push(...transferables(mesh));
      }
      (self as any).postMessage({ type: 'built', id: msg.id, results, ms: performance.now() - t0 }, tr);
    }
  } catch (err: any) {
    (self as any).postMessage({ type: 'error', id: msg?.id, message: String(err?.stack || err) });
  }
};
