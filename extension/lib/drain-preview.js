/**
 * MAIN-world bridge for the preview capture.
 *
 * content/preview-bundle-hook.js runs in the MAIN world and holds the captured
 * bundles and Blobs on `window`. Content scripts live in an isolated world and
 * cannot reach those objects, so this script is injected on demand, drains the
 * capture, and hands it back over `window.postMessage`.
 *
 * Bundles are megabytes, so everything is chunked: one CHUNK message per slice,
 * then a DONE message. The listener reassembles.
 */
(() => {
  const CHUNK = 512 * 1024;
  const id = document.currentScript?.dataset?.fseId || 'drain';
  const post = (payload) =>
    window.postMessage({ source: 'figma-sites-exporter', id, ...payload }, '*');

  (async () => {
    try {
      if (typeof window.__FSE_DRAIN_PREVIEW__ !== 'function') {
        post({ type: 'PREVIEW_DRAIN_ERROR', error: 'hook not installed — reload the editor tab' });
        return;
      }
      const drained = await window.__FSE_DRAIN_PREVIEW__();
      const bundles = window.__FSE_BUNDLES__ || {};
      const routes = Object.keys(bundles);
      if (!routes.length) {
        post({ type: 'PREVIEW_DRAIN_ERROR', error: 'no getPage bundle captured — open Full preview first' });
        return;
      }

      post({
        type: 'PREVIEW_DRAIN_BEGIN',
        routes,
        stats: drained.stats || null,
        assetCount: drained.assetCount || 0,
      });

      for (const route of routes) {
        const s = bundles[route];
        const total = Math.ceil(s.length / CHUNK);
        for (let i = 0, n = 0; i < s.length; i += CHUNK, n++) {
          post({ type: 'PREVIEW_DRAIN_CHUNK', kind: 'bundle', route, n, total, data: s.slice(i, i + CHUNK) });
        }
      }

      // Assets are already base64 in `drained.assets`; ship them as one JSON stream.
      const assetJson = JSON.stringify(drained.assets || {});
      const aTotal = Math.ceil(assetJson.length / CHUNK);
      for (let i = 0, n = 0; i < assetJson.length; i += CHUNK, n++) {
        post({ type: 'PREVIEW_DRAIN_CHUNK', kind: 'assets', n, total: aTotal, data: assetJson.slice(i, i + CHUNK) });
      }

      post({ type: 'PREVIEW_DRAIN_DONE', routes, assetBytes: assetJson.length });
    } catch (e) {
      post({ type: 'PREVIEW_DRAIN_ERROR', error: String(e?.message || e).slice(0, 300) });
    }
  })();
})();
