// UI module: overlay chrome (search, compass/coordinates, minimap, modes, time &
// weather, quality, screenshot, share, help, stats, touch controls), floating place
// labels, loading-screen polish, and the 'ui' + 'places' services.
// See docs/modules/ui.md.
import * as THREE from 'three';
import type { AppContext, CityModule } from '../../core/context';
import { getHeadingPitch, applyHeadingPitch } from '../../core/controls';
import { fetchJSON } from '../../core/data';
import { QUALITY_ORDER, type Quality } from '../../core/settings';
import { CSS } from './styles';
import { h, isTyping } from './dom';
import { ICON } from './icons';
import { getLang, setLang, t, type Lang } from './i18n';
import { Gazetteer, type PlaceItem, type PlacesData } from './gazetteer';
import { CameraFlight, type FlyOptions } from './flyto';
import { Labels } from './labels';
import { MiniMap } from './minimap';
import { Hud } from './hud';
import { Toolbar, Toasts, type PanelHandle, type PanelOptions, type ToastOptions } from './panels';
import { TimeWeather } from './timeweather';
import { Stats } from './stats';
import { openHelp } from './help';
import { TouchControls, isTouchDevice } from './touch';
import { enhanceLoading } from './loading';
import { ModeBar } from './modes';
import { PlaceCard, pickWorld, type PickInfo } from './placecard';
import { SearchBox } from './search';

export interface UIService {
  toast(msg: string, opts?: ToastOptions): () => void;
  registerPanel(opts: PanelOptions): PanelHandle;
  flyTo(x: number, z: number, opts?: FlyOptions): void;
  showPlace(nameOrItem: string | PlaceItem): boolean;
  setLabelsVisible(v: boolean): void;
  readonly root: HTMLElement | null;
  readonly lang: Lang;
}

export interface PlacesService {
  list: Array<{ name: string; x: number; z: number; kind: string; rank: number }>;
  items: PlaceItem[];
  flyTo(name: string): boolean;
  search(q: string, limit?: number): PlaceItem[];
  nearest(x: number, z: number, kind?: string, maxDist?: number): PlaceItem | null;
  ready: Promise<void>;
}

interface Prefs { labels: boolean; streets: boolean; minimap: boolean; stats: boolean }

function loadPrefs(): Prefs {
  const def: Prefs = { labels: true, streets: true, minimap: true, stats: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem('nev3d.ui') || '{}') }; } catch { return def; }
}

/** Fly-to framing per kind. */
function framing(it: PlaceItem): FlyOptions {
  switch (it.k) {
    case 'settlement': return { distance: 3200, pitch: -32, height: 0 };
    case 'district': return { distance: 1500, pitch: -32, height: 0 };
    case 'street': return { distance: it.r <= 2 ? 520 : 260, pitch: -30, height: 2 };
    case 'water': return { distance: it.r <= 1 ? 900 : 450, pitch: -24, height: 0 };
    case 'coords': return { distance: 320, pitch: -35, height: 0 };
    default: {
      const hgt = it.h ?? 12;
      if (hgt > 100) return { distance: Math.max(700, hgt * 3.2), pitch: -14, height: hgt * 0.45 };
      if (it.k === 'power' || it.k === 'industry') return { distance: 900, pitch: -25, height: 20 };
      return { distance: it.r <= 2 ? 260 : 160, pitch: -24, height: Math.min(hgt, 20) * 0.6 };
    }
  }
}

class UIApp {
  readonly gz = new Gazetteer();
  readonly flight: CameraFlight;
  root: HTMLDivElement | null = null;
  private chrome: HTMLDivElement | null = null;
  private labels: Labels | null = null;
  private toasts: Toasts | null = null;
  private touch: TouchControls | null = null;
  private hud: Hud | null = null;
  private minimap: MiniMap | null = null;
  private toolbar: Toolbar | null = null;
  private modes: ModeBar | null = null;
  private card: PlaceCard | null = null;
  private stats: Stats | null = null;
  private search: SearchBox | null = null;
  private tw: TimeWeather | null = null;
  private timePanel: PanelHandle | null = null;
  private statsBtn: PanelHandle | null = null;
  private prefs = loadPrefs();
  private external: Array<{ opts: PanelOptions; proxy: PanelHandle; cur: PanelHandle | null }> = [];
  private helpClose: (() => void) | null = null;
  private placesReady!: Promise<void>;
  readonly headless: boolean;

