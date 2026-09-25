// Web worker: generates procedural tree/shrub models (see src/modules/vegetation/treegen.ts).
import { generateTree, type GenParams, type PartArrays, type TreeModel } from '../modules/vegetation/treegen';

function buffers(p: PartArrays): ArrayBuffer[] {
  return [p.position.buffer, p.normal.buffer, p.uv.buffer, p.color.buffer, p.wind.buffer, p.index.buffer] as ArrayBuffer[];
}

self.onmessage = (e: MessageEvent<{ jobs: Array<{ id: number; gen: GenParams }> }>) => {
  for (const job of e.data.jobs) {
    try {
      const m: TreeModel = generateTree(job.gen);
      const transfer = [...buffers(m.lod0.bark), ...buffers(m.lod0.leaves), ...buffers(m.lod1.bark), ...buffers(m.lod1.leaves)];
      (self as unknown as Worker).postMessage({ id: job.id, model: m }, transfer);
    } catch (err) {
      (self as unknown as Worker).postMessage({ id: job.id, error: String((err as Error)?.stack || err) });
    }
  }
};
