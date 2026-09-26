// Mode switcher: Fly / Walk / Drive (controllers) and Photo (path tracer).
import type { AppContext } from '../../core/context';
import { ICON } from './icons';
import { h } from './dom';
import { t, type StrKey } from './i18n';

interface ModeDef { id: string; icon: string; label: StrKey; key: string; hint: StrKey }

const MODES: ModeDef[] = [
  { id: 'fly', icon: ICON.fly, label: 'fly', key: '1', hint: 'modeFly' },
  { id: 'walk', icon: ICON.walk, label: 'walk', key: '2', hint: 'modeWalk' },
  { id: 'drive', icon: ICON.car, label: 'drive', key: '3', hint: 'modeDrive' },
];

export class ModeBar {
  readonly el: HTMLDivElement;
  private btns = new Map<string, HTMLButtonElement>();
  private photo: HTMLButtonElement;
  private badge: HTMLSpanElement;
  private timer = 0;

  constructor(private ctx: AppContext, parent: HTMLElement, private toast: (m: string) => void, private beforeSwitch: () => void) {
    this.el = h('div', { class: 'nv-modes nv-glass nv-i' });
    for (const m of MODES) {
      const b = h('button', { class: 'nv-mode', title: `${t(m.label)} (${m.key})`, html: `${m.icon}<span>${t(m.label)}</span><kbd>${m.key}</kbd>` }) as HTMLButtonElement;
      b.addEventListener('click', () => this.setMode(m.id));
      this.btns.set(m.id, b);
      this.el.append(b);
    }
    this.badge = h('span', { class: 'nv-badge nv-hidden' });
    this.photo = h('button', { class: 'nv-mode nv-rtx', title: `${t('photo')} (4)`, html: `${ICON.sparkles}<span>${t('photo')}</span><kbd>4</kbd>` }) as HTMLButtonElement;
    this.photo.append(this.badge);
    this.photo.addEventListener('click', () => this.togglePhoto());
    this.el.append(this.photo);
    parent.append(this.el);
    this.refresh();
  }

  available(id: string): boolean {
    return this.ctx.controllers.has(id);
  }

  setMode(id: string): void {
    if (!this.available(id)) return;
    this.beforeSwitch();
    const pt = this.ctx.get<any>('pathtracer');
    if (pt?.active) { try { pt.stop(); } catch (e) { console.warn('[ui] pathtracer stop', e); } }
    const was = this.ctx.controller.name;
    if (this.ctx.setController(id) && was !== id) {
      const m = MODES.find((x) => x.id === id);
      if (m) this.toast(t(m.hint));
    }
    this.refresh();
  }

  togglePhoto(): void {
    const pt = this.ctx.get<any>('pathtracer');
    if (!pt) { this.toast(t('photoNA')); return; }
    try {
      if (pt.active) pt.stop();
      else { this.beforeSwitch(); pt.start(); this.toast(t('photoOn')); }
    } catch (e) {
      console.error('[ui] pathtracer', e);
    }
    this.refresh();
  }

  key(k: string): boolean {
    const m = MODES.find((x) => x.key === k);
    if (m) { if (this.available(m.id)) { this.setMode(m.id); return true; } return false; }
    if (k === '4') { if (this.ctx.get('pathtracer')) { this.togglePhoto(); return true; } }
    return false;
  }

  refresh(): void {
    const cur = this.ctx.controller.name;
    const pt = this.ctx.get<any>('pathtracer');
    const ptActive = !!pt?.active;
    for (const [id, b] of this.btns) {
      b.classList.toggle('nv-hidden', !this.available(id));
      b.classList.toggle('nv-on', id === cur && !ptActive);
    }
    this.photo.classList.toggle('nv-hidden', !pt);
    this.photo.classList.toggle('nv-on', ptActive);
    const visible = [...this.btns.keys()].filter((id) => this.available(id)).length + (pt ? 1 : 0);
    this.el.classList.toggle('nv-hidden', visible <= 1 && !pt);
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.3;
    const pt = this.ctx.get<any>('pathtracer');
    const active = !!pt?.active;
    if (active !== this.photo.classList.contains('nv-on')) this.refresh();
    if (active) {
      this.badge.classList.remove('nv-hidden');
      this.badge.textContent = `${Math.floor(pt.samples ?? 0)} spp`;
    } else this.badge.classList.add('nv-hidden');
  }
}
