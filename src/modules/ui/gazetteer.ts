// Places gazetteer: data model + multilingual fuzzy search.
// Data: public/data/places/places.json (pipeline/build_places.py).
import { worldToLonLat, lonLatToWorld } from '../../core/geo';
import { getLang, t } from './i18n';
import { editDistance, latinName, normalize, skeleton, swapLayout, translit } from './translit';

export interface PlaceItem {
  n: string;          // name (Russian)
  k: string;          // kind
  x: number;
  z: number;
  r: number;          // rank 1..5
  c?: string;         // category label (ru)
  a?: string;         // address / locality
  en?: string;        // English name
  h?: number;         // label height above ground
  d?: string;         // description (ru)
  de?: string;        // description (en)
  p?: number[];       // extra label points
  L?: number;         // length (streets/rivers)
  al?: string[];      // aliases
  /** runtime */
  id: number;
}

export interface PlacesData {
  version: number;
  kinds: Record<string, [string, string]>;
  boundary: number[];
  items: PlaceItem[];
}

export interface SearchHit {
  item: PlaceItem;
  score: number;
  dist: number;
}

const KIND_KW: Record<string, string> = {
  city: 'город city town',
  district: 'район микрорайон district neighbourhood neighborhood area',
  settlement: 'село посёлок поселок хутор деревня village settlement',
  landmark: 'достопримечательность landmark sight',
  church: 'храм церковь собор часовня church cathedral chapel',
  monument: 'памятник мемориал монумент monument memorial',
  park: 'парк сквер park square garden',
  water: 'река канал озеро пруд вода river canal lake pond water',
  street: 'улица ул переулок пер бульвар проезд шоссе дорога street st road avenue lane boulevard',
  station: 'вокзал станция жд железная дорога поезд платформа station railway train',
  bus_station: 'автовокзал автостанция автобус bus station coach',
  bus_stop: 'остановка автобус маршрутка bus stop',
  industry: 'завод предприятие комбинат фабрика factory plant industry works',
  power: 'электростанция гэс грэс вэс тэц подстанция power plant station energy',
  education: 'школа детсад сад колледж гимназия лицей school college kindergarten university',
  medical: 'больница поликлиника аптека клиника стоматология hospital clinic pharmacy dentist',
  culture: 'культура кино кинотеатр музей театр дк библиотека museum cinema culture library theatre',
  sport: 'спорт стадион фитнес бассейн sport stadium gym arena pool',
  mall: 'торговый центр тц рынок гипермаркет mall market shopping centre',
  shop: 'магазин продукты shop store',
  food: 'кафе ресторан бар кофе кофейня пицца еда cafe restaurant bar coffee pizza food',
  hotel: 'гостиница отель hotel',
  gov: 'администрация почта полиция мфц суд post office police government',
  fuel: 'азс заправка бензин fuel gas petrol station',
  service: 'услуги сервис service',
  allotment: 'снт дачи садовое товарищество allotment dacha',
  viewpoint: 'вид смотровая панорама viewpoint view panorama',
  nature: 'гора холм природа hill mountain nature',
  building: 'здание дом building house',
};

