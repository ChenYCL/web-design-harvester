/**
 * Runs inside preview iframe / published *.figma.site frames.
 * Responds to CAPTURE_SITE for WYSIWYG static export.
 */
(() => {
  if (window.__FIGMA_SITES_EXPORTER_PREVIEW__) return;
  window.__FIGMA_SITES_EXPORTER_PREVIEW__ = true;

  function isShell() {
    const t = (document.body?.innerText || '').slice(0, 80);
    return /messagePort|allowedOrigins/.test(t) && document.querySelectorAll('body *').length < 20;
  }

  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL(path);
      s.onload = () => {
        s.remove();
        resolve();
      };
      s.onerror = () => {
        s.remove();
        reject(new Error('failed to load ' + path));
      };
      (document.documentElement || document.head).appendChild(s);
    });
  }

  async function captureSite() {
    if (isShell()) return { ok: false, error: 'preview still shell — open Full preview and wait' };
    await loadScript('lib/capture-site.js');
    // Listen BEFORE run-capture posts (onload races otherwise).
    const resultPromise = new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'capture timeout' }), 30000);
      const onMsg = (ev) => {
        if (ev.data?.source === 'figma-sites-exporter' && ev.data?.type === 'CAPTURE_RESULT') {
          clearTimeout(t);
          window.removeEventListener('message', onMsg);
          resolve(ev.data.result || { ok: false, error: 'empty result' });
        }
      };
      window.addEventListener('message', onMsg);
    });
    await loadScript('lib/run-capture.js');
    return await resultPromise;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'PING_PREVIEW') {
      sendResponse({
        ok: true,
        shell: isShell(),
        href: location.href,
        title: document.title,
      });
      return;
    }
    if (msg?.type === 'CAPTURE_SITE') {
      captureSite()
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
  });

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.source !== 'figma-sites-exporter') return;
    if (d.type === 'CAPTURE_SITE') {
      const result = await captureSite().catch((e) => ({ ok: false, error: String(e?.message || e) }));
      window.postMessage(
        { source: 'figma-sites-exporter', type: 'CAPTURE_SITE_RESULT', requestId: d.requestId, result },
        '*',
      );
      chrome.runtime.sendMessage({
        type: 'CAPTURE_SITE_RESULT',
        requestId: d.requestId,
        result,
      }).catch(() => {});
    }
  });

  // Announce
  try {
    fetch('http://127.0.0.1:8788/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'preview-frame',
        message: 'preview_script_loaded',
        data: { href: location.href, shell: isShell() },
        ts: Date.now(),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* ignore */ }
})();
