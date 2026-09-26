// Compass, coordinate/status line and the "where am I" location pill.
import type { AppContext } from '../../core/context';
import { getHeadingPitch } from '../../core/controls';
import { worldToLonLat } from '../../core/geo';
import type { CameraFlight } from './flyto';
import type { Gazetteer } from './gazetteer';
import { ICON } from './icons';
import { h } from './dom';
import { cardinal, getLang, t } from './i18n';
import { latinName } from './translit';

function compassSvg(): string {
  let ticks = '';
  for (let i = 0; i < 36; i++) {
    const a = (i * 10 * Math.PI) / 180;
    const major = i % 9 === 0;
    const r0 = major ? 25 : 27.5, r1 = 30;
    ticks += `<line x1="${(32 + Math.sin(a) * r0).toFixed(2)}" y1="${(32 - Math.cos(a) * r0).toFixed(2)}" x2="${(32 + Math.sin(a) * r1).toFixed(2)}" y2="${(32 - Math.cos(a) * r1).toFixed(2)}" stroke="rgba(255,255,255,${major ? 0.8 : 0.35})" stroke-width="${major ? 1.6 : 1}"/>`;
  }
  const ru = getLang() === 'ru';
  const L = ru ? ['С', 'В', 'Ю', 'З'] : ['N', 'E', 'S', 'W'];
  const letters = L.map((s, i) => {
    const a = (i * 90 * Math.PI) / 180;
    const x = 32 + Math.sin(a) * 18.5, y = 32 - Math.cos(a) * 18.5;
    return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-size="${i === 0 ? 9.5 : 8}" font-weight="700" fill="${i === 0 ? '#ff6b6b' : 'rgba(255,255,255,.8)'}" font-family="system-ui,sans-serif">${s}</text>`;
  }).join('');
  return `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="31" fill="rgba(13,19,27,.62)" stroke="rgba(255,255,255,.12)"/>
    <g class="nv-rose">${ticks}${letters}<path d="M32 3.5 35 9h-6z" fill="#ff6b6b"/></g>
    <path d="M32 11.5 34.5 15.5h-5z" fill="#7cc4ff"/></svg>`;
}

/**
 * Nearest *named* street (the roads service's nearest() returns the nearest drivable edge, which is
 * often an unnamed service road / yard). Built lazily from roads.graph.edges.
 */
class StreetIndex {
  private cell = 80;
  private grid = new Map<number, number[]>();
  private segs: Float32Array;          // ax, az, bx, bz per segment
  private segName: string[] = [];
  constructor(edges: Array<{ cls: string; name?: string; points: Float32Array }>) {
    const tmp: number[] = [];
    const SKIP = new Set(['footway', 'path', 'steps', 'cycleway', 'track', 'rail', 'standard_gauge', 'narrow_gauge', 'tram', 'subway']);
    for (const e of edges) {
      if (!e.name || SKIP.has(e.cls)) continue;
      const p = e.points;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const i = tmp.length / 4;
        tmp.push(p[k], p[k + 1], p[k + 2], p[k + 3]);
        this.segName.push(e.name);
        const x0 = Math.floor(Math.min(p[k], p[k + 2]) / this.cell), x1 = Math.floor(Math.max(p[k], p[k + 2]) / this.cell);
        const z0 = Math.floor(Math.min(p[k + 1], p[k + 3]) / this.cell), z1 = Math.floor(Math.max(p[k + 1], p[k + 3]) / this.cell);
        for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
          const key = (gz + 512) * 1024 + (gx + 512);
          let a = this.grid.get(key);
          if (!a) this.grid.set(key, (a = []));
          a.push(i);
        }
      }
    }
    this.segs = new Float32Array(tmp);
  }

  nearest(x: number, z: number, maxDist: number): { name: string; dist: number } | null {
    const c = this.cell, s = this.segs;
    const r = Math.ceil(maxDist / c);
    const cx = Math.floor(x / c), cz = Math.floor(z / c);
    let best = -1, bd = maxDist * maxDist;
    for (let gz = cz - r; gz <= cz + r; gz++) for (let gx = cx - r; gx <= cx + r; gx++) {
      const a = this.grid.get((gz + 512) * 1024 + (gx + 512));
      if (!a) continue;
      for (const i of a) {
        const ax = s[4 * i], az = s[4 * i + 1], dx = s[4 * i + 2] - ax, dz = s[4 * i + 3] - az;
        const L2 = dx * dx + dz * dz;
        let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - x, ez = az + dz * t - z;
        const d2 = ex * ex + ez * ez;
        if (d2 < bd) { bd = d2; best = i; }
      }
    }
    return best >= 0 ? { name: this.segName[best], dist: Math.sqrt(bd) } : null;
  }
}

export class Hud {
  readonly compass: HTMLDivElement;
  readonly status: HTMLDivElement;
  readonly loc: HTMLDivElement;
  private rose: SVGGElement | null = null;
  private hdEl: HTMLDivElement;
  private timer = 0;
  private locTimer = 0;
  private lastHeading = NaN;
  private streets: StreetIndex | null = null;

  constructor(private ctx: AppContext, private flight: CameraFlight, private gz: Gazetteer, tr: HTMLElement, root: HTMLElement) {
    this.hdEl = h('div', { class: 'nv-hd' });
    this.compass = h('div', { class: 'nv-compass nv-i', title: t('north'), html: compassSvg() });
    this.compass.append(this.hdEl);
    this.compass.addEventListener('click', () => this.faceNorth());
    this.rose = this.compass.querySelector('.nv-rose');
    tr.prepend(this.compass);
    this.status = h('div', { class: 'nv-status nv-glass' });
    this.loc = h('div', { class: 'nv-loc nv-glass' });
    root.append(this.status, this.loc);
  }

  rebuild(): void {
    this.compass.innerHTML = compassSvg();
    this.compass.append(this.hdEl);
    this.compass.title = t('north');
    this.rose = this.compass.querySelector('.nv-rose');
    this.lastHeading = NaN;
    this.locTimer = 0;
  }

  faceNorth(): void {
    const hp = getHeadingPitch(this.ctx.camera);
    const turn = Math.abs(((hp.heading + 540) % 360) - 180);
    this.flight.rotateTo(0, hp.pitch, 0.5 + turn / 180 * 0.6);
  }

  update(dt: number): void {
    const cam = this.ctx.camera;
    const hp = getHeadingPitch(cam);
    if (Math.abs(hp.heading - this.lastHeading) > 0.2 || Number.isNaN(this.lastHeading)) {
      this.lastHeading = hp.heading;
      this.rose?.setAttribute('transform', `rotate(${(-hp.heading).toFixed(1)} 32 32)`);
      this.hdEl.textContent = `${Math.round(hp.heading) % 360}°`;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.12;
      const p = cam.position;
      const ll = worldToLonLat(p.x, p.z);
      const ground = this.ctx.heightfield ? this.ctx.heightfield.sample(p.x, p.z) : 0;
      const agl = p.y - ground;
      const ru = getLang() === 'ru';
      const lat = `${Math.abs(ll.lat).toFixed(5)}° ${ru ? 'с. ш.' : 'N'}`;
      const lon = `${Math.abs(ll.lon).toFixed(5)}° ${ru ? 'в. д.' : 'E'}`;
      this.status.innerHTML = `${lat}&nbsp; ${lon}<br><span class="nv-dim">${t('elevation')}</span> ${Math.round(ground)} ${t('m')} · `
        + `<span class="nv-dim">${t('agl')}</span> ${agl < 10 ? agl.toFixed(1) : Math.round(agl)} ${t('m')} · ${Math.round(hp.heading) % 360}° ${cardinal(hp.heading)}`;
    }
    this.locTimer -= dt;
    if (this.locTimer <= 0) {
      this.locTimer = 0.4;
      this.updateLocation();
    }
  }

  /** Street + district under the camera. */
  locationAt(x: number, z: number, agl: number): { street?: string; area?: string } {
    const out: { street?: string; area?: string } = {};
    const roads = this.ctx.get<any>('roads');
    if (!this.streets && roads?.graph?.edges) {
      try { this.streets = new StreetIndex(roads.graph.edges); } catch (e) { console.warn('[ui] street index', e); this.streets = null; }
    }
    if (this.streets && agl < 700) {
      const r = this.streets.nearest(x, z, Math.max(70, Math.min(250, agl * 0.8)));
      if (r) out.street = getLang() === 'ru' ? r.name : latinName(r.name);
    } else if (roads?.nearest && agl < 700) {
      try {
        const r = roads.nearest(x, z, Math.max(60, Math.min(250, agl * 0.8)));
        if (r?.name) out.street = getLang() === 'ru' ? r.name : latinName(r.name);
      } catch { /* ignore */ }
    }
    if (!out.street && agl < 400) {
      const s = this.gz.nearest(x, z, (it) => it.k === 'street', 90);
      if (s) out.street = this.gz.displayName(s.item);
    }
    const d = this.gz.nearest(x, z, (it) => it.k === 'district' && Math.hypot(it.x - x, it.z - z) < (it.r === 1 ? 1700 : it.r === 2 ? 1100 : 700), 1700);
    const s = this.gz.nearest(x, z, (it) => it.k === 'settlement', 2500);
    const inCity = this.inBoundary(x, z);
    if (d && inCity) out.area = this.gz.displayName(d.item);
    else if (s && !inCity) out.area = this.gz.displayName(s.item);
    else if (inCity) out.area = getLang() === 'ru' ? 'Невинномысск' : 'Nevinnomyssk';
    else out.area = getLang() === 'ru' ? 'Кочубеевский округ' : 'Kochubeevsky District';
    if (d && inCity && agl > 2500) out.area = getLang() === 'ru' ? 'Невинномысск' : 'Nevinnomyssk';
    return out;
  }

  inBoundary(x: number, z: number): boolean {
    const b = this.gz.boundary;
    if (b.length < 6) return true;
    let inside = false;
    for (let i = 0, j = b.length - 2; i < b.length; j = i, i += 2) {
      const xi = b[i], zi = b[i + 1], xj = b[j], zj = b[j + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  private updateLocation(): void {
    const p = this.ctx.camera.position;
    const agl = this.ctx.cameraAGL;
    const l = this.locationAt(p.x, p.z, agl);
    const parts: string[] = [];
    if (l.street) parts.push(`<span>${l.street}</span>`);
    if (l.area) parts.push(`<span class="${l.street ? 'nv-loc-d' : ''}">${l.area}</span>`);
    const html = parts.length ? `${ICON.pin}${parts.join('<span class="nv-loc-d">·</span>')}` : '';
    if (this.loc.innerHTML !== html) this.loc.innerHTML = html;
  }
}
