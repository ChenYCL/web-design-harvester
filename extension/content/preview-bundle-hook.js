/**
 * document_start, MAIN world, on the Figma editor (figma.com/site|make|design).
 *
 * Records the editor→preview data channel so an UNPUBLISHED site can be
 * restored:
 *
 *   getPage reply    -> { website, cmsBundle }   scene bundle, shape-compatible
 *                                                with a published /_json/<id>/<route>.json
 *   pushAssetData    -> { files: { name: Blob } } unpublished binary assets
 *
 * Both travel over the MessagePort the editor hands the preview iframe, so one
 * patch on MessagePort.prototype.postMessage sees everything the editor sends.
 *
 * Bundles are keyed by their ROOT GUID, never by a route name. The patch only
 * observes replies, and replies carry no request arguments, so a route label
 * can only be derived from the payload: guidToUrl[roots[0]]. That derivation
 * also verifies the capture — ask for /page-2, check that roots[0] matches.
 *
 * Why hook here rather than inside the iframe: the preview is an OOPIF whose
 * document cannot be reloaded from its own CDP session, so there is no reliable
 * way to arm a hook there before its first paint. The editor page can.
 *
 * Blobs are kept by reference; reading one needs `await blob.arrayBuffer()`,
 * which cannot happen inside the synchronous postMessage patch.
 */
(() => {
  if (window.__FSE_PREVIEW_CAP__) return;

  window.__FSE_PREVIEW_CAP__ = { seen: [], bundles: 0, blobs: 0, startedAt: Date.now() };
  window.__FSE_ROUTE_BUNDLES__ = {}; // rootGuid -> JSON string (MBs; keep as string)
  window.__FSE_ROUTE_LABELS__ = {};  // rootGuid -> route, resolved from the payload
  window.__FSE_BLOBS__ = {};         // "<sha1>.<ext>" -> Blob
  window.__FSE_CMS__ = null;

  const P = MessagePort.prototype;
  const origPost = P.postMessage;

  P.postMessage = function (msg) {
    try {
      const d = msg && msg.data !== undefined ? msg.data : msg;
      if (d && typeof d === 'object') {
        if (d.method) window.__FSE_PREVIEW_CAP__.seen.push(d.method);

        const ret = d.return;
        if (ret && ret.website && ret.website.nodeById && ret.website.roots) {
          const site = ret.website;
          const root = site.roots[0];
          const route = (site.guidToUrl || {})[root] || '/';
          window.__FSE_ROUTE_BUNDLES__[root] = JSON.stringify(site);
          window.__FSE_ROUTE_LABELS__[root] = route;
          if (ret.cmsBundle) window.__FSE_CMS__ = JSON.stringify(ret.cmsBundle);
          window.__FSE_PREVIEW_CAP__.bundles = Object.keys(window.__FSE_ROUTE_BUNDLES__).length;
          window.postMessage(
            {
              source: 'figma-sites-exporter',
              type: 'PREVIEW_BUNDLE_CAPTURED',
              rootGuid: root,
              route,
              nodes: Object.keys(site.nodeById).length,
              routes: site.guidToUrl || {},
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

  /** Called by lib/drain-preview.js once the preview has rendered. */
  window.__FSE_DRAIN_PREVIEW__ = async function drain() {
    const assets = {};
    for (const [name, b] of Object.entries(window.__FSE_BLOBS__ || {})) {
      try {
        const u8 = new Uint8Array(await b.arrayBuffer());
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        assets[name] = { b64: btoa(s), type: b.type, size: b.size };
      } catch (e) {
        assets[name] = { err: String(e).slice(0, 120) };
      }
    }
    return {
      rootGuids: Object.keys(window.__FSE_ROUTE_BUNDLES__ || {}),
      labels: window.__FSE_ROUTE_LABELS__ || {},
      assetCount: Object.keys(assets).length,
      stats: window.__FSE_PREVIEW_CAP__,
      assets,
    };
  };
})();
