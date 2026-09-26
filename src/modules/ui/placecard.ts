// Place / pick info card and the 3D-view picking (click = identify, double-click = fly to).
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { getHeadingPitch } from '../../core/controls';
import { worldToLonLat } from '../../core/geo';
import type { CameraFlight } from './flyto';
import type { Gazetteer, PlaceItem } from './gazetteer';
import { ICON, kindStyle } from './icons';
import { escapeHtml, h } from './dom';
import { fmtDist, getLang, t } from './i18n';

const TYP: Record<string, [string, string]> = {
  house: ['Частный дом', 'House'], outbuilding: ['Хозпостройка', 'Outbuilding'], garages: ['Гаражи', 'Garages'],
  dacha: ['Дачный дом', 'Dacha'], khrushchevka: ['Жилой дом, 5 этажей («хрущёвка»)', 'Five-storey block (Khrushchyovka)'],
  panel9: ['Панельный многоэтажный дом', 'Panel apartment block'], tower: ['Многоэтажный дом', 'High-rise'],
  stalinka: ['«Сталинка»', 'Stalinist-era building'], lowrise_apartments: ['Малоэтажный жилой дом', 'Low-rise apartments'],
  school: ['Школа', 'School'], kindergarten: ['Детский сад', 'Kindergarten'], public: ['Общественное здание', 'Public building'],
  commercial: ['Коммерческое здание', 'Commercial building'], mall: ['Торговый центр', 'Shopping centre'],
  industrial: ['Промышленное здание', 'Industrial building'], warehouse: ['Склад', 'Warehouse'],
  agricultural: ['Сельхозпостройка', 'Farm building'], greenhouse: ['Теплица', 'Greenhouse'], religious: ['Храм', 'Religious building'],
  modern_apartments: ['Современный жилой дом', 'Modern apartments'], utility: ['Техническое здание', 'Utility building'], kiosk: ['Киоск', 'Kiosk'],
};
const GROUND: Record<string, [string, string]> = {
  grass: ['Трава', 'Grass'], crop: ['Поле', 'Field'], stubble: ['Стерня', 'Stubble'], ploughed: ['Пашня', 'Ploughed field'],
  bare: ['Грунт', 'Bare ground'], gravel: ['Гравий', 'Gravel'], forest: ['Лес', 'Forest'], urban: ['Городская застройка', 'Urban'],
  pebbles: ['Галечник', 'Pebbles'], mud: ['Ил', 'Mud'], sand: ['Песок', 'Sand'], rock: ['Скалы', 'Rock'],
};
const tr2 = (m: Record<string, [string, string]>, k: string) => (m[k] ? m[k][getLang() === 'ru' ? 0 : 1] : k);

export interface PickInfo {
  x: number; y: number; z: number;
  building?: { name?: string; levels: number; height: number; cls: string; labelled?: boolean } | null;
  place?: PlaceItem | null;
  street?: string;
  area?: string;
  ground?: string;
  water?: PlaceItem | null;
  isWater?: boolean;
}

export class PlaceCard {
  el: HTMLDivElement | null = null;
  current: PlaceItem | null = null;
  pickPoint: THREE.Vector3 | null = null;
  private marker: HTMLDivElement;
  private v = new THREE.Vector3();

  constructor(private ctx: AppContext, private gz: Gazetteer, private flight: CameraFlight, private column: HTMLElement,
    layer: HTMLElement, private actions: {
      flyToItem: (it: PlaceItem) => void;
      walkHere: (x: number, z: number) => void;
      share: () => void;
      onClose: () => void;
    }) {
    this.marker = h('div', { class: 'nv-marker nv-hidden' });
    layer.append(this.marker);
  }

  close(): void {
    this.el?.remove();
    this.el = null;
    this.current = null;
    this.pickPoint = null;
    this.marker.classList.add('nv-hidden');
    this.actions.onClose();
  }

