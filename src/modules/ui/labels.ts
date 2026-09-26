// Floating place labels: DOM elements projected from world anchors every frame,
// with distance-based fade, screen-space decluttering and occlusion tests against
// the height field (and building roofs near the camera).
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import type { Gazetteer, PlaceItem } from './gazetteer';
import { kindStyle } from './icons';
import { getLang } from './i18n';
import { h } from './dom';

interface Label {
  item: PlaceItem;
  el: HTMLDivElement;
  body: HTMLDivElement;
  style: 'pin' | 'area' | 'street' | 'water';
  ax: number; ay: number; az: number;   // current anchor
  anchorKey: number;                    // index of the anchor point in use
  alpha: number;
  target: number;                       // wanted alpha from range/fade (before declutter/occlusion)
  occluded: boolean;
  occAge: number;
  w: number; hgt: number;
  sx: number; sy: number;
  onScreen: boolean;
  dist: number;
  prio: number;
  lastX: number; lastY: number; lastA: number; lastZ: number;
  seen: number;
}

const AREA_KINDS = new Set(['district', 'settlement']);
const MAX_ACTIVE = 90;

function settlementType(a?: string): string {
  if (!a) return '';
  const ru = getLang() === 'ru';
  if (a.startsWith('с.')) return ru ? 'село' : 'village';
  if (a.startsWith('пос.')) return ru ? 'посёлок' : 'settlement';
  if (a.startsWith('х.')) return ru ? 'хутор' : 'khutor';
  return '';
}

function styleOf(it: PlaceItem): Label['style'] {
  if (AREA_KINDS.has(it.k)) return 'area';
  if (it.k === 'street') return 'street';
  if (it.k === 'water' && (it.p?.length || it.L)) return 'water';
  return 'pin';
}

/** [min, max] visible distance (m) for an item. */
function rangeOf(it: PlaceItem): [number, number] {
  switch (it.k) {
    case 'district': return [350, it.r === 1 ? 12000 : it.r === 2 ? 8000 : 4000];
    case 'settlement': return [900, it.r === 1 ? 24000 : 14000];
    case 'street': return [0, it.r <= 1 ? 1100 : it.r === 2 ? 800 : it.r === 3 ? 550 : 380];
    case 'water': return [40, it.r === 1 ? 14000 : it.r === 2 ? 6000 : 2500];
    default: return [8, [0, 18000, 5500, 2000, 750, 260][it.r] ?? 300];
  }
}

export class Labels {
  enabled = true;
  streets = true;
  onClick: (it: PlaceItem) => void = () => {};
  selected: PlaceItem | null = null;
  readonly layer: HTMLDivElement;
  private active = new Map<number, Label>();
  private candTimer = 0;
  private lastCandPos = new THREE.Vector3(1e9, 0, 0);
  private v = new THREE.Vector3();
  private anchorCache = new Map<string, number>();
  private rects: number[] = [];
  private rr = 0;
  /** Screen rectangles covered by UI chrome (labels avoid them). */
  blockers: () => DOMRect[] = () => [];
  private blockRects: number[] = [];
  private blockTimer = 0;

  constructor(private ctx: AppContext, private gz: Gazetteer, parent: HTMLElement) {
    this.layer = h('div', { class: 'nv-labels' });
    parent.prepend(this.layer);
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.layer.style.display = v ? '' : 'none';
    if (!v) this.clear();
  }

  refreshText(): void {
    this.clear();
    this.lastCandPos.set(1e9, 0, 0);
  }

  clear(): void {
    for (const l of this.active.values()) l.el.remove();
    this.active.clear();
  }

  private groundY(x: number, z: number): number {
    return this.ctx.heightfield ? this.ctx.heightfield.sample(x, z) : 0;
  }

  private anchorY(it: PlaceItem, x: number, z: number, key: number): number {
    const ck = `${it.id}:${key}`;
    const c = this.anchorCache.get(ck);
    if (c !== undefined) return c;
    const g = this.groundY(x, z);
    const defH = it.k === 'street' ? 3.5 : it.k === 'water' ? 2 : AREA_KINDS.has(it.k) ? 40 : 12;
    let y = g + (it.h ?? defH);
    if (!AREA_KINDS.has(it.k) && it.k !== 'street' && it.k !== 'water') {
      const b = this.ctx.get<any>('buildings');
      const roof = b?.roofAt?.(x, z);
      if (typeof roof === 'number' && roof + 3 > y) y = roof + 3;
    }
    if (it.k === 'water') {
      const w = this.ctx.get<any>('water');
      const lv = w?.levelAt?.(x, z);
      if (typeof lv === 'number') y = lv + 2;
    }
    this.anchorCache.set(ck, y);
    return y;
  }

