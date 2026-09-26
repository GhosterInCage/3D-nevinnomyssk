// Touch controls: virtual joystick (maps to WASD/Shift in ctx.input), up/down
// buttons for flight, reliable look-drag deltas for touch pointers and double-tap.
import type { AppContext } from '../../core/context';
import { ICON } from './icons';
import { h } from './dom';
import { t } from './i18n';

export function isTouchDevice(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0 && matchMedia('(hover: none)').matches;
  } catch { return false; }
}

export class TouchControls {
  readonly joy: HTMLDivElement;
  readonly updown: HTMLDivElement;
  private knob: HTMLElement;
  private held = new Set<string>();
  private lastTap = { t: 0, x: 0, y: 0 };
  private touchPos = new Map<number, { x: number; y: number }>();

  constructor(private ctx: AppContext, parent: HTMLElement, onDoubleTap: (clientX: number, clientY: number) => void) {
    this.knob = h('i');
    this.joy = h('div', { class: 'nv-joy nv-i' }, this.knob);
    const up = h('button', { class: 'nv-i', 'aria-label': t('up'), html: ICON.up });
    const down = h('button', { class: 'nv-i', 'aria-label': t('down'), html: ICON.down });
    this.updown = h('div', { class: 'nv-updown' }, up, down);
    parent.append(this.joy, this.updown);
    this.bindJoystick();
    this.bindHold(up, 'KeyE');
    this.bindHold(down, 'KeyQ');

    // Look drag: make sure touch drags on the canvas produce look deltas even
    // where PointerEvent.movementX is not populated for touch input.
    const canvas = ctx.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      this.touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = performance.now();
      if (now - this.lastTap.t < 320 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30) {
        onDoubleTap(e.clientX, e.clientY);
        this.lastTap.t = 0;
      } else {
        this.lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch') return;
      const p = this.touchPos.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      // core Input already added movementX/Y; add only the missing part, with a touch gain
      const gain = 1.35;
      ctx.input.mouseDelta.x += dx * gain - (e.movementX || 0);
      ctx.input.mouseDelta.y += dy * gain - (e.movementY || 0);
    });
    const end = (e: PointerEvent) => { this.touchPos.delete(e.pointerId); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  setFlyButtons(visible: boolean): void {
    this.updown.style.display = visible ? '' : 'none';
  }

  private set(code: string, on: boolean): void {
    const keys = this.ctx.input.keys;
    if (on) { if (!this.held.has(code)) { this.held.add(code); keys.add(code); } }
    else if (this.held.has(code)) { this.held.delete(code); keys.delete(code); }
  }

  private bindHold(btn: HTMLElement, code: string): void {
    const on = (e: PointerEvent) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); btn.classList.add('nv-active'); this.set(code, true); };
    const off = () => { btn.classList.remove('nv-active'); this.set(code, false); };
    btn.addEventListener('pointerdown', on);
    btn.addEventListener('pointerup', off);
    btn.addEventListener('pointercancel', off);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private bindJoystick(): void {
    const el = this.joy;
    let id = -1, cx = 0, cy = 0;
    const R = 46;
    const move = (x: number, y: number) => {
      let dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx *= R / d; dy *= R / d; }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const nx = dx / R, ny = dy / R;
      // controllers with analog input (physics walk/drive) get the stick directly
      const c = this.ctx.controller as any;
      if (c?.analog && typeof c.analog === 'object') {
        c.analog.x = nx; c.analog.y = -ny;
        for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) this.set(k, false);
        this.set('ShiftLeft', Math.hypot(nx, ny) > 0.97);
        return;
      }
      const th = 0.32;
      this.set('KeyW', ny < -th);
      this.set('KeyS', ny > th);
      this.set('KeyA', nx < -th);
      this.set('KeyD', nx > th);
      this.set('ShiftLeft', Math.hypot(nx, ny) > 0.97);
    };
    const release = () => {
      id = -1;
      el.classList.remove('nv-active');
      this.knob.style.transform = '';
      for (const c of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft']) this.set(c, false);
      const ctl = this.ctx.controller as any;
      if (ctl?.analog && typeof ctl.analog === 'object') { ctl.analog.x = 0; ctl.analog.y = 0; }
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      el.setPointerCapture(id);
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      el.classList.add('nv-active');
      move(e.clientX, e.clientY);
    });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e.clientX, e.clientY); });
    el.addEventListener('pointerup', (e) => { if (e.pointerId === id) release(); });
    el.addEventListener('pointercancel', release);
  }

  dispose(): void {
    for (const c of [...this.held]) this.set(c, false);
    this.joy.remove();
    this.updown.remove();
  }
}
