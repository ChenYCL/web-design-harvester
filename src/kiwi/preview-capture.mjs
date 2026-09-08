/**
 * Pipeline C — deterministic multi-route preview bundle capture.
 *
 * General method, no interactive probing:
 *
 *   1. Boot the editor with the capture hook armed (document_start).
 *   2. Capture the first getPage reply -> its guidToUrl enumerates EVERY route.
 *   3. For each route: restore the editor to that page via ?node-id=<guid>,
 *      reload (hook re-arms itself), wait for the Full-preview control by
 *      polling (no fixed sleeps), click, then poll for a bundle whose
 *      roots[0] === that route's guid. The bundle self-labels through
 *      guidToUrl — message replies carry no request args, so labels are
 *      derived from the data, never guessed.
 *   4. Drain this round's pushAssetData Blobs before the next reload.
 *   5. Every route's outcome lands in capture-meta.json: captured / failed,
 *      with reasons. Nothing is silently dropped.
 *
 * Two deterministic triggers are attempted per route: the Full-preview
 * control (data-testid present-sites-full-preview, aria-label fallback), then
 * the layers-panel row `<guid>-layers-panel-row` followed by Full preview.
 *
 * Requires Chrome with --remote-debugging-port=9222, logged into Figma,
 * the Sites file open.   node --experimental-websocket preview-capture.mjs <fileKey> [outDir]
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const ROUTE_FILTER = process.env.ROUTES || ''; // optional comma list, e.g. '/page-2,/'
const BOOT_SETTLE_MS = Number(process.env.BOOT_SETTLE_MS || 20000);
const RENDER_WAIT_MS = Number(process.env.RENDER_WAIT_MS || 35000);
const CONTROL_WAIT_MS = Number(process.env.CONTROL_WAIT_MS || 30000);
// A narrow window collapses the toolbar and hides the preview control behind an
// overflow menu, so pin a known size before touching the UI.
const WINDOW = { width: Number(process.env.WIN_W || 1600), height: Number(process.env.WIN_H || 1000) };
const POLL_STEP_MS = 1500;

const log = (...a) => console.error('[preview-capture]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Editor-side hook. Armed before document_start; survives reloads. */
const HOOK_SRC = `
(() => {
  if (window.__FSE_RT__) return;
  window.__FSE_RT__ = { got: 0, seen: [] };
  window.__FSE_ROUTE_BUNDLES__ = {};   // "<rootGuid>" -> JSON string
  window.__FSE_BLOBS__ = {};           // "<sha1>.<ext>" -> Blob
  const P = MessagePort.prototype, op = P.postMessage;
  P.postMessage = function (m) {
    try {
      const d = (m && m.data !== undefined) ? m.data : m;
      if (d && typeof d === 'object') {
        if (d.method) window.__FSE_RT__.seen.push(d.method);
        const ret = d.return;
        if (ret && ret.website && ret.website.nodeById && ret.website.roots) {
          window.__FSE_ROUTE_BUNDLES__[ret.website.roots[0]] = JSON.stringify(ret.website);
          window.__FSE_RT__.got++;
        }
        if (d.method === 'pushAssetData' && d.args && d.args.files) {
          for (const [n, v] of Object.entries(d.args.files)) window.__FSE_BLOBS__[n] = v;
        }
      }
    } catch (e) { /* never break the editor */ }
    return op.apply(this, arguments);
  };
  // Blob drain — must run outside the synchronous patch.
  window.__FSE_DRAIN__ = async () => {
    const out = {};
    for (const [name, b] of Object.entries(window.__FSE_BLOBS__ || {})) {
      try {
        const u8 = new Uint8Array(await b.arrayBuffer());
        let s = ''; const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        out[name] = { b64: btoa(s), type: b.type, size: b.size };
      } catch (e) { out[name] = { err: String(e).slice(0, 100) }; }
    }
    window.__FSE_BLOBJSON__ = JSON.stringify(out);
    return Object.keys(out).length;
  };
})();
`;

// ------------------------------------------------------------------ CDP ----

async function connect(fileKey) {
  const targets = await fetch(`${CDP_HTTP}/json`).then((r) => r.json());
  const tab = targets.find((t) => t.type === 'page' && (t.url || '').includes(fileKey));
  if (!tab) throw new Error(`no Chrome tab for ${fileKey} on ${CDP_HTTP}`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evl = async (expression, awaitPromise = false) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300));
    }
    return r.result?.value;
  };
  return { call, evl, url: tab.url, close: () => ws.close() };
}

async function pullString(evl, expr, step = 300_000) {
  const size = await evl(`(${expr}) ? (${expr}).length : 0`);
  if (!size) return '';
  let out = '';
  for (let i = 0; i < size; i += step) out += await evl(`(${expr}).slice(${i}, ${i + step})`);
  return out;
}

/** Poll a page expression until truthy or timeout. */
async function pollUntil(evl, expression, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await evl(expression);
      if (v) return v;
    } catch { /* transient */ }
    await sleep(POLL_STEP_MS);
  }
  return null;
}

