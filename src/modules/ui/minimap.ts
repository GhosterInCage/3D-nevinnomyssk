// Minimap (north-up, follows the camera, FOV cone) and the full-screen big map.
// Base image: public/data/places/map.jpg (2048², 10 m/px, pixel (0,0) = world (-10240,-10240)),
// falling back to the terrain ortho image.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { getHeadingPitch } from '../../core/controls';
import { dataUrl } from '../../core/data';
import type { CameraFlight } from './flyto';
import type { Gazetteer, PlaceItem } from './gazetteer';
import { ICON, kindStyle } from './icons';
import { h } from './dom';
import { fmtDist, getLang, t } from './i18n';

const HALF = 10240;
const IMG_PX_PER_M = 2048 / (2 * HALF);

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`image ${src}`));
    img.src = src;
  });
}

interface View { cx: number; cz: number; mpp: number } // metres per CSS pixel

function drawBase(g: CanvasRenderingContext2D, img: HTMLImageElement | null, v: View, w: number, h: number, dpr: number): void {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#1b2530';
  g.fillRect(0, 0, w, h);
  if (!img) return;
  const s = IMG_PX_PER_M * (img.naturalWidth / 2048);
  const x0 = v.cx - (w / 2) * v.mpp, z0 = v.cz - (h / 2) * v.mpp;
  // clip the source rect to the image and map to destination
  let sx = (x0 + HALF) * s, sy = (z0 + HALF) * s;
  let sw = w * v.mpp * s, sh = h * v.mpp * s;
  let dx = 0, dy = 0, dw = w, dh = h;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (sx < 0) { const f = -sx / sw; dx += f * dw; dw -= f * dw; sw += sx; sx = 0; }
  if (sy < 0) { const f = -sy / sh; dy += f * dh; dh -= f * dh; sh += sy; sy = 0; }
  if (sx + sw > iw) { const f = (sx + sw - iw) / sw; dw -= f * dw; sw = iw - sx; }
  if (sy + sh > ih) { const f = (sy + sh - ih) / sh; dh -= f * dh; sh = ih - sy; }
  if (sw > 0 && sh > 0 && dw > 0 && dh > 0) {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = v.mpp < 6 ? 'high' : 'medium';
    g.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

const ROAD_COL: Record<string, [string, number]> = {
  motorway: ['#ffc46b', 1.2], trunk: ['#ffc46b', 1.15], primary: ['#ffd98a', 1.1], secondary: ['#fff0b3', 1.05],
  tertiary: ['#ffffff', 1], residential: ['#ffffff', 0.9], unclassified: ['#ffffff', 0.9], living_street: ['#ffffff', 0.85],
  service: ['#f4f4f4', 0.7], pedestrian: ['#f1e9e1', 0.7], footway: ['#efe4d8', 0.5], path: ['#efe4d8', 0.45],
  track: ['#e2d6c2', 0.5], steps: ['#efe4d8', 0.45], cycleway: ['#d8ecff', 0.5],
};

/** Crisp vector roads + building footprints drawn over the raster when zoomed in. */
class VectorLayer {
  private roads: Array<{ x0: number; z0: number; x1: number; z1: number; col: string; w: number; major: boolean; p: Float32Array }> | null = null;
  constructor(private ctx: AppContext) {}

  private ensureRoads(): void {
    if (this.roads) return;
    const edges = this.ctx.get<any>('roads')?.graph?.edges as Array<{ cls: string; width: number; points: Float32Array; tunnel?: boolean }> | undefined;
    if (!edges) return;
    this.roads = [];
    for (const e of edges) {
      const p = e.points;
      if (!p || p.length < 4 || e.tunnel) continue;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
        if (p[i + 1] < z0) z0 = p[i + 1]; if (p[i + 1] > z1) z1 = p[i + 1];
      }
      const st = ROAD_COL[e.cls] ?? ['#ffffff', 0.8];
      this.roads.push({ x0, z0, x1, z1, col: st[0], w: Math.max(2, e.width || 6) * st[1], major: st[1] >= 1.05, p });
    }
    // draw minor first
    this.roads.sort((a, b) => a.w - b.w);
  }

  draw(g: CanvasRenderingContext2D, v: View, w: number, h: number): void {
    const a = THREE.MathUtils.clamp((7 - v.mpp) / 3.5, 0, 1);
    if (a <= 0) return;
    const hw = (w / 2) * v.mpp, hh = (h / 2) * v.mpp;
    const vx0 = v.cx - hw, vx1 = v.cx + hw, vz0 = v.cz - hh, vz1 = v.cz + hh;
    const sx = (x: number) => (x - v.cx) / v.mpp + w / 2;
    const sy = (z: number) => (z - v.cz) / v.mpp + h / 2;
    g.save();
    g.globalAlpha = a;
    // buildings
    const b = this.ctx.get<any>('buildings');
    if (b?.query && b?.footprint && v.mpp < 4) {
      const ids: number[] = b.query(v.cx, v.cz, Math.hypot(hw, hh));
      g.fillStyle = 'rgba(236, 228, 216, 0.92)';
      g.strokeStyle = 'rgba(120, 104, 88, 0.9)';
      g.lineWidth = 0.8;
      let n = 0;
      for (const i of ids) {
        if (n++ > 2500) break;
        const r: Float64Array | null = b.footprint(i);
        if (!r || r.length < 6) continue;
        g.beginPath();
        g.moveTo(sx(r[0]), sy(r[1]));
        for (let k = 2; k < r.length; k += 2) g.lineTo(sx(r[k]), sy(r[k + 1]));
        g.closePath();
        g.fill();
        g.stroke();
      }
    }
    this.ensureRoads();
    if (this.roads) {
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const pass of [0, 1]) {
        for (const r of this.roads) {
          if (r.x1 < vx0 || r.x0 > vx1 || r.z1 < vz0 || r.z0 > vz1) continue;
          const lw = Math.max(1.2, r.w / v.mpp);
          g.beginPath();
          const p = r.p;
          g.moveTo(sx(p[0]), sy(p[1]));
          for (let k = 2; k < p.length; k += 2) g.lineTo(sx(p[k]), sy(p[k + 1]));
          if (pass === 0) { g.strokeStyle = 'rgba(60,55,50,0.55)'; g.lineWidth = lw + 1.6; }
          else { g.strokeStyle = r.col; g.lineWidth = lw; }
          g.stroke();
        }
      }
    }
    g.restore();
  }
}

