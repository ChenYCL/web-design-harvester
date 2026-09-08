/**
 * Pipeline C, stage 2 — build a standalone, multi-route replay site.
 *
 * A captured preview bundle is shape-compatible with a published
 * `_json/<bundleId>/<route>.json`. Lay every captured route out that way and
 * the real runtime hydrates them in `env:'published'` mode, unaware the site
 * was never published. A published-bundle control measures 0.0000% pixel
 * difference against the live site.
 *
 * Layout produced (mirrors a real *.figma.site):
 *   index.html                             boot shell
 *   server.mjs                             static server WITH SPA fallback
 *   _runtimes/sites-runtime.<hash>.js      pulled from any public figma.site
 *   _json/<bundleId>/_index.json           route '/'
 *   _json/<bundleId>/<route>.json          one per captured route
 *   _components/v2/<sourceCodeHash>.js|css compiledCode / globalStyles
 *   _assets/<assetsVersion>/<sha1>.<ext>   Blobs captured from pushAssetData
 *   _videos/v1/<sha1>                      fetched from signed URLs in bundles
 *   _woff/...                              fonts referenced by the runtime
 *
 * Three rewrites that are easy to miss:
 *   1. Unpublished VIDEO_ASSET entries are absolute *signed* S3 URLs
 *      (X-Amz-Expires=604800). Published mode builds `/_videos/v1/<name>`, so
 *      reduce to basename and fetch the bytes while the signature is valid.
 *   2. `wasServerRendered` must be false — no pre-rendered DOM to adopt.
 *   3. The SPA fallback is required: visiting /page-2 directly must serve
 *      index.html, or the runtime never boots to ask for that route's JSON.
 *
 *   node src/kiwi/replay-build.mjs <captureDir> [outDir]
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync } from 'fs';
import path from 'path';

// The runtime and the bundle are versioned together. A runtime from an
// unrelated site parses a bundle it does not match and dies inside its own
// hydration with `Object.entries(undefined)`. Prefer the site's own published
// host; fall back to a public one only when the site was never published, and
// say so loudly because that combination can break.
const RUNTIME_SOURCE = process.env.RUNTIME_SOURCE || '';
const RUNTIME_FALLBACK = 'https://design.figma.site';
const ASSETS_VERSION = process.env.ASSETS_VERSION || 'v11';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const log = (...a) => console.error('[replay-build]', ...a);

/** Cloudflare 403s default tool user agents on figma.site; always send a browser UA. */
async function get(url, asText = false) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(0, 90)}`);
  return asText ? await r.text() : Buffer.from(await r.arrayBuffer());
}

async function resolveRuntime(publishedUrl) {
  const sources = [publishedUrl, RUNTIME_SOURCE, RUNTIME_FALLBACK].filter(Boolean);
  const tried = [];
  for (const src of sources) {
    const origin = String(src).replace(/\/+$/, '');
    try {
      const html = await get(origin + '/', true);
      const m = html.match(/\/_runtimes\/sites-runtime\.[a-f0-9]+\.js/);
      if (!m) { tried.push(origin + ': no runtime reference'); continue; }
      const fonts = [...new Set(html.match(/\/_woff\/[^"')\s]+/g) || [])];
      const reset = (html.match(/<style id="reset-css">[\s\S]*?<\/style>/) || [''])[0];
      const matched = origin === String(publishedUrl || '').replace(/\/+$/, '');
      if (!matched) {
        log('WARNING: runtime taken from ' + origin + ', not the site own host.');
        log('         Runtime and bundle are versioned together; a mismatch fails');
        log('         at hydration. Pass PUBLISHED_URL=https://<slug>.figma.site to fix.');
      }
      return { path: m[0], url: origin + m[0], fonts, reset, origin, matched };
    } catch (e) { tried.push(origin + ': ' + e.message); }
  }
  throw new Error('no usable runtime source. Tried:\n  ' + tried.join('\n  '));
}

function bootHtml({ runtimePath, bundleId, sourceCodeHash, title, resetCss }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <link rel="preload" href="${runtimePath}" as="script" crossorigin />
    ${resetCss}
    ${sourceCodeHash ? `<link rel="stylesheet" href="/_components/v2/${sourceCodeHash}.css" />` : ''}
    <title>${String(title || 'replay').replace(/[<>&]/g, '')}</title>
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
        assetsVersion: ${JSON.stringify(ASSETS_VERSION)},
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

const SERVER_MJS = `#!/usr/bin/env node
// Static server with SPA fallback. Client routes such as /page-2 must serve
// index.html so the runtime can boot and then fetch that route's JSON.
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8900);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(ROOT, p.replace(/^\\//, ''));
  const isFile = existsSync(file) && statSync(file).isFile();
  if (!isFile) file = path.join(ROOT, 'index.html'); // SPA fallback
  if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => {
  console.log('replay serving http://127.0.0.1:' + PORT + '/');
});
`;

export async function buildReplay({ captureDir, outDir } = {}) {
  captureDir = captureDir || 'rehearsal/preview-capture';
  outDir = outDir || 'rehearsal/replay';
  const metaPath = path.join(captureDir, 'capture-meta.json');
  if (!existsSync(metaPath)) throw new Error(`no capture-meta.json in ${captureDir}`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const bundleId = `preview-${meta.fileKey}`.slice(0, 48);

  const bundleFiles = readdirSync(captureDir).filter((f) => /^bundle_.*\.json$/.test(f));
  if (!bundleFiles.length) throw new Error(`no bundle_*.json in ${captureDir}`);

  const publishedUrl = process.env.PUBLISHED_URL || meta.publishedUrl || '';
  const rt = await resolveRuntime(publishedUrl);
  log('runtime', rt.path.slice(0, 46) + '...', 'from', rt.origin, rt.matched ? '(site own)' : '(FALLBACK)');

  mkdirSync(path.join(outDir, path.dirname(rt.path).replace(/^\//, '')), { recursive: true });
  mkdirSync(path.join(outDir, '_json', bundleId), { recursive: true });
  mkdirSync(path.join(outDir, '_components', 'v2'), { recursive: true });
  mkdirSync(path.join(outDir, '_assets', ASSETS_VERSION), { recursive: true });
  mkdirSync(path.join(outDir, '_videos', 'v1'), { recursive: true });

  writeFileSync(path.join(outDir, rt.path.replace(/^\//, '')), await get(rt.url));

  const videoUrls = new Map();
  const routes = [];
  let primary = null;
  const hashes = new Set();

  for (const bf of bundleFiles) {
    const bundle = JSON.parse(readFileSync(path.join(captureDir, bf), 'utf8'));
    for (const a of Object.values(bundle.assets || {})) {
      if (typeof a.url === 'string' && /^https?:/i.test(a.url)) {
        let base = a.url;
        try { base = path.basename(new URL(a.url).pathname); } catch { /* keep */ }
        if (base) {
          if (a.type === 'VIDEO_ASSET') videoUrls.set(base, a.url);
          a.url = base;
        }
      }
    }
    const rootGuid = (bundle.roots || [])[0];
    const route = (bundle.guidToUrl || {})[rootGuid] || '/';
    const name = route === '/' ? '_index' : route.replace(/^\//, '').replace(/\//g, '_');
    writeFileSync(path.join(outDir, '_json', bundleId, `${name}.json`), JSON.stringify(bundle));
    routes.push({ route, file: `${name}.json`, nodes: Object.keys(bundle.nodeById || {}).length });

    const sch = bundle.sourceCodeHash;
    if (sch && !hashes.has(sch)) {
      hashes.add(sch);
      if (bundle.compiledCode) writeFileSync(path.join(outDir, '_components', 'v2', `${sch}.js`), bundle.compiledCode);
      if (bundle.globalStyles) writeFileSync(path.join(outDir, '_components', 'v2', `${sch}.css`), bundle.globalStyles);
    }
    if (route === '/' || !primary) primary = bundle;
    log(`route ${route} -> _json/${bundleId}/${name}.json (${routes.at(-1).nodes} nodes)`);
  }

  // Assets captured from pushAssetData.
  let copied = 0;
  const assetSrc = path.join(captureDir, 'assets');
  if (existsSync(assetSrc)) {
    for (const f of readdirSync(assetSrc)) {
      copyFileSync(path.join(assetSrc, f), path.join(outDir, '_assets', ASSETS_VERSION, f));
      copied++;
    }
  }

  // Fonts: the runtime requests the same /_woff paths a published site preloads.
  let fonts = 0;
  for (const f of rt.fonts) {
    try {
      mkdirSync(path.join(outDir, path.dirname(f).replace(/^\//, '')), { recursive: true });
      // Must come from the same origin the runtime came from — RUNTIME_SOURCE is
      // empty when the origin was resolved from PUBLISHED_URL instead.
      writeFileSync(path.join(outDir, f.replace(/^\//, '')), await get(rt.origin + f));
      fonts++;
    } catch { /* optional */ }
  }

  // Videos live under /_videos/v1/<sha1> (no extension), never under /_assets.
  let vids = 0;
  for (const [name, url] of videoUrls) {
    try { writeFileSync(path.join(outDir, '_videos', 'v1', name), await get(url)); vids++; }
    catch (e) { log('video failed', name.slice(0, 12), String(e.message).slice(0, 50)); }
  }

  writeFileSync(path.join(outDir, 'index.html'), bootHtml({
    runtimePath: rt.path, bundleId, sourceCodeHash: primary.sourceCodeHash,
    title: (primary.siteSettings || {}).title, resetCss: rt.reset,
  }));
  writeFileSync(path.join(outDir, 'server.mjs'), SERVER_MJS);

  const report = {
    builtAt: new Date().toISOString(),
    fileKey: meta.fileKey,
    bundleId,
    runtime: rt.path,
    runtimeOrigin: rt.origin,
    runtimeMatchesSite: rt.matched,
    routes,
    components: [...hashes],
    assets: copied,
    fonts,
    videos: `${vids}/${videoUrls.size}`,
    serve: `node ${path.join(outDir, 'server.mjs')}`,
  };
  writeFileSync(path.join(outDir, 'replay-report.json'), JSON.stringify(report, null, 2));
  log(`done: ${routes.length} routes, ${copied} assets, ${fonts} fonts, ${vids} videos -> ${outDir}`);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildReplay({ captureDir: process.argv[2], outDir: process.argv[3] })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error('[replay-build:FAIL]', e?.stack || e); process.exit(1); });
}
