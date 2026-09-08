/**
 * Decode wire frames → extract CODE_FILE + light meta → JSZip blob.
 * Scenegraph.full.json is omitted by default (too large for browser ZIP).
 */
import { decompress } from 'fzstd';
import JSZip from 'jszip';
import codec from '../vendor/decoder.js';
import { extractCompressedSchema, isFigWireFrame, isZstd, nid } from './wire.js';
import { commandsBlobToPath } from './svg.js';
import { fetchPublishedPack, mergePublishedIntoZip } from './pack-published.js';

async function gzipBytes(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function decodeMessage(raw) {
  // Generated codec accepts Uint8Array and wraps ByteBuffer internally.
  return codec.decodeMessage(raw);
}

function decompressFrame(u8) {
  if (isFigWireFrame(u8)) return null;
  if (isZstd(u8)) return decompress(u8);
  return u8;
}

/**
 * @param {Uint8Array[]} frames
 * @param {Uint8Array|null} schemaFrame
 */
export function decodeNodeChanges(frames, schemaFrame) {
  // Decoder was generated against the captured schema; schemaFrame validates presence.
  if (!schemaFrame && !frames.some(isFigWireFrame)) {
    throw new Error('missing fig-wire schema frame');
  }
  // Prefer schema from this sync (future: regenerate decoder). Current vendored
  // decoder matches the known Sites schema used by this project.
  void extractCompressedSchema;

  const nodeChanges = [];
  let joinEnd = false;
  let blobs = [];
  for (const frame of frames) {
    if (isFigWireFrame(frame)) continue;
    const raw = decompressFrame(frame);
    if (!raw) continue;
    const m = decodeMessage(raw);
    if (m.type === 'JOIN_END') joinEnd = true;
    if (m.type === 'NODE_CHANGES') {
      nodeChanges.push(...(m.nodeChanges || []));
      if (m.blobs?.length) blobs.push(...m.blobs);
    }
  }
  return { nodeChanges, blobs, joinEnd };
}

function jsonReplacer(_k, v) {
  if (typeof v === 'bigint') return { __bigint: String(v) };
  if (v instanceof Uint8Array) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < v.length; i += chunk) {
      s += String.fromCharCode(...v.subarray(i, i + chunk));
    }
    // Prefer base64 via btoa on binary string
    return { __bytes: btoa(s) };
  }
  return v;
}

function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

