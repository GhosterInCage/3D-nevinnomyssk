// All UI styles (injected once). Glass panels, dark theme, mobile layout via media queries.
export const CSS = /* css */ `
#ui-root > .nv-ui { pointer-events: none; }
.nv-ui {
  --nv-bg: rgba(13, 19, 27, 0.62);
  --nv-bg-solid: rgba(17, 24, 33, 0.92);
  --nv-bg-hi: rgba(255, 255, 255, 0.07);
  --nv-border: rgba(255, 255, 255, 0.10);
  --nv-fg: #eef2f6;
  --nv-muted: #9fb0c0;
  --nv-dim: #6f8193;
  --nv-accent: #7cc4ff;
  --nv-accent-bg: rgba(124, 196, 255, 0.16);
  --nv-warm: #ffb547;
  --nv-radius: 14px;
  --nv-shadow: 0 10px 30px rgba(0, 0, 0, 0.35), 0 1px 0 rgba(255, 255, 255, 0.04) inset;
  --nv-gap: 16px;
  position: absolute; inset: 0; color: var(--nv-fg);
  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
:where(.nv-ui) * { box-sizing: border-box; }
.nv-ui .nv-i { pointer-events: auto; }
.nv-glass {
  background: var(--nv-bg); border: 1px solid var(--nv-border); border-radius: var(--nv-radius);
  box-shadow: var(--nv-shadow);
  backdrop-filter: blur(14px) saturate(150%); -webkit-backdrop-filter: blur(14px) saturate(150%);
}
:where(.nv-ui) button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.nv-ui button:focus-visible, .nv-ui input:focus-visible, .nv-ui select:focus-visible { outline: 2px solid var(--nv-accent); outline-offset: 2px; }
.nv-ui svg { display: block; flex: none; }
.nv-hidden { display: none !important; }

/* ------------------------------------------------------------------ top-left: brand + search */
.nv-tl { position: absolute; left: var(--nv-gap); top: var(--nv-gap); width: 360px; display: flex; flex-direction: column; gap: 10px; }
.nv-brand { display: flex; align-items: center; gap: 10px; padding: 2px 4px; text-shadow: 0 1px 8px rgba(0,0,0,.55); }
.nv-logo { width: 34px; height: 34px; border-radius: 10px; flex: none; display: grid; place-items: center;
  background: linear-gradient(140deg, #3d8bfd 0%, #7cc4ff 45%, #ffb547 100%); box-shadow: 0 4px 14px rgba(61,139,253,.35); color: #0b1016; }
.nv-brand h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: .01em; line-height: 1.15; }
.nv-brand p { margin: 1px 0 0; font-size: 11.5px; color: #c9d5e1; opacity: .85; }
.nv-search { position: relative; }
.nv-search-box { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 8px 0 13px; }
.nv-search-box svg { color: var(--nv-muted); }
.nv-search input { flex: 1; min-width: 0; height: 100%; background: none; border: 0; outline: none; color: var(--nv-fg);
  font: inherit; font-size: 14px; user-select: text; -webkit-user-select: text; }
.nv-search input::placeholder { color: var(--nv-dim); }
.nv-search input::-webkit-search-cancel-button, .nv-search input::-webkit-search-decoration { -webkit-appearance: none; appearance: none; display: none; }
.nv-kbd { font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--nv-dim); border: 1px solid var(--nv-border);
  border-radius: 5px; padding: 3px 6px; }
.nv-search-clear { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: var(--nv-muted); }
.nv-search-clear:hover { background: var(--nv-bg-hi); color: var(--nv-fg); }
.nv-results { position: absolute; left: 0; right: 0; top: calc(100% + 6px); padding: 6px; max-height: min(420px, 60vh); overflow: auto;
  background: var(--nv-bg-solid); z-index: 30; }
.nv-results:empty { display: none; }
.nv-sec { padding: 8px 10px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--nv-dim); }
.nv-res { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px 10px; border-radius: 10px; }
.nv-res:hover, .nv-res.nv-sel { background: var(--nv-bg-hi); }
.nv-res.nv-sel { box-shadow: inset 2px 0 0 var(--nv-accent); }
.nv-res-main { flex: 1; min-width: 0; }
.nv-res-name { font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nv-res-name b { color: var(--nv-accent); font-weight: 650; }
.nv-res-sub { font-size: 11.5px; color: var(--nv-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.nv-res-dist { font-size: 11px; color: var(--nv-dim); white-space: nowrap; }
.nv-empty { padding: 14px; color: var(--nv-muted); text-align: center; }
.nv-dot { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; flex: none;
  background: var(--c, #9fb0c0); color: #0d141c; box-shadow: 0 0 0 2px rgba(255,255,255,.14); }
.nv-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 8px 8px; }
.nv-chip { padding: 5px 10px; border-radius: 999px; background: var(--nv-bg-hi); border: 1px solid var(--nv-border); font-size: 12px; }
.nv-chip:hover { background: var(--nv-accent-bg); border-color: rgba(124,196,255,.4); }
.nv-chip.nv-on { background: var(--nv-accent-bg); border-color: var(--nv-accent); color: #d8eeff; }

/* place card */
.nv-card { padding: 14px 14px 12px; position: relative; animation: nv-pop .22s ease-out; }
.nv-card-head { display: flex; gap: 11px; align-items: flex-start; padding-right: 26px; }
.nv-card-head .nv-dot { width: 34px; height: 34px; }
.nv-card-head .nv-dot svg { width: 16px; height: 16px; }
.nv-card h2 { margin: 0; font-size: 16px; font-weight: 650; line-height: 1.25; user-select: text; -webkit-user-select: text; }
.nv-card .nv-card-kind { color: var(--nv-muted); font-size: 12px; margin-top: 2px; }
.nv-card .nv-card-alt { color: var(--nv-dim); font-size: 11.5px; margin-top: 1px; }
.nv-card p { margin: 10px 0 0; color: #d3dde7; font-size: 12.5px; line-height: 1.45; user-select: text; -webkit-user-select: text; }
.nv-card-facts { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin-top: 10px; font-size: 12px; }
.nv-card-facts dt { color: var(--nv-dim); }
.nv-card-facts dd { margin: 0; color: #d3dde7; user-select: text; -webkit-user-select: text; font-variant-numeric: tabular-nums; }
.nv-card-actions { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
.nv-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 9px;
  background: var(--nv-bg-hi); border: 1px solid var(--nv-border) !important; font-size: 12.5px; }
.nv-btn svg { width: 16px; height: 16px; }
.nv-btn:hover { background: rgba(255,255,255,.12); }
.nv-btn.nv-primary { background: #2f7de1; border-color: #4b93f0 !important; color: #fff; }
.nv-btn.nv-primary:hover { background: #3a8bf2; }
.nv-x { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: var(--nv-muted); }
.nv-x:hover { background: var(--nv-bg-hi); color: var(--nv-fg); }
.nv-x svg { width: 16px; height: 16px; }

/* ------------------------------------------------------------------ top-center: location */
.nv-loc { position: absolute; left: 50%; top: var(--nv-gap); transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  height: 34px; padding: 0 14px 0 10px; border-radius: 999px; font-size: 12.5px; white-space: nowrap; max-width: calc(100vw - 820px);
  transition: opacity .4s ease; }
.nv-loc svg { width: 16px; height: 16px; color: var(--nv-warm); }
.nv-loc span { overflow: hidden; text-overflow: ellipsis; }
.nv-loc .nv-loc-d { color: var(--nv-muted); }
.nv-loc:empty { opacity: 0; }

/* ------------------------------------------------------------------ top-right: compass + toolbar */
.nv-tr { position: absolute; right: var(--nv-gap); top: var(--nv-gap); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.nv-compass { width: 64px; height: 64px; border-radius: 50%; position: relative; cursor: pointer; }
.nv-compass svg { width: 64px; height: 64px; }
.nv-compass .nv-hd { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); text-align: center; font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--nv-fg); pointer-events: none; }
.nv-tools { display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 16px; }
.nv-tool { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; color: #dbe5ee; position: relative; transition: background .15s ease, color .15s ease; }
.nv-tool:hover { background: var(--nv-bg-hi); color: #fff; }
.nv-tool.nv-on { background: var(--nv-accent-bg); color: var(--nv-accent); }
.nv-tool[data-tip]:hover::after { content: attr(data-tip); position: absolute; right: calc(100% + 10px); top: 50%; transform: translateY(-50%);
  background: var(--nv-bg-solid); border: 1px solid var(--nv-border); padding: 5px 9px; border-radius: 8px; white-space: nowrap; font-size: 12px;
  color: var(--nv-fg); pointer-events: none; box-shadow: var(--nv-shadow); }
.nv-sep { height: 1px; margin: 2px 6px; background: var(--nv-border); }

/* panels */
.nv-panel { position: absolute; right: calc(var(--nv-gap) + 64px); top: var(--nv-gap); width: 330px; max-height: calc(100% - 2 * var(--nv-gap) - 70px);
  overflow: auto; padding: 14px 14px 16px; background: var(--nv-bg-solid); animation: nv-pop .18s ease-out; z-index: 20; }
.nv-panel h3 { margin: 0 0 12px; font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.nv-panel h3 svg { width: 18px; height: 18px; color: var(--nv-accent); }
.nv-panel h4 { margin: 16px 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--nv-dim); font-weight: 600; }
.nv-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.nv-row label { flex: 1; color: #d3dde7; }
.nv-row .nv-val { color: var(--nv-muted); font-variant-numeric: tabular-nums; min-width: 44px; text-align: right; }
.nv-seg { display: flex; padding: 3px; gap: 3px; background: rgba(0,0,0,.25); border-radius: 11px; border: 1px solid var(--nv-border); }
.nv-seg button { flex: 1; height: 30px; border-radius: 8px; font-size: 12px; color: #c8d3de; display: flex; align-items: center; justify-content: center; gap: 5px; }
.nv-seg button:hover { background: var(--nv-bg-hi); }
.nv-seg button.nv-on { background: #2f7de1; color: #fff; box-shadow: 0 2px 8px rgba(47,125,225,.4); }
.nv-wx { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.nv-wx button { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 2px 7px; border-radius: 10px;
  background: var(--nv-bg-hi); border: 1px solid transparent; font-size: 11px; color: #c8d3de; }
.nv-wx button:hover { background: rgba(255,255,255,.12); }
.nv-wx button.nv-on { border-color: var(--nv-accent); background: var(--nv-accent-bg); color: #e6f4ff; }
.nv-time-big { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.nv-time-big b { font: 600 34px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: -.02em; }
.nv-time-big span { color: var(--nv-muted); font-size: 12px; }
.nv-sunline { display: flex; justify-content: space-between; color: var(--nv-muted); font-size: 11.5px; margin-top: 2px; }
.nv-ui input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 26px; background: transparent; cursor: pointer; }
.nv-ui input[type=range]::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: var(--track, rgba(255,255,255,.14)); }
.nv-ui input[type=range]::-moz-range-track { height: 6px; border-radius: 3px; background: var(--track, rgba(255,255,255,.14)); }
.nv-ui input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; margin-top: -6px; border-radius: 50%;
  background: #fff; border: 0; box-shadow: 0 1px 6px rgba(0,0,0,.45); }
.nv-ui input[type=range]::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 0; box-shadow: 0 1px 6px rgba(0,0,0,.45); }
.nv-time-slider { --track: linear-gradient(90deg, #0b1330 0%, #1b2a55 18%, #f39c6b 26%, #8ec5ff 34%, #bfe3ff 50%, #8ec5ff 66%, #f08a5d 76%, #1b2a55 84%, #0b1330 100%); }
.nv-ui input[type=date], .nv-ui select { background: rgba(0,0,0,.25); color: var(--nv-fg); border: 1px solid var(--nv-border); border-radius: 8px;
  height: 32px; padding: 0 8px; font: inherit; color-scheme: dark; }
.nv-switch { position: relative; width: 38px; height: 22px; border-radius: 11px; background: rgba(255,255,255,.16); transition: background .2s; flex: none; }
.nv-switch::after { content: ""; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .2s; }
.nv-switch.nv-on { background: #2f7de1; }
.nv-switch.nv-on::after { transform: translateX(16px); }
.nv-note { color: var(--nv-muted); font-size: 11.5px; margin-top: 6px; line-height: 1.4; }

/* ------------------------------------------------------------------ bottom-left: minimap */
.nv-mm { position: absolute; left: var(--nv-gap); bottom: var(--nv-gap); width: 216px; height: 216px; padding: 0; overflow: hidden; border-radius: 16px; }
.nv-mm canvas { width: 100%; height: 100%; display: block; cursor: crosshair; touch-action: none; border-radius: 15px; }
.nv-mm-btns { position: absolute; right: 6px; top: 6px; display: flex; flex-direction: column; gap: 4px; }
.nv-mm-btns button { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; background: rgba(10,15,22,.72); color: #e6eef6; border: 1px solid rgba(255,255,255,.12); }
.nv-mm-btns button:hover { background: rgba(30,40,55,.9); }
.nv-mm-btns svg { width: 15px; height: 15px; }
.nv-mm-n { position: absolute; left: 50%; top: 4px; transform: translateX(-50%); font: 700 10px/1 system-ui, sans-serif; color: #fff; text-shadow: 0 0 3px #000, 0 0 6px #000; pointer-events: none; }
.nv-mm-scale { position: absolute; left: 8px; bottom: 7px; font: 10px/1 ui-monospace, monospace; color: #fff; text-shadow: 0 0 3px #000, 0 0 5px #000; pointer-events: none; }
.nv-mm-scale i { display: block; height: 4px; border: 1.5px solid #fff; border-top: 0; margin-top: 2px; box-shadow: 0 1px 2px rgba(0,0,0,.6); }

/* big map */
.nv-bigmap { position: absolute; inset: 22px; z-index: 40; overflow: hidden; animation: nv-pop .2s ease-out; background: #0b1016; border-radius: 18px; }
.nv-bigmap canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.nv-bigmap canvas.nv-drag { cursor: grabbing; }
.nv-bigmap-bar { position: absolute; left: 12px; top: 12px; right: 12px; display: flex; align-items: center; gap: 10px; pointer-events: none; }
.nv-bigmap-bar > * { pointer-events: auto; }
.nv-bigmap-title { padding: 8px 14px; font-weight: 600; border-radius: 12px; }
.nv-bigmap-hint { color: var(--nv-muted); font-size: 12px; padding: 8px 12px; border-radius: 12px; }
.nv-bigmap-bar .nv-x { position: static; margin-left: auto; width: 38px; height: 38px; background: var(--nv-bg-solid); border: 1px solid var(--nv-border); border-radius: 12px; }
.nv-bigmap-zoom { position: absolute; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 6px; }
.nv-bigmap-zoom button { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; background: var(--nv-bg-solid); border: 1px solid var(--nv-border) !important; }

/* ------------------------------------------------------------------ bottom-center: modes */
.nv-modes { position: absolute; left: 50%; bottom: var(--nv-gap); transform: translateX(-50%); display: flex; gap: 4px; padding: 5px; border-radius: 16px; }
.nv-mode { display: flex; align-items: center; gap: 7px; height: 40px; padding: 0 14px; border-radius: 11px; color: #cdd7e1; font-size: 13px; font-weight: 550; position: relative; }
.nv-mode:hover { background: var(--nv-bg-hi); color: #fff; }
.nv-mode.nv-on { background: #2f7de1; color: #fff; box-shadow: 0 3px 12px rgba(47,125,225,.45); }
.nv-mode.nv-rtx.nv-on { background: linear-gradient(135deg, #7b3fe4, #2f7de1); }
.nv-mode .nv-badge { position: absolute; top: -6px; right: -4px; font: 600 9.5px/1 ui-monospace, monospace; padding: 3px 5px; border-radius: 6px; background: #ffb547; color: #1a1205; }
.nv-mode kbd { font: 10px/1 ui-monospace, monospace; opacity: .45; margin-left: 2px; }

/* keep clear of the physics HUD: key hint (bottom centre, ~5 s after a mode switch) and the drive dashboard (bottom right) */
.nv-modes, .nv-status, .nv-attrib { transition: bottom .3s ease; }
.nv-ui.nv-lift-modes .nv-modes { bottom: calc(var(--nv-gap) + 44px); }
.nv-ui.nv-lift-status .nv-status { bottom: calc(22px + 188px + 10px); }
.nv-ui.nv-lift-status .nv-attrib { display: none; } /* attribution stays in the help overlay */

/* photo mode (path tracer overlay at the top centre): no labels, markers or location pill over the render */
.nv-ui.nv-photo .nv-labels, .nv-ui.nv-photo .nv-loc, .nv-ui.nv-photo .nv-marker,
.nv-ui.nv-photo .nv-tl, .nv-ui.nv-photo .nv-mm { opacity: 0 !important; pointer-events: none !important; transition: opacity .25s; }
.nv-ui.nv-photo .nv-toasts { top: 150px; }

/* ------------------------------------------------------------------ bottom-right: status */
.nv-status { position: absolute; right: var(--nv-gap); bottom: var(--nv-gap); padding: 7px 12px; border-radius: 11px; font: 11.5px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #cfdae5; text-align: right; font-variant-numeric: tabular-nums; }
.nv-status .nv-dim { color: var(--nv-dim); }
.nv-attrib { position: absolute; right: var(--nv-gap); bottom: calc(var(--nv-gap) + 50px); font-size: 10.5px; color: rgba(255,255,255,.55); text-shadow: 0 1px 3px rgba(0,0,0,.8); pointer-events: none; text-align: right; }

/* stats */
.nv-stats { position: absolute; left: calc(var(--nv-gap) + 228px); bottom: var(--nv-gap); width: 196px; padding: 9px 10px; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfdae5; }
.nv-stats canvas { width: 100%; height: 38px; display: block; margin-bottom: 6px; border-radius: 6px; background: rgba(0,0,0,.25); }
.nv-stats .nv-fps { font-size: 18px; font-weight: 650; color: #fff; }
.nv-stats-grid { display: grid; grid-template-columns: 1fr auto; column-gap: 8px; }
.nv-stats-grid span:nth-child(odd) { color: var(--nv-dim); }

/* ------------------------------------------------------------------ toasts */
.nv-toasts { position: absolute; left: 50%; top: 60px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 50; pointer-events: none; }
.nv-toast { display: flex; align-items: center; gap: 10px; padding: 9px 12px 9px 14px; border-radius: 12px; background: var(--nv-bg-solid); border: 1px solid var(--nv-border);
  box-shadow: var(--nv-shadow); font-size: 12.5px; max-width: min(560px, calc(100vw - 32px)); animation: nv-toast-in .25s ease-out; pointer-events: auto; }
.nv-toast.nv-out { animation: nv-toast-out .3s ease-in forwards; }
.nv-toast .nv-btn { height: 28px; }

/* ------------------------------------------------------------------ help */
.nv-modal-bg { position: absolute; inset: 0; background: rgba(4, 7, 11, .55); z-index: 60; display: grid; place-items: center; animation: nv-fade .2s ease-out;
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
.nv-help { width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto; padding: 22px 24px; background: var(--nv-bg-solid); position: relative; }
.nv-help h2 { margin: 0 0 4px; font-size: 18px; }
.nv-help .nv-help-sub { color: var(--nv-muted); margin-bottom: 14px; }
.nv-help-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 18px 22px; }
.nv-help h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--nv-accent); display: flex; gap: 6px; align-items: center; }
.nv-help h4 svg { width: 15px; height: 15px; }
.nv-help dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; margin: 0; font-size: 12.5px; }
.nv-help dt { white-space: nowrap; }
.nv-help dd { margin: 0; color: #c8d3de; }
.nv-help kbd { display: inline-block; min-width: 20px; text-align: center; font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 4px 5px;
  border-radius: 5px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14); border-bottom-width: 2px; margin-right: 2px; }
.nv-help-foot { margin-top: 18px; color: var(--nv-dim); font-size: 11.5px; line-height: 1.5; }

/* ------------------------------------------------------------------ labels */
.nv-labels { position: absolute; inset: 0; overflow: hidden; pointer-events: none; contain: strict; }
.nv-lbl { position: absolute; left: 0; top: 0; will-change: transform, opacity; opacity: 0; white-space: nowrap; }
.nv-lbl-b { position: absolute; left: 0; bottom: 0; transform: translate(-50%, 0); display: flex; align-items: center; gap: 6px; padding: 3px 9px 3px 3px;
  border-radius: 999px; background: rgba(12, 17, 24, .66); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 2px 10px rgba(0,0,0,.3);
  font-size: 12px; font-weight: 550; color: #f2f6fa; pointer-events: auto; cursor: pointer;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.nv-lbl-b:hover { background: rgba(24, 34, 48, .88); }
.nv-lbl .nv-dot { width: 20px; height: 20px; box-shadow: none; }
.nv-lbl .nv-dot svg { width: 11px; height: 11px; }
.nv-lbl-stem { position: absolute; left: -1px; bottom: 0; width: 2px; height: 14px; background: linear-gradient(rgba(255,255,255,.75), rgba(255,255,255,.1)); border-radius: 1px; }
.nv-lbl.nv-pin .nv-lbl-b { bottom: 14px; }
.nv-lbl.nv-r1 .nv-lbl-b { font-size: 13px; padding: 4px 11px 4px 4px; }
.nv-lbl.nv-r1 .nv-dot { width: 22px; height: 22px; }
.nv-lbl.nv-r4 .nv-lbl-b, .nv-lbl.nv-r5 .nv-lbl-b { font-size: 11px; font-weight: 500; padding: 2px 8px 2px 2px; }
.nv-lbl.nv-r4 .nv-dot, .nv-lbl.nv-r5 .nv-dot { width: 17px; height: 17px; }
.nv-lbl.nv-r4 .nv-dot svg, .nv-lbl.nv-r5 .nv-dot svg { width: 9px; height: 9px; }
.nv-lbl.nv-area .nv-lbl-b { transform: translate(-50%, 50%); background: none; border: 0; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none;
  padding: 0; font-size: 15px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #fff;
  text-shadow: 0 0 2px rgba(0,0,0,.9), 0 1px 6px rgba(0,0,0,.85), 0 0 18px rgba(0,0,0,.5); flex-direction: column; gap: 0; }
.nv-lbl.nv-area .nv-lbl-b small { font-size: 9.5px; letter-spacing: .12em; font-weight: 600; color: #d6e2ee; opacity: .85; }
.nv-lbl.nv-area.nv-r2 .nv-lbl-b { font-size: 12.5px; }
.nv-lbl.nv-k-city .nv-lbl-b { font-size: 24px; font-weight: 750; letter-spacing: .3em; color: #fff4dc; }
.nv-lbl.nv-area.nv-r3 .nv-lbl-b { font-size: 11px; }
.nv-lbl.nv-street .nv-lbl-b { transform: translate(-50%, 50%); background: rgba(250, 252, 255, .88); color: #1d2733; border: 0; padding: 2px 8px; font-size: 11px; font-weight: 600;
  box-shadow: 0 1px 4px rgba(0,0,0,.35); backdrop-filter: none; -webkit-backdrop-filter: none; border-radius: 5px; }
.nv-lbl.nv-water .nv-lbl-b { transform: translate(-50%, 50%); background: none; border: 0; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none;
  padding: 0; font-style: italic; font-weight: 600; font-size: 13px; letter-spacing: .05em; color: #bfe6ff;
  text-shadow: 0 0 2px rgba(0,20,40,.95), 0 1px 6px rgba(0,20,40,.9); }
.nv-lbl.nv-sel .nv-lbl-b { box-shadow: 0 0 0 2px var(--nv-warm), 0 4px 14px rgba(0,0,0,.4); }

/* pick marker */
.nv-marker { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.nv-marker::before { content: ""; position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid #ffb547; box-shadow: 0 0 0 3px rgba(255,181,71,.25); animation: nv-pulse 1.6s ease-out infinite; }
.nv-marker::after { content: ""; position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%; background: #ffb547; }

/* ------------------------------------------------------------------ touch */
.nv-joy { position: absolute; left: 22px; bottom: 86px; width: 124px; height: 124px; border-radius: 50%; touch-action: none;
  background: radial-gradient(circle, rgba(255,255,255,.07), rgba(255,255,255,.02) 70%); border: 1px solid rgba(255,255,255,.16);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.nv-joy i { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; margin: -26px 0 0 -26px; border-radius: 50%;
  background: rgba(255,255,255,.28); border: 1px solid rgba(255,255,255,.4); box-shadow: 0 4px 12px rgba(0,0,0,.35); }
.nv-joy.nv-active i { background: rgba(124,196,255,.45); }
.nv-updown { position: absolute; right: 18px; bottom: 90px; display: flex; flex-direction: column; gap: 10px; }
.nv-updown button { width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center; background: rgba(13,19,27,.55);
  border: 1px solid rgba(255,255,255,.16) !important; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); touch-action: none; }
.nv-updown button.nv-active { background: rgba(124,196,255,.4); }
.nv-updown svg { width: 24px; height: 24px; }

@keyframes nv-pop { from { opacity: 0; transform: translateY(-4px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes nv-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes nv-toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes nv-toast-out { to { opacity: 0; transform: translateY(-8px); } }
@keyframes nv-pulse { 0% { transform: scale(.7); opacity: 1; } 100% { transform: scale(1.9); opacity: 0; } }
@keyframes nv-flash { from { opacity: .85; } to { opacity: 0; } }
.nv-flash { position: absolute; inset: 0; background: #fff; pointer-events: none; animation: nv-flash .45s ease-out forwards; z-index: 70; }

/* hide chrome while taking a screenshot / in cinematic mode */
.nv-ui.nv-clean > :not(.nv-toasts):not(.nv-flash) { opacity: 0 !important; pointer-events: none !important; transition: opacity .25s; }

/* ------------------------------------------------------------------ mobile */
@media (max-width: 720px), (max-height: 520px) {
  .nv-ui { --nv-gap: 10px; }
  .nv-tl { width: calc(100vw - 2 * var(--nv-gap) - 58px); }
  .nv-brand p { display: none; }
  .nv-brand h1 { font-size: 15px; }
  .nv-logo { width: 28px; height: 28px; border-radius: 8px; }
  .nv-search-box { height: 40px; }
  .nv-kbd { display: none; }
  .nv-loc { top: auto; bottom: 64px; max-width: calc(100vw - 32px); height: 28px; font-size: 11.5px; }
  .nv-compass, .nv-compass svg { width: 48px; height: 48px; }
  .nv-compass .nv-hd { font-size: 9px; }
  .nv-tools { padding: 4px; gap: 3px; }
  .nv-tool { width: 36px; height: 36px; }
  .nv-tool[data-tip]:hover::after { display: none; }
  .nv-panel { left: var(--nv-gap); right: var(--nv-gap); width: auto; top: auto; bottom: 62px; max-height: 62vh; border-radius: 18px; }
  .nv-mm { width: 104px; height: 104px; left: auto; right: calc(var(--nv-gap) + 58px); top: var(--nv-gap); bottom: auto; border-radius: 14px; display: none; }
  .nv-mm-btns, .nv-mm-scale { display: none; }
  .nv-modes { bottom: var(--nv-gap); padding: 4px; }
  .nv-mode { height: 38px; padding: 0 11px; font-size: 12px; }
  .nv-mode span, .nv-mode kbd { display: none; }
  .nv-status, .nv-attrib { display: none; }
  .nv-stats { left: var(--nv-gap); bottom: 250px; }
  .nv-bigmap { inset: 0; border-radius: 0; }
  .nv-bigmap-hint { display: none; }
  .nv-toasts { top: 104px; }
  .nv-card { max-height: 42vh; overflow: auto; }
  .nv-loc { transition: bottom .3s ease; }
  .nv-ui.nv-lift-modes .nv-loc { bottom: calc(64px + 44px); }
}
@media (max-width: 720px) and (min-height: 521px) {
  .nv-tl .nv-card { position: fixed; left: 10px; right: 10px; bottom: 62px; top: auto; z-index: 25; }
}
@media (max-width: 1100px) and (min-width: 721px) {
  .nv-loc { display: none; }
}

/* ------------------------------------------------------------------ loading screen (enhances #loading) */
#loading.nv-load { background: #06090d; overflow: hidden; }
#loading.nv-load .nv-load-bg { position: absolute; inset: -6%; background-size: cover; background-position: 50% 45%; opacity: 0;
  filter: saturate(1.1) brightness(.62) contrast(1.05); transition: opacity 1.6s ease; animation: nv-kb 40s ease-in-out infinite alternate; }
#loading.nv-load .nv-load-bg.nv-in { opacity: 1; }
#loading.nv-load::after { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse at 50% 42%, rgba(6,9,13,.25) 0%, rgba(6,9,13,.72) 55%, rgba(6,9,13,.96) 100%); }
#loading.nv-load .box { position: relative; z-index: 1; width: min(520px, 90vw); padding: 30px 30px 24px; border-radius: 22px;
  background: rgba(10, 15, 22, .55); border: 1px solid rgba(255,255,255,.09); box-shadow: 0 30px 80px rgba(0,0,0,.5);
  backdrop-filter: blur(16px) saturate(140%); -webkit-backdrop-filter: blur(16px) saturate(140%); }
#loading.nv-load h1 { font-weight: 250; letter-spacing: .24em; font-size: clamp(24px, 5vw, 36px); margin: 0 0 6px; padding-left: .24em;
  background: linear-gradient(180deg, #fff, #b9d7f0); -webkit-background-clip: text; background-clip: text; color: transparent; }
#loading.nv-load p { letter-spacing: .12em; text-transform: uppercase; font-size: 11px; color: #9fb0c0; margin-bottom: 22px; }
#loading.nv-load .track { height: 4px; border-radius: 2px; background: rgba(255,255,255,.09); }
#loading.nv-load #loading-bar { background: linear-gradient(90deg, #3d8bfd, #7cc4ff 60%, #ffb547); box-shadow: 0 0 12px rgba(124,196,255,.6); border-radius: 2px; }
#loading.nv-load #loading-status { display: none; }
.nv-load-status { font-size: 11.5px; margin-top: 12px; color: #9fb0c0; min-height: 1.4em; }
.nv-load-mods { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 16px; }
.nv-load-mod { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px 4px 7px; border-radius: 999px; font-size: 11px; color: #9fb0c0;
  background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.07); transition: all .3s ease; }
.nv-load-mod i { width: 8px; height: 8px; border-radius: 50%; background: #4b5b6b; }
.nv-load-mod.nv-init i, .nv-load-mod.nv-loading i { background: #7cc4ff; animation: nv-blink 1s ease-in-out infinite; }
.nv-load-mod.nv-ready { color: #d7f5e3; border-color: rgba(87,214,141,.25); }
.nv-load-mod.nv-ready i { background: #57d68d; }
.nv-load-mod.nv-error { color: #ffc2c8; border-color: rgba(255,107,122,.35); }
.nv-load-mod.nv-error i { background: #ff6b7a; }
.nv-load-tip { margin-top: 18px; min-height: 3em; font-size: 12px; line-height: 1.5; color: #b8c6d4; transition: opacity .5s ease; }
.nv-load-tip b { color: #7cc4ff; font-weight: 600; margin-right: 4px; }
.nv-load-foot { position: absolute; z-index: 1; left: 0; right: 0; bottom: 18px; text-align: center; font-size: 10.5px; color: rgba(255,255,255,.4); letter-spacing: .04em; }
@keyframes nv-blink { 50% { opacity: .35; } }
@keyframes nv-kb { from { transform: scale(1.0) translate(0, 0); } to { transform: scale(1.12) translate(-2%, 1.5%); } }
`;
