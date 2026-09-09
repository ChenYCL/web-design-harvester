/**
 * Isolated-world orchestrator for the preview capture.
 *
 * Two entry points, both additive to the existing Export ZIP flow:
 *
 *   CAPTURE_PREVIEW_BUNDLE   drain whatever the hook has seen on this page and
 *                            return it packed (single page, no navigation).
 *
 *   CAPTURE_ALL_ROUTES       the general method. Walks every route the site
 *                            declares, without knowing its layout in advance:
 *
 *     1. Make sure this page's bundle exists (open the preview if needed).
 *        Its guidToUrl enumerates every route, unpublished ones included.
 *     2. Persist a plan in sessionStorage and the captured data in IndexedDB —
 *        both survive the navigations that follow.
 *     3. For each route, navigate to ?node-id=<guid>. That is a full document
 *        load, so the document_start hook re-arms itself and this script runs
 *        again, sees the plan, and resumes.
 *     4. On resume: poll for the preview control, click it, wait for a
 *        PREVIEW_BUNDLE_CAPTURED event whose rootGuid is the one we asked for.
 *        The bundle labels itself from its own payload; nothing is guessed.
 *     5. Drain this page's Blobs into IndexedDB before moving on — a reload
 *        clears the MAIN-world store.
 *     6. When no routes remain: fetch videos (same-origin signed URLs), pack,
 *        ZIP, download. Every route's outcome is in preview-meta.json.
 */