  constructor(private ctx: AppContext) {
    this.headless = ctx.settings.shot;
    this.flight = new CameraFlight(ctx);
  }

  // ------------------------------------------------------------------ services
  provideServices(): void {
    const ctx = this.ctx;
    const self = this;
    const ui: UIService = {
      toast: (msg, o) => (this.toasts ? this.toasts.show(msg, o) : (console.info('[ui]', msg), () => {})),
      registerPanel: (o) => this.registerExternal(o),
      flyTo: (x, z, o) => this.flight.flyTo(x, z, o),
      showPlace: (n) => {
        const it = typeof n === 'string' ? this.gz.byName(n) : n;
        if (!it) return false;
        this.choose(it);
        return true;
      },
      setLabelsVisible: (v) => this.setPref('labels', v),
      get root() { return self.root; },
      get lang() { return getLang(); },
    };
    ctx.provide('ui', ui);
    const places: PlacesService = {
      list: [],
      items: this.gz.items,
      flyTo: (name) => {
        const it = this.gz.byName(name);
        if (!it) return false;
        this.choose(it);
        return true;
      },
      search: (q, limit = 8) => this.gz.search(q, { x: ctx.camera.position.x, z: ctx.camera.position.z, limit }).map((r) => r.item),
      nearest: (x, z, kind, maxDist = Infinity) => this.gz.nearest(x, z, (it) => !kind || it.k === kind, maxDist)?.item ?? null,
      ready: Promise.resolve(),
    };
    this.placesReady = fetchJSON<PlacesData>('places/places.json')
      .then((d) => {
        this.gz.load(d);
        places.items = this.gz.items;
        places.list = this.gz.items.map((it) => ({ name: it.n, x: it.x, z: it.z, kind: it.k, rank: it.r }));
      })
      .catch((e) => console.warn('[ui] places data unavailable', e))
      .then(() => {
        ctx.provide('places', places);
        this.search && document.activeElement === this.search.input && this.search.render();
      });
    places.ready = this.placesReady;
  }

  // ------------------------------------------------------------------ DOM
  mount(): void {
    const ctx = this.ctx;
    const host = document.getElementById('ui-root');
    if (!host) return;
    if (!document.getElementById('nv-ui-style')) {
      document.head.append(h('style', { id: 'nv-ui-style', text: CSS }));
    }
    this.root = h('div', { class: 'nv-ui', lang: getLang() });
    host.append(this.root);
    this.toasts = new Toasts(this.root);
    this.labels = new Labels(ctx, this.gz, this.root);
    this.labels.onClick = (it) => this.choose(it);
    this.labels.blockers = () => {
      const out: DOMRect[] = [];
      const c = this.chrome;
      if (!c || this.root?.classList.contains('nv-clean')) return out;
      c.querySelectorAll('.nv-brand, .nv-search-box, .nv-results, .nv-card, .nv-tr > *, .nv-panel:not(.nv-hidden), .nv-mm, .nv-modes, .nv-status, .nv-loc, .nv-stats')
        .forEach((el) => { if ((el as HTMLElement).offsetParent !== null) out.push(el.getBoundingClientRect()); });
      return out;
    };
    this.labels.setEnabled(this.prefs.labels);
    this.labels.streets = this.prefs.streets;
    if (isTouchDevice()) {
      this.touch = new TouchControls(ctx, this.root, (x, y) => this.doubleClick(x, y));
    }
    this.buildChrome();
    this.bindGlobal();
    ctx.onUpdate((dt) => this.update(dt), 500);
    for (const ev of ['controller', 'controller:added', 'service:pathtracer']) ctx.events.on(ev, () => this.modes?.refresh());
    ctx.events.on('controller', () => this.touch?.setFlyButtons(ctx.controller.name === 'fly'));
  }