function drawCamera(g: CanvasRenderingContext2D, x: number, y: number, headingDeg: number, hfovDeg: number, len: number): void {
  const a = THREE.MathUtils.degToRad(headingDeg);
  const hf = THREE.MathUtils.degToRad(Math.min(hfovDeg, 150) / 2);
  // FOV cone (screen: +x east, +y south; heading 0 = up)
  const grad = g.createRadialGradient(x, y, 0, x, y, len);
  grad.addColorStop(0, 'rgba(124,196,255,0.6)');
  grad.addColorStop(0.7, 'rgba(124,196,255,0.28)');
  grad.addColorStop(1, 'rgba(124,196,255,0.08)');
  g.beginPath();
  g.moveTo(x, y);
  g.arc(x, y, len, a - hf - Math.PI / 2, a + hf - Math.PI / 2);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(190,225,255,0.55)';
  g.stroke();
  // arrow
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.beginPath();
  g.moveTo(0, -9);
  g.lineTo(6.5, 7);
  g.lineTo(0, 3.5);
  g.lineTo(-6.5, 7);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,.6)';
  g.shadowBlur = 4;
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 1.5;
  g.strokeStyle = '#2f7de1';
  g.stroke();
  g.restore();
}

function niceScale(mpp: number, maxPx: number): { m: number; px: number } {
  const target = mpp * maxPx;
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  const m = [5, 2, 1].map((k) => k * p).find((v) => v <= target) ?? p;
  return { m, px: m / mpp };
}

