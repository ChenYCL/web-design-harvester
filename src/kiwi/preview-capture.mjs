/**
 * Pipeline C — Preview bundle capture (works on UNPUBLISHED sites).
 *
 * Why this exists
 * ---------------
 * Published Figma Sites and the editor's Preview iframe run the *same*
 * renderer (`SitesRuntime`). Only the data source differs:
 *
 *   published : defaultGetPage() -> fetch(`/_json/${bundleId}${route}.json`)
 *   preview   : getPage()        -> sendMessage('getPage') over a MessagePort
 *                                   -> { website, cmsBundle }
 *
 * `website` has the same shape as a published `_index.json`, plus extra keys
 * the published bundle never exposes (`compiledCode`, `globalStyles`,
 * `codeFilesystemMetadata`). Capture it and you can feed it straight back into
 * the real runtime in `env:'published'` mode — byte-identical rendering,
 * without the site ever being published.
 *
 * Unpublished binary assets never touch a public CDN either. The editor pushes
 * them to the preview as `pushAssetData` messages carrying real `Blob`s
 * (one per asset, keyed by `<sha1>.<ext>`), which the preview's Service Worker
 * then serves from an in-memory path->URL map. We intercept the same Blobs.
 *
 * Hook point
 * ----------
 * `MessagePort.prototype.postMessage` **in the top-level editor page**.
 * The editor is the sender for both `getPage` replies and `pushAssetData`, and
 * unlike the preview iframe (an OOPIF, where `Page.reload` is rejected with
 * "Command can only be executed on top-level targets") the editor tab can be
 * reloaded, so the hook can be installed before any traffic flows.
 *
 * Usage
 * -----
 *   node --experimental-websocket src/kiwi/preview-capture.mjs <fileKey> [outDir]
 *
 * Requires Chrome started with --remote-debugging-port=9222, logged into Figma.
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const FILE_KEY = process.argv[2] || process.env.FIGMA_FILE_KEY;
const OUT_DIR = process.argv[3] || 'rehearsal/preview-capture';
const SETTLE_MS = Number(process.env.SETTLE_MS || 24000);
const PREVIEW_MS = Number(process.env.PREVIEW_MS || 32000);

if (!FILE_KEY) {
  console.error('usage: preview-capture.mjs <fileKey> [outDir]');
  process.exit(1);
}

/** Injected into the editor before any of its own scripts run. */
export const EDITOR_HOOK_SRC = `
(() => {
  if (window.__FSE_PREVIEW_CAP__) return;
  window.__FSE_PREVIEW_CAP__ = { methods: {}, blobs: 0, bundles: 0 };
  window.__FSE_BUNDLES__ = {};   // route -> JSON string
  window.__FSE_BLOBS__   = {};   // "<sha1>.<ext>" -> Blob
  const P = MessagePort.prototype;
  const origPost = P.postMessage;
  P.postMessage = function (msg) {
    try {
      const d = (msg && msg.data !== undefined) ? msg.data : msg;
      if (d && typeof d === 'object') {
        if (d.method) {
          window.__FSE_PREVIEW_CAP__.methods[d.method] =
            (window.__FSE_PREVIEW_CAP__.methods[d.method] || 0) + 1;
        }
        // getPage reply: { method:'getPage', messageId, return:{ website, cmsBundle } }
        const ret = d.return;
        if (ret && ret.website && ret.website.nodeById) {
          const route = (d.args && d.args.url) || window.__FSE_LAST_ROUTE__ || '/';
          window.__FSE_BUNDLES__[route] = JSON.stringify(ret.website);
          if (ret.cmsBundle) window.__FSE_CMS__ = JSON.stringify(ret.cmsBundle);
          window.__FSE_PREVIEW_CAP__.bundles = Object.keys(window.__FSE_BUNDLES__).length;
        }
        if (d.method === 'getPage' && d.args && d.args.url) {
          window.__FSE_LAST_ROUTE__ = d.args.url;
        }
        // pushAssetData: { method:'pushAssetData', args:{ files: { name: Blob } } }
        if (d.method === 'pushAssetData' && d.args && d.args.files) {
          for (const [name, val] of Object.entries(d.args.files)) {
            window.__FSE_BLOBS__[name] = val;
            window.__FSE_PREVIEW_CAP__.blobs++;
          }
        }
      }
    } catch (e) { /* never break the editor */ }
    return origPost.apply(this, arguments);
  };
})();
`;

/** Async, run after the preview has rendered: Blob -> base64 (Blobs need await). */
export const BLOB_DRAIN_SRC = `(async () => {
  const out = {};
  for (const [name, b] of Object.entries(window.__FSE_BLOBS__ || {})) {
    try {
      const u8 = new Uint8Array(await b.arrayBuffer());
      let s = ''; const CH = 0x8000;
      for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      out[name] = { b64: btoa(s), type: b.type, size: b.size };
    } catch (e) { out[name] = { err: String(e).slice(0, 120) }; }
  }
  window.__FSE_ASSETJSON__ = JSON.stringify(out);
  return Object.keys(out).length;
})()`;