(() => {
  if (window.__FSE_PREVIEW_BRIDGE__) return;
  window.__FSE_PREVIEW_BRIDGE__ = true;

  const PLAN_KEY = 'fse_walk_v1';
  const PLAN_TTL_MS = 30 * 60 * 1000;
  const CONTROL_WAIT_MS = 30_000;
  const BUNDLE_WAIT_MS = 60_000;
  const VIDEO_BUDGET = 600 * 1024 * 1024;

  const fileKey = () => (location.pathname.match(/\/(?:site|make|design|file)\/([a-zA-Z0-9]+)/) || [])[1] || null;
  const editorBase = () => location.origin + location.pathname;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ----------------------------------------------------------- progress ----

  async function progress(stage, message, extra = {}) {
    const p = { stage, message, at: Date.now(), ...extra };
    try { await chrome.storage.local.set({ fsePreviewWalk: p }); } catch { /* ignore */ }
    try { chrome.runtime.sendMessage({ type: 'PREVIEW_WALK_PROGRESS', progress: p }).catch(() => {}); } catch { /* ignore */ }
    console.log('[fse-preview]', stage, message);
  }

  // ---------------------------------------------------------- IndexedDB ----

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('fse-preview-walk', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('bundles')) db.createObjectStore('bundles');
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPut(store, key, value) {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  }
  async function idbAll(store) {
    const db = await idb();
    const out = await new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const os = tx.objectStore(store);
      const keys = os.getAllKeys(); const vals = os.getAll();
      tx.oncomplete = () => res(Object.fromEntries(keys.result.map((k, i) => [k, vals.result[i]])));
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    return out;
  }
  async function idbClear() {
    const db = await idb();
    await new Promise((res) => {
      const tx = db.transaction(['bundles', 'assets'], 'readwrite');
      tx.objectStore('bundles').clear(); tx.objectStore('assets').clear();
      tx.oncomplete = res; tx.onerror = res;
    });
    db.close();
  }

  // --------------------------------------------------------------- plan ----

  const loadPlan = () => { try { return JSON.parse(sessionStorage.getItem(PLAN_KEY) || 'null'); } catch { return null; } };
  const savePlan = (p) => sessionStorage.setItem(PLAN_KEY, JSON.stringify(p));
  const clearPlan = () => sessionStorage.removeItem(PLAN_KEY);

  // ------------------------------------------------------ MAIN-world I/O ----

  /** Pull the MAIN-world capture over chunked postMessage. */
  function drain(timeoutMs = 120_000) {
    return new Promise((resolve) => {
      const id = 'fse_drain_' + Math.random().toString(36).slice(2);
      const bundles = {}; let assetParts = ''; let begin = null;
      const done = (r) => { window.removeEventListener('message', onMsg); clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => done({ ok: false, error: 'drain timeout' }), timeoutMs);
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.source !== 'figma-sites-exporter' || d.id !== id) return;
        if (d.type === 'PREVIEW_DRAIN_ERROR') return done({ ok: false, error: d.error });
        if (d.type === 'PREVIEW_DRAIN_BEGIN') { begin = d; return; }
        if (d.type === 'PREVIEW_DRAIN_CHUNK') {
          if (d.kind === 'bundle') bundles[d.key] = (bundles[d.key] || '') + d.data;
          else assetParts += d.data;
          return;
        }
        if (d.type === 'PREVIEW_DRAIN_DONE') {
          let assets = {};
          try { assets = JSON.parse(assetParts || '{}'); } catch { /* keep */ }
          done({ ok: true, bundles, labels: begin?.labels || {}, assets, stats: begin?.stats || null });
        }
      };
      window.addEventListener('message', onMsg);
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('lib/drain-preview.js');
      s.dataset.fseId = id;
      s.onload = () => s.remove();
      s.onerror = () => done({ ok: false, error: 'failed to inject drain-preview.js' });
      (document.documentElement || document.head).appendChild(s);
    });
  }

  /** Resolve when the hook reports a bundle (optionally a specific root guid). */
  function waitForBundle(rootGuid, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, timeoutMs);
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.source !== 'figma-sites-exporter' || d.type !== 'PREVIEW_BUNDLE_CAPTURED') return;
        if (rootGuid && d.rootGuid !== rootGuid) return;
        clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(d);
      };
      window.addEventListener('message', onMsg);
    });
  }

  // ---------------------------------------------------- preview control ----

  /**
   * The Sites preview control. Wide toolbar: data-testid. Narrow window: the
   * testid is gone and only an aria/title mentioning "full preview" remains.
   * A bare aria-label="Present" is the multiplayer spotlight, NOT the preview.
   */
  function findPreviewControl() {
    const cands = [...document.querySelectorAll('button,[role="button"],a')];
    // Localised UIs may expose the control only through its visible text
    // (e.g. "打开 Full preview" with empty aria-label), so include innerText.
    const label = (x) =>
      [x.getAttribute('aria-label'), x.getAttribute('title'), x.innerText].map((v) => v || '').join(' ');
    // Never match this extension's own floating panel — it has a "Full preview"
    // button of its own, and clicking that is a no-op that looks like success.
    const ours = (x) => !!x.closest('#fse-root, #fse-panel');
    return (
      cands.find((x) => !ours(x) && (x.getAttribute('data-testid') || '') === 'present-sites-full-preview') ||
      cands.find((x) => !ours(x) && /full preview/i.test(label(x))) ||
      null
    );
  }
  async function waitForPreviewControl(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = findPreviewControl();
      if (el) return el;
      await sleep(1000);
    }
    return null;
  }

  /** Open the preview and wait for the bundle whose root is `expectGuid` (or any). */
  function dumpControls() {
    return [...document.querySelectorAll('button,[role="button"]')]
      .filter((b) => !b.closest('#fse-root, #fse-panel'))
      .map((b) => ({ t: b.getAttribute('data-testid') || '', a: b.getAttribute('aria-label') || '', x: (b.innerText || '').trim().slice(0, 18) }))
      .filter((o) => o.t || o.a || o.x)
      .slice(0, 30);
  }

  async function openPreviewAndCapture(expectGuid) {
    const pending = waitForBundle(expectGuid, BUNDLE_WAIT_MS);
    const t0 = Date.now();
    const ctrl = await waitForPreviewControl(CONTROL_WAIT_MS);
    if (!ctrl) {
      // Self-diagnosing: say what WAS there, so a UI variant is obvious from the log.
      const seen = JSON.stringify(dumpControls()).slice(0, 400);
      return { ok: false, error: `preview control not found after ${Date.now() - t0}ms (w=${innerWidth}); controls: ${seen}` };
    }
    await progress('walk', `preview control: ${ctrl.getAttribute('data-testid') || (ctrl.innerText || ctrl.getAttribute('aria-label') || '').trim().slice(0, 30)}`);
    ctrl.click();
    const got = await pending;
    if (!got) {
      const seen = JSON.stringify([...new Set(window.__FSE_PREVIEW_CAP__?.seen || [])]).slice(0, 200);
      return { ok: false, error: `no bundle for ${expectGuid || 'this page'} within ${BUNDLE_WAIT_MS}ms (port traffic: ${seen})` };
    }
    return { ok: true, captured: got };
  }

  /** Drain MAIN-world state and persist it. Returns the drained payload. */
  async function persistCurrent() {
    const d = await drain();
    if (!d.ok) throw new Error(d.error);
    for (const [guid, json] of Object.entries(d.bundles)) {
      await idbPut('bundles', guid, { route: d.labels[guid] || '/', json });
    }
    for (const [name, v] of Object.entries(d.assets)) {
      if (v && v.b64) await idbPut('assets', name, v);
    }
    return d;
  }

  // -------------------------------------------------------------- walk -----

  let walking = false;
  async function startWalk(opts = {}) {
    if (walking) { await progress('walk', 'already running'); return; }
    walking = true;
    const only = Array.isArray(opts.routes) && opts.routes.length ? new Set(opts.routes) : null;
    const key = fileKey();
    if (!key) throw new Error('not on a Figma file URL');
    await idbClear();
    clearPlan();

    await progress('start', 'Capturing this page…');
    let first = await drain();
    let routes = null;
    if (!first.ok || !Object.keys(first.bundles).length) {
      const r = await openPreviewAndCapture(null);
      if (!r.ok) throw new Error(r.error);
      routes = r.captured.routes;
    }
    const d = await persistCurrent();
    if (!routes) {
      const any = Object.values(d.bundles)[0];
      try { routes = JSON.parse(any).guidToUrl || {}; } catch { routes = {}; }
    }

    const have = new Set(Object.keys(d.bundles));
    const pending = Object.entries(routes)
      .filter(([guid, route]) => !have.has(guid) && (!only || only.has(route)))
      .map(([guid, route]) => ({ guid, route }));

    const plan = {
      fileKey: key, base: editorBase(), startedAt: Date.now(),
      pending, done: Object.keys(d.bundles).map((g) => ({ guid: g, route: d.labels[g] || '/' })), failed: [], current: null,
    };
    savePlan(plan);
    await progress('walk', `Enumerated ${Object.keys(routes).length} routes; ${pending.length} to visit`, { total: Object.keys(routes).length, done: plan.done.length });
    await goNext(plan);
  }

  async function goNext(plan) {
    if (!plan.pending.length) return finish(plan);
    plan.current = plan.pending.shift();
    savePlan(plan);
    await progress('walk', `→ ${plan.current.route}`, { done: plan.done.length, failed: plan.failed.length });
    location.href = `${plan.base}?node-id=${plan.current.guid.replace(':', '-')}`;
  }

  async function resume(plan) {
    const cur = plan.current;
    if (!cur) return goNext(plan);
    try {
      const r = await openPreviewAndCapture(cur.guid);
      if (!r.ok) throw new Error(r.error);
      await persistCurrent();
      plan.done.push(cur);
    } catch (e) {
      plan.failed.push({ ...cur, error: String(e?.message || e).slice(0, 200) });
      await progress('walk', `✗ ${cur.route}: ${String(e?.message || e).slice(0, 80)}`);
    }
    plan.current = null;
    savePlan(plan);
    await goNext(plan);
  }

  async function fetchVideos(bundles) {
    const urls = new Map();
    for (const { json } of Object.values(bundles)) {
      let b; try { b = JSON.parse(json); } catch { continue; }
      for (const a of Object.values(b.assets || {})) {
        if (a.type !== 'VIDEO_ASSET' || typeof a.url !== 'string' || !/^https?:/i.test(a.url)) continue;
        let base = a.url; try { base = new URL(a.url).pathname.split('/').pop() || a.url; } catch { /* keep */ }
        if (!urls.has(base)) urls.set(base, a.url);
      }
    }
    const out = {}; let bytes = 0; let n = 0;
    for (const [name, url] of urls) {
      if (bytes > VIDEO_BUDGET) break;
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) continue;
        const u8 = new Uint8Array(await r.arrayBuffer());
        out[name] = u8; bytes += u8.length; n++;
        await progress('videos', `videos ${n}/${urls.size}`);
      } catch { /* leave for server.mjs to fetch */ }
    }
    return out;
  }

  async function finish(plan) {
    await progress('pack', 'Packing…');
    const bundles = await idbAll('bundles');
    const assets = await idbAll('assets');
    const videos = await fetchVideos(bundles);

    const { buildPreviewBundlePack } = await import(chrome.runtime.getURL('lib/pack-preview-bundle.js'));
    const { buildZip, downloadBlob } = await import(chrome.runtime.getURL('lib/zip-store.js'));
    const { PUBLISHED_URL } = await chrome.storage.local.get(['PUBLISHED_URL']);

    const pack = buildPreviewBundlePack({
      bundles: Object.fromEntries(Object.entries(bundles).map(([g, v]) => [g, v.json])),
      assets, videos, fileKey: plan.fileKey, publishedUrl: PUBLISHED_URL || '',
    });
    pack.meta.walk = { done: plan.done, failed: plan.failed, startedAt: plan.startedAt };
    pack.files['preview-meta.json'] = JSON.stringify(pack.meta, null, 2);

    const entries = Object.entries(pack.files).map(([name, data]) => ({ name: `preview-bundle/${name}`, data }));
    const blob = buildZip(entries);
    downloadBlob(blob, `figma-preview-${plan.fileKey}.zip`);

    clearPlan();
    await idbClear();
    await progress('done', `Downloaded ${entries.length} files, ${plan.done.length} routes (${plan.failed.length} failed)`, {
      done: plan.done.length, failed: plan.failed.length, bytes: blob.size,
    });
  }

  // ----------------------------------------------------------- messages ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'CAPTURE_ALL_ROUTES') {
      startWalk({ routes: msg.routes }).catch((e) => progress('error', String(e?.message || e))).finally(() => { walking = false; });
      sendResponse({ ok: true, started: true });
      return;
    }
    if (msg?.type === 'PREVIEW_WALK_STATUS') {
      sendResponse({ plan: loadPlan() });
      return;
    }
    if (msg?.type !== 'CAPTURE_PREVIEW_BUNDLE') return;
    (async () => {
      const raw = await drain(msg.timeoutMs || 120_000);
      if (!raw.ok) return sendResponse(raw);
      try {
        const { buildPreviewBundlePack } = await import(chrome.runtime.getURL('lib/pack-preview-bundle.js'));
        const { PUBLISHED_URL } = await chrome.storage.local.get(['PUBLISHED_URL']);
        const pack = buildPreviewBundlePack({ bundles: raw.bundles, assets: raw.assets, fileKey: fileKey(), publishedUrl: PUBLISHED_URL || '' });
        sendResponse({
          ok: true, meta: pack.meta,
          textFiles: Object.fromEntries(Object.entries(pack.files).filter(([, v]) => typeof v === 'string')),
          assetsB64: raw.assets,
        });
      } catch (e) { sendResponse({ ok: false, error: String(e?.message || e).slice(0, 300) }); }
    })();
    return true;
  });

  // Also accept a page-world trigger, so the walk can be started without the popup.
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (d && d.source === 'figma-sites-exporter' && d.type === 'CAPTURE_ALL_ROUTES') {
      startWalk({ routes: d.routes }).catch((e) => progress('error', String(e?.message || e))).finally(() => { walking = false; });
    }
  });

  // ------------------------------------------------------------- resume ----

  (async () => {
    const plan = loadPlan();
    if (!plan) return;
    if (Date.now() - (plan.startedAt || 0) > PLAN_TTL_MS || plan.fileKey !== fileKey()) { clearPlan(); return; }
    await sleep(2500); // let the editor mount its toolbar
    resume(plan).catch((e) => progress('error', String(e?.message || e)));
  })();
})();