export class MiniMap {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private img: HTMLImageElement | null = null;
  private zoomLevel: number | null = null; // null = auto (metres per px)
  private scaleEl: HTMLDivElement;
  private timer = 0;
  private lastKey = '';
  private big: BigMap | null = null;
  private dragging = false;
  private vec: VectorLayer;

  constructor(private ctx: AppContext, private flight: CameraFlight, private gz: Gazetteer, parent: HTMLElement, onPick: (it: PlaceItem | null, x: number, z: number) => void) {
    this.canvas = h('canvas');
    this.g = this.canvas.getContext('2d')!;
    this.vec = new VectorLayer(ctx);
    this.scaleEl = h('div', { class: 'nv-mm-scale' });
    const zin = h('button', { class: 'nv-i', title: '+', html: ICON.plus, onclick: () => this.zoom(1 / 1.6) });
    const zout = h('button', { class: 'nv-i', title: '−', html: ICON.minus, onclick: () => this.zoom(1.6) });
    const exp = h('button', { class: 'nv-i', title: t('map'), html: ICON.expand, onclick: () => this.openBig() });
    this.el = h('div', { class: 'nv-mm nv-glass nv-i' }, this.canvas, h('div', { class: 'nv-mm-n', text: getLang() === 'ru' ? 'С' : 'N' }),
      h('div', { class: 'nv-mm-btns' }, zin, zout, exp), this.scaleEl);
    parent.append(this.el);
    this.onPick = onPick;
    this.bind();
    const src = dataUrl('places/map.jpg');
    loadImg(src)
      .catch(() => loadImg(dataUrl(ctx.manifest?.terrain?.ortho ?? 'terrain/ortho.jpg')))
      .then((img) => { this.img = img; this.lastKey = ''; if (this.big) this.big.img = img; })
      .catch((e) => console.warn('[ui] minimap image unavailable', e));
  }

  private onPick: (it: PlaceItem | null, x: number, z: number) => void;

  get image(): HTMLImageElement | null { return this.img; }

  private autoMpp(): number {
    const agl = Math.max(2, this.ctx.cameraAGL);
    return THREE.MathUtils.clamp(agl / 60, 1.6, 60);
  }

  private mpp(): number { return this.zoomLevel ?? this.autoMpp(); }

  zoom(f: number): void {
    this.zoomLevel = THREE.MathUtils.clamp(this.mpp() * f, 0.8, 80);
    this.lastKey = '';
  }