  private frame(dotKind: string, title: string, kind: string, alt: string): { card: HTMLDivElement; body: HTMLDivElement } {
    this.el?.remove();
    const ks = kindStyle(dotKind);
    const x = h('button', { class: 'nv-x', title: t('close'), html: ICON.x, onclick: () => this.close() });
    const body = h('div');
    const card = h('div', { class: 'nv-card nv-glass nv-i' }, x,
      h('div', { class: 'nv-card-head' }, h('span', { class: 'nv-dot', style: `--c:${ks.color}`, html: ks.glyph }),
        h('div', null, h('h2', { text: title }), h('div', { class: 'nv-card-kind', text: kind }), alt ? h('div', { class: 'nv-card-alt', text: alt }) : null)),
      body);
    this.column.append(card);
    this.el = card;
    return { card, body };
  }

  private facts(rows: Array<[string, string]>): HTMLElement {
    return h('dl', { class: 'nv-card-facts', html: rows.filter((r) => r[1]).map(([a, b]) => `<dt>${escapeHtml(a)}</dt><dd>${escapeHtml(b)}</dd>`).join('') });
  }

  private coordRows(x: number, z: number): Array<[string, string]> {
    const ll = worldToLonLat(x, z);
    const g = this.ctx.heightfield ? this.ctx.heightfield.sample(x, z) : 0;
    return [
      [t('coords'), `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}`],
      [t('elevation'), `${Math.round(g)} ${t('m')}`],
    ];
  }

  private buttons(x: number, z: number, it: PlaceItem | null): HTMLElement {
    const row = h('div', { class: 'nv-card-actions' });
    const fly = h('button', { class: 'nv-btn nv-primary', html: `${ICON.fly}<span>${t('flyHere')}</span>` });
    fly.addEventListener('click', () => {
      if (it) this.actions.flyToItem(it);
      else {
        const hp = getHeadingPitch(this.ctx.camera);
        this.flight.flyTo(x, z, { distance: 220, pitch: Math.min(-18, Math.max(-50, hp.pitch)), heading: hp.heading, height: 5 });
      }
    });
    row.append(fly);
    if (this.ctx.controllers.has('walk')) {
      const w = h('button', { class: 'nv-btn', html: `${ICON.walk}<span>${t('walkHere')}</span>` });
      w.addEventListener('click', () => this.actions.walkHere(x, z));
      row.append(w);
    }
    const s = h('button', { class: 'nv-btn', title: t('share'), html: ICON.link });
    s.addEventListener('click', () => this.actions.share());
    row.append(s);
    return row;
  }

  showItem(it: PlaceItem): void {
    this.current = it;
    this.pickPoint = null;
    this.marker.classList.add('nv-hidden');
    const name = this.gz.displayName(it);
    const alt = getLang() === 'en' ? it.n : it.en ?? '';
    const { body } = this.frame(it.k, name, this.gz.kindLabel(it), alt !== name ? alt : '');
    const desc = this.gz.description(it);
    if (desc) body.append(h('p', { text: desc }));
    const rows: Array<[string, string]> = [];
    const addr = this.gz.address(it);
    if (addr) rows.push([getLang() === 'ru' ? 'Адрес' : 'Address', addr]);
    if (it.L && (it.k === 'street' || it.k === 'water')) rows.push([getLang() === 'ru' ? 'Протяжённость' : 'Length', fmtDist(it.L)]);
    const cam = this.ctx.camera.position;
    rows.push([getLang() === 'ru' ? 'Расстояние' : 'Distance', fmtDist(Math.hypot(cam.x - it.x, cam.z - it.z))]);
    rows.push(...this.coordRows(it.x, it.z));
    body.append(this.facts(rows), this.buttons(it.x, it.z, it));
  }

