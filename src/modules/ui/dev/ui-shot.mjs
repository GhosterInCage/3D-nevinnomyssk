#!/usr/bin/env node
// UI screenshot harness (NOT shot mode, so the overlay is visible).
//
//   node src/modules/ui/dev/ui-shot.mjs --out tools/shots/ui/desktop.png
//   node src/modules/ui/dev/ui-shot.mjs --mobile --out tools/shots/ui/mobile.png
//   node src/modules/ui/dev/ui-shot.mjs --only terrain,sky,ui --steps '[{"eval":"__ui.search.focus()","out":"a.png"}]' --dir tools/shots/ui
//
// Options: --w/--h viewport, --mobile (390x844, touch, DPR 2), --only/--skip, --cam x,y,z,h,p, --time H,
//          --quality (default low), --extra "&k=v", --eval js (after ready), --settle ms, --steps JSON [{eval, settle, out}],
//          --dir output dir for steps, --url existing server, --lang ru|en, --wait ms (default 900000)
// Step fields (all optional, applied in this order): eval (JS), type (text), press (key), click [x,y], tap [x,y],
//          until (JS expression polled until truthy, e.g. "!__ui.flight.active"), settle (ms), out (png)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
    args[k] = v;
  }
}
const mobile = args.mobile === 'true';
const W = +(args.w || (mobile ? 390 : 1280)), H = +(args.h || (mobile ? 844 : 720));

let server = null;
let base = args.url;
if (!base) {
  const { createServer } = await import('vite');
  server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}/`;
}

function exe() {
  const p = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
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
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox', '--no-sandbox', '--js-flags=--max-old-space-size=8192'],
});
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
  locale: args.lang === 'en' ? 'en-US' : 'ru-RU',
  userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined,
});
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning' || args.verbose) logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack || e.message}`));

const q = new URLSearchParams();
q.set('quality', args.quality || 'low');
q.set('intro', args.intro || '0');
if (args.only) q.set('only', args.only);
if (args.skip) q.set('skip', args.skip);
if (args.cam) q.set('cam', args.cam);
if (args.time) q.set('time', args.time);
if (args.lang) q.set('lang', args.lang);
const url = `${base}?${q.toString()}${args.extra || ''}`;
const t0 = Date.now();
let code = 0;
try {
  if (args['loading-shot']) {
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(+(args['loading-wait'] || 6000));
    fs.mkdirSync(path.dirname(args['loading-shot']), { recursive: true });
    await page.screenshot({ path: args['loading-shot'], timeout: 180000 });
    console.log('saved', args['loading-shot']);
    if (args['loading-only']) throw new Error('loading-only: done');
  } else {
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  }
  await page.waitForFunction(() => window.__city?.isReady?.(), null, { timeout: +(args.wait || 900000), polling: 1000 });
  const states = await page.evaluate(() => window.__city.states.map((s) => `${s.id}:${s.status}${s.ms !== undefined ? `(${s.ms}ms)` : ''}${s.error ? ` ERROR ${s.error.split('\n')[0]}` : ''}`));
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s  modules: ${states.join('  ')}`);
  await page.waitForTimeout(1500);
  const steps = args.steps ? JSON.parse(args.steps) : [{ eval: args.eval, settle: +(args.settle || 2500), out: args.out || 'tools/shots/ui/ui.png' }];
  for (const s of steps) {
    if (s.eval) {
      const r = await page.evaluate(s.eval);
      if (r !== undefined) console.log('eval ->', typeof r === 'string' ? r : JSON.stringify(r));
    }
    if (s.type) await page.keyboard.type(s.type, { delay: 60 });
    if (s.press) await page.keyboard.press(s.press);
    if (s.click) await page.mouse.click(s.click[0], s.click[1]);
    if (s.tap) await page.touchscreen.tap(s.tap[0], s.tap[1]);
    if (s.until) {
      const tu = Date.now();
      await page.waitForFunction(s.until, null, { timeout: 600000, polling: 500 });
      console.log(`until ${s.until}: ${((Date.now() - tu) / 1000).toFixed(1)}s`);
    }
    await page.waitForTimeout(s.settle ?? 2500);
    // let a couple of frames render
    await page.evaluate(() => new Promise((r) => { const c = window.__city.ctx; const f = c.frame; const off = c.events.on('frame', (n) => { if (n - f >= 2) { off(); r(); } }); }));
    if (s.out) {
      const file = args.dir ? path.join(args.dir, s.out) : s.out;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // SwiftShader frames are slow: freeze the render loop so the compositor can capture the page
      const ft = await page.evaluate(() => { const c = window.__city.ctx; c.renderer.setAnimationLoop(null); return c.frame; });
      await page.waitForTimeout(300);
      try {
        await page.screenshot({ path: file, timeout: 180000 });
      } catch (e) {
        // SwiftShader under heavy machine load: give the compositor more time and retry once
        console.log('screenshot timed out, retrying', file);
        await page.waitForTimeout(5000);
        await page.screenshot({ path: file, timeout: 300000 });
      }
      await page.evaluate(() => window.__city.ctx.start());
      console.log('saved', file, 'frame', ft);
    }
  }
} catch (e) {
  console.error('FAILED:', e.message);
  code = 1;
  try {
    const st = await page.evaluate(() => (window.__city?.states ?? []).map((s) => `${s.id}:${s.status}`).join(' '));
    console.error('module states:', st);
  } catch { /* ignore */ }
  try { fs.mkdirSync(path.join(root, 'tools/shots/ui'), { recursive: true }); await page.screenshot({ path: path.join(root, 'tools/shots/ui/failed.png'), timeout: 60000 }); } catch { /* ignore */ }
}
const uniq = [...new Set(logs)];
if (uniq.length) console.log(`--- browser console (${uniq.length}) ---\n${uniq.slice(0, 50).join('\n')}`);
await browser.close();
if (server) await server.close();
process.exit(code);