  private bind(): void {
    const c = this.canvas;
    let sx = 0, sy = 0, camX = 0, camZ = 0, moved = false, id = -1;
    c.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      c.setPointerCapture(id);
      sx = e.clientX; sy = e.clientY; moved = false;
      camX = this.ctx.camera.position.x; camZ = this.ctx.camera.position.z;
      this.dragging = true;
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging || e.pointerId !== id) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      const m = this.mpp();
      this.flight.teleport(THREE.MathUtils.clamp(camX - dx * m, -HALF, HALF), THREE.MathUtils.clamp(camZ - dy * m, -HALF, HALF));
    });
    const up = (e: PointerEvent) => {
      if (!this.dragging || e.pointerId !== id) return;
      this.dragging = false;
      if (!moved) {
        const r = c.getBoundingClientRect();
        const m = this.mpp();
        const x = this.ctx.camera.position.x + (e.clientX - r.left - r.width / 2) * m;
        const z = this.ctx.camera.position.z + (e.clientY - r.top - r.height / 2) * m;
        const hit = this.gz.nearest(x, z, (it) => it.r <= 3 && it.k !== 'street', 10 * m);
        this.flyToPoint(x, z);
        this.onPick(hit?.item ?? null, x, z);
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', () => { this.dragging = false; });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.25 : 0.8); }, { passive: false });
    c.addEventListener('dblclick', (e) => { e.preventDefault(); this.openBig(); });
  }

  /** Fly so the camera keeps its heading/pitch/altitude but looks at (x, z). */
  flyToPoint(x: number, z: number): void {
    const cam = this.ctx.camera;
    const hp = getHeadingPitch(cam);
    const pitch = THREE.MathUtils.clamp(hp.pitch, -75, -12);
    const agl = THREE.MathUtils.clamp(this.ctx.cameraAGL, 30, 3000);
    const dist = agl / Math.sin(THREE.MathUtils.degToRad(-pitch));
    this.flight.flyTo(x, z, { distance: dist, pitch, heading: hp.heading, height: 0 });
  }

  openBig(): void {
    if (this.big) return;
    this.big = new BigMap(this.ctx, this.flight, this.gz, this.img, this.el.parentElement!, (x, z, it) => {
      this.onPick(it, x, z);
    }, () => { this.big = null; });
  }

  toggleBig(): void {
    if (this.big) this.big.close(); else this.openBig();
  }

  get bigOpen(): boolean { return !!this.big; }

  private size = { w: 216, h: 216 };
  private mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 720px), (max-height: 520px)') : null;
  private ro: ResizeObserver | null = null;

  /** Visible without forcing a layout (CSS hides the minimap on small screens). */
  private visible(): boolean {
    return !this.el.classList.contains('nv-hidden') && !(this.mq?.matches ?? false);
  }

  update(dt: number): void {
    this.big?.update();
    if (!this.visible()) return;
    if (!this.ro && typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver((e) => {
        const r = e[0]?.contentRect;
        if (r && r.width > 0) { this.size = { w: r.width, h: r.height }; this.lastKey = ''; }
      });
      this.ro.observe(this.canvas);
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / 20;
    const cam = this.ctx.camera;
    const hp = getHeadingPitch(cam);
    const mpp = this.mpp();
    const key = `${cam.position.x.toFixed(0)},${cam.position.z.toFixed(0)},${hp.heading.toFixed(0)},${mpp.toFixed(2)},${cam.fov},${!!this.img}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.size.w, hgt = this.size.h;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hgt * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hgt * dpr);
    }
    const g = this.g;
    const view = { cx: cam.position.x, cz: cam.position.z, mpp };
    drawBase(g, this.img, view, w, hgt, dpr);
    try { this.vec.draw(g, view, w, hgt); } catch (e) { /* optional layer */ }
    const hfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.aspect));
    drawCamera(g, w / 2, hgt / 2, hp.heading, hfov, Math.min(w, hgt) * 0.42);
    // inner vignette
    const vg = g.createRadialGradient(w / 2, hgt / 2, Math.min(w, hgt) * 0.35, w / 2, hgt / 2, Math.max(w, hgt) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, hgt);
    const sc = niceScale(mpp, w * 0.32);
    this.scaleEl.innerHTML = `${fmtDist(sc.m)}<i style="width:${sc.px.toFixed(0)}px"></i>`;
  }
}

class BigMap {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private view: View;
  private dirty = true;
  private lastCam = '';

  constructor(private ctx: AppContext, private flight: CameraFlight, private gz: Gazetteer, public img: HTMLImageElement | null,
    parent: HTMLElement, private onPick: (x: number, z: number, it: PlaceItem | null) => void, private onClose: () => void) {
    this.canvas = h('canvas');
    this.g = this.canvas.getContext('2d')!;
    const close = h('button', { class: 'nv-x nv-i', title: t('close'), html: ICON.x, onclick: () => this.close() });
    const zin = h('button', { class: 'nv-i', html: ICON.plus, onclick: () => this.zoomAt(0.7) });
    const zout = h('button', { class: 'nv-i', html: ICON.minus, onclick: () => this.zoomAt(1 / 0.7) });
    this.el = h('div', { class: 'nv-bigmap nv-glass nv-i' }, this.canvas,
      h('div', { class: 'nv-bigmap-bar' },
        h('div', { class: 'nv-bigmap-title nv-glass', text: `${t('map')} · ${getLang() === 'ru' ? 'Невинномысск' : 'Nevinnomyssk'}` }),
        h('div', { class: 'nv-bigmap-hint nv-glass', text: t('mapHint') }), close),
      h('div', { class: 'nv-bigmap-zoom' }, zin, zout));
    parent.append(this.el);
    const r = this.el.getBoundingClientRect();
    const c = ctx.camera.position;
    const fit = Math.max(1, (2 * HALF) / Math.max(200, Math.min(r.width, r.height)));
    this.view = { cx: THREE.MathUtils.clamp(c.x * 0.5, -HALF, HALF), cz: THREE.MathUtils.clamp(c.z * 0.5, -HALF, HALF), mpp: fit * 0.62 };
    this.bind();
    window.addEventListener('keydown', this.onKey, true);
  }

  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } };

  close(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
    this.onClose();
  }

  private zoomAt(f: number, px?: number, py?: number): void {
    const r = this.canvas.getBoundingClientRect();
    const ox = px ?? r.width / 2, oy = py ?? r.height / 2;
    const v = this.view;
    const wx = v.cx + (ox - r.width / 2) * v.mpp, wz = v.cz + (oy - r.height / 2) * v.mpp;
    v.mpp = THREE.MathUtils.clamp(v.mpp * f, 0.8, 60);
    v.cx = wx - (ox - r.width / 2) * v.mpp;
    v.cz = wz - (oy - r.height / 2) * v.mpp;
    this.dirty = true;
  }

  private bind(): void {
    const c = this.canvas;
    const pts = new Map<number, { x: number; y: number }>();
    let moved = false, startX = 0, startY = 0, pinch0 = 0;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { moved = false; startX = e.clientX; startY = e.clientY; }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); moved = true; }
      c.classList.add('nv-drag');
    });
    c.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0 > 0 && d > 0) {
          const r = c.getBoundingClientRect();
          this.zoomAt(pinch0 / d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
          pinch0 = d;
        }
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 4) moved = true;
      if (moved) {
        this.view.cx -= dx * this.view.mpp;
        this.view.cz -= dy * this.view.mpp;
        this.dirty = true;
      }
    });
    const up = (e: PointerEvent) => {
      const had = pts.delete(e.pointerId);
      if (pts.size === 0) c.classList.remove('nv-drag');
      if (!had || moved || pts.size > 0) return;
      const r = c.getBoundingClientRect();
      const x = this.view.cx + (e.clientX - r.left - r.width / 2) * this.view.mpp;
      const z = this.view.cz + (e.clientY - r.top - r.height / 2) * this.view.mpp;
      if (Math.abs(x) > HALF || Math.abs(z) > HALF) return;
      const hit = this.gz.nearest(x, z, (it) => it.r <= 2 && it.k !== 'street', 14 * this.view.mpp);
      const tx = hit ? hit.item.x : x, tz = hit ? hit.item.z : z;
      const hp = getHeadingPitch(this.ctx.camera);
      const agl = THREE.MathUtils.clamp(this.ctx.cameraAGL, 120, 900);
      this.flight.flyTo(tx, tz, { distance: agl * 1.6, pitch: -32, heading: hp.heading, height: hit?.item.h ?? 0 });
      this.onPick(tx, tz, hit?.item ?? null);
      this.close();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomAt(e.deltaY > 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  update(): void {
    const cam = this.ctx.camera;
    const hp = getHeadingPitch(cam);
    const ck = `${cam.position.x.toFixed(0)},${cam.position.z.toFixed(0)},${hp.heading.toFixed(0)}`;
    if (!this.dirty && ck === this.lastCam) return;
    this.dirty = false;
    this.lastCam = ck;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight;
    if (!w || !hgt) return;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hgt * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hgt * dpr);
    }
    const g = this.g;
    const v = this.view;
    drawBase(g, this.img, v, w, hgt, dpr);
    const toS = (x: number, z: number) => [(x - v.cx) / v.mpp + w / 2, (z - v.cz) / v.mpp + hgt / 2];
    // city boundary
    const b = this.gz.boundary;
    if (b.length > 4) {
      g.beginPath();
      for (let i = 0; i < b.length; i += 2) {
        const [sx, sy] = toS(b[i], b[i + 1]);
        if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy);
      }
      g.closePath();
      g.setLineDash([6, 5]);
      g.lineWidth = 1.6;
      g.strokeStyle = 'rgba(255,150,110,0.85)';
      g.stroke();
      g.setLineDash([]);
    }
    // labels
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const placed: number[] = [];
    const tryPlace = (x0: number, y0: number, x1: number, y1: number) => {
      for (let i = 0; i < placed.length; i += 4) if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) return false;
      placed.push(x0, y0, x1, y1);
      return true;
    };
    const items = this.gz.items.filter((it) => {
      if (it.k === 'street') return it.r <= (v.mpp < 4 ? 3 : v.mpp < 8 ? 2 : 1) && it.r <= 3;
      if (it.k === 'district' || it.k === 'settlement') return true;
      return it.r <= (v.mpp < 3 ? 3 : v.mpp < 7 ? 2 : 1);
    }).sort((a, b) => a.r - b.r);
    for (const it of items) {
      const [sx, sy] = toS(it.x, it.z);
      if (sx < -50 || sy < -20 || sx > w + 50 || sy > hgt + 20) continue;
      const name = this.gz.displayName(it);
      if (it.k === 'district' || it.k === 'settlement') {
        g.font = `700 ${it.r === 1 ? 13 : 11}px system-ui, sans-serif`;
        const tw = g.measureText(name.toUpperCase()).width;
        if (!tryPlace(sx - tw / 2 - 4, sy - 9, sx + tw / 2 + 4, sy + 9)) continue;
        g.lineWidth = 3.5;
        g.strokeStyle = 'rgba(0,0,0,0.75)';
        g.strokeText(name.toUpperCase(), sx, sy);
        g.fillStyle = '#ffffff';
        g.fillText(name.toUpperCase(), sx, sy);
      } else if (it.k === 'street' || it.k === 'water') {
        g.font = `${it.k === 'water' ? 'italic 600' : '600'} 11px system-ui, sans-serif`;
        const tw = g.measureText(name).width;
        if (!tryPlace(sx - tw / 2 - 3, sy - 8, sx + tw / 2 + 3, sy + 8)) continue;
        g.lineWidth = 3;
        g.strokeStyle = it.k === 'water' ? 'rgba(0,25,50,0.85)' : 'rgba(255,255,255,0.85)';
        g.strokeText(name, sx, sy);
        g.fillStyle = it.k === 'water' ? '#bfe6ff' : '#1d2733';
        g.fillText(name, sx, sy);
      } else {
        g.font = '600 11.5px system-ui, sans-serif';
        const tw = g.measureText(name).width;
        if (!tryPlace(sx - 8, sy - 8, sx + 12 + tw, sy + 8)) continue;
        const ks = kindStyle(it.k);
        g.beginPath();
        g.arc(sx, sy, 5, 0, Math.PI * 2);
        g.fillStyle = ks.color;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = '#0d141c';
        g.stroke();
        g.textAlign = 'left';
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(0,0,0,0.75)';
        g.strokeText(name, sx + 9, sy);
        g.fillStyle = '#ffffff';
        g.fillText(name, sx + 9, sy);
        g.textAlign = 'center';
      }
    }
    const [cx, cy] = toS(cam.position.x, cam.position.z);
    const hfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.aspect));
    drawCamera(g, cx, cy, hp.heading, hfov, 70);
    const sc = niceScale(v.mpp, 140);
    g.fillStyle = 'rgba(10,15,22,0.7)';
    g.fillRect(12, hgt - 34, sc.px + 60, 22);
    g.fillStyle = '#fff';
    g.fillRect(20, hgt - 20, sc.px, 3);
    g.font = '11px ui-monospace, monospace';
    g.textAlign = 'left';
    g.fillText(fmtDist(sc.m), sc.px + 26, hgt - 19);
  }
}
