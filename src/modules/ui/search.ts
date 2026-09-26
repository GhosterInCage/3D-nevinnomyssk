// Search box with autocomplete (keyboard navigable) + highlights when empty.
import type { AppContext } from '../../core/context';
import type { Gazetteer, PlaceItem, SearchHit } from './gazetteer';
import { ICON, kindStyle } from './icons';
import { escapeHtml, h } from './dom';
import { fmtDist, getLang, t } from './i18n';
import { normalize } from './translit';

export class SearchBox {
  readonly el: HTMLDivElement;
  readonly input: HTMLInputElement;
  private results: HTMLDivElement;
  private clearBtn: HTMLButtonElement;
  private hits: PlaceItem[] = [];
  private sel = -1;
  private open = false;

  constructor(private ctx: AppContext, private gz: Gazetteer, parent: HTMLElement, private onChoose: (it: PlaceItem) => void) {
    this.input = h('input', { type: 'search', placeholder: t('searchPh'), 'aria-label': t('searchPh'), autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' }) as HTMLInputElement;
    this.clearBtn = h('button', { class: 'nv-search-clear nv-hidden', title: t('close'), html: ICON.x }) as HTMLButtonElement;
    const box = h('div', { class: 'nv-search-box nv-glass' }, h('span', { style: 'display:contents', html: ICON.search }), this.input, this.clearBtn, h('span', { class: 'nv-kbd', text: '/' }));
    this.results = h('div', { class: 'nv-results nv-glass', role: 'listbox' });
    this.el = h('div', { class: 'nv-search nv-i' }, box, this.results);
    parent.append(this.el);

    this.input.addEventListener('input', () => { this.sel = -1; this.render(); });
    this.input.addEventListener('focus', () => { this.open = true; this.render(); });
    this.input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== this.input) this.hide(); }, 180));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.clearBtn.addEventListener('click', () => { this.input.value = ''; this.render(); this.input.focus(); });
    this.results.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  hide(): void {
    this.open = false;
    this.results.innerHTML = '';
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.hits.length) return;
      this.sel = (this.sel + (e.key === 'ArrowDown' ? 1 : -1) + this.hits.length) % this.hits.length;
      this.highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = this.hits[this.sel >= 0 ? this.sel : 0];
      if (it) this.choose(it);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (this.input.value) { this.input.value = ''; this.render(); } else { this.input.blur(); this.hide(); }
    }
  }

  private choose(it: PlaceItem): void {
    this.input.value = this.gz.displayName(it);
    this.input.blur();
    this.hide();
    this.onChoose(it);
  }

  private highlight(): void {
    const rows = this.results.querySelectorAll('.nv-res');
    rows.forEach((r, i) => r.classList.toggle('nv-sel', i === this.sel));
    rows[this.sel]?.scrollIntoView({ block: 'nearest' });
  }

  private row(it: PlaceItem, q: string, dist: number | null): HTMLElement {
    const ks = kindStyle(it.k);
    const name = this.gz.displayName(it);
    let nameHtml = escapeHtml(name);
    const qn = q.trim();
    if (qn.length >= 1) {
      const idx = normalize(name).indexOf(normalize(qn).split(' ')[0] ?? '');
      // map normalized index back approximately (same length for most names)
      const token = normalize(qn).split(' ')[0];
      if (idx >= 0 && token && normalize(name.slice(idx, idx + token.length)) === token) {
        nameHtml = `${escapeHtml(name.slice(0, idx))}<b>${escapeHtml(name.slice(idx, idx + token.length))}</b>${escapeHtml(name.slice(idx + token.length))}`;
      }
    }
    const sub = [this.gz.kindLabel(it), this.gz.address(it), getLang() === 'en' && it.n !== name ? it.n : ''].filter(Boolean).join(' · ');
    const b = h('button', { class: 'nv-res', role: 'option' },
      h('span', { class: 'nv-dot', style: `--c:${ks.color}`, html: ks.glyph }),
      h('div', { class: 'nv-res-main' }, h('div', { class: 'nv-res-name', html: nameHtml }), h('div', { class: 'nv-res-sub', text: sub })),
      dist !== null ? h('span', { class: 'nv-res-dist', text: fmtDist(dist) }) : null);
    b.addEventListener('click', () => this.choose(it));
    return b;
  }

  render(): void {
    const q = this.input.value;
    this.clearBtn.classList.toggle('nv-hidden', !q);
    this.results.innerHTML = '';
    this.hits = [];
    if (!this.open) return;
    const cam = this.ctx.camera.position;
    if (!q.trim()) {
      if (!this.gz.items.length) return;
      const top = this.gz.items.filter((it) => it.r === 1 && it.k !== 'street' && it.k !== 'district' && it.k !== 'settlement').slice(0, 9);
      this.results.append(h('div', { class: 'nv-sec', text: t('popular') }));
      for (const it of top) { this.hits.push(it); this.results.append(this.row(it, '', Math.hypot(it.x - cam.x, it.z - cam.z))); }
      const chips = h('div', { class: 'nv-chips' });
      for (const d of this.gz.items.filter((it) => it.k === 'district' || (it.k === 'settlement' && it.r === 1))) {
        const c = h('button', { class: 'nv-chip', text: this.gz.displayName(d) });
        c.addEventListener('click', () => this.choose(d));
        chips.append(c);
      }
      this.results.append(h('div', { class: 'nv-sec', text: t('districts') }), chips);
      return;
    }
    const res: SearchHit[] = this.gz.search(q, { x: cam.x, z: cam.z, limit: 8 });
    if (!res.length) {
      this.results.append(h('div', { class: 'nv-empty', text: t('noResults') }));
      return;
    }
    for (const r of res) {
      this.hits.push(r.item);
      this.results.append(this.row(r.item, q, r.item.k === 'coords' ? null : r.dist));
    }
    if (this.sel < 0) this.sel = 0;
    this.highlight();
  }
}
