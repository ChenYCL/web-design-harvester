/**
 * Isolated-world bridge: exposes the preview capture as a runtime message.
 *
 * Deliberately additive — it does not touch the existing Export ZIP flow in
 * editor.js. Send `CAPTURE_PREVIEW_BUNDLE` to this tab and it returns the
 * captured scene bundles plus base64 assets, already shaped by
 * lib/pack-preview-bundle.js into the published folder layout.
 */
(() => {
  if (window.__FSE_PREVIEW_BRIDGE__) return;
  window.__FSE_PREVIEW_BRIDGE__ = true;

  function fileKeyFromUrl(href = location.href) {
    return (href.match(/\/(?:site|make|design|file)\/([a-zA-Z0-9]+)/) || [])[1] || null;
  }

  function drain(timeoutMs = 120000) {
    return new Promise((resolve) => {
      const id = 'fse_drain_' + Math.random().toString(36).slice(2);
      const bundleParts = {};
      let assetParts = '';
      let begin = null;

      const done = (result) => {
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => done({ ok: false, error: 'drain timeout' }), timeoutMs);

      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.source !== 'figma-sites-exporter' || d.id !== id) return;
        if (d.type === 'PREVIEW_DRAIN_ERROR') return done({ ok: false, error: d.error });
        if (d.type === 'PREVIEW_DRAIN_BEGIN') { begin = d; return; }
        if (d.type === 'PREVIEW_DRAIN_CHUNK') {
          if (d.kind === 'bundle') bundleParts[d.route] = (bundleParts[d.route] || '') + d.data;
          else assetParts += d.data;
          return;
        }
        if (d.type === 'PREVIEW_DRAIN_DONE') {
          let assets = {};
          try { assets = JSON.parse(assetParts || '{}'); } catch { /* keep empty */ }
          done({ ok: true, bundles: bundleParts, assets, stats: begin?.stats || null, routes: d.routes });
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'CAPTURE_PREVIEW_BUNDLE') return;
    (async () => {
      const raw = await drain(msg.timeoutMs || 120000);
      if (!raw.ok) return sendResponse(raw);
      try {
        const { buildPreviewBundlePack } = await import(
          chrome.runtime.getURL('lib/pack-preview-bundle.js')
        );
        const pack = buildPreviewBundlePack(
          { assets: raw.assets, stats: raw.stats },
          raw.bundles,
          { fileKey: fileKeyFromUrl() },
        );
        // Uint8Array does not survive sendResponse; hand back base64 for assets.
        sendResponse({
          ok: true,
          meta: pack.meta,
          textFiles: Object.fromEntries(
            Object.entries(pack.files).filter(([, v]) => typeof v === 'string'),
          ),
          assetsB64: raw.assets,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e).slice(0, 300) });
      }
    })();
    return true;
  });
})();
