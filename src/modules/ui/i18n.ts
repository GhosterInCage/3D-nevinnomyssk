// Tiny i18n: Russian (default for ru browsers) and English UI strings.
export type Lang = 'ru' | 'en';

const STR = {
  title: ['Невинномысск 3D', 'Nevinnomyssk 3D'],
  subtitle: ['Ставропольский край · город в реальном 3D', 'Stavropol Krai · the city in real-time 3D'],
  searchPh: ['Поиск: улица, место, район…', 'Search streets, places, districts…'],
  noResults: ['Ничего не найдено', 'Nothing found'],
  popular: ['Главные места', 'Highlights'],
  districts: ['Районы', 'Districts'],
  fly: ['Полёт', 'Fly'],
  walk: ['Пешком', 'Walk'],
  drive: ['Авто', 'Drive'],
  photo: ['Фото RTX', 'Photo RTX'],
  photoStop: ['Стоп', 'Stop'],
  modeFly: ['Свободный полёт: WASD — движение, мышь — обзор, колесо — скорость', 'Free flight: WASD to move, drag to look, wheel = speed'],
  modeWalk: ['Пешеход: WASD, Shift — бег, Space — прыжок', 'Walking: WASD, Shift to run, Space to jump'],
  modeDrive: ['Автомобиль: W/S — газ/тормоз, A/D — руль, Space — ручник', 'Driving: W/S throttle/brake, A/D steer, Space handbrake'],
  photoOn: ['Трассировка путей: не двигайте камеру, изображение уточняется', 'Path tracing: keep the camera still while the image refines'],
  photoNA: ['Трассировщик ещё загружается', 'Path tracer is still loading'],
  time: ['Время и погода', 'Time & weather'],
  timeOfDay: ['Время суток', 'Time of day'],
  date: ['Дата', 'Date'],
  play: ['Пуск', 'Play'],
  pause: ['Пауза', 'Pause'],
  speed: ['Скорость', 'Speed'],
  sunrise: ['Восход', 'Sunrise'],
  sunset: ['Закат', 'Sunset'],
  sunElev: ['Солнце', 'Sun'],
  weather: ['Погода', 'Weather'],
  clear: ['Ясно', 'Clear'],
  fair: ['Малооблачно', 'Fair'],
  cloudy: ['Облачно', 'Cloudy'],
  overcast: ['Пасмурно', 'Overcast'],
  rain: ['Дождь', 'Rain'],
  storm: ['Гроза', 'Storm'],
  fog: ['Туман', 'Fog'],
  clouds: ['Облака', 'Clouds'],
  rainAmt: ['Осадки', 'Rain'],
  fogAmt: ['Туман', 'Fog'],
  noSky: ['Модуль неба не загружен', 'Sky module not loaded'],
  settings: ['Настройки', 'Settings'],
  quality: ['Качество графики', 'Graphics quality'],
  qlow: ['Низкое', 'Low'],
  qmedium: ['Среднее', 'Medium'],
  qhigh: ['Высокое', 'High'],
  qultra: ['Ультра', 'Ultra'],
  qualityChanged: ['Качество изменено. Часть настроек применится после перезагрузки.', 'Quality changed. Some settings apply after a reload.'],
  reload: ['Перезагрузить', 'Reload'],
  labels: ['Подписи на карте', 'Map labels'],
  streetLabels: ['Названия улиц', 'Street names'],
  minimap: ['Мини-карта', 'Minimap'],
  stats: ['Статистика (FPS)', 'Stats (FPS)'],
  fov: ['Угол обзора', 'Field of view'],
  language: ['Язык', 'Language'],
  screenshot: ['Снимок экрана', 'Screenshot'],
  screenshotSaved: ['Снимок сохранён', 'Screenshot saved'],
  share: ['Поделиться видом', 'Share this view'],
  linkCopied: ['Ссылка на этот вид скопирована', 'Link to this view copied'],
  copyLink: ['Скопируйте ссылку', 'Copy the link'],
  help: ['Управление', 'Controls'],
  fullscreen: ['Полный экран', 'Fullscreen'],
  map: ['Карта', 'Map'],
  mapHint: ['Клик — перелёт, перетаскивание — перемещение, колесо — масштаб', 'Click to fly, drag to pan, wheel to zoom'],
  close: ['Закрыть', 'Close'],
  flyHere: ['Перелететь', 'Fly here'],
  walkHere: ['Прогуляться здесь', 'Walk here'],
  coords: ['Координаты', 'Coordinates'],
  elevation: ['Высота н.у.м.', 'Elevation'],
  asl: ['н.у.м.', 'ASL'],
  agl: ['над землёй', 'AGL'],
  m: ['м', 'm'],
  km: ['км', 'km'],
  building: ['Здание', 'Building'],
  floors: ['этажей', 'floors'],
  height: ['высота', 'height'],
  street: ['Улица', 'Street'],
  district: ['Район', 'District'],
  here: ['Это место', 'This place'],
  ground: ['Поверхность', 'Ground'],
  water: ['Вода', 'Water'],
  nearby: ['Рядом', 'Nearby'],
  loadingTip: ['Подсказка', 'Tip'],
  welcome: ['Мышь — обзор · WASD — полёт · / — поиск · H — справка', 'Drag to look · WASD to fly · / to search · H for help'],
  touchWelcome: ['Джойстик — движение · проведите по экрану — обзор', 'Joystick to move · swipe to look around'],
  up: ['Вверх', 'Up'],
  down: ['Вниз', 'Down'],
  north: ['На север', 'Face north'],
  fps: ['кадр/с', 'fps'],
  calls: ['вызовы', 'draw calls'],
  tris: ['треугольники', 'triangles'],
  geoms: ['геометрии', 'geometries'],
  textures: ['текстуры', 'textures'],
  heap: ['память JS', 'JS heap'],
  cursorInfo: ['Кликните по городу, чтобы узнать, что это', 'Click the city to identify what you see'],
} as const;

