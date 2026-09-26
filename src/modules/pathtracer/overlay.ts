// Minimal DOM overlay for photo mode: status/progress, sample counter and the
// few controls that matter (depth of field, aperture, denoise, bounces, save,
// exit). Self-contained styles (prefix "ptx-"); hidden in screenshot mode.

export interface OverlayHandlers {
  onExit(): void;
  onSave(): void;
  onDof(on: boolean): void;
  onFStop(f: number): void;
  onDenoise(on: boolean): void;
  onBounces(n: number): void;
}

const CSS = `
.ptx-root{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:60;font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8edf2;
  background:rgba(14,18,24,.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.12);border-radius:12px;
  padding:9px 12px 10px;min-width:300px;max-width:min(94vw,640px);box-shadow:0 6px 24px rgba(0,0,0,.35);user-select:none}
.ptx-root.ptx-hidden{display:none}
.ptx-head{display:flex;align-items:center;gap:8px;justify-content:space-between}
.ptx-title{font-weight:600;letter-spacing:.02em;display:flex;align-items:center;gap:6px}
.ptx-dot{width:8px;height:8px;border-radius:50%;background:#f5b041;box-shadow:0 0 8px #f5b041}
.ptx-dot.ptx-live{background:#58d68d;box-shadow:0 0 8px #58d68d}
.ptx-dot.ptx-err{background:#ec7063;box-shadow:0 0 8px #ec7063}
.ptx-status{opacity:.85;font-variant-numeric:tabular-nums;margin-top:3px}
.ptx-bar{height:3px;background:rgba(255,255,255,.12);border-radius:2px;margin-top:6px;overflow:hidden}
.ptx-bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#5dade2,#58d68d);transition:width .2s}
.ptx-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center}
.ptx-row button,.ptx-row select{font:inherit;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:3px 8px;cursor:pointer}
.ptx-row button:hover,.ptx-row select:hover{background:rgba(255,255,255,.16)}
.ptx-row button.ptx-on{background:rgba(88,214,141,.25);border-color:rgba(88,214,141,.6)}
.ptx-row select option{color:#111}
.ptx-hint{opacity:.6;margin-top:6px;font-size:11px}
.ptx-x{background:none;border:none;color:inherit;font-size:16px;cursor:pointer;opacity:.7;padding:0 2px}
.ptx-x:hover{opacity:1}
.ptx-focus{position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border:1.5px solid rgba(255,255,255,.85);border-radius:50%;pointer-events:none;z-index:59;
  box-shadow:0 0 0 1px rgba(0,0,0,.35);transition:opacity .6s;opacity:0}
`;

export class Overlay {
  readonly el: HTMLDivElement;
  private dot: HTMLSpanElement;
  private status: HTMLDivElement;
  private bar: HTMLElement;
  private barWrap: HTMLDivElement;
  private row: HTMLDivElement;
  private dofBtn: HTMLButtonElement;
  private fSel: HTMLSelectElement;
  private dnBtn: HTMLButtonElement;
  private focusRing: HTMLDivElement;
  private static styled = false;

  constructor(private h: OverlayHandlers, opts: { dof: boolean; fStop: number; denoise: boolean; bounces: number }) {
    if (!Overlay.styled) {
      const st = document.createElement('style');
      st.textContent = CSS;
      document.head.appendChild(st);
      Overlay.styled = true;
    }
    const el = this.el = document.createElement('div');
    el.className = 'ptx-root ptx-hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Photo mode (path tracing)');
    const head = document.createElement('div');
    head.className = 'ptx-head';
    const title = document.createElement('div');
    title.className = 'ptx-title';
    this.dot = document.createElement('span');
    this.dot.className = 'ptx-dot';
    title.append(this.dot, document.createTextNode('Photo mode · path tracing'));
    const x = document.createElement('button');
    x.className = 'ptx-x';
    x.title = 'Exit (Esc / P)';
    x.textContent = '×';
    x.addEventListener('click', () => h.onExit());
    head.append(title, x);
    this.status = document.createElement('div');
    this.status.className = 'ptx-status';
    this.barWrap = document.createElement('div');
    this.barWrap.className = 'ptx-bar';
    this.bar = document.createElement('i');
    this.barWrap.append(this.bar);

    const row = this.row = document.createElement('div');
    row.className = 'ptx-row';
    this.dofBtn = this.btn('Depth of field', () => { const on = !this.dofBtn.classList.contains('ptx-on'); this.dofBtn.classList.toggle('ptx-on', on); this.fSel.disabled = !on; h.onDof(on); });
    this.dofBtn.classList.toggle('ptx-on', opts.dof);
    this.fSel = document.createElement('select');
    this.fSel.title = 'Aperture';
    for (const f of [1.4, 2, 2.8, 4, 5.6, 8, 11, 16]) {
      const o = document.createElement('option');
      o.value = String(f); o.textContent = `f/${f}`;
      if (Math.abs(f - opts.fStop) < 1e-3) o.selected = true;
      this.fSel.append(o);
    }
    this.fSel.disabled = !opts.dof;
    this.fSel.addEventListener('change', () => h.onFStop(+this.fSel.value));
    this.dnBtn = this.btn('Denoise', () => { const on = !this.dnBtn.classList.contains('ptx-on'); this.dnBtn.classList.toggle('ptx-on', on); h.onDenoise(on); });
    this.dnBtn.classList.toggle('ptx-on', opts.denoise);
    const bSel = document.createElement('select');
    bSel.title = 'Light bounces';
    for (const b of [2, 3, 4, 5, 6, 8, 12]) {
      const o = document.createElement('option');
      o.value = String(b); o.textContent = `${b} bounces`;
      if (b === opts.bounces) o.selected = true;
      bSel.append(o);
    }
    bSel.addEventListener('change', () => h.onBounces(+bSel.value));
    const save = this.btn('Save PNG', () => h.onSave());
    const exit = this.btn('Exit', () => h.onExit());
    row.append(this.dofBtn, this.fSel, this.dnBtn, bSel, save, exit);
    const hint = document.createElement('div');
    hint.className = 'ptx-hint';
    hint.textContent = 'Camera frozen. With depth of field on, click the image to focus. P or Esc returns to the live view.';
    el.append(head, this.status, this.barWrap, row, hint);
    document.body.appendChild(el);
    // stop UI clicks from reaching the canvas handlers
    for (const ev of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel']) el.addEventListener(ev, (e) => e.stopPropagation());

    this.focusRing = document.createElement('div');
    this.focusRing.className = 'ptx-focus';
    document.body.appendChild(this.focusRing);
  }

  private btn(label: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  show(on: boolean): void { this.el.classList.toggle('ptx-hidden', !on); }

  setStatus(text: string, progress: number | null, kind: 'busy' | 'live' | 'error' = 'busy'): void {
    this.status.textContent = text;
    this.dot.className = `ptx-dot${kind === 'live' ? ' ptx-live' : kind === 'error' ? ' ptx-err' : ''}`;
    this.barWrap.style.visibility = progress === null ? 'hidden' : 'visible';
    if (progress !== null) this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    this.row.style.display = kind === 'error' ? 'none' : '';
  }

  flashFocus(x: number, y: number): void {
    const r = this.focusRing;
    r.style.left = `${x}px`; r.style.top = `${y}px`;
    r.style.transition = 'none';
    r.style.opacity = '1';
    requestAnimationFrame(() => { r.style.transition = 'opacity .8s'; r.style.opacity = '0'; });
  }

  dispose(): void { this.el.remove(); this.focusRing.remove(); }
}