/**
 * Locate the preview control. The testid only exists when the toolbar is wide
 * enough; in a narrow window the same control collapses to an icon whose only
 * marker is aria-label="Present". Match all known forms, and report which one
 * matched so a failure says why rather than just "not found".
 */
const FIND_PREVIEW = `(() => {
  const cands = [...document.querySelectorAll('button,[role="button"],a')];
  if (cands.some(x => (x.getAttribute('data-testid') || '') === 'present-sites-full-preview')) return 'testid';
  // "Present" alone is the multiplayer spotlight button in some UI states — it
  // is NOT the site preview, so only accept it when the Sites-specific testid
  // is absent AND the label mentions preview.
  if (cands.some(x => /full preview/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('title') || '')))) return 'aria';
  return '';
})()`;

const CLICK_FULL_PREVIEW = `(() => {
  const cands = [...document.querySelectorAll('button,[role="button"],a')];
  const b = cands.find(x => (x.getAttribute('data-testid') || '') === 'present-sites-full-preview')
    || cands.find(x => /full preview/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('title') || '')));
  if (!b) return false;
  b.click(); return true;
})()`;

/** Candidate dump used in error messages so failures are self-diagnosing. */
const DUMP_CONTROLS = `JSON.stringify([...document.querySelectorAll('button,[role="button"]')]
  .map(b => ({ t: b.getAttribute('data-testid') || '', a: b.getAttribute('aria-label') || '', x: (b.innerText||'').trim().slice(0,20) }))
  .filter(o => o.t || o.a || o.x).slice(0, 40))`;

const CLICK_ROW = (guid) => `(() => {
  const r = [...document.querySelectorAll('[data-testid*="layers-panel-row"]')]
    .find(x => (x.getAttribute('data-testid') || '').startsWith('${guid}'));
  if (!r) return false;
  r.scrollIntoView({ block: 'center' });
  r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  r.click(); return true;
})()`;

// --------------------------------------------------------------- capture --