// ------------------------------------------------------------------ CDP ----

function getWebSocket() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  throw new Error('WebSocket unavailable — use Node 22+ or --experimental-websocket');
}

async function connectEditor(fileKey) {
  const targets = await fetch(`${CDP_HTTP}/json`).then((r) => r.json());
  const tab = targets.find((t) => t.type === 'page' && (t.url || '').includes(fileKey));
  if (!tab) {
    throw new Error(
      `no Chrome tab for ${fileKey} — open the file with --remote-debugging-port=9222`,
    );
  }
  const ws = new (getWebSocket())(tab.webSocketDebuggerUrl);
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
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  };
  return { cdp, evaluate, close: () => ws.close(), url: tab.url };
}

/** Pull a large page-world string out in chunks (returnByValue chokes on MBs). */
async function pullString(evaluate, expr, step = 250_000) {
  const size = await evaluate(`(${expr}) ? (${expr}).length : 0`);
  if (!size) return '';
  let out = '';
  for (let i = 0; i < size; i += step) {
    out += await evaluate(`(${expr}).slice(${i}, ${i + step})`);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function capturePreview({ fileKey, outDir }) {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(path.join(outDir, 'assets'), { recursive: true });

  const ed = await connectEditor(fileKey);
  console.error('[preview-capture] editor:', ed.url.slice(0, 90));

  await ed.cdp('Page.enable', {});
  await ed.cdp('Runtime.enable', {});
  await ed.cdp('Page.addScriptToEvaluateOnNewDocument', { source: EDITOR_HOOK_SRC });
  console.error('[preview-capture] hook armed, reloading editor…');
  await ed.cdp('Page.reload', {});
  await sleep(SETTLE_MS);

  const clicked = await ed.evaluate(`(() => {
    const b = [...document.querySelectorAll('button,[role="button"]')]
      .find(x => (x.getAttribute('data-testid') || '') === 'present-sites-full-preview')
      || [...document.querySelectorAll('button,[role="button"]')]
        .find(x => /full preview/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.innerText || '')));
    if (!b) return 'not-found';
    b.click(); return 'clicked';
  })()`);
  console.error('[preview-capture] full preview:', clicked);
  if (clicked === 'not-found') throw new Error('Full preview control not found in editor UI');
  await sleep(PREVIEW_MS);

  const stats = await ed.evaluate(`JSON.stringify(window.__FSE_PREVIEW_CAP__ || {})`);
  console.error('[preview-capture] traffic:', stats);

  const routes = JSON.parse(
    (await ed.evaluate(`JSON.stringify(Object.keys(window.__FSE_BUNDLES__ || {}))`)) || '[]',
  );
  if (!routes.length) throw new Error('no getPage bundle captured — preview did not render');

  const bundles = {};
  for (const route of routes) {
    const json = await pullString(ed.evaluate, `window.__FSE_BUNDLES__[${JSON.stringify(route)}]`);
    bundles[route] = JSON.parse(json);
    const file = path.join(outDir, `bundle${route === '/' ? '_index' : route.replace(/\//g, '_')}.json`);
    writeFileSync(file, json);
    console.error(`[preview-capture] route ${route}: ${Object.keys(bundles[route].nodeById).length} nodes -> ${path.basename(file)}`);
  }

  const blobCount = await ed.evaluate(BLOB_DRAIN_SRC, true);
  console.error('[preview-capture] draining', blobCount, 'asset blobs…');
  const assetJson = await pullString(ed.evaluate, 'window.__FSE_ASSETJSON__');
  const assetMap = assetJson ? JSON.parse(assetJson) : {};
  const assetMeta = {};
  let written = 0;
  let bytes = 0;
  for (const [name, v] of Object.entries(assetMap)) {
    if (!v.b64) continue;
    const buf = Buffer.from(v.b64, 'base64');
    writeFileSync(path.join(outDir, 'assets', name), buf);
    assetMeta[name] = { type: v.type, size: buf.length };
    written++;
    bytes += buf.length;
  }
  console.error(`[preview-capture] assets: ${written} files, ${bytes} bytes`);

  const primary = bundles['/'] || bundles[routes[0]];
  const meta = {
    fileKey,
    capturedAt: new Date().toISOString(),
    editorUrl: ed.url,
    routes,
    guidToUrl: primary.guidToUrl || null,
    nodeCount: Object.keys(primary.nodeById || {}).length,
    sourceCodeHash: primary.sourceCodeHash || null,
    siteSettings: primary.siteSettings || null,
    hasCompiledCode: !!primary.compiledCode,
    hasGlobalStyles: !!primary.globalStyles,
    assets: assetMeta,
    traffic: JSON.parse(stats || '{}'),
  };
  writeFileSync(path.join(outDir, 'capture-meta.json'), JSON.stringify(meta, null, 2));
  ed.close();
  console.error('[preview-capture] done ->', outDir);
  return meta;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  capturePreview({ fileKey: FILE_KEY, outDir: OUT_DIR }).catch((e) => {
    console.error('[preview-capture:FAIL]', e?.stack || e);
    process.exit(1);
  });
}