  private buildChrome(): void {
    const ctx = this.ctx;
    const root = this.root!;
    this.root!.lang = getLang();
    const chrome = h('div', { class: 'nv-chrome', style: 'position:absolute;inset:0;pointer-events:none' });
    this.chrome = chrome;
    root.append(chrome);

    // top-left: brand, search, card column
    const tl = h('div', { class: 'nv-tl' });
    const brand = h('div', { class: 'nv-brand' },
      h('div', { class: 'nv-logo', html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V11l4-3v13"/><path d="M9 21V6l5-3v18"/><path d="M14 21v-8l5 2v6"/></svg>' }),
      h('div', null, h('h1', { text: t('title') }), h('p', { text: t('subtitle') })));
    tl.append(brand);
    chrome.append(tl);
    this.search = new SearchBox(ctx, this.gz, tl, (it) => this.choose(it));
    this.card = new PlaceCard(ctx, this.gz, this.flight, tl, chrome, {
      flyToItem: (it) => this.flyToItem(it),
      walkHere: (x, z) => this.walkHere(x, z),
      share: () => this.share(),
      onClose: () => this.labels?.select(null),
    });

    // top-right: compass + toolbar
    const tr = h('div', { class: 'nv-tr' });
    chrome.append(tr);
    this.hud = new Hud(ctx, this.flight, this.gz, tr, chrome);
    this.toolbar = new Toolbar(tr, chrome);
    this.tw = new TimeWeather(ctx);
    this.timePanel = this.toolbar.register({
      id: 'time', title: t('time'), icon: ctx.env.night > 0.5 ? ICON.moon : ICON.sun, order: 10, key: 'KeyT',
      content: (b) => this.tw!.build(b), onOpen: () => this.tw!.refresh(),
    });
    this.toolbar.register({ id: 'map', title: t('map'), icon: ICON.map, order: 20, onClick: () => this.minimap?.toggleBig() });
    this.toolbar.register({ id: 'settings', title: t('settings'), icon: ICON.sliders, order: 30, content: (b) => this.buildSettings(b) });
    this.toolbar.register({ id: 'screenshot', title: `${t('screenshot')} (K)`, icon: ICON.camera, order: 40, separator: true, onClick: () => this.screenshot() });
    this.toolbar.register({ id: 'share', title: t('share'), icon: ICON.share, order: 50, onClick: () => this.share() });
    this.statsBtn = this.toolbar.register({ id: 'stats', title: t('stats'), icon: ICON.activity, order: 60, onClick: () => this.setPref('stats', !this.prefs.stats) });
    this.toolbar.register({ id: 'help', title: `${t('help')} (H)`, icon: ICON.help, order: 70, onClick: () => this.help() });
    this.toolbar.register({ id: 'fullscreen', title: t('fullscreen'), icon: ICON.maximize, order: 80, onClick: () => this.fullscreen() });
    for (const ex of this.external) {
      ex.cur = this.toolbar.register(ex.opts);
      if (ex.opts.content instanceof HTMLElement) { /* re-parented lazily on open */ }
    }

    // bottom
    this.minimap = new MiniMap(ctx, this.flight, this.gz, chrome, (it, x, z) => {
      if (it) { this.labels?.select(it); }
      void x; void z;
    });
    this.minimap.el.classList.toggle('nv-hidden', !this.prefs.minimap);
    this.modes = new ModeBar(ctx, chrome, (m) => this.toasts?.show(m, { key: 'mode' }), () => this.flight.cancel());
    this.stats = new Stats(ctx, chrome);
    this.stats.setVisible(this.prefs.stats || ctx.settings.debug);
    this.statsBtn.setActive(this.stats.visible);
    chrome.append(h('div', { class: 'nv-attrib', text: '© OpenStreetMap, Overture Maps · Copernicus / ESA Sentinel-2' }));
    this.touch?.setFlyButtons(ctx.controller.name === 'fly');
  }

  rebuild(): void {
    this.card?.close();
    this.chrome?.remove();
    this.helpClose?.();
    this.labels?.refreshText();
    this.buildChrome();
  }

  private registerExternal(opts: PanelOptions): PanelHandle {
    const ex = { opts, cur: null as PanelHandle | null, proxy: null as unknown as PanelHandle };
    const call = (fn: keyof PanelHandle) => () => { const c = ex.cur as any; if (c) c[fn](); };
    ex.proxy = {
      get el() { return ex.cur ? ex.cur.el : h('div'); },
      get button() { return ex.cur ? ex.cur.button : (h('button') as HTMLButtonElement); },
      get isOpen() { return !!ex.cur?.isOpen; },
      open: call('open'), close: call('close'), toggle: call('toggle'),
      remove: () => { ex.cur?.remove(); this.external = this.external.filter((e) => e !== ex); },
      setActive: (v: boolean) => ex.cur?.setActive(v),
      setTitle: (s: string) => { opts.title = s; ex.cur?.setTitle(s); },
    };
    this.external.push(ex);
    if (this.toolbar) ex.cur = this.toolbar.register(opts);
    return ex.proxy;
  }

  // ------------------------------------------------------------------ settings panel
  private buildSettings(b: HTMLElement): void {
    const ctx = this.ctx;
    b.append(h('h4', { text: t('quality'), style: 'margin-top:0' }));
    const seg = h('div', { class: 'nv-seg' });
    const qBtns: HTMLButtonElement[] = [];
    for (const q of QUALITY_ORDER) {
      const btn = h('button', { text: t(`q${q}` as any) }) as HTMLButtonElement;
      btn.classList.toggle('nv-on', ctx.settings.quality === q);
      btn.addEventListener('click', () => {
        this.setQuality(q);
        qBtns.forEach((x, i) => x.classList.toggle('nv-on', QUALITY_ORDER[i] === q));
      });
      qBtns.push(btn);
      seg.append(btn);
    }
    b.append(seg);
    const p = ctx.settings.profile;
    b.append(h('div', { class: 'nv-note', text: getLang() === 'ru'
      ? `Тени ${p.shadowMapSize}px × ${p.shadowCascades}, дальность ${Math.round(p.drawDistance / 1000)} км, облака: ${p.clouds}`
      : `Shadows ${p.shadowMapSize}px × ${p.shadowCascades}, draw distance ${Math.round(p.drawDistance / 1000)} km, clouds: ${p.clouds}` }));

    b.append(h('h4', { text: getLang() === 'ru' ? 'Отображение' : 'Display' }));
    const sw = (label: string, key: keyof Prefs) => {
      const s = h('button', { class: `nv-switch${this.prefs[key] ? ' nv-on' : ''}`, 'aria-label': label, role: 'switch' });
      s.addEventListener('click', () => { this.setPref(key, !this.prefs[key]); s.classList.toggle('nv-on', this.prefs[key]); });
      b.append(h('div', { class: 'nv-row' }, h('label', { text: label }), s));
    };
    sw(t('labels'), 'labels');
    sw(t('streetLabels'), 'streets');
    sw(t('minimap'), 'minimap');
    sw(t('stats'), 'stats');

    const fovVal = h('span', { class: 'nv-val' });
    const fov = h('input', { type: 'range', min: 30, max: 100, step: 1, value: ctx.camera.fov }) as HTMLInputElement;
    fovVal.textContent = `${Math.round(ctx.camera.fov)}°`;
    fov.addEventListener('input', () => {
      ctx.camera.fov = +fov.value;
      ctx.camera.updateProjectionMatrix();
      fovVal.textContent = `${fov.value}°`;
    });
    b.append(h('div', { class: 'nv-row' }, h('label', { text: t('fov') }), h('div', { style: 'flex:1.4' }, fov), fovVal));

    const fly = ctx.controllers.get('fly') as any;
    if (fly && typeof fly.speedFactor === 'number') {
      const spVal = h('span', { class: 'nv-val' });
      const sp = h('input', { type: 'range', min: -3, max: 3, step: 0.1, value: Math.log2(fly.speedFactor) }) as HTMLInputElement;
      const upd = () => { spVal.textContent = `×${fly.speedFactor < 1 ? fly.speedFactor.toFixed(2) : fly.speedFactor.toFixed(1)}`; };
      sp.addEventListener('input', () => { fly.speedFactor = Math.pow(2, +sp.value); upd(); });
      upd();
      b.append(h('div', { class: 'nv-row' }, h('label', { text: getLang() === 'ru' ? 'Скорость полёта' : 'Flight speed' }), h('div', { style: 'flex:1.4' }, sp), spVal));
    }

    b.append(h('h4', { text: t('language') }));
    const lseg = h('div', { class: 'nv-seg' });
    for (const [l, label] of [['ru', 'Русский'], ['en', 'English']] as const) {
      const btn = h('button', { text: label });
      btn.classList.toggle('nv-on', getLang() === l);
      btn.addEventListener('click', () => { if (getLang() !== l) { setLang(l); this.rebuild(); } });
      lseg.append(btn);
    }
    b.append(lseg);
  }

  private setQuality(q: Quality): void {
    const ctx = this.ctx;
    if (ctx.settings.quality === q) return;
    ctx.settings.setQuality(q);
    try { ctx.resize(); } catch (e) { console.warn('[ui] resize', e); }
    ctx.events.emit('settings', q);
    this.toasts?.show(t('qualityChanged'), { key: 'quality', action: { label: t('reload'), fn: () => location.reload() } });
  }

  private setPref(key: keyof Prefs, v: boolean): void {
    this.prefs[key] = v;
    try { localStorage.setItem('nev3d.ui', JSON.stringify(this.prefs)); } catch { /* ignore */ }
    if (key === 'labels') this.labels?.setEnabled(v);
    if (key === 'streets' && this.labels) { this.labels.streets = v; this.labels.refreshText(); }
    if (key === 'minimap') this.minimap?.el.classList.toggle('nv-hidden', !v);
    if (key === 'stats') { this.stats?.setVisible(v); this.statsBtn?.setActive(v); }
  }

  // ------------------------------------------------------------------ actions
  choose(it: PlaceItem): void {
    this.flyToItem(it);
    this.card?.showItem(it);
    this.labels?.select(it.id >= 0 ? it : null);
  }

  flyToItem(it: PlaceItem): void {
    const f = framing(it);
    const cam = this.ctx.camera.position;
    const horiz = Math.hypot(it.x - cam.x, it.z - cam.z);
    // look along the approach, but for very close targets orbit a bit from the current side
    if (horiz < 50) f.heading = getHeadingPitch(this.ctx.camera).heading;
    this.flight.flyTo(it.x, it.z, f);
  }

  private walkHere(x: number, z: number): void {
    const ctx = this.ctx;
    if (!ctx.controllers.has('walk')) return;
    this.flight.cancel();
    const g = ctx.heightfield.sample(x, z);
    const hp = getHeadingPitch(ctx.camera);
    ctx.camera.position.set(x, g + 1.7, z);
    applyHeadingPitch(ctx.camera, hp.heading, 0);
    ctx.camera.updateMatrixWorld();
    this.modes?.setMode('walk');
    ctx.events.emit('teleport', { x, z });
  }

  shareUrl(): string {
    const ctx = this.ctx;
    const c = ctx.camera.position;
    const hp = getHeadingPitch(ctx.camera);
    const env = ctx.env;
    const q = new URLSearchParams();
    q.set('cam', [c.x, c.y, c.z, hp.heading, hp.pitch].map((v) => v.toFixed(1)).join(','));
    q.set('time', env.hours.toFixed(2));
    q.set('date', `${env.year}-${String(env.month).padStart(2, '0')}-${String(env.day).padStart(2, '0')}`);
    const w = ctx.get<any>('sky')?.getWeather?.();
    if (w) {
      q.set('clouds', w.cloudCover.toFixed(2));
      if (w.rain > 0.01) q.set('rain', w.rain.toFixed(2));
      if (w.fog > 0.01) q.set('fog', w.fog.toFixed(2));
    }
    if (ctx.controller.name !== 'fly') q.set('mode', ctx.controller.name);
    const keep = ctx.settings.params.get('lang');
    if (keep) q.set('lang', keep);
    return `${location.origin}${location.pathname}?${q.toString().replace(/%2C/g, ',')}`;
  }

  share(): void {
    const url = this.shareUrl();
    try { history.replaceState(null, '', url); } catch { /* ignore */ }
    const done = () => this.toasts?.show(t('linkCopied'), { key: 'share' });
    const fallback = () => { window.prompt(t('copyLink'), url); };
    if (navigator.share && isTouchDevice()) {
      navigator.share({ title: t('title'), url }).catch(() => { /* cancelled */ });
      return;
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, fallback);
    else fallback();
  }

  screenshot(): void {
    const ctx = this.ctx;
    const off = ctx.events.on('frame', () => {
      off();
      try {
        ctx.canvas.toBlob((blob) => {
          if (!blob) return;
          const a = document.createElement('a');
          const d = new Date();
          const p = (n: number) => String(n).padStart(2, '0');
          a.download = `nevinnomyssk-3d-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
          a.href = URL.createObjectURL(blob);
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          this.toasts?.show(t('screenshotSaved'), { key: 'shot' });
        }, 'image/png');
      } catch (e) {
        console.error('[ui] screenshot failed', e);
      }
    });
    const flash = h('div', { class: 'nv-flash' });
    this.root?.append(flash);
    setTimeout(() => flash.remove(), 500);
  }

  help(): void {
    if (this.helpClose) { this.helpClose(); return; }
    const done = openHelp(this.root!, {
      walk: this.ctx.controllers.has('walk'), drive: this.ctx.controllers.has('drive'), photo: !!this.ctx.get('pathtracer'),
    });
    this.helpClose = () => { done(); this.helpClose = null; };
    const obs = new MutationObserver(() => { if (!this.root!.querySelector('.nv-modal-bg')) { this.helpClose = null; obs.disconnect(); } });
    obs.observe(this.root!, { childList: true });
  }

  fullscreen(): void {
    const d = document as any;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen)?.call(d);
    else {
      const el = document.documentElement as any;
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
    }
  }

  // ------------------------------------------------------------------ picking
  private pickInfo(p: THREE.Vector3): PickInfo {
    const ctx = this.ctx;
    const info: PickInfo = { x: p.x, y: p.y, z: p.z };
    const g = ctx.heightfield.sample(p.x, p.z);
    const b = ctx.get<any>('buildings');
    let bIndex = -1;
    try {
      const bi = b?.infoAt?.(p.x, p.z);
      if (bi && p.y > g - 1) { info.building = bi; bIndex = bi.index ?? -1; }
    } catch { /* ignore */ }
    const poi = (it: PlaceItem) => it.k !== 'street' && it.k !== 'district' && it.k !== 'settlement' && it.k !== 'water' && it.k !== 'bus_stop';
    // a POI belongs to the picked building if it lies inside the same footprint; otherwise only very close ones
    let place: PlaceItem | null = null;
    if (bIndex >= 0) {
      let bd = 80;
      for (const it of this.gz.items) {
        if (!poi(it)) continue;
        const d = Math.hypot(it.x - p.x, it.z - p.z);
        if (d >= bd) continue;
        try { if (b.infoAt(it.x, it.z)?.index === bIndex) { bd = d; place = it; } } catch { /* ignore */ }
      }
    }
    if (!place) place = this.gz.nearest(p.x, p.z, poi, info.building ? 12 : 25)?.item ?? null;
    info.place = place;
    const loc = this.hud?.locationAt(p.x, p.z, 0);
    info.street = loc?.street;
    info.area = loc?.area;
    try { info.ground = ctx.get<any>('terrain')?.groundTypeAt?.(p.x, p.z); } catch { /* ignore */ }
    try { info.isWater = !!ctx.get<any>('water')?.isWater?.(p.x, p.z); } catch { /* ignore */ }
    if (info.isWater) info.water = this.gz.nearest(p.x, p.z, (it) => it.k === 'water' && !!it.L, 4000)?.item ?? null;
    return info;
  }

  private click(clientX: number, clientY: number): void {
    const p = pickWorld(this.ctx, clientX, clientY);
    if (!p) return;
    const info = this.pickInfo(p);
    this.card?.showPick(info);
    this.labels?.select(info.place ?? null);
  }

  private doubleClick(clientX: number, clientY: number): void {
    const ctx = this.ctx;
    const p = pickWorld(ctx, clientX, clientY);
    if (!p) return;
    const cam = ctx.camera;
    const hp = getHeadingPitch(cam);
    const d = cam.position.distanceTo(p);
    const g = ctx.heightfield.sample(p.x, p.z);
    this.flight.flyTo(p.x, p.z, {
      distance: THREE.MathUtils.clamp(d * 0.4, 40, 2500),
      pitch: THREE.MathUtils.clamp(hp.pitch, -65, -12),
      heading: hp.heading,
      height: p.y - g,
    });
  }

  private bindGlobal(): void {
    const ctx = this.ctx;
    const canvas = ctx.canvas;
    let down: { x: number; y: number; t: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) { down = null; return; }
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.search?.input.blur();
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || document.pointerLockElement) return;
      if (ctx.controller.name !== 'fly' || this.flight.active) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 450) return;
      if (e.pointerType === 'touch') return; // touch uses double-tap
      this.click(e.clientX, e.clientY);
    });
    canvas.addEventListener('dblclick', (e) => {
      if (ctx.controller.name !== 'fly' || document.pointerLockElement) return;
      this.doubleClick(e.clientX, e.clientY);
    });
    window.addEventListener('keydown', (e) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const code = e.code;
      if (e.key === '/' || (code === 'KeyF' && e.shiftKey)) { e.preventDefault(); this.search?.focus(); return; }
      if (e.key === '?' || code === 'KeyH') { e.preventDefault(); this.help(); return; }
      if (code === 'KeyM') { this.minimap?.toggleBig(); return; }
      if (code === 'KeyL') { this.setPref('labels', !this.prefs.labels); this.toasts?.show(`${t('labels')}: ${this.prefs.labels ? 'on' : 'off'}`, { key: 'labels', duration: 1500 }); return; }
      if (code === 'KeyK') { this.screenshot(); return; }
      if (code === 'KeyU') { this.root?.classList.toggle('nv-clean'); return; }
      if (/^Digit[1-4]$/.test(code)) { if (this.modes?.key(code.slice(5))) e.preventDefault(); return; }
      if (e.key === 'Escape') {
        if (this.card?.el) { this.card.close(); return; }
      }
      this.toolbar?.key(code);
    });
  }

  // ------------------------------------------------------------------ frame
  private update(dt: number): void {
    try {
      this.labels?.update(dt);
      this.hud?.update(dt);
      this.minimap?.update(dt);
      this.card?.update();
      this.modes?.update(dt);
      this.tw?.update(dt, !!this.timePanel?.isOpen);
      this.stats?.update();
    } catch (e) {
      console.error('[ui] update', e);
    }
  }

  // ------------------------------------------------------------------ intro
  intro(): void {
    const ctx = this.ctx;
    const p = ctx.settings.params;
    const t0 = this.touch ? t('touchWelcome') : t('welcome');
    let seen = false;
    try { seen = localStorage.getItem('nev3d.seen') === '1'; localStorage.setItem('nev3d.seen', '1'); } catch { /* ignore */ }
    const mode = p.get('mode');
    if (mode && ctx.controllers.has(mode)) ctx.setController(mode);
    if (p.has('cam') || p.has('ll') || p.get('intro') === '0' || mode) {
      if (!seen) this.toasts?.show(t0, { duration: 6000 });
      return;
    }
    const cam = ctx.camera;
    const endPos = cam.position.clone();
    const hp = getHeadingPitch(cam);
    // start high above the Kuban valley south-east of the centre, looking at the city
    cam.position.set(endPos.x + 3800, endPos.y + 3400, endPos.z + 5200);
    cam.lookAt(0, 400, 0);
    const s = getHeadingPitch(cam);
    applyHeadingPitch(cam, s.heading, s.pitch);
    cam.updateMatrixWorld();
    this.flight.flyTo(endPos.x, endPos.z, {
      position: endPos, heading: hp.heading, pitch: hp.pitch, duration: 6,
      onDone: () => { if (!seen) this.toasts?.show(t0, { duration: 6000 }); },
    });
    setTimeout(() => { if (!this.flight.active && !seen) { /* cancelled early */ } }, 0);
  }
}

const mod: CityModule = {
  id: 'ui',
  init(ctx: AppContext) {
    const app = new UIApp(ctx);
    (window as any).__ui = app;
    app.provideServices();
    if (app.headless) return; // shot mode: services only, no chrome
    try { enhanceLoading(); } catch (e) { console.warn('[ui] loading screen', e); }
    try {
      app.mount();
    } catch (e) {
      console.error('[ui] mount failed', e);
      return;
    }
    ctx.events.once('ready', () => {
      try { app.intro(); } catch (e) { console.warn('[ui] intro', e); }
    });
  },
};
export default mod;