/** English words for the Russian category labels (for category search in English). */
const CAT_EN: Record<string, string> = {
  'Аптека': 'pharmacy chemist drugstore', 'Школа': 'school', 'Кафе': 'cafe', 'Ресторан': 'restaurant', 'Пиццерия': 'pizza pizzeria',
  'Фастфуд': 'fast food', 'Кофейня': 'coffee', 'Бар': 'bar pub', 'Больница': 'hospital', 'Клиника': 'clinic doctor',
  'Медцентр': 'clinic medical', 'Стоматология': 'dentist dental', 'АЗС': 'fuel gas petrol', 'Банк': 'bank atm', 'Гостиница': 'hotel',
  'Продукты': 'grocery food shop', 'Супермаркет': 'supermarket', 'Гипермаркет': 'hypermarket supermarket', 'Парк': 'park',
  'Стадион': 'stadium', 'Музей': 'museum', 'Кинотеатр': 'cinema movie', 'Библиотека': 'library', 'Остановка': 'bus stop',
  'Ж/д станция': 'railway station train', 'Ж/д платформа': 'railway halt train', 'Автовокзал': 'bus station', 'Автостанция': 'bus station',
  'Торговый центр': 'mall shopping centre', 'Салон связи': 'phone mobile', 'Электроника': 'electronics', 'Одежда': 'clothes clothing',
  'Обувь': 'shoes', 'Цветы': 'flowers', 'Спорт': 'sport', 'Фитнес': 'gym fitness', 'Полиция': 'police', 'Колледж': 'college',
  'Учебное заведение': 'college school', 'Детский сад': 'kindergarten', 'Река': 'river', 'Канал': 'canal', 'Озеро': 'lake',
  'Пруд': 'pond', 'Улица': 'street', 'Переулок': 'lane', 'Бульвар': 'boulevard', 'Шоссе': 'highway', 'Электростанция': 'power plant',
  'Подстанция': 'substation', 'Смотровая точка': 'viewpoint view', 'Памятник': 'monument', 'Автосервис': 'car repair garage',
  'Пункт выдачи / почта': 'post parcel', 'Дом культуры': 'culture house', 'Ледовая арена': 'ice rink', 'Пляж': 'beach',
  'Храм': 'church cathedral temple', 'Гимназия': 'school gymnasium', 'Лицей': 'school lyceum', 'Поликлиника': 'clinic polyclinic',
  'Предприятие': 'factory plant company industry', 'Учреждение': 'office institution', 'Садовое товарищество': 'allotment dacha',
  'Магазин': 'shop store', 'Энергетика': 'power energy', 'Природа': 'nature', 'Район города': 'district neighbourhood',
  'Медучреждение': 'medical clinic', 'Пожарная часть': 'fire station', 'Почта': 'post office', 'Роддом': 'maternity hospital',
  'Федеральная трасса': 'highway motorway', 'Автодорога': 'road highway', 'Проезд': 'drive passage',
};

const STOP = new Set(['г', 'город', 'невинномысск', 'nevinnomyssk', 'ул', 'улица', 'д', 'дом']);
const NUMERIC = /^\d+[а-яa-z]?$/;

function merge(a: SearchHit[], b: SearchHit[]): SearchHit[] {
  const seen = new Set(a.map((h) => h.item.id));
  // typo hits rank below any exact hit
  for (const h of b) if (!seen.has(h.item.id)) { seen.add(h.item.id); a.push({ ...h, score: h.score - 0.5 }); }
  return a;
}

interface Entry {
  name: string;          // normalized full name (+aliases joined)
  toks: string[];        // normalized name tokens (cyr / as-is)
  skel: string[];        // skeleton tokens of name tokens
  kw: string[];          // keyword tokens (kind words, address) normalized + skeleton
  cat: string[];         // category tokens (own category label ru + en)
}

export class Gazetteer {
  items: PlaceItem[] = [];
  kinds: Record<string, [string, string]> = {};
  boundary: number[] = [];
  private entries: Entry[] = [];

  load(data: PlacesData): void {
    this.kinds = data.kinds ?? {};
    this.boundary = data.boundary ?? [];
    this.items = data.items.map((it, i) => ({ ...it, id: i }));
    this.entries = this.items.map((it) => this.entryOf(it));
  }

  /** Add runtime items (e.g. from other modules). */
  add(items: Array<Omit<PlaceItem, 'id'>>): void {
    for (const it of items) {
      const item = { ...it, id: this.items.length } as PlaceItem;
      this.items.push(item);
      this.entries.push(this.entryOf(item));
    }
  }

