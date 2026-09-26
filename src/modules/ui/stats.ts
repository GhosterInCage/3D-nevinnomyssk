// Lightweight performance overlay: FPS, frame-time graph, renderer counters.
import type { AppContext } from '../../core/context';
import { h } from './dom';
import { t } from './i18n';

export class Stats {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private fpsEl: HTMLSpanElement;
  private grid: HTMLDivElement;
  private hist = new Float32Array(90);
  private hi = 0;
  private acc = 0;
  private frames = 0;
  private timer = 0;
  private last = performance.now();
  visible = false;

  constructor(private ctx: AppContext, parent: HTMLElement) {
    this.canvas = h('canvas', { width: 176 * 2, height: 38 * 2 });
    this.g = this.canvas.getContext('2d')!;
    this.fpsEl = h('span', { class: 'nv-fps' });
    this.grid = h('div', { class: 'nv-stats-grid' });
    this.el = h('div', { class: 'nv-stats nv-glass nv-i nv-hidden' }, this.canvas, h('div', null, this.fpsEl, ` ${t('fps')}`), this.grid);
    parent.append(this.el);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.classList.toggle('nv-hidden', !v);
  }

  update(): void {
    const now = performance.now();
    const ms = now - this.last;
    this.last = now;
    if (!this.visible) return;
    this.hist[this.hi] = ms;
    this.hi = (this.hi + 1) % this.hist.length;
    this.acc += ms;
    this.frames++;
    if (now - this.timer < 400) return;
    this.timer = now;
    const avg = this.acc / Math.max(1, this.frames);
    this.acc = 0; this.frames = 0;
    this.fpsEl.textContent = (1000 / avg).toFixed(avg > 100 ? 1 : 0);
    const r = this.ctx.renderer.info;
    const heap = (performance as any).memory ? Math.round((performance as any).memory.usedJSHeapSize / 1048576) : null;
    const f = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n));
    const rows: Array<[string, string]> = [
      ['ms', avg.toFixed(1)],
      [t('calls'), f(r.render.calls)],
      [t('tris'), f(r.render.triangles)],
      [t('geoms'), String(r.memory.geometries)],
      [t('textures'), String(r.memory.textures)],
      ['quality', this.ctx.settings.quality],
    ];
    if (heap !== null) rows.push([t('heap'), `${heap} MB`]);
    this.grid.innerHTML = rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('');
    // graph
    const g = this.g, W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,.12)';
    g.lineWidth = 1;
    for (const target of [16.7, 33.3]) {
      const y = H - (target / 50) * H;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    const n = this.hist.length;
    const bw = W / n;
    for (let i = 0; i < n; i++) {
      const v = this.hist[(this.hi + i) % n];
      const hh = Math.min(H, (v / 50) * H);
      g.fillStyle = v < 18 ? '#57d68d' : v < 34 ? '#ffd166' : '#ff6b7a';
      g.fillRect(i * bw, H - hh, Math.max(1, bw - 1), hh);
    }
  }
}
