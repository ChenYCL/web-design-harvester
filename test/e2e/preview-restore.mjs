#!/usr/bin/env node
/**
 * E2E: Preview iframe screenshot → capture/restore site/ → pixel-diff.
 *
 * Requires:
 *   - Chrome with --remote-debugging-port=9222, Sites file + Full preview open
 *   - npm i (playwright, pixelmatch, pngjs)
 *
 *   npm run test:e2e:preview
 *   CDP_HTTP=http://127.0.0.1:9222 MAX_DIFF_PCT=8 npm run test:e2e:preview
 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'rehearsal/e2e');
const CDP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const MAX_DIFF_PCT = Number(process.env.MAX_DIFF_PCT || 8);
const BRAND = process.env.E2E_BRAND || ''; // distinctive copy from the site, e.g. its brand name
const VIEW_W = Number(process.env.VIEW_W || 1440);
const VIEW_H = Number(process.env.VIEW_H || 900);

mkdirSync(OUT, { recursive: true });

function log(...a) {
  console.error('[e2e]', ...a);
}

function fail(msg) {
  console.error('[e2e:FAIL]', msg);
  process.exit(1);
}

async function serveDir(dir, port = 8791) {
  const server = createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(dir, p.replace(/^\//, ''));
      if (!file.startsWith(dir) || !existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${port}` };
}

function comparePng(aPath, bPath, diffPath) {
  const a = PNG.sync.read(readFileSync(aPath));
  const b = PNG.sync.read(readFileSync(bPath));
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  // crop both to common size
  const ac = new PNG({ width: w, height: h });
  const bc = new PNG({ width: w, height: h });
  PNG.bitblt(a, ac, 0, 0, w, h, 0, 0);
  PNG.bitblt(b, bc, 0, 0, w, h, 0, 0);
  const diff = new PNG({ width: w, height: h });
  const mismatch = pixelmatch(ac.data, bc.data, diff.data, w, h, {
    threshold: 0.12,
    includeAA: true,
  });
  writeFileSync(diffPath, PNG.sync.write(diff));
  const pct = (mismatch / (w * h)) * 100;
  return { mismatch, pct, w, h };
}

/** Capture via window stash + chunked CDP reads (avoids huge returnByValue). */
async function captureFrameToSite(frame, siteDir) {
  mkdirSync(path.join(siteDir, 'assets'), { recursive: true });

  await frame.evaluate(() => {
    const ABS = /url\(["']?([^"')]+)["']?\)/gi;
    const add = (set, u) => {
      if (!u) return;
      try {
        const abs = new URL(u, location.href).href;
        if (/^https?:/i.test(abs)) set.add(abs);
      } catch {}
    };
    const urls = new Set();
    for (const el of document.querySelectorAll('img,video,source,audio')) {
      add(urls, el.currentSrc || el.src);
      if (el.srcset) for (const part of el.srcset.split(',')) add(urls, part.trim().split(/\s+/)[0]);
      if (el.poster) add(urls, el.poster);
    }
    for (const el of document.querySelectorAll('[style]')) {
      const s = el.getAttribute('style') || '';
      let m;
      ABS.lastIndex = 0;
      while ((m = ABS.exec(s))) add(urls, m[1]);
    }
    const chunks = [];
    for (const sheet of Array.from(document.styleSheets || [])) {
      try {
        for (const rule of Array.from(sheet.cssRules || [])) chunks.push(rule.cssText);
      } catch {
        if (sheet.href) add(urls, sheet.href);
      }
    }
    for (const st of document.querySelectorAll('style')) chunks.push(st.textContent || '');
    try {
      for (const e of performance.getEntriesByType('resource')) {
        const n = e.name || '';
        if (/\.(png|jpe?g|gif|webp|svg|mp4|webm|woff2?)(\?|$)/i.test(n) || /figma\.com\/img\//i.test(n))
          add(urls, n);
      }
    } catch {}

    // Cap assets for E2E speed/stability
    const list = [...urls].slice(0, 60);
    const assets = list.map((url, i) => {
      const extMatch = url.match(/\.(png|jpe?g|gif|webp|svg|mp4|webm|woff2?|css)(\?|$)/i);
      const ext = (extMatch ? extMatch[1] : 'bin').toLowerCase().replace('jpeg', 'jpg');
      return { url, path: `assets/${String(i).padStart(4, '0')}.${ext}` };
    });
    const map = Object.fromEntries(assets.map((a) => [a.url, a.path]));
    let css = chunks.join('\n');
    for (const [from, to] of Object.entries(map)) css = css.split(from).join(to);

    // Inline computed styles — Figma Sites CSSOM is often opaque/cross-origin.
    const STYLE_PROPS = [
      'display','position','top','right','bottom','left','z-index',
      'width','height','min-width','min-height','max-width','max-height',
      'margin','padding','box-sizing','overflow','overflow-x','overflow-y',
      'flex','flex-direction','flex-wrap','justify-content','align-items','align-self','gap','row-gap','column-gap','flex-grow','flex-shrink','flex-basis','order',
      'grid-template-columns','grid-template-rows','grid-area',
      'font','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','color','white-space','text-overflow',
      'background','background-color','background-image','background-size','background-position','background-repeat',
      'border','border-radius','box-shadow','opacity','transform','transform-origin','filter','backdrop-filter',
      'object-fit','object-position','visibility','pointer-events','cursor',
    ];
    const origNodes = [document.documentElement, ...document.querySelectorAll('body, body *')];
    const styleMap = new Map();
    const lim = Math.min(origNodes.length, 4000);
    for (let i = 0; i < lim; i++) {
      const el = origNodes[i];
      if (!(el instanceof Element)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const parts = [];
      for (const p of STYLE_PROPS) {
        const v = cs.getPropertyValue(p);
        if (!v || v === 'none' || v === 'normal' || v === 'auto' || v === 'static' || v === 'visible' || v === 'rgba(0, 0, 0, 0)') continue;
        parts.push(`${p}:${v}`);
      }
      if (parts.length) styleMap.set(el, parts.join(';'));
    }

    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script').forEach((s) => s.remove());
    clone.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());
    // Pair by tree order, but skip removed script nodes already stripped from clone
    const cloneNodes = [clone, ...clone.querySelectorAll('body, body *')];
    let ci = 0;
    for (let i = 0; i < origNodes.length && ci < cloneNodes.length; i++) {
      const o = origNodes[i];
      if (!(o instanceof Element)) continue;
      if (o.tagName === 'SCRIPT' || o.tagName === 'LINK') continue;
      const c = cloneNodes[ci++];
      const st = styleMap.get(o);
      if (st && c instanceof Element) {
        const prev = c.getAttribute('style') || '';
        c.setAttribute('style', prev ? prev + ';' + st : st);
      }
    }
    const mapAttr = (el, attr) => {
      const v = el.getAttribute(attr);
      if (!v) return;
      try {
        const abs = new URL(v, location.href).href;
        if (map[abs]) el.setAttribute(attr, map[abs]);
        else if (map[v]) el.setAttribute(attr, map[v]);
      } catch {}
    };
    clone.querySelectorAll('img,video,source,audio').forEach((el) => {
      mapAttr(el, 'src');
      mapAttr(el, 'poster');
      el.removeAttribute('srcset');
    });
    const head = clone.querySelector('head') || clone;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'styles.css';
    head.appendChild(link);
    let html = '<!doctype html>\n' + clone.outerHTML;
    for (const [from, to] of Object.entries(map)) html = html.split(from).join(to);

    window.__FSE_E2E_CAP__ = {
      title: document.title,
      href: location.href,
      css: `html,body{margin:0;padding:0;min-height:100%;}\n` + css,
      html,
      assets,
    };
    return {
      htmlBytes: html.length,
      cssBytes: css.length,
      assetCount: assets.length,
    };
  });

  const meta = await frame.evaluate(() => {
    const c = window.__FSE_E2E_CAP__;
    if (!c) return null;
    return { title: c.title, href: c.href, htmlBytes: c.html.length, cssBytes: c.css.length, assets: c.assets };
  });
  if (!meta) throw new Error('capture stash missing');

  const pull = async (key) => {
    const size = await frame.evaluate((k) => window.__FSE_E2E_CAP__[k].length, key);
    const step = 200000;
    let out = '';
    for (let i = 0; i < size; i += step) {
      out += await frame.evaluate(
        ({ k, i, step }) => window.__FSE_E2E_CAP__[k].slice(i, i + step),
        { k: key, i, step },
      );
    }
    return out;
  };

  const html = await pull('html');
  const css = await pull('css');
  log('pulled html', html.length, 'css', css.length);

  let ok = 0;
  for (const a of meta.assets || []) {
    try {
      const res = await fetch(a.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path.join(siteDir, a.path), buf);
      ok++;
    } catch {
      /* skip */
    }
  }
  writeFileSync(path.join(siteDir, 'index.html'), html);
  writeFileSync(path.join(siteDir, 'styles.css'), css || '');
  writeFileSync(
    path.join(siteDir, 'meta.json'),
    JSON.stringify({ title: meta.title, href: meta.href, assetOk: ok, assetTotal: meta.assets?.length || 0 }, null, 2),
  );
  return { html, css, assets: meta.assets, assetOk: ok };
}

/** Attach to OOPIF preview via browser WS + Target.attachToTarget(flatten). */
async function attachPreviewViaCdp() {
  const targets = await fetch(`${CDP}/json/list`).then((r) => r.json());
  const preview = targets.find(
    (t) =>
      (t.type === 'iframe' || t.type === 'page') &&
      /figmaiframepreview\.figma\.site/i.test(t.url || ''),
  );
  if (!preview?.id) return null;

  const ver = await fetch(`${CDP}/json/version`).then((r) => r.json());
  const WS = globalThis.WebSocket;
  if (!WS) throw new Error('WebSocket unavailable — use Node 22+ or --experimental-websocket');

  const ws = new WS(ver.webSocketDebuggerUrl);
  const on = (ev, fn) => ws.addEventListener(ev, fn);
  await new Promise((res, rej) => {
    on('open', res);
    on('error', rej);
  });

  let id = 1;
  const pending = new Map();
  on('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });

  const cdp = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const i = id++;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const att = await cdp('Target.attachToTarget', { targetId: preview.id, flatten: true });
  const sessionId = att.sessionId;
  await cdp('Runtime.enable', {}, sessionId);
  // Avoid Page.enable on some OOPIF targets ("top-level only"); screenshot via parent element instead.

  return {
    url: preview.url,
    targetId: preview.id,
    sessionId,
    async evaluate(fn, arg) {
      const expression =
        typeof fn === 'string'
          ? fn
          : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
      const r = await cdp(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
      }
      return r.result?.value;
    },
    async screenshotPng(filePath) {
      // Try Page.captureScreenshot on session; fall back handled by caller.
      try {
        const r = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
        writeFileSync(filePath, Buffer.from(r.data, 'base64'));
        return true;
      } catch {
        return false;
      }
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}

async function main() {
  log('CDP', CDP);
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  if (!context) fail('no browser context on CDP');

  const page =
    context.pages().find((p) => /figma\.com\/(site|make|design)\//.test(p.url()) && p.url().includes(process.env.FIGMA_FILE_KEY || '')) ||
    context.pages().find((p) => /figma\.com\/(site|make|design)\//.test(p.url()));
  if (!page) fail('No Figma Sites/Design tab open — open the file and Full preview first');

  log('page', page.url());
  await page.bringToFront();

  // Ensure preview exists in CDP target list
  let preview = await attachPreviewViaCdp();
  if (!preview) {
    log('no preview target — clicking Full preview');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button,[role="button"]')];
      const b = btns.find((x) => /full preview/i.test(x.getAttribute('aria-label') || ''));
      b?.click();
    });
    await page.waitForTimeout(8000);
    preview = await attachPreviewViaCdp();
  }
  if (!preview) fail('Preview iframe CDP target not found — open Full preview');

  const shell = await preview.evaluate(() => {
    const t = (document.body?.innerText || '').slice(0, 80);
    return /messagePort|allowedOrigins/.test(t) && document.querySelectorAll('body *').length < 20;
  });
  if (shell) fail('Preview iframe is still the empty shell — wait for init');

  log('preview', preview.url);
  await preview.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);

  const refPath = path.join(OUT, 'ref-iframe.png');
  let shotOk = await preview.screenshotPng(refPath);
  if (!shotOk) {
    log('CDP Page.screenshot failed — using element screenshot of #rendered-site');
    const handle =
      (await page.$('#rendered-site')) ||
      (await page.$('iframe[data-testid="site-preview-iframe"]'));
    if (!handle) fail('cannot find #rendered-site for screenshot fallback');
    await handle.screenshot({ path: refPath, type: 'png' });
  }
  log('wrote', refPath);

  // Capture using the same evaluate body via a thin Playwright-less adapter
  const siteDir = path.join(OUT, 'site');
  rmSync(siteDir, { recursive: true, force: true });
  mkdirSync(siteDir, { recursive: true });

  // Reuse captureFrameToSite by wrapping CDP evaluate as Playwright-like frame
  const frameLike = {
    evaluate: (fn, arg) => preview.evaluate(fn, arg),
    url: () => preview.url,
  };
  const cap = await captureFrameToSite(frameLike, siteDir);
  log('captured html', cap.html.length, 'assets ok', cap.assetOk, '/', cap.assets?.length || 0);

  const { server, url } = await serveDir(siteDir, 8791);
  log('serving', url);

  const restore = await context.newPage();
  await restore.setViewportSize({ width: VIEW_W, height: VIEW_H });
  await restore.goto(url + '/', { waitUntil: 'networkidle', timeout: 60000 }).catch(async () => {
    await restore.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  });
  await restore.waitForTimeout(1500);
  await restore.evaluate(() => window.scrollTo(0, 0));
  const restoredPath = path.join(OUT, 'restored-site.png');
  await restore.screenshot({ path: restoredPath, type: 'png', fullPage: false });
  log('wrote', restoredPath);

  const diffPath = path.join(OUT, 'diff.png');
  const { mismatch, pct, w, h } = comparePng(refPath, restoredPath, diffPath);

  const restoredHtml = readFileSync(path.join(siteDir, 'index.html'), 'utf8');
  const structural = {
    htmlBytes: restoredHtml.length,
    hasBrand: !BRAND ? true : new RegExp(BRAND, 'i').test(restoredHtml),
    assetsOk: cap.assetOk,
    assetsTotal: cap.assets?.length || 0,
  };
  const structuralOk =
    structural.htmlBytes > 50000 && structural.hasBrand && structural.assetsOk >= 5;
  const visualOk = pct <= MAX_DIFF_PCT;

  const report = {
    ok: structuralOk && visualOk,
    structuralOk,
    visualOk,
    maxDiffPct: MAX_DIFF_PCT,
    diffPct: Number(pct.toFixed(3)),
    mismatch,
    size: { w, h },
    structural,
    ref: refPath,
    restored: restoredPath,
    diff: diffPath,
    previewUrl: preview.url,
    editorUrl: page.url(),
    note:
      'Visual pixel parity with Figma Sites runtime is hard (opaque CSSOM). ' +
      'structuralOk means restore produced a real page; visualOk is the strict iframe match gate.',
  };
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log('diff', `${pct.toFixed(2)}%`, 'threshold', MAX_DIFF_PCT, 'structuralOk', structuralOk);

  preview.close();
  await restore.close();
  server.close();
  await browser.close();

  console.log(JSON.stringify(report, null, 2));
  if (!structuralOk) fail('structural restore checks failed — see report.json');
  if (!visualOk) {
    // Soft-fail visual while capture fidelity is still being improved: exit 2
    console.error(
      `[e2e:VISUAL] mismatch ${pct.toFixed(2)}% > ${MAX_DIFF_PCT}% — see ${diffPath}`,
    );
    process.exit(2);
  }
  log('PASS');
}

main().catch((e) => fail(e?.stack || e));
