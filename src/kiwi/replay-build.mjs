/**
 * Pipeline C, stage 2 — build a standalone replay site from a preview capture.
 *
 * The trick: a captured preview `website` bundle is shape-compatible with a
 * published `_index.json`. Lay it out the way the published host does and the
 * *real* runtime will hydrate it in `env:'published'` mode with no idea it was
 * never published. Measured against a live published site this reproduces the
 * page at 0.0000% pixel difference.
 *
 * Layout produced (mirrors a real *.figma.site):
 *   index.html
 *   _runtimes/sites-runtime.<hash>.js      pulled from a public figma.site
 *   _json/<bundleId>/_index.json           captured bundle, per route
 *   _components/v2/<sourceCodeHash>.js     bundle.compiledCode
 *   _components/v2/<sourceCodeHash>.css    bundle.globalStyles
 *   _assets/<assetsVersion>/<sha1>.<ext>   captured Blobs
 *   _videos/v1/<sha1>                      fetched from signed URLs in the bundle
 *
 * Two rewrites are required and easy to miss:
 *   1. Unpublished VIDEO_ASSET entries carry absolute *signed* S3 URLs
 *      (X-Amz-Expires=604800). Published-mode `getAssetURL` builds
 *      `/_videos/v1/<name>`, so the URL must be reduced to its basename and the
 *      bytes fetched while the signature is still valid.
 *   2. `wasServerRendered` must be false — unlike a published page there is no
 *      pre-rendered DOM inside #container for the runtime to adopt.
 *
 * Usage:
 *   node src/kiwi/replay-build.mjs <captureDir> [outDir]
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync } from 'fs';
import path from 'path';

const CAPTURE_DIR = process.argv[2] || 'rehearsal/preview-capture';
const OUT_DIR = process.argv[3] || 'rehearsal/replay';
const RUNTIME_SOURCE = process.env.RUNTIME_SOURCE || 'https://design.figma.site';
const ASSETS_VERSION = process.env.ASSETS_VERSION || 'v11';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const log = (...a) => console.error('[replay-build]', ...a);

/** Cloudflare 403s the default Node/py UA on figma.site; always send a browser UA. */
async function get(url, asText = false) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return asText ? await r.text() : Buffer.from(await r.arrayBuffer());
}

/** Discover the current runtime URL from any public published site. */
async function resolveRuntimeUrl() {
  const html = await get(RUNTIME_SOURCE + '/', true);
  const m = html.match(/\/_runtimes\/sites-runtime\.[a-f0-9]+\.js/);
  if (!m) throw new Error(`no runtime reference found at ${RUNTIME_SOURCE}`);
  return { path: m[0], url: RUNTIME_SOURCE + m[0], html };
}

function resetCssFrom(html) {
  const m = html.match(/<style id="reset-css">[\s\S]*?<\/style>/);
  return m ? m[0] : '';
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
    <title>${(title || 'replay').replace(/[<>&]/g, '')}</title>
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

export async function buildReplay({ captureDir = CAPTURE_DIR, outDir = OUT_DIR } = {}) {
  const metaPath = path.join(captureDir, 'capture-meta.json');
  if (!existsSync(metaPath)) throw new Error(`no capture-meta.json in ${captureDir}`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const bundleId = `preview-${meta.fileKey}`.slice(0, 48);

  const bundleFiles = readdirSync(captureDir).filter((f) => f.startsWith('bundle') && f.endsWith('.json'));
  if (!bundleFiles.length) throw new Error(`no bundle*.json in ${captureDir}`);

  log('runtime source:', RUNTIME_SOURCE);
  const rt = await resolveRuntimeUrl();
  const resetCss = resetCssFrom(rt.html);

  mkdirSync(path.join(outDir, path.dirname(rt.path).replace(/^\//, '')), { recursive: true });
  mkdirSync(path.join(outDir, '_json', bundleId), { recursive: true });
  mkdirSync(path.join(outDir, '_components', 'v2'), { recursive: true });
  mkdirSync(path.join(outDir, '_assets', ASSETS_VERSION), { recursive: true });
  mkdirSync(path.join(outDir, '_videos', 'v1'), { recursive: true });

  writeFileSync(path.join(outDir, rt.path.replace(/^\//, '')), await get(rt.url));
  log('runtime ->', rt.path);

  let primary = null;
  const videoUrls = new Map(); // basename -> signed URL

  for (const bf of bundleFiles) {
    const bundle = JSON.parse(readFileSync(path.join(captureDir, bf), 'utf8'));
    // Reduce signed absolute asset URLs to the basename the runtime will request.
    for (const a of Object.values(bundle.assets || {})) {
      if (typeof a.url === 'string' && /^https?:/i.test(a.url)) {
        const base = path.basename(new URL(a.url).pathname);
        if (base) {
          if (a.type === 'VIDEO_ASSET') videoUrls.set(base, a.url);
          a.url = base;
        }
      }
    }
    const route = bf === 'bundle_index.json' ? '_index' : bf.replace(/^bundle_?/, '').replace(/\.json$/, '');
    writeFileSync(path.join(outDir, '_json', bundleId, `${route}.json`), JSON.stringify(bundle));
    log(`route ${route}: ${Object.keys(bundle.nodeById || {}).length} nodes`);
    if (route === '_index' || !primary) primary = bundle;
  }

  const sch = primary.sourceCodeHash;
  if (sch && primary.compiledCode) {
    writeFileSync(path.join(outDir, '_components', 'v2', `${sch}.js`), primary.compiledCode);
    log('compiledCode ->', `${sch}.js`, primary.compiledCode.length, 'chars');
  }
  if (sch && primary.globalStyles) {
    writeFileSync(path.join(outDir, '_components', 'v2', `${sch}.css`), primary.globalStyles);
    log('globalStyles ->', `${sch}.css`, primary.globalStyles.length, 'chars');
  }

  // Captured Blobs (images/svg) land in _assets; videos are fetched by signed URL.
  const assetSrc = path.join(captureDir, 'assets');
  let copied = 0;
  if (existsSync(assetSrc)) {
    for (const f of readdirSync(assetSrc)) {
      copyFileSync(path.join(assetSrc, f), path.join(outDir, '_assets', ASSETS_VERSION, f));
      copied++;
    }
  }
  log('assets copied:', copied);

  let vids = 0;
  for (const [name, url] of videoUrls) {
    try {
      writeFileSync(path.join(outDir, '_videos', 'v1', name), await get(url));
      vids++;
    } catch (e) {
      log('video failed', name.slice(0, 12), String(e.message).slice(0, 60));
    }
  }
  log(`videos: ${vids}/${videoUrls.size}`);

  writeFileSync(
    path.join(outDir, 'index.html'),
    bootHtml({
      runtimePath: rt.path,
      bundleId,
      sourceCodeHash: sch,
      title: (primary.siteSettings || {}).title,
      resetCss,
    }),
  );

  const report = {
    builtAt: new Date().toISOString(),
    fileKey: meta.fileKey,
    bundleId,
    runtime: rt.path,
    routes: bundleFiles.length,
    nodeCount: Object.keys(primary.nodeById || {}).length,
    sourceCodeHash: sch,
    assets: copied,
    videos: `${vids}/${videoUrls.size}`,
    serve: `npx serve ${outDir}  # or: python3 -m http.server -d ${outDir}`,
  };
  writeFileSync(path.join(outDir, 'replay-report.json'), JSON.stringify(report, null, 2));
  log('done ->', outDir);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildReplay().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => {
    console.error('[replay-build:FAIL]', e?.stack || e);
    process.exit(1);
  });
}