  private create(it: PlaceItem): Label {
    const style = styleOf(it);
    const ks = kindStyle(it.k);
    const name = this.gz.displayName(it);
    const el = h('div', { class: `nv-lbl nv-${style} nv-r${it.r}${style === 'pin' ? ' nv-pin' : ''}` });
    let body: HTMLDivElement;
    if (style === 'area') {
      const sub = it.k === 'settlement' ? settlementType(it.a) : '';
      body = h('div', { class: 'nv-lbl-b' }, name, sub ? h('small', null, sub) : null);
    } else if (style === 'street' || style === 'water') {
      body = h('div', { class: 'nv-lbl-b' }, name);
    } else {
      const dot = h('span', { class: 'nv-dot', style: `--c:${ks.color}`, html: ks.glyph });
      body = h('div', { class: 'nv-lbl-b' }, dot, name);
      el.append(h('div', { class: 'nv-lbl-stem' }));
    }
    body.title = it.n;
    body.addEventListener('click', (e) => { e.stopPropagation(); this.onClick(it); });
    body.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.append(body);
    this.layer.append(el);
    const l: Label = {
      item: it, el, body, style, ax: it.x, ay: 0, az: it.z, anchorKey: -1, alpha: 0, target: 0, occluded: false, occAge: 99,
      w: 0, hgt: 0, sx: -9999, sy: -9999, onScreen: false, dist: 0, prio: 0, lastX: NaN, lastY: NaN, lastA: -1, lastZ: -1, seen: 0,
    };
    // measure once (forces a layout for this element only)
    l.w = body.offsetWidth || name.length * 7 + 30;
    l.hgt = body.offsetHeight || 22;
    return l;
  }

  /** Candidate selection (a few times per second). */
  private selectCandidates(): void {
    const cam = this.ctx.camera.position;
    const agl = this.ctx.cameraAGL;
    const out: Array<{ it: PlaceItem; d: number; key: number; x: number; z: number; prio: number }> = [];
    for (const it of this.gz.items) {
      if (it.k === 'street' && (!this.streets || agl > 260)) continue;
      if (it.r >= 4 && agl > 500) continue;
      if (it.k === 'bus_stop' && agl > 120) continue;
      const [minD, maxD] = rangeOf(it);
      // nearest anchor point
      let bx = it.x, bz = it.z, bk = -1;
      let bd = (it.x - cam.x) ** 2 + (it.z - cam.z) ** 2;
      const p = it.p;
      if (p) {
        for (let i = 0; i < p.length; i += 2) {
          const d = (p[i] - cam.x) ** 2 + (p[i + 1] - cam.z) ** 2;
          if (d < bd) { bd = d; bx = p[i]; bz = p[i + 1]; bk = i; }
        }
      }
      const horiz = Math.sqrt(bd);
      const dy = cam.y - this.groundY(bx, bz);
      const d = Math.sqrt(bd + dy * dy);
      if (d > maxD * 1.05 || d < minD * 0.7) continue;
      if (horiz > maxD) continue;
      const prio = it.r * 1000 + (AREA_KINDS.has(it.k) ? -500 : 0) + (it.k === 'street' ? 300 : 0) + d / maxD * 900;
      out.push({ it, d, key: bk, x: bx, z: bz, prio });
    }
    out.sort((a, b) => a.prio - b.prio);
    const keep = new Set<number>();
    for (let i = 0; i < out.length && keep.size < MAX_ACTIVE; i++) {
      const c = out[i];
      keep.add(c.it.id);
      let l = this.active.get(c.it.id);
      if (!l) { l = this.create(c.it); this.active.set(c.it.id, l); }
      if (l.anchorKey !== c.key || l.ay === 0) {
        l.anchorKey = c.key;
        l.ax = c.x; l.az = c.z;
        l.ay = this.anchorY(c.it, c.x, c.z, c.key);
        l.occAge = 99;
      }
      l.prio = c.prio;
      l.seen = performance.now();
    }
    // retire labels no longer wanted once faded out
    for (const [id, l] of this.active) {
      if (!keep.has(id)) {
        l.target = 0;
        l.prio = 1e9;
        if (l.alpha < 0.02 || performance.now() - l.seen > 4000) { l.el.remove(); this.active.delete(id); }
      }
    }
  }