export type StrKey = keyof typeof STR;

let lang: Lang = detect();

function detect(): Lang {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'ru' || q === 'en') return q;
    const s = localStorage.getItem('nev3d.lang');
    if (s === 'ru' || s === 'en') return s;
  } catch { /* ignore */ }
  return /^(ru|uk|be|kk)/i.test(navigator.language || '') ? 'ru' : 'en';
}

export function getLang(): Lang { return lang; }

export function setLang(l: Lang): void {
  lang = l;
  try { localStorage.setItem('nev3d.lang', l); } catch { /* ignore */ }
}

export function t(k: StrKey): string {
  return STR[k][lang === 'ru' ? 0 : 1];
}

/** Metres -> "850 м" / "2,4 км" */
export function fmtDist(m: number): string {
  if (m < 950) return `${Math.round(m / 10) * 10} ${t('m')}`;
  const km = m / 1000;
  const s = km < 10 ? km.toFixed(1) : Math.round(km).toString();
  return `${lang === 'ru' ? s.replace('.', ',') : s} ${t('km')}`;
}

const CARD_RU = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
const CARD_EN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function cardinal(h: number): string {
  const i = Math.round((((h % 360) + 360) % 360) / 45) % 8;
  return (lang === 'ru' ? CARD_RU : CARD_EN)[i];
}

export function fmtTime(hours: number): string {
  const h = ((hours % 24) + 24) % 24;
  let hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  if (mm === 60) { mm = 0; hh = (hh + 1) % 24; }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Module id -> human name for the loading screen. */
export const MODULE_NAMES: Record<string, [string, string]> = {
  sky: ['Небо и свет', 'Sky & light'],
  terrain: ['Рельеф', 'Terrain'],
  water: ['Вода', 'Water'],
  roads: ['Дороги', 'Roads'],
  buildings: ['Здания', 'Buildings'],
  vegetation: ['Деревья', 'Trees'],
  landmarks: ['Достопримечательности', 'Landmarks'],
  traffic: ['Транспорт', 'Traffic'],
  physics: ['Физика', 'Physics'],
  pathtracer: ['Трассировка лучей', 'Path tracer'],
  ui: ['Интерфейс', 'Interface'],
};

export const TIPS: Array<[string, string]> = [
  ['Невинномысск основан в 1825 году как станица, статус города — с 1939 года.', 'Nevinnomyssk was founded in 1825 as a Cossack stanitsa and became a town in 1939.'],
  ['Дымовая труба Невинномысской ГРЭС высотой около 250 м — самое высокое сооружение города.', 'The ≈250 m chimney of the Nevinnomysskaya power station is the tallest structure in the city.'],
  ['Через город течёт Кубань — главная река Северного Кавказа; здесь в неё впадает Большой Зеленчук.', 'The Kuban, the main river of the North Caucasus, flows through the city; the Bolshoy Zelenchuk joins it here.'],
  ['Рельеф — Copernicus DEM, снимки — Sentinel-2, здания и улицы — Overture Maps / OpenStreetMap.', 'Terrain from Copernicus DEM, imagery from Sentinel-2, buildings and streets from Overture Maps / OpenStreetMap.'],
  ['Положение солнца рассчитывается астрономически для любой даты и времени.', 'The sun position is computed astronomically for any date and time.'],
  ['Нажмите «/» для поиска улиц и мест, «M» — большая карта, «H» — справка.', 'Press “/” to search, “M” for the big map, “H” for help.'],
  ['В ясную погоду с высоты на юге виден Кавказский хребет.', 'On a clear day the Caucasus range is visible to the south from altitude.'],
];
