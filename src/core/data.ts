// Data loading helpers. All static data lives under public/data/ and is fetched
// relative to the page (works on GitHub Pages sub-paths and in artifacts).

export const DATA_BASE = `${import.meta.env.BASE_URL}data/`;

export function dataUrl(path: string): string {
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return DATA_BASE + path.replace(/^\/+/, '');
}

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

/**
 * Fetch a binary file. Files ending in .gz are gunzipped in the browser unless
 * the server already decoded them (detected via the gzip magic bytes).
 */
export async function fetchBuffer(path: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(dataUrl(path));
  if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
  let buf: ArrayBuffer;
  if (onProgress && res.body) {
    const total = Number(res.headers.get('content-length') || 0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    const out = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    buf = out.buffer;
  } else {
    buf = await res.arrayBuffer();
  }
  const u8 = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (u8.length === 2 && u8[0] === 0x1f && u8[1] === 0x8b) buf = await gunzip(buf);
  return buf;
}

export async function fetchJSON<T = any>(path: string): Promise<T> {
  if (path.endsWith('.gz')) {
    const buf = await fetchBuffer(path);
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  }
  const res = await fetch(dataUrl(path));
  if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export async function loadImage(path: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = dataUrl(path);
  await img.decode();
  return img;
}

/** Decode an image to raw RGBA pixels (row 0 = top of the image). */
export async function loadImagePixels(path: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const img = await loadImage(path);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: d.data };
}