  showPick(p: PickInfo): void {
    this.current = p.place ?? null;
    this.pickPoint = new THREE.Vector3(p.x, p.y, p.z);
    this.marker.classList.remove('nv-hidden');
    const ru = getLang() === 'ru';
    let title = t('here');
    let kind = '';
    let dot = 'coords';
    const rows: Array<[string, string]> = [];
    if (p.building) {
      const b = p.building;
      dot = 'building';
      title = b.name ?? p.place?.n ?? tr2(TYP, b.cls);
      kind = b.name || p.place ? tr2(TYP, b.cls) : t('building');
      if (b.levels > 0) rows.push([ru ? 'Этажность' : 'Floors', `${b.levels}${b.labelled === false ? (ru ? ' (оценка)' : ' (est.)') : ''}`]);
      rows.push([ru ? 'Высота' : 'Height', `≈${Math.round(b.height)} ${t('m')}`]);
    } else if (p.place) {
      dot = p.place.k;
      title = this.gz.displayName(p.place);
      kind = this.gz.kindLabel(p.place);
    } else if (p.isWater) {
      dot = 'water';
      title = p.water ? this.gz.displayName(p.water) : t('water');
      kind = p.water ? this.gz.kindLabel(p.water) : '';
    } else if (p.street) {
      dot = 'street';
      title = p.street;
      kind = t('street');
    } else if (p.ground) {
      kind = tr2(GROUND, p.ground);
    }
    if (p.place && p.building) rows.unshift([ru ? 'Место' : 'Place', this.gz.displayName(p.place)]);
    if (p.street && title !== p.street) rows.push([t('street'), p.street]);
    if (p.area) rows.push([t('district'), p.area]);
    if (p.ground && !p.building && !p.isWater) rows.push([t('ground'), tr2(GROUND, p.ground)]);
    const cam = this.ctx.camera.position;
    rows.push([ru ? 'Расстояние' : 'Distance', fmtDist(Math.hypot(cam.x - p.x, cam.z - p.z, cam.y - p.y))]);
    rows.push(...this.coordRows(p.x, p.z));
    const { body } = this.frame(dot, title, kind, '');
    if (p.place?.d && !p.building) body.append(h('p', { text: this.gz.description(p.place) }));
    body.append(this.facts(rows), this.buttons(p.x, p.z, p.place ?? null));
  }

  update(): void {
    if (!this.pickPoint || !this.el) return;
    const cam = this.ctx.camera;
    const v = this.v.copy(this.pickPoint).applyMatrix4(cam.matrixWorldInverse);
    if (v.z > -cam.near) { this.marker.style.opacity = '0'; return; }
    v.applyMatrix4(cam.projectionMatrix);
    const x = (v.x * 0.5 + 0.5) * this.ctx.width, y = (-v.y * 0.5 + 0.5) * this.ctx.height;
    this.marker.style.opacity = '1';
    this.marker.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}

/** Cast a ray from the camera through a screen point against terrain + building roofs. */
export function pickWorld(ctx: AppContext, clientX: number, clientY: number): THREE.Vector3 | null {
  const cam = ctx.camera;
  const r = ctx.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector3(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, 0.5);
  const dir = ndc.unproject(cam).sub(cam.position).normalize();
  const o = cam.position.clone();
  const hf = ctx.heightfield;
  if (!hf) return null;
  let tHit = hf.raycast(o, dir, 40000);
  const b = ctx.get<any>('buildings');
  if (b?.roofAt) {
    const maxT = Math.min(tHit > 0 ? tHit : 4000, 4000);
    let t = 0.5;
    while (t < maxT) {
      const x = o.x + dir.x * t, y = o.y + dir.y * t, z = o.z + dir.z * t;
      const roof = b.roofAt(x, z);
      if (roof !== null && y <= roof) {
        // refine
        let lo = Math.max(0, t - Math.max(1, t * 0.004)), hi = t;
        for (let i = 0; i < 12; i++) {
          const m = (lo + hi) / 2;
          const rr = b.roofAt(o.x + dir.x * m, o.z + dir.z * m);
          if (rr !== null && o.y + dir.y * m <= rr) hi = m; else lo = m;
        }
        tHit = hi;
        break;
      }
      t += Math.max(1, t * 0.004);
    }
  }
  if (tHit < 0) return null;
  return o.addScaledVector(dir, tHit);
}
