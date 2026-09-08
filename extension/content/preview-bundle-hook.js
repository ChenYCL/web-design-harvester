/**
 * document_start, MAIN world, on the Figma editor (figma.com/site|make|design).
 *
 * Captures the *preview* data channel so an UNPUBLISHED site can be restored:
 *
 *   getPage       reply -> { website, cmsBundle }   the scene bundle, shape-
 *                                                   compatible with a published
 *                                                   /_json/<id>/_index.json
 *   pushAssetData args  -> { files: { name: Blob } } unpublished binary assets,
 *                                                   one Blob per file
 *
 * Both travel over the MessagePort the editor hands to the preview iframe, so a
 * single patch on MessagePort.prototype.postMessage sees everything the editor
 * sends. Hooking here rather than inside the iframe is deliberate: the preview
 * is an OOPIF whose document cannot be reloaded from its own CDP session, so
 * there is no reliable way to install a hook there before its first paint.
 *
 * Blobs are kept by reference — reading them needs `await blob.arrayBuffer()`,
 * which cannot happen inside the synchronous postMessage patch.
 */
(() => {
  if (window.__FSE_PREVIEW_CAP__) return;

  window.__FSE_PREVIEW_CAP__ = { methods: {}, blobs: 0, bundles: 0, startedAt: Date.now() };
  window.__FSE_BUNDLES__ = {}; // route -> JSON string (kept as string; these are MBs)
  window.__FSE_BLOBS__ = {}; // "<sha1>.<ext>" -> Blob
  window.__FSE_CMS__ = null;

  const P = MessagePort.prototype;
  const origPost = P.postMessage;

  P.postMessage = function (msg) {
    try {
      const d = msg && msg.data !== undefined ? msg.data : msg;
      if (d && typeof d === 'object') {
        if (d.method) {
          window.__FSE_PREVIEW_CAP__.methods[d.method] =
            (window.__FSE_PREVIEW_CAP__.methods[d.method] || 0) + 1;
        }
        if (d.method === 'getPage' && d.args && d.args.url) {
          window.__FSE_LAST_ROUTE__ = d.args.url;
        }
        const ret = d.return;
        if (ret && ret.website && ret.website.nodeById) {
          const route = (d.args && d.args.url) || window.__FSE_LAST_ROUTE__ || '/';
          window.__FSE_BUNDLES__[route] = JSON.stringify(ret.website);
          if (ret.cmsBundle) window.__FSE_CMS__ = JSON.stringify(ret.cmsBundle);
          window.__FSE_PREVIEW_CAP__.bundles = Object.keys(window.__FSE_BUNDLES__).length;
          window.postMessage(
            {
              source: 'figma-sites-exporter',
              type: 'PREVIEW_BUNDLE_CAPTURED',
              route,
              nodes: Object.keys(ret.website.nodeById).length,
            },
            '*',
          );
        }
        if (d.method === 'pushAssetData' && d.args && d.args.files) {
          for (const [name, val] of Object.entries(d.args.files)) {
            window.__FSE_BLOBS__[name] = val;
            window.__FSE_PREVIEW_CAP__.blobs++;
          }
        }
      }
    } catch {
      /* never break the editor */
    }
    return origPost.apply(this, arguments);
  };

  /** Called by the content script once the preview has finished rendering. */
  window.__FSE_DRAIN_PREVIEW__ = async function drain() {
    const assets = {};
    for (const [name, b] of Object.entries(window.__FSE_BLOBS__ || {})) {
      try {
        const u8 = new Uint8Array(await b.arrayBuffer());
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) {
          s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        }
        assets[name] = { b64: btoa(s), type: b.type, size: b.size };
      } catch (e) {
        assets[name] = { err: String(e).slice(0, 120) };
      }
    }
    return {
      routes: Object.keys(window.__FSE_BUNDLES__ || {}),
      assetCount: Object.keys(assets).length,
      stats: window.__FSE_PREVIEW_CAP__,
      assets,
    };
  };
})();
