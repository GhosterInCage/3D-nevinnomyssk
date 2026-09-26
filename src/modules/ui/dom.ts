// Minimal DOM helpers.
type Attrs = Record<string, string | number | boolean | undefined | null | ((e: any) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs | null = null, ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function iconEl(svg: string, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.style.display = 'contents';
  s.innerHTML = svg;
  return s;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** True while the user types in an input/textarea. */
export function isTyping(e: KeyboardEvent | null = null): boolean {
  const t = (e?.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
