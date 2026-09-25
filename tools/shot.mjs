#!/usr/bin/env node
// Headless screenshot harness (Chromium + SwiftShader WebGL).
//
// Usage examples:
//   node tools/shot.mjs --out tools/shots/overview.png
//   node tools/shot.mjs --cam 0,420,800,0,-15 --time 18.5 --only terrain,sky,buildings --out tools/shots/b.png
//   node tools/shot.mjs --views '[{"name":"center","cam":"-270,360,900,0,-10"},{"name":"azot","ll":"41.969,44.656,300,200,-20"}]' --dir tools/shots
//
// Options:
//   --url <base>        use an already running server (default: start a Vite dev server)
//   --cam x,y,z,h,p     camera (world metres, heading deg cw from north, pitch deg)
//   --ll lon,lat,agl,h,p camera by geographic coordinates (agl = metres above ground)
//   --time H            local time of day;  --date YYYY-MM-DD
//   --only a,b / --skip a,b   module filter;  --quality low|medium|high|ultra (default medium)
//   --w 1280 --h 720    viewport size
//   --views JSON        several views taken in one page load ({name, cam|ll|xz+agl+heading+pitch, time?}); needs --dir
//   --preset a,b|all    named views from tools/views.json (implies --views); saved as <dir>/<name>.png
//   --wait ms           max wait for ready (default 240000)
//   --settle ms         extra wait after ready before each capture (default 1500)
//   --extra "&k=v"      extra query string
//   --eval "js"         JS evaluated in the page after ready (before shots)
//   --headed            use full chromium instead of headless shell
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
    args[k] = v;
  }
}
const W = +(args.w || 1280), H = +(args.h || 720);
const quality = args.quality || 'medium';

let server = null;
let base = args.url;
if (!base) {
  const { createServer } = await import('vite');
  server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
  await server.listen();
  const addr = server.httpServer.address();
  base = `http://127.0.0.1:${addr.port}/`;
}

function exe() {
  const p = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (args.headed) return undefined;
  try {
    const d = fs.readdirSync(p).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop();
    if (d) {
      const c = path.join(p, d, 'chrome-linux', 'headless_shell');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* ignore */ }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: exe(),
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox', '--no-sandbox', '--js-flags=--max-old-space-size=8192',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning' || t === 'info' || args.verbose) logs.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack || e.message}`));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

const q = new URLSearchParams();
q.set('shot', '1');
q.set('quality', quality);
if (args.cam) q.set('cam', args.cam);
if (args.ll) q.set('ll', args.ll);
if (args.time) q.set('time', args.time);
if (args.date) q.set('date', args.date);
if (args.only) q.set('only', args.only);
if (args.skip) q.set('skip', args.skip);
let views = null;
if (args.preset) {
  const all = JSON.parse(fs.readFileSync(path.join(root, 'tools/views.json'), 'utf8'));
  const names = args.preset === 'all' ? all.map((v) => v.name) : args.preset.split(',');
  args.views = JSON.stringify(names.map((n) => { const v = all.find((x) => x.name === n); if (!v) throw new Error('unknown preset ' + n); return v; }));
}
if (args.views) {
  views = JSON.parse(args.views);
  if (views[0]?.cam && !args.cam) q.set('cam', views[0].cam);
  if (views[0]?.ll && !args.ll && !views[0]?.cam) q.set('ll', views[0].ll);
}
const url = `${base}?${q.toString()}${args.extra || ''}`;
const t0 = Date.now();
let exitCode = 0;
try {
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__city?.isReady?.(), null, { timeout: +(args.wait || 240000), polling: 500 });
  const states = await page.evaluate(() => window.__city.states.map((s) => `${s.id}:${s.status}${s.ms !== undefined ? `(${s.ms}ms)` : ''}${s.error ? ` ERROR ${s.error.split('\n')[0]}` : ''}`));
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s  modules: ${states.join('  ')}`);
  if (args.eval) console.log('eval ->', await page.evaluate(args.eval));
  const settle = +(args.settle || 1500);
  const capture = async (file) => {
    await page.evaluate(() => window.__city.ctx.settle());
    await page.waitForTimeout(settle);
    // wait for a couple of real frames
    await page.evaluate(() => new Promise((r) => { const c = window.__city.ctx; const f = c.frame; const off = c.events.on('frame', (n) => { if (n - f >= 2) { off(); r(); } }); }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    const info = await page.evaluate(() => {
      const r = window.__city.ctx.renderer.info;
      const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
      return { calls: r.render.calls, triangles: r.render.triangles, points: r.render.points, lines: r.render.lines,
        geometries: r.memory.geometries, textures: r.memory.textures, programs: r.programs?.length, heapMB: heap };
    });
    console.log('saved', file, JSON.stringify(info));
  };
  if (views) {
    const dir = args.dir || 'tools/shots';
    for (const v of views) {
      await page.evaluate((v) => {
        const c = window.__city;
        if (v.time !== undefined) c.setTime(+v.time);
        if (v.cam) { const a = v.cam.split(',').map(Number); c.setCamera(a[0], a[1], a[2], a[3] ?? 0, a[4] ?? -20); }
        else if (v.xz) {
          const g = c.ctx.heightfield.sample(v.xz[0], v.xz[1]);
          c.setCamera(v.xz[0], g + (v.agl ?? 100), v.xz[1], v.heading ?? 0, v.pitch ?? -20);
        } else if (v.ll) {
          const a = v.ll.split(',').map(Number);
          const ctx = c.ctx;
          // geographic -> world via the app's projection
          const p = c.lonLatToWorld ? c.lonLatToWorld(a[0], a[1]) : null;
          if (p) { const g = ctx.heightfield.sample(p.x, p.z); c.setCamera(p.x, g + (a[2] ?? 300), p.z, a[3] ?? 0, a[4] ?? -20); }
        }
      }, v);
      await capture(path.join(dir, `${v.name}.png`));
    }
  } else {
    await capture(args.out || 'tools/shots/shot.png');
  }
} catch (e) {
  console.error('FAILED:', e.message);
  try { await page.screenshot({ path: args.out || 'tools/shots/failed.png' }); } catch { /* ignore */ }
  exitCode = 1;
}
const uniq = [...new Set(logs)];
if (uniq.length) console.log('--- browser console (' + uniq.length + ') ---\n' + uniq.slice(0, 60).join('\n'));
await browser.close();
if (server) await server.close();
process.exit(exitCode);
