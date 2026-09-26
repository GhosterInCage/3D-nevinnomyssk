// Loading screen polish: map backdrop with slow Ken Burns zoom, per-module status
// chips (read-only view of window.__city.states), rotating tips. index.html owns
// #loading; this only adds classes/children and never touches the progress logic.
import { dataUrl } from '../../core/data';
import { h } from './dom';
import { MODULE_NAMES, TIPS, getLang, t } from './i18n';

export function enhanceLoading(): void {
  const el = document.getElementById('loading');
  if (!el || el.classList.contains('done') || el.classList.contains('nv-load')) return;
  const ru = getLang() === 'ru';
  el.classList.add('nv-load');
  const bg = h('div', { class: 'nv-load-bg' });
  el.prepend(bg);
  const img = new Image();
  img.onload = () => { bg.style.backgroundImage = `url("${img.src}")`; requestAnimationFrame(() => bg.classList.add('nv-in')); };
  img.src = dataUrl('places/map.jpg');
  const box = el.querySelector('.box');
  const sub = box?.querySelector('p');
  if (sub) sub.textContent = ru ? 'Ставропольский край · 3D' : 'Stavropol Krai · 3D';
  const mods = h('div', { class: 'nv-load-mods' });
  const tip = h('div', { class: 'nv-load-tip' });
  const status = h('div', { class: 'nv-load-status' });
  box?.querySelector('#loading-status')?.after(status);
  box?.append(mods, tip);
  el.append(h('div', {
    class: 'nv-load-foot',
    text: ru ? 'Copernicus DEM · Sentinel-2 · Overture Maps / OpenStreetMap · ESA WorldCover' : 'Copernicus DEM · Sentinel-2 · Overture Maps / OpenStreetMap · ESA WorldCover',
  }));
  const chips = new Map<string, HTMLElement>();
  let tipIdx = Math.floor(Math.random() * TIPS.length);
  const setTip = () => {
    tip.innerHTML = `<b>${t('loadingTip')}:</b>${TIPS[tipIdx % TIPS.length][ru ? 0 : 1]}`;
    tip.style.opacity = '1';
    tipIdx++;
  };
  const showTip = () => {
    tip.style.opacity = '0';
    setTimeout(setTip, 450);
  };
  setTip();
  const tipTimer = setInterval(showTip, 6000);
  const poll = setInterval(() => {
    if (!document.body.contains(el) || el.classList.contains('done')) {
      clearInterval(poll);
      clearInterval(tipTimer);
      return;
    }
    const states: Array<{ id: string; status: string }> = (window as any).__city?.states ?? [];
    const busy = states.filter((s) => s.status === 'loading' || s.status === 'init').map((s) => MODULE_NAMES[s.id]?.[ru ? 0 : 1] ?? s.id);
    const txt = !states.length ? (ru ? 'Загрузка рельефа…' : 'Loading terrain…')
      : busy.length ? `${ru ? 'Строим город' : 'Building the city'}: ${busy.join(', ').toLowerCase()}…` : (ru ? 'Последние штрихи…' : 'Finishing…');
    if (status.textContent !== txt) status.textContent = txt;
    for (const s of states) {
      let c = chips.get(s.id);
      if (!c) {
        const nm = MODULE_NAMES[s.id]?.[ru ? 0 : 1] ?? s.id;
        c = h('span', { class: 'nv-load-mod' }, h('i'), nm);
        chips.set(s.id, c);
        mods.append(c);
      }
      const cls = `nv-load-mod nv-${s.status}`;
      if (c.className !== cls) c.className = cls;
    }
  }, 200);
}