  private occlusionTest(l: Label): boolean {
    const ctx = this.ctx;
    const hf = ctx.heightfield;
    if (!hf) return false;
    const c = ctx.camera.position;
    const dx = l.ax - c.x, dy = l.ay - c.y, dz = l.az - c.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 20) return false;
    const n = Math.min(90, Math.max(8, Math.ceil(d / 22)));
    const tEnd = 1 - Math.min(0.5, 15 / d);
    for (let i = 1; i < n; i++) {
      const t = (i / n) * tEnd;
      const x = c.x + dx * t, y = c.y + dy * t, z = c.z + dz * t;
      if (hf.sample(x, z) > y + 0.8) return true;
    }
    // buildings between camera and label (near field, low camera only)
    const agl = ctx.cameraAGL;
    const b = ctx.get<any>('buildings');
    if (b?.roofAt && agl < 250 && l.style !== 'area') {
      const horiz = Math.hypot(dx, dz);
      const maxT = Math.min(1 - Math.min(0.6, 28 / Math.max(1, horiz)), 1100 / Math.max(1, horiz));
      const step = 7 / Math.max(1, horiz);
      for (let t = step; t < maxT; t += step) {
        const x = c.x + dx * t, y = c.y + dy * t, z = c.z + dz * t;
        const roof = b.roofAt(x, z);
        if (roof !== null && roof > y + 0.3) return true;
      }
    }
    return false;
  }

  update(dt: number): void {
    if (!this.enabled || !this.gz.items.length) return;
    const ctx = this.ctx;
    const cam = ctx.camera;
    this.candTimer -= dt;
    if (this.candTimer <= 0 || cam.position.distanceToSquared(this.lastCandPos) > 60 * 60) {
      this.candTimer = 0.25;
      this.lastCandPos.copy(cam.position);
      this.selectCandidates();
    }
    const W = ctx.width, H = ctx.height;
    cam.updateMatrixWorld();
    const view = cam.matrixWorldInverse;
    const proj = cam.projectionMatrix;
    const labels = [...this.active.values()];
    // occlusion: a few labels per frame, oldest first
    let budget = 6;
    for (let i = 0; i < labels.length && budget > 0; i++) {
      const l = labels[(this.rr + i) % labels.length];
      l.occAge += dt;
      if (l.occAge > 0.35 && l.prio < 1e9) {
        l.occluded = this.occlusionTest(l);
        l.occAge = 0;
        budget--;
      }
    }
    this.rr = (this.rr + 6) % Math.max(1, labels.length);
    for (const l of labels) {
      const v = this.v.set(l.ax, l.ay, l.az).applyMatrix4(view);
      if (v.z > -cam.near) { l.onScreen = false; continue; }
      l.dist = -v.z;
      v.applyMatrix4(proj);
      l.sx = (v.x * 0.5 + 0.5) * W;
      l.sy = (-v.y * 0.5 + 0.5) * H;
      l.onScreen = l.sx > -60 && l.sx < W + 60 && l.sy > -40 && l.sy < H + 60;
      const [minD, maxD] = rangeOf(l.item);
      const d = cam.position.distanceTo(this.v.set(l.ax, l.ay, l.az));
      l.dist = d;
      let a = 1;
      a *= 1 - THREE.MathUtils.smoothstep(d, maxD * 0.7, maxD);
      if (minD > 0) a *= THREE.MathUtils.smoothstep(d, minD * 0.7, minD * 1.2);
      l.target = l.prio >= 1e9 ? 0 : a;
    }
    // declutter: highest priority first
    labels.sort((a, b) => a.prio - b.prio);
    this.blockTimer -= dt;
    if (this.blockTimer <= 0) {
      this.blockTimer = 0.3;
      this.blockRects.length = 0;
      for (const r of this.blockers()) if (r.width > 0 && r.height > 0) this.blockRects.push(r.left - 4, r.top - 4, r.right + 4, r.bottom + 4);
    }
    const rects = this.rects;
    rects.length = 0;
    for (const v of this.blockRects) rects.push(v);
    const k = 1 - Math.exp(-dt * 9);
    for (const l of labels) {
      let want = l.onScreen && !l.occluded ? l.target : 0;
      if (this.selected && l.item.id === this.selected.id) want = Math.max(want, l.onScreen ? 1 : 0);
      if (want > 0.02) {
        let x0: number, y0: number;
        const w = l.w + 6, hh = l.hgt + 4;
        if (l.style === 'pin') { x0 = l.sx - w / 2; y0 = l.sy - 14 - hh; }
        else { x0 = l.sx - w / 2; y0 = l.sy - hh / 2; }
        let overlap = false;
        for (let i = 0; i < rects.length; i += 4) {
          if (x0 < rects[i + 2] && x0 + w > rects[i] && y0 < rects[i + 3] && y0 + hh > rects[i + 1]) { overlap = true; break; }
        }
        if (overlap && !(this.selected && l.item.id === this.selected.id)) want = 0;
        else rects.push(x0, y0, x0 + w, y0 + hh);
      }
      l.alpha += (want - l.alpha) * k;
      if (Math.abs(l.alpha - want) < 0.003) l.alpha = want;
      const a = l.alpha;
      if (a < 0.01) {
        if (l.lastA !== 0) { l.el.style.opacity = '0'; l.el.style.visibility = 'hidden'; l.lastA = 0; }
        continue;
      }
      const x = Math.round(l.sx * 2) / 2, y = Math.round(l.sy * 2) / 2;
      if (x !== l.lastX || y !== l.lastY) {
        l.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        l.lastX = x; l.lastY = y;
      }
      if (Math.abs(a - l.lastA) > 0.01) {
        if (l.lastA <= 0) l.el.style.visibility = 'visible';
        l.el.style.opacity = a.toFixed(3);
        l.el.style.pointerEvents = a > 0.5 ? '' : 'none';
        l.lastA = a;
      }
      const zi = Math.max(1, 5000 - Math.round(l.prio / 10));
      if (zi !== l.lastZ) { l.el.style.zIndex = String(zi); l.lastZ = zi; }
    }
  }

  select(it: PlaceItem | null): void {
    for (const l of this.active.values()) l.el.classList.toggle('nv-sel', !!it && l.item.id === it.id);
    this.selected = it;
    if (it && !this.active.has(it.id)) this.lastCandPos.set(1e9, 0, 0);
  }
}
