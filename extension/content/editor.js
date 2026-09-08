/**
 * Figma editor content script — floating panel + one-click Export ZIP.
 * Multiplayer URL comes from:
 *   1) MAIN-world hook-early.js (document_start)
 *   2) SW webRequest listener
 *   3) auto-reload resume if still missing when user clicks Export
 */
(() => {
  if (window.__FIGMA_SITES_EXPORTER_EDITOR__) return;
  window.__FIGMA_SITES_EXPORTER_EDITOR__ = true;

  const PENDING_KEY = 'fse_pending_export_v1';
  const RELOAD_ONCE_KEY = 'fse_auto_reload_once_v1';

  const state = {
    multiplayerUrl: null,
    panelOpen: false,
    selecting: false,
    /** @type {Array<{id:string, viewport:object, inIframe:object, previewSrc?:string}>} */
    selections: [],
    progress: null,
    exporting: false,
    applyingRemoteProgress: false,
    lastProgressKey: '',
    selectCleanup: null,
  };

  // Back-compat for older export paths that read state.selection
  Object.defineProperty(state, 'selection', {
    get() {
      if (!state.selections.length) return null;
      return { regions: state.selections.slice(), ...state.selections[state.selections.length - 1] };
    },
    set(v) {
      if (!v) state.selections = [];
      else if (Array.isArray(v.regions)) state.selections = v.regions.slice();
      else state.selections = [v];
    },
  });

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.source !== 'figma-sites-exporter') return;
    if (d.type === 'MULTIPLAYER_URL' && d.url) {
      state.multiplayerUrl = d.url;
      updatePanelMeta();
      dbg('multiplayer_captured_page', { url: d.url.slice(0, 160) });
    }
  });

  /** Read window.__FSE_LAST_MP__ from the page (MAIN) world without inline scripts (CSP). */
  function readPageMultiplayer() {
    return new Promise((resolve) => {
      const id = 'fse_mp_' + Math.random().toString(36).slice(2);
      const onMsg = (ev) => {
        if (ev.data?.source === 'figma-sites-exporter' && ev.data?.type === 'PAGE_MP' && ev.data?.id === id) {
          window.removeEventListener('message', onMsg);
          resolve(ev.data.url || null);
        }
      };
      window.addEventListener('message', onMsg);
      // Ask MAIN world via external script (web_accessible), not inline textContent.
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('lib/read-mp.js');
      s.dataset.fseId = id;
      s.onload = () => s.remove();
      s.onerror = () => {
        window.removeEventListener('message', onMsg);
        resolve(null);
      };
      // Pass id through a data attribute readable by the script via document.currentScript
      (document.documentElement || document.head).appendChild(s);
      setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 800);
    });
  }

  function fileKeyFromUrl(href = location.href) {
    const m = href.match(/figma\.com\/(?:site|make|design|file|proto)\/([a-zA-Z0-9]+)/);
    return m ? m[1] : null;
  }

  function previewInfo() {
    const f =
      document.querySelector('#rendered-site') ||
      document.querySelector('iframe[data-testid="site-preview-iframe"]');
    if (!f) return { present: false };
    return {
      present: true,
      src: f.src || null,
      w: f.clientWidth,
      h: f.clientHeight,
      ready: f.clientWidth > 10 && f.clientHeight > 10,
    };
  }

  // ---- panel UI ----
  function ensurePanel() {
    let root = document.getElementById('fse-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'fse-root';
    root.innerHTML = `
      <style>
        #fse-root { all: initial; }
        #fse-panel {
          position: fixed; top: 72px; right: 16px; z-index: 2147483646;
          width: 340px; font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
          color: #e8e8f0; background: #1a1a22ee; border: 1px solid #3a3a4a; border-radius: 12px;
          box-shadow: 0 12px 40px #0008; backdrop-filter: blur(8px);
        }
        #fse-panel header {
          display:flex; align-items:center; justify-content:space-between;
          padding: 10px 12px; border-bottom: 1px solid #2e2e3a; font-weight: 600; font-size: 13px;
        }
        #fse-panel .body { padding: 12px; display: grid; gap: 8px; }
        #fse-panel .meta { color: #9aa0b4; word-break: break-all; }
        #fse-panel .row { display:flex; gap: 8px; }
        #fse-panel button {
          flex:1; cursor:pointer; border:0; border-radius: 8px; padding: 8px 10px;
          background:#5b5cff; color:white; font-weight:600;
        }
        #fse-panel button.secondary { background:#2a2a36; color:#ddd; }
        #fse-panel button:disabled { opacity: .5; cursor: default; }
        #fse-panel .progress {
          min-height: 42px; padding: 8px; border-radius: 8px; background:#12121a; color:#c7cbe0;
          white-space: pre-wrap;
        }
        #fse-panel .bar {
          height: 8px; border-radius: 999px; background:#2a2a36; overflow: hidden; margin-top: 6px;
        }
        #fse-panel .bar > i {
          display:block; height:100%; width:0%; background:linear-gradient(90deg,#5b5cff,#8b8dff);
          transition: width .2s ease;
        }
        #fse-panel .bar.indeterminate > i {
          width: 40% !important; animation: fse-slide 1s ease-in-out infinite;
        }
        @keyframes fse-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(280%); }
        }
        #fse-panel .ok { color: #6dffa8; }
        #fse-panel .err { color: #ff8f8f; }
        #fse-panel .sel-list { display:grid; gap:6px; max-height:120px; overflow:auto; }
        #fse-panel .sel-item {
          display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:8px;
          background:#12121a; border:1px solid #2a3a2a; color:#cfe9d4; font-size:11px;
        }
        #fse-panel .sel-item button {
          flex:0; padding:4px 8px; background:#1f2a1f; color:#86efac; border:1px solid #225522;
        }
        #fse-select-layer {
          display:none; position: fixed; inset: 0; z-index: 2147483645; cursor: crosshair;
        }
        #fse-select-box {
          position: fixed; border: 1.5px solid #22c55e; background: #22c55e22; pointer-events: none;
          box-shadow: 0 0 0 1px #14532d55 inset;
        }
        #fse-select-marks { position: fixed; inset: 0; z-index: 2147483644; pointer-events: none; }
        .fse-sel-mark {
          position: fixed; border: 1.5px solid #22c55e; background: #22c55e18;
          box-shadow: 0 0 0 1px #14532d44 inset; pointer-events: auto; border-radius: 2px;
        }
        .fse-sel-mark button {
          position:absolute; top:-9px; right:-9px; width:18px; height:18px; border-radius:50%;
          border:1px solid #166534; background:#14532d; color:#bbf7d0; font-size:11px; line-height:16px;
          padding:0; cursor:pointer; pointer-events:auto;
        }
        #fse-select-hint {
          position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
          z-index: 2147483646; display:none; padding:8px 12px; border-radius:8px;
          background:#052e1aee; color:#bbf7d0; border:1px solid #22c55e88; font:12px/1.4 system-ui;
        }
      </style>
      <div id="fse-panel" style="display:none">
        <header>
          <span>Figma Sites Exporter <small style="opacity:.6;font-weight:400">v0.3.1</small></span>
          <button class="secondary" id="fse-close" style="flex:0;padding:4px 8px">✕</button>
        </header>
        <div class="body">
          <div class="meta" id="fse-meta">Detecting…</div>
          <div class="progress" id="fse-progress">Ready. 全量逆向：site/ + code/ + scenegraph + vectors + anims + assets</div>
          <div class="bar indeterminate" id="fse-bar" style="display:none"><i id="fse-bar-i"></i></div>
          <div class="row">
            <button id="fse-export">Export 全量包</button>
          </div>
          <div class="row">
            <button class="secondary" id="fse-select">框选</button>
            <button class="secondary" id="fse-select-clear">取消全部框选</button>
          </div>
          <div class="row">
            <button class="secondary" id="fse-preview-btn">打开 Full preview</button>
          </div>
          <div class="sel-list" id="fse-sel-list"></div>
        </div>
      </div>
      <div id="fse-select-marks"></div>
      <div id="fse-select-layer"><div id="fse-select-box"></div></div>
      <div id="fse-select-hint">拖拽框选（细绿色）· Esc 退出框选 · 可多选</div>
    `;
    document.documentElement.appendChild(root);
    root.querySelector('#fse-close').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPanel(false);
    });
    root.querySelector('#fse-export').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startExport();
    });
    root.querySelector('#fse-select').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      beginSelect();
    });
    root.querySelector('#fse-select-clear').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearAllSelections();
    });
    root.querySelector('#fse-preview-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clickFullPreview();
    });
    return root;
  }

  function setPanel(open) {
    ensurePanel();
    state.panelOpen = open;
    document.getElementById('fse-panel').style.display = open ? 'block' : 'none';
    if (open) {
      updatePanelMeta();
      renderSelectionList();
      renderSelectionMarks();
    }
  }

  function updatePanelMeta() {
    const el = document.getElementById('fse-meta');
    if (!el) return;
    const key = fileKeyFromUrl();
    const pv = previewInfo();
    el.innerHTML = [
      `<div><b>fileKey</b>: ${key || '—'}</div>`,
      `<div><b>multiplayer</b>: ${state.multiplayerUrl ? 'captured' : 'waiting (interact with file)'}</div>`,
      `<div><b>preview iframe</b>: ${pv.present ? `${pv.w}×${pv.h}${pv.ready ? '' : ' (not ready)'}` : 'not found'}</div>`,
      pv.src ? `<div class="meta">${pv.src}</div>` : '',
    ].join('');
  }

  function stagePercent(p) {
    if (!p?.stage) return null;
    if (p.percent != null) return Math.max(0, Math.min(100, Number(p.percent)));
    const map = {
      start: 5,
      cookies: 10,
      sync: 35,
      decode: 55,
      code: 70,
      zip: 85,
      download: 95,
      done: 100,
      error: 100,
      selection: 20,
      ui: 15,
    };
    if (p.stage === 'sync' && p.frames) return Math.min(50, 15 + p.frames * 3);
    return map[p.stage] ?? 30;
  }

  function dbg(message, data, level) {
    try {
      window.__fseDebug?.(message, data, level || 'info');
    } catch { /* ignore */ }
  }

  function setProgressView(p, { fromRemote = false } = {}) {
    if (!p) return;
    const key = `${p.stage}|${p.message || ''}|${p.frames || ''}`;
    // Deduplicate identical progress (also breaks SW↔content echo storms).
    if (key === state.lastProgressKey && !p.force) return;
    state.lastProgressKey = key;

    // Keep panel visible during export so progress is obvious.
    if (p.stage && p.stage !== 'done') setPanel(true);
    const el = document.getElementById('fse-progress');
    const bar = document.getElementById('fse-bar');
    const barI = document.getElementById('fse-bar-i');
    if (el) {
      const cls = p.stage === 'error' ? 'err' : p.stage === 'done' ? 'ok' : '';
      el.className = `progress ${cls}`;
      el.textContent = `[${p.stage || '…'}] ${p.message || ''}`;
    }
    if (bar && barI) {
      const pct = stagePercent(p);
      const busy = p.stage && p.stage !== 'done' && p.stage !== 'error';
      bar.style.display = busy || p.stage === 'done' || p.stage === 'error' ? 'block' : 'none';
      if (pct == null || (p.stage === 'sync' && !p.frames)) {
        bar.classList.add('indeterminate');
      } else {
        bar.classList.remove('indeterminate');
        barI.style.width = `${pct}%`;
      }
      if (p.stage === 'done') {
        bar.classList.remove('indeterminate');
        barI.style.width = '100%';
      }
    }
    // Throttle debug: only log stage changes / sync frame milestones.
    if (p.stage !== 'start' || p.message?.includes('已点击')) {
      dbg('progress', { stage: p.stage, message: p.message, frames: p.frames, percent: stagePercent(p) });
    }
    // Mirror to SW only for local updates — never echo remote broadcasts (prevents infinite loop).
    if (!fromRemote && !state.applyingRemoteProgress) {
      chrome.runtime.sendMessage({ type: 'EXPORT_PROGRESS_PUSH', progress: p }).catch(() => {});
    }
  }

  function clickFullPreview() {
    // Do NOT write into export progress — it looks like export is looping.
    const btns = [...document.querySelectorAll('button,[role="button"]')];
    const b = btns.find((x) => /full preview/i.test(x.getAttribute('aria-label') || ''));
    const meta = document.getElementById('fse-meta');
    if (b) {
      b.click();
      if (meta) {
        meta.insertAdjacentHTML(
          'beforeend',
          `<div style="color:#9aa0b4;margin-top:4px">已点 Full preview — 与 Export 无关，请等 iframe，再看 multiplayer 是否 captured</div>`,
        );
      }
      setTimeout(updatePanelMeta, 2500);
    } else if (meta) {
      meta.insertAdjacentHTML(
        'beforeend',
        `<div style="color:#ff8f8f;margin-top:4px">Full preview 按钮未找到</div>`,
      );
    }
  }

  // ---- selection overlay (thin green; multi-select; cancel all / partial) ----
  function renderSelectionMarks() {
    const marks = document.getElementById('fse-select-marks');
    if (!marks) return;
    marks.innerHTML = '';
    for (const sel of state.selections) {
      const v = sel.viewport || {};
      const el = document.createElement('div');
      el.className = 'fse-sel-mark';
      el.dataset.id = sel.id;
      Object.assign(el.style, {
        left: `${v.x || 0}px`,
        top: `${v.y || 0}px`,
        width: `${v.w || 0}px`,
        height: `${v.h || 0}px`,
      });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = '取消此框选';
      btn.textContent = '×';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeSelection(sel.id);
      });
      el.appendChild(btn);
      marks.appendChild(el);
    }
  }

  function renderSelectionList() {
    const list = document.getElementById('fse-sel-list');
    if (!list) return;
    if (!state.selections.length) {
      list.innerHTML = '<div style="color:#6b7280;font-size:11px">尚无框选</div>';
      return;
    }
    list.innerHTML = state.selections
      .map((s, i) => {
        const r = s.inIframe || s.viewport || {};
        return `<div class="sel-item" data-id="${s.id}">
          <span style="flex:1">#${i + 1} ${Math.round(r.w || 0)}×${Math.round(r.h || 0)} @ (${Math.round(r.x || 0)},${Math.round(r.y || 0)})</span>
          <button type="button" data-rm="${s.id}">取消</button>
        </div>`;
      })
      .join('');
    list.querySelectorAll('button[data-rm]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeSelection(btn.getAttribute('data-rm'));
      });
    });
  }

  function removeSelection(id) {
    state.selections = state.selections.filter((s) => s.id !== id);
    renderSelectionMarks();
    renderSelectionList();
    dbg('selection_removed', { id, left: state.selections.length });
    setProgressView({
      stage: 'selection',
      message: state.selections.length
        ? `已取消一块，剩余 ${state.selections.length} 个框选`
        : '已取消该框选，当前无选区',
      force: true,
    });
  }

  function clearAllSelections() {
    state.selections = [];
    renderSelectionMarks();
    renderSelectionList();
    endSelectMode();
    dbg('selection_cleared_all', {});
    setProgressView({ stage: 'selection', message: '已取消全部框选', force: true });
  }

  function endSelectMode() {
    if (typeof state.selectCleanup === 'function') {
      try { state.selectCleanup(); } catch { /* ignore */ }
      state.selectCleanup = null;
    }
    const layer = document.getElementById('fse-select-layer');
    const hint = document.getElementById('fse-select-hint');
    const box = document.getElementById('fse-select-box');
    if (layer) layer.style.display = 'none';
    if (hint) hint.style.display = 'none';
    if (box) Object.assign(box.style, { width: '0px', height: '0px' });
    state.selecting = false;
  }

  function beginSelect() {
    const layer = document.getElementById('fse-select-layer');
    const box = document.getElementById('fse-select-box');
    const hint = document.getElementById('fse-select-hint');
    const iframe = document.querySelector('#rendered-site, iframe[data-testid="site-preview-iframe"]');
    if (!iframe || iframe.clientWidth < 10) {
      setProgressView({
        stage: 'error',
        message: 'Preview iframe not ready — 先点「打开 Full preview」',
        force: true,
      });
      return;
    }
    endSelectMode();
    state.selecting = true;
    layer.style.display = 'block';
    if (hint) hint.style.display = 'block';
    Object.assign(box.style, { left: '0px', top: '0px', width: '0px', height: '0px' });
    let start = null;

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        endSelectMode();
        setProgressView({
          stage: 'selection',
          message: `已退出框选（保留 ${state.selections.length} 块）`,
          force: true,
        });
      }
    };

    const onDown = (e) => {
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
      Object.assign(box.style, {
        left: `${start.x}px`,
        top: `${start.y}px`,
        width: '0px',
        height: '0px',
      });
    };
    const onMove = (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x);
      const h = Math.abs(e.clientY - start.y);
      Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    };
    const onUp = (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x);
      const h = Math.abs(e.clientY - start.y);
      start = null;
      Object.assign(box.style, { width: '0px', height: '0px' });
      if (w < 4 || h < 4) return;
      const ir = iframe.getBoundingClientRect();
      const sel = {
        id: 'sel_' + Math.random().toString(36).slice(2, 9),
        viewport: { x, y, w, h },
        inIframe: {
          x: x - ir.left,
          y: y - ir.top,
          w,
          h,
        },
        previewSrc: iframe.src || null,
      };
      state.selections.push(sel);
      renderSelectionMarks();
      renderSelectionList();
      iframe.contentWindow?.postMessage(
        { source: 'figma-sites-exporter', type: 'RESOLVE_SELECTION', rect: sel.inIframe },
        '*',
      );
      dbg('selection_added', { id: sel.id, w, h, count: state.selections.length });
      setProgressView({
        stage: 'selection',
        message: `已添加框选 #${state.selections.length}：${Math.round(w)}×${Math.round(h)}（继续拖拽可多选，Esc 结束）`,
        force: true,
      });
    };

    state.selectCleanup = () => {
      layer.removeEventListener('mousedown', onDown);
      layer.removeEventListener('mousemove', onMove);
      layer.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
    layer.addEventListener('mousedown', onDown);
    layer.addEventListener('mousemove', onMove);
    layer.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    renderSelectionList();
  }

  function ensurePageSyncInjected() {
    if (window.__FSE_PAGE_SYNC_INJECTED__) return Promise.resolve();
    // MUST use external script URL — Figma/extension CSP blocks inline textContent.
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('lib/page-sync-inject.js');
      s.onload = () => {
        s.remove();
        window.__FSE_PAGE_SYNC_INJECTED__ = true;
        dbg('page_sync_injected', { ok: true });
        resolve();
      };
      s.onerror = () => {
        s.remove();
        dbg('page_sync_inject_failed', {}, 'error');
        reject(new Error('failed to inject page-sync-inject.js (CSP/WAR)'));
      };
      (document.documentElement || document.head).appendChild(s);
    });
  }

  function runPageSync(multiplayerUrl, timeoutMs = 120000) {
    return new Promise(async (resolve, reject) => {
      await ensurePageSyncInjected();
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.source !== 'figma-sites-exporter' || d.type !== 'SYNC_EVENT') return;
        if (d.event === 'progress') {
          chrome.runtime
            .sendMessage({
              type: 'EXPORT_PROGRESS_PUSH',
              progress: {
                stage: 'sync',
                message: `Syncing… ${d.frames || 0} frames, ${((d.dataBytes || 0) / 1048576).toFixed(1)}MB`,
                frames: d.frames,
                dataBytes: d.dataBytes,
                joinEnd: d.joinEnd,
              },
            })
            .catch(() => {});
          setProgressView({
            stage: 'sync',
            message: `Syncing… ${d.frames || 0} frames, ${((d.dataBytes || 0) / 1048576).toFixed(1)}MB${d.phase ? ' (' + d.phase + ')' : ''}`,
            frames: d.frames,
            force: true,
          });
        } else if (d.event === 'done') {
          window.removeEventListener('message', onMsg);
          resolve(d);
        } else if (d.event === 'error') {
          window.removeEventListener('message', onMsg);
          reject(new Error(d.message || 'page sync failed'));
        }
      };
      window.addEventListener('message', onMsg);
      window.postMessage(
        {
          source: 'figma-sites-exporter',
          type: 'START_PAGE_SYNC',
          multiplayerUrl,
          timeoutMs,
        },
        '*',
      );
    });
  }

  function withTimeout(promise, ms, fallback = null) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  }

  async function resolveMultiplayerUrl(fileKey) {
    if (state.multiplayerUrl) return state.multiplayerUrl;
    const fromPage = await withTimeout(readPageMultiplayer(), 500, null);
    if (fromPage) {
      state.multiplayerUrl = fromPage;
      updatePanelMeta();
      return fromPage;
    }
    try {
      const res = await withTimeout(
        chrome.runtime.sendMessage({ type: 'GET_MULTIPLAYER_URL', fileKey }),
        800,
        null,
      );
      if (res?.ok && res.url) {
        state.multiplayerUrl = res.url;
        updatePanelMeta();
        return res.url;
      }
    } catch { /* ignore */ }
    return null;
  }

  function alreadyAutoReloaded() {
    try {
      const raw = sessionStorage.getItem(RELOAD_ONCE_KEY);
      if (!raw) return false;
      const at = Number(raw) || 0;
      return Date.now() - at < 5 * 60 * 1000;
    } catch {
      return false;
    }
  }

  function scheduleReloadAndResume(fileKey) {
    if (alreadyAutoReloaded()) {
      setProgressView({
        stage: 'error',
        message:
          '仍未捕获 multiplayer（已自动刷新过一次，已停止循环）。请手动 ⌘R，等画布稳定 5–10 秒后再点 Export。不要开 p=f 死循环预览。',
      });
      const btn = document.getElementById('fse-export');
      if (btn) btn.disabled = false;
      return;
    }
    setProgressView({
      stage: 'sync',
      message: '尚未捕获 multiplayer — 自动刷新一次（仅一次），刷新后会继续…',
    });
    try {
      sessionStorage.setItem(RELOAD_ONCE_KEY, String(Date.now()));
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ fileKey, selection: state.selection, at: Date.now() }),
      );
    } catch { /* ignore */ }
    setTimeout(() => location.reload(), 200);
  }

  /** Wait on the current page for multiplayer instead of immediately reloading. */
  async function waitForMultiplayer(fileKey, seconds = 20) {
    for (let i = 0; i < seconds; i++) {
      const mp = await resolveMultiplayerUrl(fileKey);
      if (mp) return mp;
      setProgressView({
        stage: 'sync',
        message: `等待 multiplayer 连接… ${i + 1}/${seconds}s（请点一下画布）`,
        percent: Math.round(((i + 1) / seconds) * 30),
      });
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  async function startExport() {
    if (state.exporting) {
      dbg('export_ignored_busy', {});
      return;
    }
    state.exporting = true;
    setPanel(true);
    const btn = document.getElementById('fse-export');
    if (btn) btn.disabled = true;
    dbg('export_click', { href: location.href, multiplayer: !!state.multiplayerUrl });
    setProgressView({ stage: 'start', message: 'Export 已点击… 正在检查 multiplayer 会话', force: true });

    try {
      const fileKey = fileKeyFromUrl();
      dbg('file_key', { fileKey });
      if (!fileKey) {
        setProgressView({ stage: 'error', message: 'Cannot parse fileKey from URL', force: true });
        return;
      }
      let mp = await resolveMultiplayerUrl(fileKey);
      dbg('multiplayer_resolve', { found: !!mp, preview: mp ? mp.slice(0, 120) : null });
      if (!mp) mp = await waitForMultiplayer(fileKey, 20);
      dbg('multiplayer_after_wait', { found: !!mp });
      if (!mp) {
        dbg('schedule_reload', { fileKey }, 'warn');
        state.exporting = false;
        scheduleReloadAndResume(fileKey);
        return;
      }
      state.multiplayerUrl = mp;
      await runExportWithMp(fileKey, mp);
    } catch (e) {
      dbg('export_error', { error: String(e?.message || e) }, 'error');
      setProgressView({ stage: 'error', message: String(e?.message || e), force: true });
    } finally {
      state.exporting = false;
      if (btn) btn.disabled = false;
    }
  }

  function collectPreviewMedia() {
    const out = [];
    const seen = new Set();
    const add = (url, kind) => {
      if (!url || seen.has(url)) return;
      if (!/^https?:/i.test(url)) return;
      seen.add(url);
      out.push({ url, kind });
    };
    for (const v of document.querySelectorAll('video')) {
      add(v.currentSrc || v.src, 'video');
      for (const s of v.querySelectorAll('source')) add(s.src, 'video');
    }
    for (const img of document.querySelectorAll('img')) add(img.currentSrc || img.src, 'image');
    try {
      for (const e of performance.getEntriesByType('resource')) {
        const u = e.name || '';
        if (/\.(mp4|webm|mov)(\?|$)/i.test(u)) add(u, 'video');
        if (/s3-alpha.*figma\.com\/img\//i.test(u) || /figma\.com\/.*(png|jpg|jpeg|webp)/i.test(u)) add(u, 'image');
      }
    } catch { /* ignore */ }
    return out.slice(0, 80);
  }

  async function runExportWithMp(fileKey, mp) {
    const pv = previewInfo();
    const btn = document.getElementById('fse-export');
    if (btn) btn.disabled = true;
    setProgressView({ stage: 'sync', message: 'Syncing wire protocol…', force: true });
    try {
      // Ensure preview iframe exists
      if (!pv.ready) {
        setProgressView({ stage: 'site', message: 'Preview 未就绪 — 尝试点击 Full preview…', force: true });
        clickFullPreview();
        await new Promise((r) => setTimeout(r, 5000));
      }

      // 1) WYSIWYG preview capture (primary visual deliverable)
      setProgressView({ stage: 'site', message: '正在抓取 Preview iframe 整页…', force: true });
      let siteCapture = await chrome.runtime.sendMessage({ type: 'CAPTURE_PREVIEW_IN_TAB' });
      dbg('site_capture', {
        ok: !!siteCapture?.ok,
        error: siteCapture?.error,
        assets: siteCapture?.assetCount,
        htmlBytes: siteCapture?.htmlBytes,
      });
      if (!siteCapture?.ok) {
        setProgressView({
          stage: 'site',
          message: `Preview 抓取失败: ${siteCapture?.error || 'unknown'} — 仍继续导出 CODE_FILE`,
          force: true,
        });
      }

      // 2) Wire sync for CODE_FILE
      const sync = await runPageSync(mp);
      if (!sync.joinEnd) throw new Error('sync incomplete (no JOIN_END)');
      const previewMedia = collectPreviewMedia();
      dbg('preview_media', { count: previewMedia.length, sample: previewMedia.slice(0, 5) });
      setProgressView({
        stage: 'sync',
        message: `Sync complete: ${sync.frames?.length || 0} frames — packing site/ + code/…`,
        force: true,
      });
      const res = await chrome.runtime.sendMessage({
        type: 'EXPORT_FROM_FRAMES',
        fileKey,
        framesB64: sync.frames,
        editorUrl: location.href,
        previewUrl: pv.src || null,
        selection: state.selection,
        previewMedia,
        siteCapture: siteCapture?.ok ? siteCapture : null,
      });
      if (!res?.ok) throw new Error(res?.error || 'export failed');
      const a = res.assetStats || {};
      setProgressView({
        stage: 'done',
        message: `Downloaded ${res.filename}\nsiteAssets=${a.siteAssets || 0} code=${(res.codeFiles || []).length} wireImages=${a.images || 0} videos=${a.videos || 0} anims=${a.animations || 0}`,
        force: true,
      });
    } catch (e) {
      setProgressView({ stage: 'error', message: String(e?.message || e), force: true });
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'PING_PANEL') {
      sendResponse({ ok: true, version: '0.3.0' });
      return;
    }
    if (msg?.type === 'TOGGLE_PANEL') setPanel(!state.panelOpen);
    if (msg?.type === 'EXPORT_PROGRESS') {
      // Apply badge/popup echo for UI only — never push back to SW.
      state.applyingRemoteProgress = true;
      try {
        setProgressView(msg.progress || {}, { fromRemote: true });
      } finally {
        state.applyingRemoteProgress = false;
      }
    }
    if (msg?.type === 'SHOW_PANEL') setPanel(true);
    if (msg?.type === 'START_EXPORT') {
      setPanel(true);
      setProgressView({ stage: 'start', message: '后台 Export 已启动…' });
      startExport();
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === 'MULTIPLAYER_CAPTURED' && msg.url) {
      state.multiplayerUrl = msg.url;
      updatePanelMeta();
    }
  });

  // Auto-show on Sites / Make / Design (this file is often opened via /design/).
  ensurePanel();
  if (/figma\.com\/(site|make|design)\//.test(location.href)) {
    setTimeout(() => setPanel(true), 600);
  }
  setInterval(updatePanelMeta, 3000);
  // Heartbeat so debug server shows the tab is alive.
  setInterval(() => {
    dbg('heartbeat', {
      multiplayer: !!state.multiplayerUrl,
      panelOpen: state.panelOpen,
      href: location.href.slice(0, 160),
    });
  }, 5000);

  // Resume export after the single allowed auto-reload. Never reload again here.
  (async () => {
    let pending = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
      sessionStorage.removeItem(PENDING_KEY);
    } catch { /* ignore */ }
    if (!pending || Date.now() - (pending.at || 0) > 120000) return;
    setPanel(true);
    setProgressView({ stage: 'sync', message: '刷新后恢复导出 — 等待 multiplayer（不会再自动刷新）…' });
    const fileKey = pending.fileKey || fileKeyFromUrl();
    const mp = await waitForMultiplayer(fileKey, 45);
    if (!mp) {
      setProgressView({
        stage: 'error',
        message:
          '刷新后仍无 multiplayer。请关掉带 p=f 的预览死循环，打开普通 Sites/Design 编辑页，等画布出来后再点 Export。',
      });
      return;
    }
    if (pending.selection) {
      state.selection = pending.selection;
      renderSelectionMarks();
      renderSelectionList();
    }
    state.multiplayerUrl = mp;
    await runExportWithMp(fileKey, mp);
  })();
})();
