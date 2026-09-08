/**
 * Fetch a published *.figma.site into a ZIP folder tree (no crypto — plain HTTPS).
 * Layout mirrors the live host: _runtimes / _components / _json / _assets + index.html.
 */

const PRELOAD_RE =
  /<(?:link|script)[^>]+(?:href|src)=["']([^"']+)["'][^>]*>/gi;
const ASSET_RE = /\/_assets\/[^"'\\\s)]+/g;

async function mapPool(items, concurrency, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return ret;
}

/**
 * @param {string} publishedUrl e.g. https://<slug>.figma.site/
 * @param {{ onProgress?: (p:object)=>void, maxAssetBytes?: number, concurrency?: number }} [opts]
 */
export async function fetchPublishedPack(publishedUrl, opts = {}) {
  const onProgress = opts.onProgress;
  const maxAssetBytes = opts.maxAssetBytes ?? 40 * 1024 * 1024;
  const concurrency = opts.concurrency ?? 8;
  const base = new URL(publishedUrl);
  if (!/\.figma\.site$/i.test(base.hostname)) {
    throw new Error(`not a figma.site host: ${base.hostname}`);
  }
  const origin = base.origin;

  onProgress?.({ stage: 'published', message: `Fetching ${origin}/ …` });
  const htmlRes = await fetch(origin + '/');
  if (!htmlRes.ok) throw new Error(`published HTML ${htmlRes.status}`);
  const html = await htmlRes.text();

  const urls = new Set();
  let m;
  PRELOAD_RE.lastIndex = 0;
  while ((m = PRELOAD_RE.exec(html))) {
    try {
      urls.add(new URL(m[1], origin).href);
    } catch { /* ignore */ }
  }
  ASSET_RE.lastIndex = 0;
  while ((m = ASSET_RE.exec(html))) {
    try {
      urls.add(new URL(m[0], origin).href);
    } catch { /* ignore */ }
  }

  const jsonUrl = [...urls].find((u) => /\/_json\/[^/]+\/_index\.json$/i.test(u));
  const runtimeUrl = [...urls].find((u) => /\/_runtimes\/sites-runtime\./i.test(u));
  const componentJs = [...urls].find((u) => /\/_components\/v2\/[^/]+\.js$/i.test(u));
  const componentCss = componentJs ? componentJs.replace(/\.js$/i, '.css') : null;
  if (componentCss) urls.add(componentCss);

  /** @type {Record<string, Uint8Array|string>} */
  const files = {};
  files['index.html'] = html;

  const meta = {
    origin,
    publishedUrl: origin + '/',
    fetchedAt: new Date().toISOString(),
    boot: {
      json: jsonUrl || null,
      runtime: runtimeUrl || null,
      componentsJs: componentJs || null,
      componentsCss: componentCss || null,
    },
    sourceCodeHash: null,
    siteSettings: null,
    routes: null,
    nodeCount: null,
    assetFiles: 0,
    errors: [],
  };

  async function put(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const rel = new URL(url).pathname.replace(/^\//, '');
      files[rel] = buf;
      return buf;
    } catch (e) {
      meta.errors.push({ url, error: String(e?.message || e) });
      return null;
    }
  }

  if (jsonUrl) {
    onProgress?.({ stage: 'published', message: 'Fetching _index.json…' });
    const buf = await put(jsonUrl);
    if (buf) {
      try {
        const j = JSON.parse(new TextDecoder().decode(buf));
        meta.sourceCodeHash = j.sourceCodeHash || null;
        meta.siteSettings = j.siteSettings || null;
        meta.routes = j.guidToUrl || null;
        meta.nodeCount = j.nodeById ? Object.keys(j.nodeById).length : null;
        // Prefer HTML-discovered assets; only add JSON assets that look like hashed CDN files.
        for (const [hash, a] of Object.entries(j.assets || {})) {
          const name = a?.url;
          if (!name || typeof name !== 'string') continue;
          if (!/^[a-f0-9]{32,}\.[a-z0-9]+$/i.test(name) && !/^[a-f0-9]{40}\./i.test(name)) continue;
          try {
            urls.add(new URL(`/_assets/v11/${name}`, origin).href);
          } catch { /* ignore */ }
          void hash;
        }
      } catch (e) {
        meta.errors.push({ url: jsonUrl, error: `json parse: ${e?.message || e}` });
      }
    }
  }

  for (const u of [runtimeUrl, componentJs, componentCss]) {
    if (!u) continue;
    onProgress?.({ stage: 'published', message: `Fetching ${u.split('/').pop()}…` });
    await put(u);
  }

  // Assets referenced by HTML (+ vetted JSON). Concurrent, size-capped.
  const assetUrls = [...urls].filter((u) => /\/_assets\//i.test(u));
  let embedded = 0;
  let done = 0;
  await mapPool(assetUrls, concurrency, async (u) => {
    if (embedded >= maxAssetBytes) return;
    const buf = await put(u);
    done++;
    if (done % 8 === 0 || done === assetUrls.length) {
      onProgress?.({
        stage: 'published',
        message: `Published assets ${done}/${assetUrls.length}…`,
        percent: Math.round((done / Math.max(assetUrls.length, 1)) * 100),
      });
    }
    if (!buf) return;
    if (embedded + buf.length > maxAssetBytes) {
      const rel = new URL(u).pathname.replace(/^\//, '');
      delete files[rel];
      meta.errors.push({ url: u, error: 'skipped: zip size cap' });
      return;
    }
    embedded += buf.length;
    meta.assetFiles++;
  });

  files['published-meta.json'] = JSON.stringify(meta, null, 2);
  files['README.md'] =
    `# published/\n\nOffline mirror of \`${origin}/\`.\n\n` +
    `No encryption — plain HTTPS. Open via static server after unpacking the ZIP:\n\n` +
    '```bash\nnpx serve published\n```\n\n' +
    `Boot: runtime + components + \`_json/.../_index.json\` (distilled scenegraph).\n` +
    `Editable CODE_FILE source lives under \`../code/\` from the wire sync, not here.\n`;

  return { files, meta };
}

/**
 * Write fetchPublishedPack result into an existing JSZip under `published/`.
 * @param {import('jszip')} zip
 * @param {Awaited<ReturnType<typeof fetchPublishedPack>>} pack
 */
export function mergePublishedIntoZip(zip, pack) {
  const folder = zip.folder('published');
  for (const [rel, body] of Object.entries(pack.files)) {
    folder.file(rel, body);
  }
  return pack.meta;
}
