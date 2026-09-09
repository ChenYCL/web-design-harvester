const statusEl = document.getElementById('status');
const barEl = document.getElementById('bar');
const exportBtn = document.getElementById('export');
const panelBtn = document.getElementById('panel');
const capturePreviewBtn = document.getElementById('capturePreview');
const tokenInput = document.getElementById('token');
const publishedInput = document.getElementById('published');
const saveTokenBtn = document.getElementById('saveToken');

function setStatus(text, cls = '') {
  statusEl.className = cls;
  statusEl.textContent = text;
}

function setBar(percent) {
  barEl.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
}

function renderProgress(p) {
  if (!p) {
    setStatus('Open a Figma Sites tab, save token (for images), then Export.');
    setBar(0);
    return;
  }
  const cls = p.stage === 'error' ? 'err' : p.stage === 'done' ? 'ok' : '';
  setStatus(`[${p.stage}] ${p.message || ''}`, cls);
  const map = {
    start: 5,
    sync: 30,
    site: 40,
    published: 50,
    decode: 55,
    code: 65,
    anims: 70,
    assets: 80,
    zip: 90,
    download: 95,
    done: 100,
    error: 100,
  };
  setBar(p.percent != null ? p.percent : map[p.stage] ?? 25);
}

async function activeFigmaTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !/figma\.com\/(site|make|design)/.test(tab.url || '')) {
    throw new Error('请先打开并激活一个 Figma Sites / Make / Design 标签页');
  }
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING_PANEL' });
    return true;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/preview-bundle-bridge.js', 'content/debug-bridge.js', 'content/editor.js'],
    });
    return true;
  }
}

chrome.storage.local.get(['FIGMA_TOKEN', 'PUBLISHED_URL'], (res) => {
  if (res.FIGMA_TOKEN) tokenInput.value = res.FIGMA_TOKEN;
  if (res.PUBLISHED_URL) publishedInput.value = res.PUBLISHED_URL;
  if (res.FIGMA_TOKEN || res.PUBLISHED_URL) {
    setStatus('Saved. Export packs wire + optional published/ mirror.', 'ok');
  }
});

saveTokenBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const publishedUrl = publishedInput.value.trim();
  if (publishedUrl && !/\.figma\.site(\/|$)/i.test(publishedUrl)) {
    setStatus('Published URL must be a https://*.figma.site/ address', 'err');
    return;
  }
  await chrome.storage.local.set({
    FIGMA_TOKEN: token,
    PUBLISHED_URL: publishedUrl || '',
  });
  setStatus(
    [
      token ? 'Token saved.' : 'Token cleared.',
      publishedUrl ? `Published: ${publishedUrl}` : 'No published URL.',
    ].join(' '),
    'ok',
  );
});

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  setStatus('已发送后台导出指令…');
  setBar(5);
  try {
    const tab = await activeFigmaTab();
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'START_EXPORT' });
    setStatus('导出运行中 — 可关弹窗，看徽章 …/SYN/ZIP/OK');
  } catch (e) {
    setStatus(`${e?.message || e}\n先 ⌘R 刷新 Figma 标签再试。`, 'err');
  } finally {
    exportBtn.disabled = false;
  }
});

panelBtn.addEventListener('click', async () => {
  try {
    const tab = await activeFigmaTab();
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_PANEL' });
    setStatus('已打开页面浮层', 'ok');
  } catch (e) {
    setStatus(String(e?.message || e), 'err');
  }
});

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (res?.progress) renderProgress(res.progress);
  } catch { /* ignore */ }
}

refresh();
setInterval(refresh, 500);

// ---- Preview capture (all routes) ------------------------------------------
// Deterministic walk: the first bundle's guidToUrl enumerates every route, the
// bridge visits each via ?node-id=<guid>, and bundles label themselves from
// their own payload. Progress lands in chrome.storage.local.fsePreviewWalk.
function renderWalk(p) {
  if (!p) return;
  const cls = p.stage === 'error' ? 'err' : p.stage === 'done' ? 'ok' : '';
  const extra = p.total ? ` (${p.done ?? 0}/${p.total})` : '';
  setStatus(`[preview:${p.stage}] ${p.message || ''}${extra}`, cls);
  const map = { start: 5, walk: 40, videos: 70, pack: 85, done: 100, error: 100 };
  setBar(map[p.stage] ?? 30);
}

capturePreviewBtn?.addEventListener('click', async () => {
  try {
    const tab = await activeFigmaTab();
    await ensureContentScript(tab.id);
    capturePreviewBtn.disabled = true;
    setStatus('[preview:start] Arming capture — the tab will navigate through every route…');
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_ALL_ROUTES' });
    if (!res?.ok) throw new Error(res?.error || 'bridge did not start');
  } catch (e) {
    setStatus(String(e?.message || e), 'err');
    capturePreviewBtn.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.fsePreviewWalk) return;
  const p = changes.fsePreviewWalk.newValue;
  renderWalk(p);
  if (p && (p.stage === 'done' || p.stage === 'error') && capturePreviewBtn) capturePreviewBtn.disabled = false;
});
chrome.storage.local.get(['fsePreviewWalk'], (r) => {
  if (r.fsePreviewWalk && Date.now() - (r.fsePreviewWalk.at || 0) < 10 * 60 * 1000) renderWalk(r.fsePreviewWalk);
});
