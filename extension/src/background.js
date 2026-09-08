/**
 * MV3 service worker — packs CODE_FILE ZIP from frames captured in the editor page world
 * (page-world WS keeps Origin: https://www.figma.com).
 */
import { buildCodeZip } from '../lib/pack-code.js';
import { isFigWireFrame } from '../lib/wire.js';
import { debugLog } from '../lib/debug-log.js';

debugLog('service-worker', 'sw_booted', { version: chrome.runtime.getManifest().version });

const state = {
  lastProgress: null,
  lastError: null,
  busy: false,
  /** @type {Record<string,string>} fileKey -> multiplayerUrl */
  multiplayerByFile: {},
  lastMultiplayerUrl: null,
};

// Observe multiplayer WS URLs (more reliable than page-world WebSocket hook).
// NOTE: do NOT use invalid patterns like wss://*/* — they crash the SW on register.
try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const url = details.url || '';
      if (!/multiplayer/i.test(url)) return;
      state.lastMultiplayerUrl = url;
      // Typical: wss://www.figma.com/api/multiplayer/<FILE_KEY>?role=editor&...
      const pathKey = (url.match(/\/api\/multiplayer\/([a-zA-Z0-9]+)/) || [])[1];
      let fileKey = pathKey || null;
      try {
        const q = new URL(url);
        fileKey =
          fileKey ||
          q.searchParams.get('file_key') ||
          q.searchParams.get('fileKey') ||
          q.searchParams.get('fkey') ||
          null;
      } catch { /* ignore */ }
      if (fileKey) state.multiplayerByFile[fileKey] = url;
      broadcast({ type: 'MULTIPLAYER_CAPTURED', url, fileKey });
      debugLog('service-worker', 'multiplayer_webrequest', { fileKey, url: url.slice(0, 160) });
    },
    { urls: ['wss://www.figma.com/*', 'wss://*.figma.com/*'] },
  );
} catch (e) {
  console.warn('webRequest listener failed', e);
  debugLog('service-worker', 'webrequest_failed', { error: String(e?.message || e) }, 'error');
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
  chrome.tabs.query({ url: ['https://www.figma.com/*'] }, (tabs) => {
    for (const t of tabs || []) {
      chrome.tabs.sendMessage(t.id, msg).catch(() => {});
    }
  });
}

function badgeFor(progress) {
  if (!progress?.stage) return { text: '', color: '#5b5cff' };
  if (progress.stage === 'error') return { text: 'ERR', color: '#d93025' };
  if (progress.stage === 'done') return { text: 'OK', color: '#0bda6e' };
  if (progress.stage === 'sync') return { text: 'SYN', color: '#5b5cff' };
  if (progress.stage === 'download' || progress.stage === 'zip') return { text: 'ZIP', color: '#5b5cff' };
  return { text: '…', color: '#5b5cff' };
}

let lastProgressKey = '';
function setProgress(progress, { echoToTabs = false } = {}) {
  const next = { ...progress, at: Date.now() };
  const key = `${next.stage}|${next.message || ''}|${next.frames || ''}`;
  // Deduplicate — content script echoes were causing infinite progress storms.
  if (key === lastProgressKey) return;
  lastProgressKey = key;
  state.lastProgress = next;
  // Default: update badge/storage/popup only. Do NOT broadcast back to the page
  // unless explicitly requested (avoids content↔SW feedback loop).
  if (echoToTabs) broadcast({ type: 'EXPORT_PROGRESS', progress: state.lastProgress });
  const b = badgeFor(state.lastProgress);
  chrome.action.setBadgeText({ text: b.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: b.color }).catch(() => {});
  chrome.storage.session.set({ fseProgress: state.lastProgress }).catch(() => {});
  if (next.stage !== 'start') debugLog('service-worker', 'progress', state.lastProgress);
}

function b64ToU8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  // Handled exclusively by offscreen.js
  if (msg.type === 'OFFSCREEN_DOWNLOAD_ZIP') return;

  if (msg.type === 'GET_STATUS') {
    sendResponse({
      busy: state.busy,
      progress: state.lastProgress,
      error: state.lastError,
      lastMultiplayerUrl: state.lastMultiplayerUrl,
      multiplayerByFile: state.multiplayerByFile,
    });
    return;
  }

  if (msg.type === 'GET_MULTIPLAYER_URL') {
    const fileKey = msg.fileKey;
    const url =
      (fileKey && state.multiplayerByFile[fileKey]) ||
      state.lastMultiplayerUrl ||
      null;
    sendResponse({ ok: !!url, url, fileKey: fileKey || null });
    return;
  }

  if (msg.type === 'PING') {
    sendResponse({ ok: true, version: 1 });
    return;
  }

  if (msg.type === 'EXPORT_PROGRESS_PUSH') {
    setProgress(msg.progress || {});
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'EXPORT_FROM_FRAMES') {
    handlePack(msg, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => {
        state.lastError = String(err?.message || err);
        setProgress({ stage: 'error', message: state.lastError });
        sendResponse({ ok: false, error: state.lastError });
      });
    return true;
  }

  if (msg.type === 'CAPTURE_PREVIEW_IN_TAB') {
    capturePreviewInTab(sender?.tab?.id)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});