  private entryOf(it: PlaceItem): Entry {
    const names = [it.n, ...(it.al ?? []), ...(it.en ? [it.en] : [])];
    const toks = new Set<string>();
    const skel = new Set<string>();
    for (const nm of names) {
      for (const tk of normalize(nm).split(' ')) {
        if (!tk) continue;
        toks.add(tk);
        const s = skeleton(tk);
        if (s) skel.add(s);
      }
    }
    const tokset = (src: string) => {
      const out = new Set<string>();
      for (const tk of normalize(src).split(' ')) {
        if (!tk) continue;
        out.add(tk);
        const sk = skeleton(tk);
        if (sk) out.add(sk);
      }
      return [...out];
    };
    const kw = tokset(`${KIND_KW[it.k] ?? ''} ${it.a ?? ''}`);
    const cat = it.c ? tokset(`${it.c} ${CAT_EN[it.c] ?? ''}`) : [];
    return { name: names.map(normalize).join(' | '), toks: [...toks], skel: [...skel], kw, cat };
  }

  displayName(it: PlaceItem): string {
    if (getLang() === 'en') return it.en ?? latinName(it.n);
    return it.n;
  }

  /** Secondary name (the other script) for search results. */
  altName(it: PlaceItem): string {
    return getLang() === 'en' ? it.n : '';
  }

  kindLabel(it: PlaceItem): string {
    if (getLang() === 'ru' && it.c) return it.c;
    const k = this.kinds[it.k];
    if (getLang() === 'en') return k ? k[1] : it.k;
    return k ? k[0] : it.k;
  }

  address(it: PlaceItem): string {
    if (!it.a) return '';
    return getLang() === 'en' ? translit(it.a) : it.a;
  }

  description(it: PlaceItem): string {
    return (getLang() === 'en' ? it.de ?? it.d : it.d) ?? '';
  }

  byName(name: string): PlaceItem | undefined {
    const n = normalize(name);
    let best: PlaceItem | undefined;
    for (const it of this.items) {
      if (normalize(it.n) === n || (it.en && normalize(it.en) === n) || it.al?.some((a) => normalize(a) === n)) {
        if (!best || it.r < best.r) best = it;
      }
    }
    return best ?? this.search(name, { limit: 1 })[0]?.item;
  }

  nearest(x: number, z: number, pred: (it: PlaceItem) => boolean, maxDist = Infinity): { item: PlaceItem; dist: number } | null {
    let best: PlaceItem | null = null;
    let bd = maxDist;
    for (const it of this.items) {
      if (!pred(it)) continue;
      const d = Math.hypot(it.x - x, it.z - z);
      if (d < bd) { bd = d; best = it; }
    }
    return best ? { item: best, dist: bd } : null;
  }