function paintHash(p) {
  const h = p?.image?.hash ?? p?.imageHash ?? p?.video?.hash ?? p?.videoHash;
  if (h instanceof Uint8Array) return h.length === 20 ? bytesToHex(h) : null;
  if (typeof h === 'string' && /^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
  return null;
}

function collectMediaHashes(nodes) {
  const hashes = new Set();
  const scan = (paints) => {
    for (const p of paints || []) {
      const h = paintHash(p);
      if (h) hashes.add(h);
    }
  };
  for (const nc of nodes) {
    scan(nc.fillPaints);
    scan(nc.strokePaints);
  }
  return [...hashes];
}

function collectMakeMeta(nodes) {
  const libraryKeys = new Set();
  const usedLibs = [];
  let isMakeKit = false;
  let makeContentState = null;
  for (const nc of nodes) {
    if (nc.isMakeKit) isMakeKit = true;
    if (nc.makeContentState) makeContentState = nc.makeContentState;
    if (nc.sourceCodeLibraryKey) libraryKeys.add(nc.sourceCodeLibraryKey);
    for (const k of nc.sourceCodeLibraryKeys || []) libraryKeys.add(k);
    for (const lib of nc.usedMakeLibraries || []) usedLibs.push(lib);
  }
  return {
    isMakeKit,
    makeContentState,
    sourceCodeLibraryKeys: [...libraryKeys],
    usedMakeLibraries: usedLibs.slice(0, 50),
  };
}

async function fetchImageMap(fileKey, token) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/images`, {
    headers: { 'X-FIGMA-TOKEN': token },
  });
  if (!res.ok) throw new Error(`REST /images failed: ${res.status}`);
  const body = await res.json();
  if (body.error || body.status !== 200) throw new Error(`REST /images error: ${JSON.stringify(body).slice(0, 160)}`);
  return body.meta?.images || {};
}

async function downloadBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * @param {object} opts
 * @param {string} opts.fileKey
 * @param {string} [opts.editorUrl]
 * @param {string} [opts.previewUrl]
 * @param {object} [opts.selection]
 * @param {string} [opts.figmaToken]
 * @param {Array<{url:string, kind?:string}>} [opts.previewMedia]
 * @param {object} [opts.siteCapture] WYSIWYG preview capture {html,css,assets:[{url,path}]}
 * @param {string} [opts.publishedUrl] https://*.figma.site — plain HTTPS published mirror
 * @param {Uint8Array[]} opts.frames
 * @param {Uint8Array|null} opts.schemaFrame
 * @param {(p:object)=>void} [opts.onProgress]
 */
export async function buildCodeZip(opts) {
  const {
    fileKey,
    editorUrl,
    previewUrl,
    selection,
    frames,
    schemaFrame,
    onProgress,
    figmaToken,
    previewMedia,
    siteCapture,
    publishedUrl,
  } = opts;
  onProgress?.({ stage: 'decode', message: 'Decoding wire frames…' });
  const { nodeChanges, blobs, joinEnd } = decodeNodeChanges(frames, schemaFrame);
  if (!joinEnd) throw new Error('JOIN_END missing — sync incomplete');
  onProgress?.({ stage: 'decode', message: `Decoded ${nodeChanges.length} nodes`, nodes: nodeChanges.length });

  const byId = new Map();
  for (const nc of nodeChanges) {
    const id = nid(nc.guid);
    if (!byId.has(id) || (nc.parentIndex && !byId.get(id).parentIndex)) byId.set(id, nc);
  }

  const children = new Map();
  for (const nc of byId.values()) {
    const pi = nc.parentIndex;
    if (!pi?.guid) continue;
    const pid = nid(pi.guid);
    const id = nid(nc.guid);
    if (pid === id) continue;
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(id);
  }

  const siteRoot = [...byId.values()].find((n) => n.type === 'RESPONSIVE_SET' && n.responsiveSetSettings);
  const anims = nodeChanges.filter((n) =>
    ['KEYFRAME', 'KEYFRAME_TRACK', 'ANIMATION_PRESET_INSTANCE'].includes(n.type),
  );

  const zip = new JSZip();
  const assetStats = {
    images: 0,
    videos: 0,
    animations: anims.length,
    imageErrors: 0,
    siteAssets: 0,
    publishedFiles: 0,
  };
  const makeMeta = collectMakeMeta([...byId.values()]);
  const truthParts = [];
  if (siteCapture?.ok) truthParts.push('PREVIEW_SITE');
  if (publishedUrl) truthParts.push('PUBLISHED');
  truthParts.push('CODE_FILE');
  const manifest = {
    fileKey,
    editorUrl: editorUrl || null,
    previewUrl: previewUrl || null,
    publishedUrl: publishedUrl || null,
    exportedAt: new Date().toISOString(),
    nodeCount: nodeChanges.length,
    blobCount: blobs.length,
    truth: truthParts.join('+'),
    make: makeMeta,
    assets: assetStats,
    cryptoNote:
      'Wire = fig-wire + zstd + Kiwi (NOT AES). Published *.figma.site is plain HTTPS. ' +
      'Editor CDN images may use time-limited signed URLs (s3-alpha-sig).',
    note:
      'site/ = WYSIWYG Preview iframe. published/ = offline mirror of *.figma.site. ' +
      'code/ = CODE_FILE from multiplayer wire. animations/ = wire keyframes. ' +
      'wire-assets/ = image fills via REST (FIGMA_TOKEN).',
  };
  zip.file('site.json', JSON.stringify(siteRoot?.responsiveSetSettings ?? {}, jsonReplacer, 2));
  zip.file('tree.json', JSON.stringify(Object.fromEntries(children)));

  onProgress?.({ stage: 'code', message: 'Extracting CODE_FILE…' });
  const codeFolder = zip.folder('code');
  /** @type {Map<string, {name:string, bytes:number, source:string}>} */
  const bestByName = new Map();
  for (const nc of byId.values()) {
    if (nc.type !== 'CODE_FILE' || !nc.sourceCode?.length) continue;
    const name = nc.name || `code-${nid(nc.guid)}.tsx`;
    const bytes = nc.sourceCode.length;
    const prev = bestByName.get(name);
    if (!prev || bytes > prev.bytes) bestByName.set(name, { name, bytes, source: nc.sourceCode });
  }
  const codeFiles = [];
  for (const entry of bestByName.values()) {
    codeFolder.file(entry.name, entry.source);
    codeFiles.push({ name: entry.name, bytes: entry.bytes });
  }
  if (!codeFiles.length) {
    const hint = makeMeta.isMakeKit
      ? 'Make kit file may store sources under library keys — check make.usedMakeLibraries'
      : 'is this a Sites/Make file with code layers?';
    throw new Error(`No CODE_FILE nodes found in sync — ${hint}`);
  }
  onProgress?.({ stage: 'code', message: `Extracted ${codeFiles.length} CODE_FILE(s)`, codeFiles });

  onProgress?.({ stage: 'anims', message: `Writing ${anims.length} animation nodes…` });
  zip.folder('animations').file('animations.json', JSON.stringify(anims, jsonReplacer));

  // Vectors from geometry blobs (bottom-layer, deterministic)
  onProgress?.({ stage: 'vectors', message: 'Decoding vector geometry…' });
  const vectors = {};
  for (const nc of byId.values()) {
    if (!nc.fillGeometry?.length) continue;
    const paths = [];
    for (const g of nc.fillGeometry) {
      const bytes = Number.isInteger(g?.commandsBlob)
        ? blobs[g.commandsBlob]?.bytes
        : g?.commandsBlob;
      if (!bytes || bytes.length < 4) continue;
      try {
        const d = commandsBlobToPath(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        if (d) paths.push(d);
      } catch { /* keep others */ }
    }
    if (paths.length) vectors[nid(nc.guid)] = paths;
  }
  zip.file('vectors.json', JSON.stringify(vectors));
  onProgress?.({ stage: 'vectors', message: `vectors: ${Object.keys(vectors).length}` });

  // Full scenegraph as gzip (bottom-layer). Keep out of peak ZIP inflate cost via STORE.
  onProgress?.({ stage: 'scenegraph', message: 'Serializing scenegraph (may take a bit)…' });
  try {
    const sgJson = JSON.stringify({ nodeChanges, blobs }, jsonReplacer);
    const sgBytes = new TextEncoder().encode(sgJson);
    const gz = await gzipBytes(sgBytes);
    if (gz) {
      zip.file('scenegraph.full.json.gz', gz, { compression: 'STORE' });
      onProgress?.({
        stage: 'scenegraph',
        message: `scenegraph.full.json.gz ${(gz.length / 1048576).toFixed(1)}MB (from ${(sgBytes.length / 1048576).toFixed(1)}MB json)`,
      });
    } else {
      zip.file('scenegraph.full.json', sgJson);
    }
  } catch (e) {
    zip.file(
      'scenegraph.ERROR.txt',
      `Failed to serialize scenegraph (memory?): ${e?.message || e}\nframes/meta still valid for CLI re-pack.\n`,
    );
  }
  // Image fills via REST (token required)
  const hashes = collectMediaHashes([...byId.values()]);
  const imageEntries = {};
  // ---- WYSIWYG preview site (primary visual deliverable) ----
  if (siteCapture?.ok && siteCapture.html) {
    onProgress?.({ stage: 'site', message: 'Building site/ from Preview iframe…' });
    const site = zip.folder('site');
    site.file('index.html', siteCapture.html);
    site.file('styles.css', siteCapture.css || '/* empty */');
    // interactions.js from extension bundle text
    try {
      const inter = await fetch(chrome.runtime.getURL('lib/interactions.js')).then((r) => r.text());
      site.file('interactions.js', inter);
    } catch {
      site.file('interactions.js', '/* interactions unavailable */');
    }
    const siteAssets = site.folder('assets');
    const list = siteCapture.assets || [];
    let i = 0;
    let embeddedBytes = 0;
    const MAX_EMBED_BYTES = 20 * 1024 * 1024;
    for (const a of list) {
      i++;
      onProgress?.({
        stage: 'site',
        message: `Downloading preview assets ${i}/${list.length}…`,
        percent: 40 + Math.round((i / Math.max(list.length, 1)) * 25),
      });
      try {
        const buf = await downloadBinary(a.url);
        if (embeddedBytes + buf.length > MAX_EMBED_BYTES) continue;
        siteAssets.file(a.path.replace(/^assets\//, ''), buf);
        embeddedBytes += buf.length;
        assetStats.siteAssets++;
        if (/\.(mp4|webm|mov)$/i.test(a.path)) assetStats.videos++;
        else assetStats.images++;
      } catch {
        assetStats.imageErrors++;
      }
    }
    site.file(
      'README.md',
      '# site/\n\nWYSIWYG export from Figma Sites Preview iframe.\n\nOpen `index.html` via a static server:\n\n```bash\nnpx serve .\n```\n',
    );
  } else {
    zip.folder('site').file(
      'README.md',
      `# site/\n\nPreview capture missing: ${siteCapture?.error || 'no capture'}\nOpen Full preview in the editor so the iframe is live, then Export again.\n`,
    );
  }

  if (figmaToken && hashes.length) {
    onProgress?.({ stage: 'assets', message: `Resolving ${hashes.length} wire image hashes…` });
    try {
      const map = await fetchImageMap(fileKey, figmaToken);
      const assets = zip.folder('wire-assets');
      let i = 0;
      let embeddedBytes = 0;
      const MAX_EMBED_BYTES = 12 * 1024 * 1024;
      for (const h of hashes) {
        const url = map[h];
        if (!url) continue;
        imageEntries[h] = url;
        i++;
        onProgress?.({
          stage: 'assets',
          message: `Downloading wire-assets ${i}/${hashes.length}…`,
          percent: 70 + Math.round((i / hashes.length) * 15),
        });
        if (embeddedBytes >= MAX_EMBED_BYTES) continue;
        try {
          const buf = await downloadBinary(url);
          if (embeddedBytes + buf.length > MAX_EMBED_BYTES) {
            imageEntries[h] = { url, skippedEmbed: true, reason: 'zip_size_cap' };
            continue;
          }
          assets.file(`${h}.png`, buf);
          embeddedBytes += buf.length;
          assetStats.images++;
        } catch {
          assetStats.imageErrors++;
        }
      }
      zip.file('images.json', JSON.stringify(imageEntries, null, 2));
    } catch (e) {
      zip.file(
        'wire-assets/ERROR.txt',
        `Failed to fetch images: ${e?.message || e}\nSet FIGMA_TOKEN in the extension popup and re-export.\n`,
      );
    }
  } else {
    zip.folder('wire-assets').file(
      'README.md',
      hashes.length
        ? `# wire-assets/\n\nFound ${hashes.length} image hashes, but no FIGMA_TOKEN.\nSave a token in the extension popup and re-export.\n`
        : '# wire-assets/\n\nNo image-fill hashes found.\n',
    );
  }

  // Optional media URLs captured from live preview (videos etc.)
  if (previewMedia?.length) {
    onProgress?.({ stage: 'assets', message: `Fetching ${previewMedia.length} preview media URLs…` });
    const media = zip.folder('media');
    const list = [];
    let i = 0;
    for (const m of previewMedia) {
      if (!m?.url) continue;
      i++;
      try {
        const buf = await downloadBinary(m.url);
        const kind = m.kind || (/\.(mp4|webm|mov)/i.test(m.url) ? 'video' : 'file');
        const name = m.name || `media-${i}${kind === 'video' ? '.mp4' : ''}`;
        media.file(name, buf);
        list.push({ name, url: m.url, kind, bytes: buf.length });
        if (kind === 'video') assetStats.videos++;
        else assetStats.images++;
      } catch {
        list.push({ url: m.url, error: true });
      }
    }
    zip.file('media/manifest.json', JSON.stringify(list, null, 2));
  }

  if (selection) zip.file('selection.json', JSON.stringify(selection, null, 2));

  // ---- Published *.figma.site mirror (plain HTTPS, no AES) ----
  if (publishedUrl) {
    try {
      onProgress?.({ stage: 'published', message: `Mirroring ${publishedUrl}…` });
      const pack = await fetchPublishedPack(publishedUrl, { onProgress });
      const pubMeta = mergePublishedIntoZip(zip, pack);
      assetStats.publishedFiles = Object.keys(pack.files).length;
      manifest.published = pubMeta;
    } catch (e) {
      zip.folder('published').file(
        'ERROR.txt',
        `Failed to mirror published site: ${e?.message || e}\nURL: ${publishedUrl}\n`,
      );
      manifest.publishedError = String(e?.message || e);
    }
  }

  zip.file(
    'README.md',
    `# Figma Sites / Make export\n\n## What's in here\n\n- \`site/\` — WYSIWYG Preview iframe capture\n- \`published/\` — offline mirror of \`*.figma.site\` (runtime + components + _json + assets)\n- \`code/\` — **CODE_FILE** React/TSX from multiplayer wire (editable source)\n- \`animations/\` — ${anims.length} keyframe/track/preset nodes\n- \`wire-assets/\` — image fills (needs Figma token)\n- \`media/\` — optional preview media URLs\n\n## Crypto note\n\nWire frames are **fig-wire + zstd + Kiwi** (binary schema), not AES.\nPublished sites are plain HTTPS. See \`docs/make-reverse-notes.md\`.\n\n## Run\n\n\`\`\`bash\nnpx serve site        # preview capture\nnpx serve published   # published runtime mirror\n\`\`\`\n`,
  );

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  onProgress?.({ stage: 'zip', message: 'Compressing ZIP…' });
  const base64 = await zip.generateAsync({
    type: 'base64',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { base64, codeFiles, nodeCount: nodeChanges.length, manifest, assetStats };
}