async function capturePreviewInTab(tabId) {
  if (!tabId) throw new Error('missing tabId');
  setProgress({ stage: 'site', message: 'Capturing Preview iframe (WYSIWYG)…' });
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const candidates = (frames || []).filter(
    (f) => /figma\.site/i.test(f.url || '') && !/plugin-sandbox/i.test(f.url || ''),
  );
  debugLog('service-worker', 'preview_frames', {
    count: candidates.length,
    urls: candidates.map((c) => c.url).slice(0, 5),
  });
  if (!candidates.length) {
    return { ok: false, error: 'no preview iframe frame found — click Full preview first' };
  }
  let lastErr = 'no frame responded';
  for (const frame of candidates) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_SITE' }, { frameId: frame.frameId });
      if (result?.ok) {
        setProgress({
          stage: 'site',
          message: `Captured preview HTML (${Math.round((result.htmlBytes || 0) / 1024)}KB, ${result.assetCount || 0} assets)`,
        });
        return result;
      }
      lastErr = result?.error || lastErr;
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }
  return { ok: false, error: lastErr };
}
async function getFigmaCookies() {
  const cookies = await chrome.cookies.getAll({ domain: 'figma.com' });
  const session = cookies.find((c) => c.name === 'figma.session');
  if (!session) throw new Error('No figma.session cookie — log into Figma in this Chrome profile');
  return cookies;
}

async function handlePack(msg, sender) {
  if (state.busy) throw new Error('Export already running');
  state.busy = true;
  state.lastError = null;
  try {
    const fileKey = msg.fileKey;
    if (!fileKey) throw new Error('missing fileKey');
    if (!Array.isArray(msg.framesB64) || !msg.framesB64.length) {
      throw new Error('missing frames from page sync');
    }

    setProgress({ stage: 'cookies', message: 'Checking Figma session…' });
    await getFigmaCookies();

    setProgress({ stage: 'decode', message: `Received ${msg.framesB64.length} frames — decoding…` });
    const frames = msg.framesB64.map(b64ToU8);
    const schemaFrame = frames.find((f) => isFigWireFrame(f)) || null;

    const stored = await chrome.storage.local.get(['FIGMA_TOKEN', 'PUBLISHED_URL']);
    const figmaToken = msg.figmaToken || stored.FIGMA_TOKEN || null;
    const publishedUrl = msg.publishedUrl || stored.PUBLISHED_URL || null;
    if (!figmaToken) {
      setProgress({
        stage: 'assets',
        message: 'No FIGMA_TOKEN in extension storage — ZIP will include code+animations only (set token in popup for images)',
      });
    }

    const { base64, codeFiles, nodeCount, manifest, assetStats } = await buildCodeZip({
      fileKey,
      editorUrl: msg.editorUrl || sender?.tab?.url || null,
      previewUrl: msg.previewUrl || null,
      publishedUrl,
      selection: msg.selection || null,
      previewMedia: msg.previewMedia || null,
      siteCapture: msg.siteCapture || null,
      figmaToken,
      frames,
      schemaFrame,
      onProgress: setProgress,
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `figma-full-${fileKey.slice(0, 10)}-${stamp}.zip`;
    setProgress({ stage: 'download', message: `Downloading ${filename}…` });

    const downloadId = await downloadZipBase64(base64, filename);
    setProgress({
      stage: 'done',
      message: `Exported full pack: code=${codeFiles.length} nodes=${nodeCount} siteAssets=${assetStats?.siteAssets || 0} images=${assetStats?.images || 0} videos=${assetStats?.videos || 0} anims=${assetStats?.animations || 0}`,
      downloadId,
      codeFiles,
      manifest,
      assetStats,
    });
    return { filename, downloadId, codeFiles, nodeCount, assetStats };
  } finally {
    state.busy = false;
  }
}

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument?.();
  if (exists) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Create object URLs for large ZIP downloads from full wire pack',
  });
}

/** Prefer offscreen blob URL for large zips; fall back to data: URL. */
async function downloadZipBase64(base64, filename) {
  const bytesApprox = Math.floor((base64.length * 3) / 4);
  // data: URLs get flaky above ~20–30MB in Chrome
  if (bytesApprox < 18 * 1024 * 1024) {
    return chrome.downloads.download({
      url: `data:application/zip;base64,${base64}`,
      filename,
      saveAs: true,
    });
  }
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_DOWNLOAD_ZIP',
    base64,
    filename,
    saveAs: true,
  });
  if (!res?.ok) throw new Error(res?.error || 'offscreen download failed');
  return res.downloadId;
}

// Toolbar uses default_popup (ui/popup.html). No action.onClicked.