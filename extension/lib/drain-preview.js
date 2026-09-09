/**
 * MAIN-world bridge for the preview capture.
 *
 * content/preview-bundle-hook.js holds captured bundles and Blobs on `window`
 * in the MAIN world, which an isolated-world content script cannot read. This
 * script is injected on demand, drains the capture, and hands it back over
 * window.postMessage in chunks (bundles are megabytes).
 *
 * Bundles are sent keyed by root guid; the receiver labels them from the
 * payload's own guidToUrl.
 */
(() => {
  const CHUNK = 512 * 1024;
  const id = document.currentScript?.dataset?.fseId || 'drain';
  const post = (payload) => window.postMessage({ source: 'figma-sites-exporter', id, ...payload }, '*');

  (async () => {
    try {
      if (typeof window.__FSE_DRAIN_PREVIEW__ !== 'function') {
        post({ type: 'PREVIEW_DRAIN_ERROR', error: 'hook not installed — reload the editor tab' });
        return;
      }
      const drained = await window.__FSE_DRAIN_PREVIEW__();
      const bundles = window.__FSE_ROUTE_BUNDLES__ || {};
      const guids = Object.keys(bundles);

      post({
        type: 'PREVIEW_DRAIN_BEGIN',
        rootGuids: guids,
        labels: drained.labels || {},
        stats: drained.stats || null,
        assetCount: drained.assetCount || 0,
      });

      for (const guid of guids) {
        const s = bundles[guid];
        const total = Math.ceil(s.length / CHUNK);
        for (let i = 0, n = 0; i < s.length; i += CHUNK, n++) {
          post({ type: 'PREVIEW_DRAIN_CHUNK', kind: 'bundle', key: guid, n, total, data: s.slice(i, i + CHUNK) });
        }
      }

      const assetJson = JSON.stringify(drained.assets || {});
      const aTotal = Math.ceil(assetJson.length / CHUNK);
      for (let i = 0, n = 0; i < assetJson.length; i += CHUNK, n++) {
        post({ type: 'PREVIEW_DRAIN_CHUNK', kind: 'assets', n, total: aTotal, data: assetJson.slice(i, i + CHUNK) });
      }

      post({ type: 'PREVIEW_DRAIN_DONE', rootGuids: guids, assetBytes: assetJson.length });
    } catch (e) {
      post({ type: 'PREVIEW_DRAIN_ERROR', error: String(e?.message || e).slice(0, 300) });
    }
  })();
})();
