// Right-hand toolbar with pop-over panels (registerPanel API) and toasts.
import { h } from './dom';

export interface PanelOptions {
  id: string;
  title: string;
  /** SVG markup or short text for the toolbar button. */
  icon: string;
  /** Panel body; a function is called lazily on first open. */
  content?: HTMLElement | ((body: HTMLElement) => void);
  /** Lower = higher in the toolbar (default 100). */
  order?: number;
  /** Keyboard shortcut (KeyboardEvent.code), e.g. 'KeyT'. */
  key?: string;
  /** Called when the button is pressed instead of opening a panel. */
  onClick?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** Visual separator before this button. */
  separator?: boolean;
}

export interface PanelHandle {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  open(): void;
  close(): void;
  toggle(): void;
  remove(): void;
  setActive(v: boolean): void;
  setTitle(title: string): void;
  readonly isOpen: boolean;
}

interface Entry { opts: PanelOptions; handle: PanelHandle; built: boolean; body: HTMLElement; panel: HTMLElement; sep: HTMLElement | null }

export class Toolbar {
  readonly el: HTMLDivElement;
  private entries: Entry[] = [];
  private openEntry: Entry | null = null;

  constructor(parentTR: HTMLElement, private panelParent: HTMLElement) {
    this.el = h('div', { class: 'nv-tools nv-glass nv-i' });
    parentTR.append(this.el);
    const onKey = (e: KeyboardEvent) => {
      if (!this.el.isConnected) { window.removeEventListener('keydown', onKey); return; }
      if (e.key === 'Escape' && this.openEntry) this.openEntry.handle.close();
    };
    window.addEventListener('keydown', onKey);
    const onDown = (e: PointerEvent) => {
      if (!this.el.isConnected) { document.removeEventListener('pointerdown', onDown, true); return; }
      const oe = this.openEntry;
      if (!oe) return;
      const tgt = e.target as Node;
      if (oe.panel.contains(tgt) || oe.handle.button.contains(tgt)) return;
      // clicks on the 3D view close panels; clicks on other UI keep them
      if ((tgt as HTMLElement).id === 'scene') oe.handle.close();
    };
    document.addEventListener('pointerdown', onDown, true);
  }

  register(opts: PanelOptions): PanelHandle {
    const button = h('button', { class: 'nv-tool', 'data-tip': opts.title, 'aria-label': opts.title, html: opts.icon }) as HTMLButtonElement;
    const body = h('div', { class: 'nv-panel-body' });
    const panel = h('div', { class: 'nv-panel nv-glass nv-i nv-hidden' }, h('h3', { html: `${opts.icon}<span>${opts.title}</span>` }), body);
    this.panelParent.append(panel);
    const sep = opts.separator ? h('div', { class: 'nv-sep' }) : null;
    const entry = {} as Entry;
    const self = this;
    const handle: PanelHandle = {
      el: body,
      button,
      get isOpen() { return self.openEntry === entry; },
      open() {
        if (opts.onClick) { opts.onClick(); return; }
        if (self.openEntry && self.openEntry !== entry) self.openEntry.handle.close();
        if (!entry.built) {
          entry.built = true;
          if (typeof opts.content === 'function') opts.content(body);
          else if (opts.content) body.append(opts.content);
        }
        panel.classList.remove('nv-hidden');
        button.classList.add('nv-on');
        self.openEntry = entry;
        opts.onOpen?.();
      },
      close() {
        if (self.openEntry !== entry) return;
        panel.classList.add('nv-hidden');
        button.classList.remove('nv-on');
        self.openEntry = null;
        opts.onClose?.();
      },
      toggle() { if (self.openEntry === entry) handle.close(); else handle.open(); },
      remove() {
        handle.close();
        button.remove(); panel.remove(); sep?.remove();
        self.entries = self.entries.filter((e) => e !== entry);
      },
      setActive(v: boolean) { button.classList.toggle('nv-on', v); },
      setTitle(title: string) {
        button.setAttribute('data-tip', title);
        button.setAttribute('aria-label', title);
        const s = panel.querySelector('h3 span');
        if (s) s.textContent = title;
      },
    };
    Object.assign(entry, { opts, handle, built: false, body, panel, sep });
    button.addEventListener('click', () => handle.toggle());
    this.entries.push(entry);
    this.entries.sort((a, b) => (a.opts.order ?? 100) - (b.opts.order ?? 100));
    for (const e of this.entries) {
      if (e.sep) this.el.append(e.sep);
      this.el.append(e.handle.button);
    }
    return handle;
  }

  /** Handle a keyboard shortcut; returns true if consumed. */
  key(code: string): boolean {
    for (const e of this.entries) {
      if (e.opts.key === code) { e.handle.toggle(); return true; }
    }
    return false;
  }

  closeAll(): void { this.openEntry?.handle.close(); }
}

export interface ToastOptions {
  duration?: number;
  action?: { label: string; fn: () => void };
  /** Replace any toast with the same key. */
  key?: string;
}

export class Toasts {
  readonly el: HTMLDivElement;
  private byKey = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement) {
    this.el = h('div', { class: 'nv-toasts' });
    parent.append(this.el);
  }

  show(msg: string, o: ToastOptions = {}): () => void {
    if (o.key) this.byKey.get(o.key)?.remove();
    const t = h('div', { class: 'nv-toast nv-i' }, h('span', { text: msg }));
    if (o.action) {
      const b = h('button', { class: 'nv-btn nv-primary', text: o.action.label });
      b.addEventListener('click', () => { o.action!.fn(); dismiss(); });
      t.append(b);
    }
    this.el.append(t);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    if (o.key) this.byKey.set(o.key, t);
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      t.classList.add('nv-out');
      setTimeout(() => t.remove(), 320);
      if (o.key && this.byKey.get(o.key) === t) this.byKey.delete(o.key);
    };
    const dur = o.duration ?? (o.action ? 8000 : 3200);
    if (dur > 0) setTimeout(dismiss, dur);
    t.addEventListener('click', (e) => { if ((e.target as HTMLElement).tagName !== 'BUTTON') dismiss(); });
    return dismiss;
  }
}
