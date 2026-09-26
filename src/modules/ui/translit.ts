// Russian <-> Latin helpers for search and English display.

const RU_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Plain transliteration (BGN/PCGN-like, no diacritics). Keeps case of the first letter. */
export function translit(s: string): string {
  let out = '';
  for (const ch of s) {
    const lo = ch.toLowerCase();
    const r = RU_LAT[lo];
    if (r === undefined) { out += ch; continue; }
    if (ch !== lo && r.length) out += r[0].toUpperCase() + r.slice(1);
    else out += r;
  }
  return out;
}

const TYPE_EN: Array<[RegExp, string, boolean]> = [
  // pattern, replacement, suffix? (true = goes after the name)
  [/^улица\s+имени\s+/i, 'St.', true],
  [/^улица\s+/i, 'St.', true],
  [/\s+улица$/i, 'St.', true],
  [/^переулок\s+/i, 'Ln.', true],
  [/\s+переулок$/i, 'Ln.', true],
  [/^бульвар\s+/i, 'Blvd.', true],
  [/\s+бульвар$/i, 'Blvd.', true],
  [/^проспект\s+/i, 'Ave.', true],
  [/\s+проезд$/i, 'Dr.', true],
  [/^проезд\s+/i, 'Dr.', true],
  [/\s+шоссе$/i, 'Hwy', true],
  [/^площадь\s+/i, 'Sq.', true],
  [/^микрорайон\s+/i, 'Microdistrict', false],
];

/** English-friendly display name: street type words translated, rest transliterated. */
export function latinName(name: string): string {
  for (const [re, rep, suffix] of TYPE_EN) {
    if (re.test(name)) {
      const core = translit(name.replace(re, '').trim());
      return suffix ? `${core} ${rep}` : `${rep} ${core}`;
    }
  }
  let s = translit(name);
  s = s.replace(/«|»/g, '"');
  return s;
}

/** Lower-case, ё→е, punctuation to spaces. */
const LAT_ACC: Record<string, string> = { é: 'e', è: 'e', ê: 'e', ë: 'e', á: 'a', à: 'a', â: 'a', ä: 'a', ó: 'o', ò: 'o', ô: 'o', ö: 'o', ú: 'u', ù: 'u', û: 'u', ü: 'u', í: 'i', ì: 'i', î: 'i', ï: 'i', ç: 'c', ñ: 'n', š: 's', ž: 'z', č: 'c' };

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[éèêëáàâäóòôöúùûüíìîïçñšžč]/g, (c) => LAT_ACC[c] ?? c)
    .replace(/[«»"'“”„()№#.,:;!?/\\\-–—_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phonetic-ish Latin skeleton used for fuzzy matching of both Cyrillic and Latin
 * input ("Gagarina", "gagarin", "гагарина" → "gagarina"). Applied to both sides.
 */
export function skeleton(s: string): string {
  let x = translit(normalize(s)).toLowerCase();
  x = x
    .replace(/shch|sch/g, 'sh')
    .replace(/kh/g, 'h')
    .replace(/ts|tz/g, 'c')
    .replace(/zh/g, 'j')
    .replace(/ck/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/[yj]/g, 'i')
    .replace(/w/g, 'v')
    .replace(/x/g, 'ks')
    .replace(/q/g, 'k')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/(.)\1+/g, '$1');
  return x.trim();
}

const EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU_KEYS = 'йцукенгшщзхъфывапролджэячсмитьбюё';

/** Re-type a string typed with the wrong keyboard layout (ghbdtn -> привет). */
export function swapLayout(s: string): string {
  let out = '';
  let changed = false;
  for (const ch of s.toLowerCase()) {
    const i = EN_KEYS.indexOf(ch);
    if (i >= 0) { out += RU_KEYS[i]; changed = true; continue; }
    const j = RU_KEYS.indexOf(ch);
    if (j >= 0) { out += EN_KEYS[j]; changed = true; continue; }
    out += ch;
  }
  return changed ? out : s;
}

/** Levenshtein distance with early exit when it exceeds `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[lb];
}
