/**
 * Drain what content/preview-bundle-hook.js captured and shape it into the
 * folder layout a published *.figma.site uses, so the result can be served
 * statically and hydrated by the real runtime.
 *
 * Produces (inside the export ZIP, under `preview-bundle/`):
 *   _json/<bundleId>/_index.json       captured scene bundle, one file per route
 *   _components/v2/<hash>.js|.css      bundle.compiledCode / bundle.globalStyles
 *   _assets/v11/<sha1>.<ext>           Blobs pushed via pushAssetData
 *   index.html                         boot shell (env:'published')
 *   preview-meta.json                  routes, node counts, asset inventory
 *
 * Videos are *not* embedded: unpublished VIDEO_ASSET entries are absolute signed
 * S3 URLs with a 7-day expiry. They are listed in preview-meta.json under
 * `videoUrls` so they can be fetched while the signature is still valid.
 */

const ASSETS_VERSION = 'v11';

function b64ToU8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bootHtml({ runtimePath, bundleId, sourceCodeHash, title }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    ${sourceCodeHash ? `<link rel="stylesheet" href="/_components/v2/${sourceCodeHash}.css" />` : ''}
    <title>${String(title || 'preview replay').replace(/[<>&]/g, '')}</title>
  </head>
  <body>
    <div id="container"></div>
    <script type="module">
      import { SitesRuntime } from '${runtimePath}';
      new SitesRuntime({
        container: document.getElementById('container'),
        env: 'published',
        bundleId: ${JSON.stringify(bundleId)},
        loadComponentsOverNetwork: true,
        assetsVersion: '${ASSETS_VERSION}',
        fontsVersion: 'v1',
        videosVersion: 'v1',
        codeComponentsVersion: 'v2',
        wasServerRendered: false,
        withBaseStyles: true,
        isFigmake: false,
        enableMetaTags: true,
      });
    </script>
  </body>
</html>
`;
}

/**
 * @param {{routes:string[], assets:Record<string,{b64?:string,type?:string,size?:number}>, stats:object}} drained
 *        result of window.__FSE_DRAIN_PREVIEW__()
 * @param {Record<string,string>} bundleStrings  route -> JSON string
 * @param {{fileKey:string, runtimePath?:string}} opts
 * @returns {{files:Record<string,Uint8Array|string>, meta:object}}
 */
export function buildPreviewBundlePack(drained, bundleStrings, opts = {}) {
  const bundleId = `preview-${opts.fileKey || 'site'}`.slice(0, 48);
  const runtimePath =
    opts.runtimePath || '/_runtimes/sites-runtime.js'; /* replaced at serve time */
  const files = {};
  const meta = {
    fileKey: opts.fileKey || null,
    bundleId,
    capturedAt: new Date().toISOString(),
    routes: [],
    nodeCounts: {},
    sourceCodeHash: null,
    videoUrls: {},
    assetCount: 0,
    stats: drained?.stats || null,
    note:
      'Serve this folder statically. Fetch the runtime referenced in index.html ' +
      'from any public *.figma.site and place it at the same path.',
  };

  let primary = null;
  for (const [route, json] of Object.entries(bundleStrings || {})) {
    let bundle;
    try {
      bundle = JSON.parse(json);
    } catch {
      continue;
    }
    // Signed absolute asset URLs must become the basenames the runtime requests.
    for (const a of Object.values(bundle.assets || {})) {
      if (typeof a.url === 'string' && /^https?:/i.test(a.url)) {
        let base = a.url;
        try {
          base = new URL(a.url).pathname.split('/').pop() || a.url;
        } catch { /* keep as-is */ }
        if (a.type === 'VIDEO_ASSET') meta.videoUrls[base] = a.url;
        a.url = base;
      }
    }
    const name = route === '/' ? '_index' : route.replace(/^\//, '').replace(/\//g, '_');
    files[`_json/${bundleId}/${name}.json`] = JSON.stringify(bundle);
    meta.routes.push(route);
    meta.nodeCounts[route] = Object.keys(bundle.nodeById || {}).length;
    if (route === '/' || !primary) primary = bundle;
  }

  if (primary) {
    meta.sourceCodeHash = primary.sourceCodeHash || null;
    if (primary.sourceCodeHash) {
      if (primary.compiledCode) {
        files[`_components/v2/${primary.sourceCodeHash}.js`] = primary.compiledCode;
      }
      if (primary.globalStyles) {
        files[`_components/v2/${primary.sourceCodeHash}.css`] = primary.globalStyles;
      }
    }
    files['index.html'] = bootHtml({
      runtimePath,
      bundleId,
      sourceCodeHash: primary.sourceCodeHash,
      title: (primary.siteSettings || {}).title,
    });
  }

  for (const [name, v] of Object.entries(drained?.assets || {})) {
    if (!v || !v.b64) continue;
    files[`_assets/${ASSETS_VERSION}/${name}`] = b64ToU8(v.b64);
    meta.assetCount++;
  }

  files['preview-meta.json'] = JSON.stringify(meta, null, 2);
  return { files, meta };
}

/** Write a pack into an existing JSZip under `preview-bundle/`. */
export function mergePreviewBundleIntoZip(zip, pack) {
  const folder = zip.folder('preview-bundle');
  for (const [rel, body] of Object.entries(pack.files)) folder.file(rel, body);
  return pack.meta;
}