  /** Parse "44.63, 41.94" (lat, lon) or "41.94 44.63" (lon, lat). */
  parseCoords(q: string): PlaceItem | null {
    const m = /^\s*(-?\d{1,3}(?:[.,]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(q);
    if (!m) return null;
    let a = parseFloat(m[1].replace(',', '.')), b = parseFloat(m[2].replace(',', '.'));
    let lat = a, lon = b;
    if (a > 40 && a < 43.5 && b > 43.5 && b < 46) { lat = b; lon = a; }
    if (!(lat > 43.5 && lat < 46 && lon > 40 && lon < 43.5)) return null;
    const p = lonLatToWorld(lon, lat);
    if (Math.abs(p.x) > 10240 || Math.abs(p.z) > 10240) return null;
    return { id: -1, n: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, k: 'coords', x: Math.round(p.x), z: Math.round(p.z), r: 1, c: t('coords') };
  }

  search(query: string, opts: { x?: number; z?: number; limit?: number } = {}): SearchHit[] {
    const limit = opts.limit ?? 8;
    const coords = this.parseCoords(query);
    if (coords) return [{ item: coords, score: 100, dist: 0 }];
    // exact/prefix matching first; typo-tolerant matching only when that finds (almost) nothing,
    // so that e.g. "стадион" does not also list every "station"
    let hits = this.run(query, opts, false);
    if (hits.length < 3) hits = merge(hits, this.run(query, opts, true));
    if (hits.length === 0) {
      const swapped = swapLayout(query);
      if (swapped !== query) {
        hits = this.run(swapped, opts, false);
        if (hits.length < 3) hits = merge(hits, this.run(swapped, opts, true));
      }
    }
    hits.sort((a, b) => b.score - a.score || a.dist - b.dist);
    // collapse identical names (e.g. chain stores) to the nearest few
    const out: SearchHit[] = [];
    const seen = new Map<string, number>();
    for (const h of hits) {
      const key = h.item.n;
      const c = seen.get(key) ?? 0;
      if (c >= 2) continue;
      seen.set(key, c + 1);
      out.push(h);
      if (out.length >= limit) break;
    }
    return out;
  }

  private run(query: string, opts: { x?: number; z?: number }, fuzzy: boolean): SearchHit[] {
    const qn = normalize(query);
    if (!qn) return [];
    let qtoks = qn.split(' ').filter(Boolean);
    const significant = qtoks.filter((q) => !STOP.has(q));
    if (significant.length) qtoks = significant;
    const qskel = qtoks.map((q) => skeleton(q));
    const cx = opts.x ?? 0, cz = opts.z ?? 0;
    const out: SearchHit[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const e = this.entries[i];
      let total = 0;
      let ok = true;
      let nameHits = 0;
      for (let qi = 0; qi < qtoks.length; qi++) {
        const q = qtoks[qi], qs = qskel[qi];
        let best = 0;
        for (const tk of e.toks) {
          if (tk === q) { best = Math.max(best, 3.5); break; }
          if (tk.startsWith(q)) best = Math.max(best, 2 + q.length / tk.length);
        }
        if (best < 3 && qs) {
          for (const tk of e.skel) {
            if (tk === qs) { best = Math.max(best, 3.4); break; }
            if (tk.startsWith(qs)) best = Math.max(best, 1.9 + qs.length / tk.length);
            else if (fuzzy && qs.length >= 4 && tk[0] === qs[0]) {
              // typo tolerance: 1 edit for 4-8 chars, 2 for longer words; first letter must match
              const maxE = qs.length >= 9 ? 2 : 1;
              const d = editDistance(qs, tk.slice(0, qs.length), maxE);
              const d2 = d > 0 ? editDistance(qs, tk, maxE) : d;
              const dd = Math.min(d, d2);
              if (dd <= maxE) best = Math.max(best, 1.2 - dd * 0.2);
            }
          }
        }
        if (best === 0 && q.length >= 3 && e.name.includes(q)) best = 1;
        if (best > 0) nameHits++;
        if (best === 0) {
          // category search ("аптека", "school"): the item's own category word counts like a name hit;
          // generic kind words only when the item has no specific category
          for (const k of e.cat) {
            if (k === q || k === qs || (q.length >= 4 && k.startsWith(q))) { best = 1.1; if (q.length >= 3) nameHits++; break; }
          }
          if (best === 0) {
            for (const k of e.kw) {
              if (k === q || k === qs) {
                // a matching house number makes this an address hit ("менделеева 34")
                if (NUMERIC.test(q)) { best = 2; nameHits++; break; }
                best = 0.8;
                if (q.length >= 4 && !e.cat.length) nameHits++;
                break;
              }
              if ((q.length >= 2 && k.startsWith(q)) || (qs.length >= 3 && k.startsWith(qs))) best = Math.max(best, 0.5);
            }
          }
        }
        if (best === 0) {
          // house numbers ("менделеева 5") are optional: they only add score when the address matches
          if (NUMERIC.test(q)) continue;
          ok = false; break;
        }
        total += best;
      }
      if (!ok || nameHits === 0) continue;
      const it = this.items[i];
      const dist = Math.hypot(it.x - cx, it.z - cz);
      let score = total + (6 - it.r) * 0.25 - Math.log10(1 + dist / 1000) * 0.4;
      // stops are usually named after the street / place they serve: list the real thing first
      if (it.k === 'bus_stop') score -= 0.9;
      if (e.name.startsWith(qn)) score += 1.2;
      out.push({ item: it, score, dist });
    }
    return out;
  }

  lonLat(it: PlaceItem): { lon: number; lat: number } {
    return worldToLonLat(it.x, it.z);
  }
}
