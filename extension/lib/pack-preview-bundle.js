/**
 * Shape captured preview data into the folder layout a published *.figma.site
 * uses, so the result serves statically and hydrates through the real runtime.
 *
 * Multi-route: one `_json/<bundleId>/<route>.json` per captured bundle, and
 * one `_components/v2/<hash>.{js,css}` pair per distinct sourceCodeHash. Each
 * bundle labels itself from `guidToUrl[roots[0]]`.
 *
 * What the ZIP cannot contain, and why:
 *   - the runtime and fonts. `*.figma.site` sends no CORS headers, so a
 *     content script on figma.com cannot fetch them. They are versioned with
 *     the bundle and MUST come from the site's own host, so `server.mjs`
 *     downloads them on first start (Node has no CORS) when PUBLISHED_URL is
 *     known. If the main Export set a Published URL, `published/_runtimes/`
 *     already has the matching file too.
 *   - videos are included when the caller fetched them (signed S3 URLs live on
 *     www.figma.com, same origin as the editor, so that fetch works).
 */

const ASSETS_VERSION = 'v11';

function b64ToU8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bootHtml({ bundleId, sourceCodeHash, title }) {
  // The runtime path is filled in by server.mjs once it has fetched the file;
  // until then the placeholder keeps the boot shell valid.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <!--RESET_CSS-->
    ${sourceCodeHash ? `<link rel="stylesheet" href="/_components/v2/${sourceCodeHash}.css" />` : ''}
    <title>${String(title || 'preview replay').replace(/[<>&]/g, '')}</title>
  </head>
  <body>
    <div id="container"></div>
    <script type="module">
      import { SitesRuntime } from '__RUNTIME_PATH__';
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

const SERVER_MJS = `#!/usr/bin/env node
// Static server with SPA fallback + one-time bootstrap of the runtime.
//
//   PUBLISHED_URL=https://<slug>.figma.site node server.mjs
//
// The runtime and the bundle are versioned together; a runtime from another
// site fails inside hydration. Fetch it from the site's own host once, then
// serve everything locally.
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8900);
const META = JSON.parse(readFileSync(path.join(ROOT, 'preview-meta.json'), 'utf8'));
const PUBLISHED = (process.env.PUBLISHED_URL || META.publishedUrl || '').replace(/\\/+$/, '');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0 Safari/537.36';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return Buffer.from(await r.arrayBuffer());
}

async function bootstrap() {
  const rtDir = path.join(ROOT, '_runtimes');
  const have = existsSync(rtDir) && readdirSync(rtDir).find((f) => /^sites-runtime\\..*\\.js$/.test(f));
  let runtimePath = have ? '/_runtimes/' + have : null;
  let reset = '';
  if (!runtimePath) {
    if (!PUBLISHED) {
      console.error('No runtime present and no PUBLISHED_URL given.');
      console.error('Run:  PUBLISHED_URL=https://<slug>.figma.site node server.mjs');
      console.error('Or copy _runtimes/ from the main export\\'s published/ folder.');
      process.exit(1);
    }
    console.log('bootstrapping runtime from', PUBLISHED);
    const html = (await get(PUBLISHED + '/')).toString('utf8');
    const m = html.match(/\\/_runtimes\\/sites-runtime\\.[a-f0-9]+\\.js/);
    if (!m) throw new Error('no runtime reference at ' + PUBLISHED);
    runtimePath = m[0];
    mkdirSync(rtDir, { recursive: true });
    writeFileSync(path.join(ROOT, runtimePath), await get(PUBLISHED + runtimePath));
    reset = (html.match(/<style id="reset-css">[\\s\\S]*?<\\/style>/) || [''])[0];
    for (const f of new Set(html.match(/\\/_woff\\/[^"')\\s]+/g) || [])) {
      try {
        mkdirSync(path.join(ROOT, path.dirname(f)), { recursive: true });
        writeFileSync(path.join(ROOT, f), await get(PUBLISHED + f));
      } catch { /* optional */ }
    }
    for (const [name, url] of Object.entries(META.videoUrls || {})) {
      const dest = path.join(ROOT, '_videos', 'v1', name);
      if (existsSync(dest)) continue;
      try { mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, await get(url)); }
      catch (e) { console.warn('video skipped', name.slice(0, 12), e.message.slice(0, 60)); }
    }
    console.log('runtime ready:', runtimePath);
  }
  const idx = path.join(ROOT, 'index.html');
  let html = readFileSync(idx, 'utf8').replace('__RUNTIME_PATH__', runtimePath);
  if (reset) html = html.replace('<!--RESET_CSS-->', reset);
  writeFileSync(idx, html);
}

await bootstrap();
createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(ROOT, p.replace(/^\\//, ''));
  if (!(existsSync(file) && statSync(file).isFile())) file = path.join(ROOT, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log('replay serving http://127.0.0.1:' + PORT + '/'));
`;

/**
 * @param {{
 *   bundles: Record<string,string>,        rootGuid -> JSON string
 *   assets?: Record<string,{b64?:string,type?:string,size?:number}>,
 *   videos?: Record<string,Uint8Array>,    basename -> bytes (already fetched)
 *   fileKey?: string,
 *   publishedUrl?: string,
 * }} input
 * @returns {{ files: Record<string, Uint8Array|string>, meta: object }}
 */
export function buildPreviewBundlePack(input) {
  const { bundles = {}, assets = {}, videos = {}, fileKey = 'site', publishedUrl = '' } = input;
  const bundleId = `preview-${fileKey}`.slice(0, 48);
  const files = {};
  const meta = {
    fileKey,
    bundleId,
    publishedUrl: publishedUrl || null,
    capturedAt: new Date().toISOString(),
    routes: [],
    components: [],
    videoUrls: {},
    videosIncluded: 0,
    assetCount: 0,
    runtime: 'not included — fetched by server.mjs from the site\'s own host (versioned with the bundle)',
  };

  let primary = null;
  const hashes = new Set();

  for (const [rootGuid, json] of Object.entries(bundles)) {
    let bundle;
    try { bundle = JSON.parse(json); } catch { continue; }

    for (const a of Object.values(bundle.assets || {})) {
      if (typeof a.url === 'string' && /^https?:/i.test(a.url)) {
        let base = a.url;
        try { base = new URL(a.url).pathname.split('/').pop() || a.url; } catch { /* keep */ }
        if (a.type === 'VIDEO_ASSET' && !videos[base]) meta.videoUrls[base] = a.url;
        a.url = base;
      }
    }

    const route = (bundle.guidToUrl || {})[rootGuid] || '/';
    const name = route === '/' ? '_index' : route.replace(/^\//, '').replace(/\//g, '_');
    files[`_json/${bundleId}/${name}.json`] = JSON.stringify(bundle);
    meta.routes.push({ route, rootGuid, file: `${name}.json`, nodes: Object.keys(bundle.nodeById || {}).length });

    const sch = bundle.sourceCodeHash;
    if (sch && !hashes.has(sch)) {
      hashes.add(sch);
      if (bundle.compiledCode) files[`_components/v2/${sch}.js`] = bundle.compiledCode;
      if (bundle.globalStyles) files[`_components/v2/${sch}.css`] = bundle.globalStyles;
    }
    if (route === '/' || !primary) primary = bundle;
  }
  meta.components = [...hashes];

  for (const [name, v] of Object.entries(assets)) {
    if (!v || !v.b64) continue;
    files[`_assets/${ASSETS_VERSION}/${name}`] = b64ToU8(v.b64);
    meta.assetCount++;
  }
  for (const [name, bytes] of Object.entries(videos)) {
    files[`_videos/v1/${name}`] = bytes;
    meta.videosIncluded++;
  }

  if (primary) {
    files['index.html'] = bootHtml({
      bundleId,
      sourceCodeHash: primary.sourceCodeHash,
      title: (primary.siteSettings || {}).title,
    });
  }
  files['server.mjs'] = SERVER_MJS;
  files['preview-meta.json'] = JSON.stringify(meta, null, 2);
  files['README.md'] = `# preview-bundle/

Scene bundles captured from the editor preview — ${meta.routes.length} route(s):
${meta.routes.map((r) => `- \`${r.route}\` (${r.nodes} nodes)`).join('\n')}

Serve it through the real runtime:

\`\`\`bash
PUBLISHED_URL=${publishedUrl || 'https://<slug>.figma.site'} node server.mjs
# → http://127.0.0.1:8900/   (client routes like /page-2 resolve via SPA fallback)
\`\`\`

\`server.mjs\` fetches the runtime, fonts and any videos it does not yet have on
first start. It must be the site's **own** runtime: the runtime and the bundle
are versioned together, and a mismatch fails during hydration.
`;
  return { files, meta };
}

/** Write a pack into an existing JSZip under \`preview-bundle/\`. */
export function mergePreviewBundleIntoZip(zip, pack) {
  const folder = zip.folder('preview-bundle');
  for (const [rel, body] of Object.entries(pack.files)) folder.file(rel, body);
  return pack.meta;
}
