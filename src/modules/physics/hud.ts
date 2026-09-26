// Minimal in-world HUD owned by the physics module: a crosshair while walking with the pointer
// locked, and a speedometer / tachometer / gear readout while driving. Hidden in screenshot mode
// (unless ?physhud=1) and can be disabled by the UI via the service (physics.setHud(false)).
import type { AppContext } from '../../core/context';

const CSS = `
.phx-hud{position:fixed;inset:0;pointer-events:none;z-index:40;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff}
.phx-cross{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 1.5px rgba(0,0,0,.35);opacity:0;transition:opacity .2s}
.phx-cross.on{opacity:1}
.phx-dash{position:absolute;right:22px;bottom:22px;width:188px;height:188px;opacity:0;transition:opacity .25s}
.phx-dash.on{opacity:1}
.phx-dash svg{width:100%;height:100%;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))}
.phx-spd{position:absolute;left:0;right:0;top:78px;text-align:center;font-weight:700;font-size:38px;letter-spacing:-1px;font-variant-numeric:tabular-nums;text-shadow:0 1px 3px rgba(0,0,0,.6)}
.phx-unit{position:absolute;left:0;right:0;top:122px;text-align:center;font-size:11px;opacity:.75;letter-spacing:1px}
.phx-gear{position:absolute;left:0;right:0;top:140px;text-align:center;font-size:15px;font-weight:700;color:#ffd27a}
.phx-hint{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);background:rgba(13,19,27,.55);backdrop-filter:blur(6px);padding:6px 12px;border-radius:9px;font-size:12px;opacity:0;transition:opacity .4s;white-space:nowrap}
.phx-hint.on{opacity:.92}
`;

export class PhysicsHud {
  private root: HTMLDivElement | null = null;
  private cross!: HTMLDivElement;
  private dash!: HTMLDivElement;
  private spd!: HTMLDivElement;
  private gear!: HTMLDivElement;
  private arc!: SVGPathElement;
  private rpmArc!: SVGPathElement;
  private hint!: HTMLDivElement;
  private hintT = 0;
  enabled: boolean;

  constructor(private ctx: AppContext) {
    const p = ctx.settings.params.get('physhud');
    this.enabled = p === '1' || (!ctx.settings.shot && p !== '0');
    if (this.enabled) this.build();
  }

  private build(): void {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.append(st);
    const r = document.createElement('div');
    r.className = 'phx-hud';
    this.cross = document.createElement('div');
    this.cross.className = 'phx-cross';
    this.dash = document.createElement('div');
    this.dash.className = 'phx-dash';
    const ticks: string[] = [];
    for (let k = 0; k <= 20; k++) {
      const a = (-225 + (k / 20) * 270) * (Math.PI / 180);
      const r0 = k % 2 ? 78 : 72, r1 = 84;
      ticks.push(`<line x1="${94 + Math.cos(a) * r0}" y1="${94 + Math.sin(a) * r0}" x2="${94 + Math.cos(a) * r1}" y2="${94 + Math.sin(a) * r1}" stroke="rgba(255,255,255,${k % 2 ? 0.35 : 0.8})" stroke-width="${k % 2 ? 1 : 2}"/>`);
      if (k % 4 === 0) {
        const lx = 94 + Math.cos(a) * 60, ly = 94 + Math.sin(a) * 60;
        ticks.push(`<text x="${lx}" y="${ly}" fill="rgba(255,255,255,.7)" font-size="10" text-anchor="middle" dominant-baseline="central">${k * 10}</text>`);
      }
    }
    this.dash.innerHTML = `<svg viewBox="0 0 188 188">
      <circle cx="94" cy="94" r="90" fill="rgba(13,19,27,.55)" stroke="rgba(255,255,255,.12)"/>
      <path d="${arcPath(94, 94, 88, -225, 45)}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="5"/>
      <path class="phx-rpm" d="" fill="none" stroke="#ff9f43" stroke-width="5" stroke-linecap="round"/>
      <path d="${arcPath(94, 94, 81, -225, 45)}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3"/>
      <path class="phx-arc" d="" fill="none" stroke="#7cc4ff" stroke-width="3" stroke-linecap="round"/>
      ${ticks.join('')}</svg><div class="phx-spd">0</div><div class="phx-unit">KM/H</div><div class="phx-gear">1</div>`;
    this.spd = this.dash.querySelector('.phx-spd')!;
    this.gear = this.dash.querySelector('.phx-gear')!;
    this.arc = this.dash.querySelector('.phx-arc')!;
    this.rpmArc = this.dash.querySelector('.phx-rpm')!;
    this.hint = document.createElement('div');
    this.hint.className = 'phx-hint';
    r.append(this.cross, this.dash, this.hint);
    document.body.append(r);
    this.root = r;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.root) this.build();
    if (this.root) this.root.style.display = on ? '' : 'none';
  }

  showHint(text: string, seconds = 5): void {
    if (!this.root) return;
    this.hint.textContent = text;
    this.hint.classList.add('on');
    this.hintT = seconds;
  }

  update(dt: number, mode: string, drive: { kmh: number; rpm: number; gear: number } | null): void {
    if (!this.root || !this.enabled) return;
    const locked = document.pointerLockElement === this.ctx.canvas;
    this.cross.classList.toggle('on', mode === 'walk' && locked);
    const showDash = mode === 'drive' && !!drive;
    this.dash.classList.toggle('on', showDash);
    if (showDash && drive) {
      const k = Math.round(drive.kmh);
      if (this.spd.textContent !== String(k)) this.spd.textContent = String(k);
      const g = drive.gear === -1 ? 'R' : drive.gear === 0 ? 'N' : String(drive.gear);
      if (this.gear.textContent !== g) this.gear.textContent = g;
      const f = Math.min(1, drive.kmh / 200);
      this.arc.setAttribute('d', f > 0.002 ? arcPath(94, 94, 81, -225, -225 + 270 * f) : '');
      const fr = Math.min(1, drive.rpm / 7000);
      this.rpmArc.setAttribute('d', arcPath(94, 94, 88, -225, -225 + 270 * fr));
      this.rpmArc.setAttribute('stroke', drive.rpm > 5900 ? '#ff5e57' : '#ff9f43');
    }
    if (this.hintT > 0) {
      this.hintT -= dt;
      if (this.hintT <= 0) this.hint.classList.remove('on');
    }
  }
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + Math.cos((a * Math.PI) / 180) * r, cy + Math.sin((a * Math.PI) / 180) * r];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
