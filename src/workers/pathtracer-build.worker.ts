// Path tracer scene builder (Web Worker).
//
// Input: a list of canonical source geometries (float arrays, local space) and
// a list of items {geo, mat, matrices[n*16], colors?[n*3]} whose matrices are
// already expressed in the path tracer's re-centred world frame. The worker
// bakes every instance into one indexed geometry (position, normal, tangent,
// uv, color rgba, materialIndex) and builds a three-mesh-bvh MeshBVH (SAH,
// 1 triangle per leaf, indirect) that three-gpu-pathtracer can consume
// directly. All buffers are transferred back without copies.
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';

export interface PTSrcGeo {
  pos: Float32Array;
  nrm: Float32Array | null;
  uv: Float32Array | null;
  /** rgba */
  col: Float32Array | null;
  idx: Uint32Array | null;
  /** compute tangents (the material has a normal map) */
  tan: boolean;
}

export interface PTItem {
  geo: number;
  mat: number;
  /** column-major 4x4 matrices, n * 16 */
  m: Float32Array;
  /** optional per-instance linear rgb multipliers, n * 3 */
  c: Float32Array | null;
  /** extra offset along -Y applied after the transform (terrain drop etc.) */
  dy?: number;
  /** generate planar world uv (x, -z) + tangent (for normal-mapped meshes without uv, e.g. water) */
  puv?: boolean;
}

export interface PTBuildRequest {
  type: 'build';
  id: number;
  geos: PTSrcGeo[];
  items: PTItem[];
  maxLeafTris?: number;
}

export interface PTBuildResult {
  type: 'done';
  id: number;
  position: Float32Array;
  normal: Float32Array;
  tangent: Float32Array;
  uv: Float32Array;
  color: Float32Array;
  materialIndex: Uint16Array;
  index: Uint32Array;
  roots: ArrayBuffer[];
  indirect: Uint32Array | null;
  triangles: number;
  vertices: number;
  ms: { merge: number; bvh: number };
}

type Msg = PTBuildRequest;

const post = (m: unknown, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? []);

