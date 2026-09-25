// Bootstrap: settings -> context -> manifest + heightfield -> feature modules.
import * as THREE from 'three';
import { AppContext, type CityModule, type Manifest } from './core/context';
import { Settings } from './core/settings';
import { fetchJSON } from './core/data';
import { HeightField } from './core/heightfield';
import { applyHeadingPitch } from './core/controls';
import { lonLatToWorld } from './core/geo';
import { MODULES } from './modules';

type ModuleState = { id: string; status: 'loading' | 'init' | 'ready' | 'error'; error?: string; ms?: number };

const loadingEl = document.getElementById('loading');
const statusEl = document.getElementById('loading-status');
const barEl = document.getElementById('loading-bar');

function setStatus(text: string, frac?: number) {
  if (statusEl) statusEl.textContent = text;
  if (barEl && frac !== undefined) barEl.style.width = `${Math.round(frac * 100)}%`;
}

async function main() {
  const settings = new Settings();
  document.body.classList.toggle('shot', settings.shot);
  const ctx = new AppContext(document.getElementById('app')!, settings);
  const states: ModuleState[] = [];
  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));
  let isReady = false;

  // debug / automation handle
  (window as any).__city = {
    ctx, THREE, states, ready, lonLatToWorld,
    isReady: () => isReady,
    setCamera(x: number, y: number, z: number, heading = 0, pitch = -20) {
      ctx.camera.position.set(x, y, z);
      applyHeadingPitch(ctx.camera, heading, pitch);
      ctx.controller.enter(ctx);
    },
    setTime(h: number) { ctx.env.hours = h; },
  };

  setStatus('Loading terrain…', 0.02);
  ctx.manifest = await fetchJSON<Manifest>('manifest.json');
  ctx.heightfield = await HeightField.load(ctx.manifest.terrain, (l, t) => t && setStatus('Loading terrain…', 0.02 + 0.15 * (l / t)));

  // initial camera from URL (?cam= or ?ll=) or default overview
  const cam = settings.numbers('cam');
  const ll = settings.numbers('ll');
  if (cam && cam.length >= 3) {
    ctx.camera.position.set(cam[0], cam[1], cam[2]);
    applyHeadingPitch(ctx.camera, cam[3] ?? 0, cam[4] ?? -20);
  } else if (ll && ll.length >= 2) {
    const p = lonLatToWorld(ll[0], ll[1]);
    const g = ctx.heightfield.sample(p.x, p.z);
    ctx.camera.position.set(p.x, g + (ll[2] ?? 300), p.z);
    applyHeadingPitch(ctx.camera, ll[3] ?? 0, ll[4] ?? -20);
  } else {
    ctx.camera.position.set(1500, 760, 2900);
    applyHeadingPitch(ctx.camera, 312, -24);
  }
  const t = settings.params.get('time');
  if (t && Number.isFinite(+t)) ctx.env.hours = +t;
  const d = settings.params.get('date');
  if (d) ctx.env.setDate(d);
  ctx.controller.enter(ctx);
  ctx.env.update(0);
  ctx.start();

  // load modules
  const wanted = MODULES.filter((m) => settings.wants(m.id));
  const loaded = new Map<string, CityModule>();
  const inited = new Map<string, Promise<void>>();
  let done = 0;
  const report = () => {
    const busy = states.filter((s) => s.status === 'loading' || s.status === 'init').map((s) => s.id);
    setStatus(busy.length ? `Building the city: ${busy.join(', ')}…` : 'Finishing…', 0.2 + 0.8 * (done / Math.max(1, wanted.length)));
  };

  await Promise.all(wanted.map(async (entry) => {
    const st: ModuleState = { id: entry.id, status: 'loading' };
    states.push(st);
    report();
    try {
      const mod = (await entry.load()).default;
      loaded.set(entry.id, mod);
    } catch (e: any) {
      st.status = 'error'; st.error = String(e?.stack || e);
      console.error(`[module ${entry.id}] load failed`, e);
      done++; report();
    }
  }));

  const initModule = (id: string): Promise<void> => {
    if (inited.has(id)) return inited.get(id)!;
    const mod = loaded.get(id)!;
    const st = states.find((s) => s.id === id)!;
    const p = (async () => {
      for (const dep of mod.after ?? []) if (loaded.has(dep)) await initModule(dep).catch(() => undefined);
      st.status = 'init';
      report();
      const t0 = performance.now();
      try {
        await mod.init(ctx);
        if (mod.update) ctx.onUpdate((dt, c) => mod.update!(dt, c));
        st.status = 'ready';
      } catch (e: any) {
        st.status = 'error'; st.error = String(e?.stack || e);
        console.error(`[module ${id}] init failed`, e);
      }
      st.ms = Math.round(performance.now() - t0);
      done++; report();
    })();
    inited.set(id, p);
    return p;
  };
  await Promise.all([...loaded.keys()].map(initModule));
  await ctx.settle();

  const errors = states.filter((s) => s.status === 'error');
  if (errors.length) console.warn('[modules] failed:', errors.map((e) => e.id).join(', '));
  console.info('[modules]', states.map((s) => `${s.id}:${s.status}${s.ms !== undefined ? `(${s.ms}ms)` : ''}`).join(' '));
  ctx.events.emit('ready', states);

  // wait a few frames so GPU uploads/shader compiles settle before signalling ready
  const f0 = ctx.frame;
  await new Promise<void>((res) => {
    const off = ctx.events.on('frame', (f: number) => { if (f - f0 >= 3) { off(); res(); } });
  });
  loadingEl?.classList.add('done');
  setTimeout(() => loadingEl?.remove(), 1200);
  isReady = true;
  readyResolve();
}

main().catch((e) => {
  console.error(e);
  setStatus(`Failed to start: ${e?.message || e}`);
});
