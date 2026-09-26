// Help overlay with keyboard / mouse / touch controls.
import { ICON } from './icons';
import { h } from './dom';
import { getLang, t } from './i18n';

type Row = [string, string, string]; // keys html, ru, en

const k = (...keys: string[]) => keys.map((x) => `<kbd>${x}</kbd>`).join('');
const small = (svg: string) => svg.replace('width="20" height="20"', 'width="14" height="14"');
const ic = (svg: string, txt: string) => `<span style="display:inline-flex;align-items:center;gap:5px">${small(svg)}${txt}</span>`;

export function openHelp(parent: HTMLElement, opts: { walk: boolean; drive: boolean; photo: boolean }): () => void {
  const ru = getLang() === 'ru';
  const sec = (icon: string, title: string, rows: Row[]) =>
    h('div', null, h('h4', { html: `${icon}${title}` }),
      h('dl', { html: rows.map(([keys, r, e]) => `<dt>${keys}</dt><dd>${ru ? r : e}</dd>`).join('') }));
  const fly: Row[] = [
    [k('W', 'A', 'S', 'D'), 'движение (или стрелки)', 'move (or arrow keys)'],
    [k('E') + k('Space'), 'вверх', 'up'],
    [k('Q') + k('C'), 'вниз', 'down'],
    [k('Shift'), 'быстрее ×4', 'faster ×4'],
    [k('Alt'), 'медленнее', 'slower'],
    [ic(ICON.mouse, ru ? 'перетаскивание' : 'drag'), 'осмотреться', 'look around'],
    [ic(ICON.mouse, ru ? 'колесо' : 'wheel'), 'скорость полёта', 'flight speed'],
    [ic(ICON.mouse, ru ? 'клик' : 'click'), 'что это? (здание, улица)', 'what is this? (building, street)'],
    [ic(ICON.mouse, ru ? 'двойной клик' : 'double-click'), 'подлететь к точке', 'fly to point'],
  ];
  const walk: Row[] = [
    [k('W', 'A', 'S', 'D'), 'идти', 'walk'],
    [k('Shift'), 'бег', 'run'],
    [k('Space'), 'прыжок', 'jump'],
  ];
  const drive: Row[] = [
    [k('W') + k('S'), 'газ / тормоз', 'throttle / brake'],
    [k('A') + k('D'), 'руль', 'steer'],
    [k('Space'), 'ручной тормоз', 'handbrake'],
  ];
  const app: Row[] = [
    [k('/'), 'поиск мест и улиц', 'search places & streets'],
    [k('1') + k('2') + k('3') + k('4'), 'режимы: полёт / пешком / авто / фото', 'modes: fly / walk / drive / photo'],
    [k('M'), 'большая карта', 'big map'],
    [k('T'), 'время и погода', 'time & weather'],
    [k('L'), 'подписи вкл/выкл', 'labels on/off'],
    [k('K'), 'снимок экрана', 'screenshot'],
    [k('U'), 'скрыть интерфейс', 'hide interface'],
    [k('H') + k('?'), 'эта справка', 'this help'],
    [k('Esc'), 'закрыть', 'close'],
  ];
  const touch: Row[] = [
    [ic(ICON.target, ru ? 'джойстик' : 'joystick'), 'движение', 'move'],
    [ic(ICON.hand, ru ? 'свайп' : 'swipe'), 'осмотреться', 'look around'],
    [ic(ICON.up, '') + ic(ICON.down, ''), 'вверх / вниз (полёт)', 'up / down (fly)'],
    [ic(ICON.hand, ru ? 'двойное касание' : 'double tap'), 'подлететь к точке', 'fly to point'],
  ];
  const cols = h('div', { class: 'nv-help-cols' },
    sec(ICON.fly, t('fly'), fly),
    sec(ICON.keyboard, ru ? 'Интерфейс' : 'Interface', app),
    opts.walk ? sec(ICON.walk, t('walk'), walk) : null,
    opts.drive ? sec(ICON.car, t('drive'), drive) : null,
    sec(ICON.hand, ru ? 'Сенсорный экран' : 'Touch', touch),
  );
  const close = h('button', { class: 'nv-x nv-i', title: t('close'), html: ICON.x });
  const card = h('div', { class: 'nv-help nv-glass nv-i' }, close,
    h('h2', { text: t('help') }),
    h('div', { class: 'nv-help-sub', text: ru ? 'Невинномысск целиком — рельеф, реки, 58 тысяч зданий, улицы, деревья и небо в реальном времени.' : 'All of Nevinnomyssk — terrain, rivers, 58 thousand buildings, streets, trees and a live sky.' }),
    cols,
    h('div', {
      class: 'nv-help-foot',
      html: ru
        ? 'Данные: © участники OpenStreetMap и Overture Maps (ODbL / CDLA), Copernicus DEM GLO-30 и Sentinel-2 (© ESA/Copernicus), ESA WorldCover. Высоты зданий частично оценены по модели поверхности.'
        : 'Data: © OpenStreetMap contributors & Overture Maps (ODbL / CDLA), Copernicus DEM GLO-30 and Sentinel-2 (© ESA/Copernicus), ESA WorldCover. Some building heights are estimated from the surface model.',
    }),
  );
  const bg = h('div', { class: 'nv-modal-bg nv-i' }, card);
  const done = () => { bg.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'h' || e.key === 'H' || e.key === '?') { e.stopPropagation(); e.preventDefault(); done(); } };
  close.addEventListener('click', done);
  bg.addEventListener('pointerdown', (e) => { if (e.target === bg) done(); });
  window.addEventListener('keydown', onKey, true);
  parent.append(bg);
  return done;
}