async function captureRoute({ ed, editorUrl, guid, route }, outDir) {
  const nodeUrl = guid === null
    ? editorUrl.replace(/([?&])node-id=[^&]*/, '$1').replace(/\?$/, '')
    : `${editorUrl.replace(/([?&])node-id=[^&]*/, '').replace(/\?$/, '')}?node-id=${guid.replace(':', '-')}`;

  // Restore page + reload so the hook is guaranteed armed in a fresh document.
  await ed.evl(`location.href = ${JSON.stringify(nodeUrl)}`);
  await sleep(BOOT_SETTLE_MS);
  await ed.call('Page.reload', {});
  await sleep(BOOT_SETTLE_MS);

  const ready = await ed.evl(`typeof window.__FSE_RT__ === 'object'`);
  if (!ready) throw new Error('hook not armed after reload');

  // Wait for the preview control to mount — the editor renders its toolbar
  // asynchronously, so a single probe right after reload is a coin flip.
  const kind = await pollUntil(ed.evl, FIND_PREVIEW, CONTROL_WAIT_MS, 'preview control');
  if (!kind) {
    const dump = await ed.evl(DUMP_CONTROLS).catch(() => '[]');
    throw new Error(`preview control not found after ${CONTROL_WAIT_MS}ms; controls seen: ${String(dump).slice(0, 400)}`);
  }

  // Trigger 1: click it directly (the editor already restored to this page).
  let clicked = await ed.evl(CLICK_FULL_PREVIEW);
  if (!clicked && guid) {
    // Trigger 2: select the page row first, then click again.
    await ed.evl(CLICK_ROW(guid));
    await sleep(2500);
    clicked = await ed.evl(CLICK_FULL_PREVIEW);
  }
  if (!clicked) throw new Error(`preview control matched by ${kind} but did not click`);

  // Poll for a bundle whose root guid matches (self-verification, no guessing).
  // guid is already a JSON string literal here; index directly.
  const key = guid === null ? null : JSON.stringify(guid);
  const expr = key === null
    ? `Object.keys(window.__FSE_ROUTE_BUNDLES__ || {}).length > 0`
    : `!!(window.__FSE_ROUTE_BUNDLES__ || {})[${key}]`;
  const bundleExpr = key === null
    ? `Object.values(window.__FSE_ROUTE_BUNDLES__ || {})[0]`
    : `(window.__FSE_ROUTE_BUNDLES__ || {})[${key}]`;
  const ok = await pollUntil(ed.evl, expr, RENDER_WAIT_MS, `bundle for ${route}`);
  if (!ok) {
    // Distinguish "preview never opened" from "opened but no reply": if the
    // port saw no traffic at all, the click did not start a preview session.
    const seen = await ed.evl(`JSON.stringify([...new Set((window.__FSE_RT__||{}).seen||[])])`).catch(() => '[]');
    const hint = seen === '[]'
      ? 'port saw no messages — the control clicked was not the site preview'
      : `port traffic: ${seen}`;
    throw new Error(`no bundle within ${RENDER_WAIT_MS}ms (${hint})`);
  }

  const json = await pullString(ed.evl, bundleExpr);
  const bundle = JSON.parse(json);
  const root = bundle.roots[0];
  const selfLabel = (bundle.guidToUrl || {})[root] || route || '/';
  const file = selfLabel === '/' ? '_index' : selfLabel.replace(/^\//, '').replace(/\//g, '_');
  writeFileSync(path.join(outDir, `bundle_${file}.json`), json);

  // Drain this round's Blobs before the next reload wipes the page.
  const blobCount = await ed.evl(`window.__FSE_DRAIN__()`, true);
  const blobJson = await pullString(ed.evl, 'window.__FSE_BLOBJSON__');
  const blobs = blobJson ? JSON.parse(blobJson) : {};
  const assetsDir = path.join(outDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  let assetBytes = 0;
  for (const [name, v] of Object.entries(blobs)) {
    if (!v?.b64) continue;
    const buf = Buffer.from(v.b64, 'base64');
    writeFileSync(path.join(assetsDir, name), buf);
    assetBytes += buf.length;
  }

  return {
    route: selfLabel,
    rootGuid: root,
    requestedRoute: route || '(default)',
    nodes: Object.keys(bundle.nodeById || {}).length,
    bytes: json.length,
    sourceCodeHash: bundle.sourceCodeHash || null,
    hasCompiledCode: !!bundle.compiledCode,
    blobs: blobCount,
    assetBytes,
  };
}

/**
 * Transport-agnostic core. `ed` only needs { call, evl, url }, so the same
 * logic runs over a raw CDP WebSocket (fresh Chrome) or over an agent
 * browser's own CDP channel — whichever one actually has the editor UI that
 * exposes the preview control.
 */
export async function capturePreviewWith(ed, { fileKey, outDir }) {
  mkdirSync(outDir, { recursive: true });
  log('editor:', String(ed.url).slice(0, 90));

  await ed.call('Page.enable', {});
  await ed.call('Runtime.enable', {});
  try {
    const { windowId } = await ed.call('Browser.getWindowForTarget', {});
    await ed.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', ...WINDOW } });
    log(`window pinned to ${WINDOW.width}x${WINDOW.height}`);
  } catch (e) { log('window resize skipped:', String(e.message).slice(0, 60)); }
  await ed.call('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SRC });

  const filter = ROUTE_FILTER ? ROUTE_FILTER.split(',').map((s) => s.trim()) : null;

  // Route 0: whatever page the editor is on; its bundle enumerates the rest.
  const first = await captureRoute({ ed, editorUrl: ed.url.split('#')[0], guid: null, route: null }, outDir);
  log(`route ${first.route}: ${first.nodes} nodes`);
  const firstBundle = JSON.parse(
    (await import('fs')).readFileSync(path.join(outDir, `bundle_${first.route === '/' ? '_index' : first.route.replace(/^\//, '')}.json`), 'utf8'),
  );
  const routes = Object.entries(firstBundle.guidToUrl || {});
  log(`guidToUrl enumerates ${routes.length} routes`);

  const results = [first];
  const done = new Set([first.rootGuid]);
  for (const [guid, route] of routes) {
    if (done.has(guid)) continue;
    if (filter && !filter.includes(route)) continue;
    try {
      const r = await captureRoute({ ed, editorUrl: ed.url.split('#')[0], guid, route }, outDir);
      done.add(r.rootGuid);
      results.push(r);
      log(`route ${r.route}: ${r.nodes} nodes, ${r.blobs} blobs`);
    } catch (e) {
      results.push({ route, guid, failed: String(e.message || e) });
      log(`route ${route}: FAILED — ${e.message}`);
    }
  }

  // Summarise assets on disk.
  const assets = readdirSync(path.join(outDir, 'assets')).filter((f) => !f.startsWith('.'));
  const meta = {
    fileKey,
    capturedAt: new Date().toISOString(),
    editorUrl: ed.url,
    routes: results,
    okRoutes: results.filter((r) => !r.failed).length,
    failedRoutes: results.filter((r) => r.failed),
    assets: assets.length,
    note: 'Bundles self-label via roots→guidToUrl. Failures are recorded, never skipped silently.',
  };
  writeFileSync(path.join(outDir, 'capture-meta.json'), JSON.stringify(meta, null, 2));
  log(`done: ${meta.okRoutes}/${results.length} routes, ${assets.length} assets -> ${outDir}`);
  return meta;
}

/** Convenience wrapper: connect to a Chrome on CDP_HTTP, capture, disconnect. */
export async function capturePreview({ fileKey, outDir }) {
  const ed = await connect(fileKey);
  try {
    return await capturePreviewWith(ed, { fileKey, outDir });
  } finally {
    ed.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const FILE_KEY = process.argv[2] || process.env.FIGMA_FILE_KEY;
  const OUT_DIR = process.argv[3] || 'rehearsal/preview-capture';
  if (!FILE_KEY) { console.error('usage: preview-capture.mjs <fileKey> [outDir]'); process.exit(1); }
  capturePreview({ fileKey: FILE_KEY, outDir: OUT_DIR }).catch((e) => {
    console.error('[preview-capture:FAIL]', e?.stack || e);
    process.exit(1);
  });
}