function smoothNormals(pos: Float32Array, idx: Uint32Array | null): Float32Array {
  const n = new Float32Array(pos.length);
  const tri = idx ? idx.length / 3 : pos.length / 9;
  for (let t = 0; t < tri; t++) {
    const a = idx ? idx[3 * t] : 3 * t, b = idx ? idx[3 * t + 1] : 3 * t + 1, c = idx ? idx[3 * t + 2] : 3 * t + 2;
    const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
    const e1x = pos[3 * b] - ax, e1y = pos[3 * b + 1] - ay, e1z = pos[3 * b + 2] - az;
    const e2x = pos[3 * c] - ax, e2y = pos[3 * c + 1] - ay, e2z = pos[3 * c + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) { n[3 * v] += nx; n[3 * v + 1] += ny; n[3 * v + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/** Per-vertex tangents (xyz + handedness) from uv derivatives (Lengyel). */
function computeTangents(pos: Float32Array, nrm: Float32Array, uv: Float32Array, idx: Uint32Array | null): Float32Array {
  const V = pos.length / 3;
  const t1 = new Float32Array(V * 3), t2 = new Float32Array(V * 3);
  const tri = idx ? idx.length / 3 : V / 3;
  for (let t = 0; t < tri; t++) {
    const a = idx ? idx[3 * t] : 3 * t, b = idx ? idx[3 * t + 1] : 3 * t + 1, c = idx ? idx[3 * t + 2] : 3 * t + 2;
    const x1 = pos[3 * b] - pos[3 * a], y1 = pos[3 * b + 1] - pos[3 * a + 1], z1 = pos[3 * b + 2] - pos[3 * a + 2];
    const x2 = pos[3 * c] - pos[3 * a], y2 = pos[3 * c + 1] - pos[3 * a + 1], z2 = pos[3 * c + 2] - pos[3 * a + 2];
    const s1 = uv[2 * b] - uv[2 * a], u1 = uv[2 * b + 1] - uv[2 * a + 1];
    const s2 = uv[2 * c] - uv[2 * a], u2 = uv[2 * c + 1] - uv[2 * a + 1];
    const d = s1 * u2 - s2 * u1;
    if (Math.abs(d) < 1e-12) continue;
    const r = 1 / d;
    const sx = (u2 * x1 - u1 * x2) * r, sy = (u2 * y1 - u1 * y2) * r, sz = (u2 * z1 - u1 * z2) * r;
    const tx = (s1 * x2 - s2 * x1) * r, ty = (s1 * y2 - s2 * y1) * r, tz = (s1 * z2 - s2 * z1) * r;
    for (const v of [a, b, c]) {
      t1[3 * v] += sx; t1[3 * v + 1] += sy; t1[3 * v + 2] += sz;
      t2[3 * v] += tx; t2[3 * v + 1] += ty; t2[3 * v + 2] += tz;
    }
  }
  const out = new Float32Array(V * 4);
  for (let v = 0; v < V; v++) {
    const nx = nrm[3 * v], ny = nrm[3 * v + 1], nz = nrm[3 * v + 2];
    let tx = t1[3 * v], ty = t1[3 * v + 1], tz = t1[3 * v + 2];
    const dn = nx * tx + ny * ty + nz * tz;
    tx -= nx * dn; ty -= ny * dn; tz -= nz * dn;
    const l = Math.hypot(tx, ty, tz);
    if (l < 1e-12) continue; // stays (0,0,0,0): the path tracer then ignores the normal map
    tx /= l; ty /= l; tz /= l;
    // handedness
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    const w = cx * t2[3 * v] + cy * t2[3 * v + 1] + cz * t2[3 * v + 2] < 0 ? -1 : 1;
    out[4 * v] = tx; out[4 * v + 1] = ty; out[4 * v + 2] = tz; out[4 * v + 3] = w;
  }
  return out;
}

function build(req: PTBuildRequest): void {
  const t0 = performance.now();
  const { geos, items } = req;
  // derived per-geometry data
  const nrms: Float32Array[] = geos.map((g) => g.nrm ?? smoothNormals(g.pos, g.idx));
  const tans: Array<Float32Array | null> = geos.map((g, i) => (g.tan && g.uv ? computeTangents(g.pos, nrms[i], g.uv, g.idx) : null));

  let V = 0, I = 0;
  for (const it of items) {
    const g = geos[it.geo];
    const n = it.m.length / 16;
    const gv = g.pos.length / 3;
    V += n * gv;
    I += n * (g.idx ? g.idx.length : gv);
  }
  const position = new Float32Array(V * 3);
  const normal = new Float32Array(V * 3);
  const tangent = new Float32Array(V * 4);
  const uv = new Float32Array(V * 2);
  const color = new Float32Array(V * 4);
  const materialIndex = new Uint16Array(V);
  const index = new Uint32Array(I);

  let vb = 0, ib = 0;
  let lastReport = t0;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const g = geos[it.geo];
    const gp = g.pos, gn = nrms[it.geo], gt = tans[it.geo], guv = g.uv, gc = g.col, gi = g.idx;
    const gv = gp.length / 3;
    const n = it.m.length / 16;
    const dy = it.dy ?? 0;
    const puv = !!it.puv;
    for (let s = 0; s < n; s++) {
      const e = it.m.subarray(16 * s, 16 * s + 16);
      const m0 = e[0], m1 = e[1], m2 = e[2], m4 = e[4], m5 = e[5], m6 = e[6], m8 = e[8], m9 = e[9], m10 = e[10];
      const m12 = e[12], m13 = e[13] - dy, m14 = e[14];
      // normal matrix = inverse transpose of the upper 3x3
      const c00 = m5 * m10 - m6 * m9, c01 = m6 * m8 - m4 * m10, c02 = m4 * m9 - m5 * m8;
      const det = m0 * c00 + m1 * c01 + m2 * c02;
      const c10 = m2 * m9 - m1 * m10, c11 = m0 * m10 - m2 * m8, c12 = m1 * m8 - m0 * m9;
      const c20 = m1 * m6 - m2 * m5, c21 = m2 * m4 - m0 * m6, c22 = m0 * m5 - m1 * m4;
      // n' = cofactor * n (scale irrelevant, we normalise)
      const cr = it.c ? it.c[3 * s] : 1, cg = it.c ? it.c[3 * s + 1] : 1, cb = it.c ? it.c[3 * s + 2] : 1;
      for (let v = 0; v < gv; v++) {
        const x = gp[3 * v], y = gp[3 * v + 1], z = gp[3 * v + 2];
        const o = vb + v;
        position[3 * o] = m0 * x + m4 * y + m8 * z + m12;
        position[3 * o + 1] = m1 * x + m5 * y + m9 * z + m13;
        position[3 * o + 2] = m2 * x + m6 * y + m10 * z + m14;
        const nx = gn[3 * v], ny = gn[3 * v + 1], nz = gn[3 * v + 2];
        let wx = c00 * nx + c10 * ny + c20 * nz;
        let wy = c01 * nx + c11 * ny + c21 * nz;
        let wz = c02 * nx + c12 * ny + c22 * nz;
        if (det < 0) { wx = -wx; wy = -wy; wz = -wz; }
        const l = Math.hypot(wx, wy, wz) || 1;
        normal[3 * o] = wx / l; normal[3 * o + 1] = wy / l; normal[3 * o + 2] = wz / l;
        if (gt) {
          const tx = gt[4 * v], ty = gt[4 * v + 1], tz = gt[4 * v + 2];
          const ux = m0 * tx + m4 * ty + m8 * tz, uy = m1 * tx + m5 * ty + m9 * tz, uz = m2 * tx + m6 * ty + m10 * tz;
          const lt = Math.hypot(ux, uy, uz);
          if (lt > 0) {
            tangent[4 * o] = ux / lt; tangent[4 * o + 1] = uy / lt; tangent[4 * o + 2] = uz / lt;
            tangent[4 * o + 3] = det < 0 ? -gt[4 * v + 3] : gt[4 * v + 3];
          }
        }
        if (puv) {
          const px = position[3 * o], pz = position[3 * o + 2];
          uv[2 * o] = px; uv[2 * o + 1] = -pz;
          // tangent = +x projected onto the tangent plane
          const nx2 = normal[3 * o], ny2 = normal[3 * o + 1], nz2 = normal[3 * o + 2];
          let tx = 1 - nx2 * nx2, ty = -nx2 * ny2, tz = -nx2 * nz2;
          const lt = Math.hypot(tx, ty, tz);
          if (lt > 1e-6) { tx /= lt; ty /= lt; tz /= lt; tangent[4 * o] = tx; tangent[4 * o + 1] = ty; tangent[4 * o + 2] = tz; tangent[4 * o + 3] = 1; }
        } else if (guv) { uv[2 * o] = guv[2 * v]; uv[2 * o + 1] = guv[2 * v + 1]; }
        if (gc) {
          color[4 * o] = gc[4 * v] * cr; color[4 * o + 1] = gc[4 * v + 1] * cg;
          color[4 * o + 2] = gc[4 * v + 2] * cb; color[4 * o + 3] = gc[4 * v + 3];
        } else {
          color[4 * o] = cr; color[4 * o + 1] = cg; color[4 * o + 2] = cb; color[4 * o + 3] = 1;
        }
        materialIndex[o] = it.mat;
      }
      if (gi) {
        const L = gi.length;
        if (det < 0) {
          for (let j = 0; j < L; j += 3) { index[ib + j] = vb + gi[j + 2]; index[ib + j + 1] = vb + gi[j + 1]; index[ib + j + 2] = vb + gi[j]; }
        } else {
          for (let j = 0; j < L; j++) index[ib + j] = vb + gi[j];
        }
        ib += L;
      } else {
        for (let j = 0; j < gv; j += 3) {
          if (det < 0) { index[ib + j] = vb + j + 2; index[ib + j + 1] = vb + j + 1; index[ib + j + 2] = vb + j; }
          else { index[ib + j] = vb + j; index[ib + j + 1] = vb + j + 1; index[ib + j + 2] = vb + j + 2; }
        }
        ib += gv;
      }
      vb += gv;
    }
    const now = performance.now();
    if (now - lastReport > 100) {
      lastReport = now;
      post({ type: 'progress', id: req.id, stage: 'merge', p: k / items.length });
    }
  }
  const t1 = performance.now();

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  let lastP = 0;
  const bvh = new MeshBVH(geometry, {
    strategy: SAH,
    targetLeafSize: req.maxLeafTris ?? 1,
    indirect: true,
    onProgress: (p: number) => {
      const now = performance.now();
      if (now - lastP > 100) { lastP = now; post({ type: 'progress', id: req.id, stage: 'bvh', p }); }
    },
  } as any);
  const ser = MeshBVH.serialize(bvh, { cloneBuffers: false });
  const t2 = performance.now();
  const roots = ser.roots as ArrayBuffer[];
  const indirect = (ser.indirectBuffer as Uint32Array | null) ?? null;
  const res: PTBuildResult = {
    type: 'done', id: req.id, position, normal, tangent, uv, color, materialIndex, index,
    roots, indirect, triangles: I / 3, vertices: V, ms: { merge: t1 - t0, bvh: t2 - t1 },
  };
  const transfer: Transferable[] = [position.buffer, normal.buffer, tangent.buffer, uv.buffer, color.buffer, materialIndex.buffer, index.buffer, ...roots];
  if (indirect) transfer.push(indirect.buffer as ArrayBuffer);
  post(res, transfer);
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const req = e.data;
  if (!req || req.type !== 'build') return;
  try {
    build(req);
  } catch (err: any) {
    post({ type: 'error', id: req.id, error: String(err?.stack || err) });
  }
};
