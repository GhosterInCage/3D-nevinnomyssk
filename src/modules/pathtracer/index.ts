// Path tracer module ("Photo mode"): real, progressive Monte-Carlo path
// tracing of the frozen view with three-gpu-pathtracer (BVH via
// three-mesh-bvh, built in a worker). See docs/modules/pathtracer.md.
//
// Service 'pathtracer':
//   start(opts?) -> Promise<'rendering'|'unsupported'|'error'|'cancelled'>
//   stop(), toggle(), active, samples, state, message
//   saveImage(download = true) -> Promise<Blob | null>
//   whenDone() -> Promise<void>   (resolves when opts.spp samples are reached)
//   stats() -> build/render statistics
// Keys: P toggles photo mode, Esc leaves it. URL: ?photo=1 starts it once the
// city is ready; ptspp, ptscale, ptradius, ptbudget, ptbounces, ptdof,
// ptfstop, ptfocus, pttrees=0, ptdenoise=0 tune it.
import type { AppContext, CityModule } from '../../core/context';
import { PhotoMode, type PhotoOptions } from './photo';

export interface PathTracerService {
  start(opts?: PhotoOptions): Promise<string>;
  stop(): void;
  toggle(): void;
  readonly active: boolean;
  readonly samples: number;
  readonly state: string;
  readonly message: string;
  saveImage(download?: boolean): Promise<Blob | null>;
  whenDone(): Promise<void>;
  stats(): Record<string, unknown>;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

const mod: CityModule = {
  id: 'pathtracer',
  init(ctx: AppContext) {
    const photo = new PhotoMode(ctx);
    const api: PathTracerService = {
      start: (o?: PhotoOptions) => photo.start(o).catch((e) => { console.error('[pathtracer]', e); return 'error'; }),
      stop: () => { try { photo.stop(); } catch (e) { console.error('[pathtracer] stop', e); } },
      toggle: () => { if (photo.active) api.stop(); else void api.start(); },
      get active() { return photo.active; },
      get samples() { return photo.samples; },
      get state() { return photo.state; },
      get message() { return photo.message; },
      saveImage: (download = true) => photo.saveImage(download).catch((e) => { console.error('[pathtracer] save', e); return null; }),
      whenDone: () => photo.whenDone(),
      stats: () => ({ ...photo.stats, state: photo.state, samples: photo.samples }),
      probe: () => photo.probe(),
      rawImage: () => photo.rawImage(),
    } as PathTracerService & { probe(): Record<string, unknown>; rawImage(): string | null };
    ctx.provide('pathtracer', api);

    window.addEventListener('keydown', (e) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.code === 'KeyP') { e.preventDefault(); api.toggle(); }
      else if (e.key === 'Escape' && photo.active) { e.preventDefault(); api.stop(); }
    });

    // time-of-day / weather changes while rendering: re-light without rebuilding the BVH
    let relightTimer = 0;
    const relight = () => {
      if (!photo.active) return;
      clearTimeout(relightTimer);
      relightTimer = window.setTimeout(() => photo.relight(), 400);
    };
    ctx.events.on('time', relight);

    if (ctx.settings.params.get('photo') === '1') {
      ctx.events.once('ready', () => { void api.start(); });
    }
  },
};
export default mod;
