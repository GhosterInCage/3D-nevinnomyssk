// Time-of-day / date / play-pause and weather controls.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { solarPosition } from '../../core/sun';
import { ORIGIN, UTC_OFFSET_HOURS } from '../../core/geo';
import { ICON } from './icons';
import { h } from './dom';
import { fmtTime, getLang, t, type StrKey } from './i18n';

export const WEATHER_PRESETS: Record<string, { cloudCover: number; rain: number; fog: number; cirrus: number; icon: string }> = {
  clear: { cloudCover: 0.0, rain: 0, fog: 0, cirrus: 0.15, icon: ICON.sun },
  fair: { cloudCover: 0.32, rain: 0, fog: 0, cirrus: 0.3, icon: ICON.cloudSun },
  cloudy: { cloudCover: 0.62, rain: 0, fog: 0, cirrus: 0.2, icon: ICON.cloud },
  overcast: { cloudCover: 0.95, rain: 0, fog: 0.1, cirrus: 0, icon: ICON.overcast },
  rain: { cloudCover: 1.0, rain: 0.8, fog: 0.25, cirrus: 0, icon: ICON.rain },
  storm: { cloudCover: 1.0, rain: 1.0, fog: 0.35, cirrus: 0, icon: ICON.storm },
  fog: { cloudCover: 0.5, rain: 0, fog: 0.8, cirrus: 0.1, icon: ICON.fog },
};

const SPEEDS = [
  { v: 60 / 3600, ru: '1 мин/с', en: '1 min/s' },
  { v: 600 / 3600, ru: '10 мин/с', en: '10 min/s' },
  { v: 1, ru: '1 ч/с', en: '1 h/s' },
];

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Sunrise / sunset (local hours) for the env date, by scanning elevation crossings of -0.833°. */
function sunTimes(y: number, m: number, d: number): { rise: number | null; set: number | null } {
  let rise: number | null = null, set: number | null = null;
  const v = new THREE.Vector3();
  let prev = -90;
  for (let i = 0; i <= 24 * 12; i++) {
    const hrs = i / 12;
    const date = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + (hrs - UTC_OFFSET_HOURS) * 3600000);
    const e = solarPosition(date, ORIGIN.lat, ORIGIN.lon, v).elevation + 0.833;
    if (i > 0) {
      if (prev < 0 && e >= 0 && rise === null) rise = hrs - (e / (e - prev)) / 12;
      if (prev >= 0 && e < 0) set = hrs - (e / (e - prev)) / 12;
    }
    prev = e;
  }
  return { rise, set };
}

export class TimeWeather {
  private timeBig!: HTMLElement;
  private dateLbl!: HTMLElement;
  private sunLine!: HTMLElement;
  private slider!: HTMLInputElement;
  private dateInput!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];
  private wxBtns = new Map<string, HTMLButtonElement>();
  private sliders: Record<string, { input: HTMLInputElement; val: HTMLElement }> = {};
  private speedIdx = 1;
  private sunCacheKey = '';
  private sun = { rise: null as number | null, set: null as number | null };
  private dragging = false;
  private timer = 0;
  built = false;

  constructor(private ctx: AppContext) {}

  build(body: HTMLElement): void {
    this.built = true;
    const ctx = this.ctx;
    this.timeBig = h('b');
    this.dateLbl = h('span');
    this.sunLine = h('div', { class: 'nv-sunline' });
    this.slider = h('input', { type: 'range', min: 0, max: 24, step: 1 / 60, class: 'nv-time-slider', 'aria-label': t('timeOfDay') }) as HTMLInputElement;
    this.slider.addEventListener('input', () => { this.dragging = true; this.setTime(+this.slider.value); });
    this.slider.addEventListener('change', () => { this.dragging = false; });
    this.playBtn = h('button', { class: 'nv-btn', html: ICON.play }) as HTMLButtonElement;
    this.playBtn.addEventListener('click', () => this.togglePlay());
    const seg = h('div', { class: 'nv-seg', style: 'flex:1' });
    SPEEDS.forEach((s, i) => {
      const b = h('button', { text: getLang() === 'ru' ? s.ru : s.en }) as HTMLButtonElement;
      b.addEventListener('click', () => {
        this.speedIdx = i;
        if (ctx.env.timeScale) ctx.env.timeScale = s.v;
        this.refresh();
      });
      this.speedBtns.push(b);
      seg.append(b);
    });
    this.dateInput = h('input', { type: 'date', 'aria-label': t('date') }) as HTMLInputElement;
    this.dateInput.addEventListener('change', () => {
      if (!this.dateInput.value) return;
      ctx.env.setDate(this.dateInput.value);
      ctx.env.update(0);
      ctx.events.emit('time', ctx.env.hours);
      this.refresh();
    });
    const seasons = h('div', { class: 'nv-chips', style: 'padding:6px 0 0' });
    const S: Array<[string, string, string]> = [['03-20', 'Весна', 'Spring'], ['06-21', 'Лето', 'Summer'], ['09-22', 'Осень', 'Autumn'], ['12-21', 'Зима', 'Winter']];
    for (const [md, ru, en] of S) {
      const c = h('button', { class: 'nv-chip', text: getLang() === 'ru' ? ru : en });
      c.addEventListener('click', () => {
        this.dateInput.value = `${ctx.env.year}-${md}`;
        this.dateInput.dispatchEvent(new Event('change'));
      });
      seasons.append(c);
    }

    body.append(
      h('div', { class: 'nv-time-big' }, this.timeBig, this.dateLbl),
      this.slider,
      this.sunLine,
      h('div', { class: 'nv-row' }, this.playBtn, seg),
      h('div', { class: 'nv-row' }, h('label', { text: t('date') }), this.dateInput),
      seasons,
    );

    body.append(h('h4', { text: t('weather') }));
    const sky = ctx.get<any>('sky');
    if (!sky?.setWeather) {
      body.append(h('div', { class: 'nv-note', text: t('noSky') }));
    }
    const grid = h('div', { class: 'nv-wx' });
    for (const [k, p] of Object.entries(WEATHER_PRESETS)) {
      const b = h('button', { html: `${p.icon}<span>${t(k as StrKey)}</span>` }) as HTMLButtonElement;
      b.addEventListener('click', () => this.setWeather(k));
      this.wxBtns.set(k, b);
      grid.append(b);
    }
    body.append(grid);
    for (const [k, label] of [['cloudCover', 'clouds'], ['rain', 'rainAmt'], ['fog', 'fogAmt']] as const) {
      const input = h('input', { type: 'range', min: 0, max: 1, step: 0.01 }) as HTMLInputElement;
      const val = h('span', { class: 'nv-val' });
      input.addEventListener('input', () => {
        const s = this.ctx.get<any>('sky');
        s?.setWeather?.({ [k]: +input.value });
        val.textContent = `${Math.round(+input.value * 100)}%`;
        this.syncEnvWeather({ [k]: +input.value });
      });
      this.sliders[k] = { input, val };
      body.append(h('div', { class: 'nv-row' }, h('label', { text: t(label) }), h('div', { style: 'flex:1.4' }, input), val));
    }
    this.refresh();
  }

  setTime(hours: number): void {
    const ctx = this.ctx;
    const sky = ctx.get<any>('sky');
    const hh = ((hours % 24) + 24) % 24;
    if (sky?.setTime) sky.setTime(hh);
    else { ctx.env.hours = hh; ctx.events.emit('time', hh); }
    ctx.env.update(0);
    this.refresh(false);
  }

  togglePlay(): void {
    const env = this.ctx.env;
    env.timeScale = env.timeScale ? 0 : SPEEDS[this.speedIdx].v;
    this.refresh();
  }

  setWeather(key: string): void {
    const p = WEATHER_PRESETS[key];
    if (!p) return;
    const sky = this.ctx.get<any>('sky');
    sky?.setWeather?.({ cloudCover: p.cloudCover, rain: p.rain, fog: p.fog, cirrus: p.cirrus });
    this.syncEnvWeather(p);
    this.refresh();
  }

  private syncEnvWeather(w: { cloudCover?: number; rain?: number; fog?: number }): void {
    // keep ctx.env in sync when the sky module is absent (it normally writes env itself)
    if (this.ctx.get('sky')) return;
    const env = this.ctx.env;
    if (w.cloudCover !== undefined) env.cloudCover = w.cloudCover;
    if (w.rain !== undefined) env.rain = w.rain;
    if (w.fog !== undefined) env.fog = w.fog;
  }

  currentWeather(): { cloudCover: number; rain: number; fog: number } {
    const sky = this.ctx.get<any>('sky');
    const w = sky?.getWeather?.();
    if (w) return w;
    return { cloudCover: this.ctx.env.cloudCover, rain: this.ctx.env.rain, fog: this.ctx.env.fog };
  }

  refresh(updateSlider = true): void {
    if (!this.built) return;
    const env = this.ctx.env;
    this.timeBig.textContent = fmtTime(env.hours);
    const ru = getLang() === 'ru';
    this.dateLbl.textContent = ru ? `${env.day} ${MONTHS_RU[env.month - 1]} ${env.year}` : `${MONTHS_EN[env.month - 1]} ${env.day}, ${env.year}`;
    if (updateSlider && !this.dragging) this.slider.value = String(env.hours);
    const key = `${env.year}-${env.month}-${env.day}`;
    if (key !== this.sunCacheKey) { this.sunCacheKey = key; this.sun = sunTimes(env.year, env.month, env.day); }
    const el = env.sunElevation;
    this.sunLine.innerHTML = `<span>${t('sunrise')} ${this.sun.rise !== null ? fmtTime(this.sun.rise) : '—'}</span>`
      + `<span>${t('sunElev')} ${el.toFixed(0)}°</span><span>${t('sunset')} ${this.sun.set !== null ? fmtTime(this.sun.set) : '—'}</span>`;
    const iso = `${env.year}-${String(env.month).padStart(2, '0')}-${String(env.day).padStart(2, '0')}`;
    if (document.activeElement !== this.dateInput) this.dateInput.value = iso;
    this.playBtn.innerHTML = `${env.timeScale ? ICON.pause : ICON.play}<span>${env.timeScale ? t('pause') : t('play')}</span>`;
    this.speedBtns.forEach((b, i) => b.classList.toggle('nv-on', i === this.speedIdx));
    const w = this.currentWeather();
    let best = '', bd = 0.12;
    for (const [k, p] of Object.entries(WEATHER_PRESETS)) {
      const d = Math.abs(p.cloudCover - w.cloudCover) + Math.abs(p.rain - w.rain) + Math.abs(p.fog - w.fog);
      if (d < bd) { bd = d; best = k; }
    }
    for (const [k, b] of this.wxBtns) b.classList.toggle('nv-on', k === best);
    for (const k of ['cloudCover', 'rain', 'fog'] as const) {
      const s = this.sliders[k];
      if (!s || document.activeElement === s.input) continue;
      s.input.value = String((w as any)[k] ?? 0);
      s.val.textContent = `${Math.round(((w as any)[k] ?? 0) * 100)}%`;
    }
  }

  update(dt: number, visible: boolean): void {
    if (!visible || !this.built) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    this.refresh();
  }
}
