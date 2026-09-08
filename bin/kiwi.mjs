#!/usr/bin/env node
// kiwi CLI — Figma Sites wire-protocol pipeline.
//   kiwi sync <fileKey>   cookie steal → standalone WS full sync → decode
//   kiwi pack             wire frames → lossless package (rehearsal/kiwi-package)
//   kiwi pack-app         package → app data (desktop subtree, format conversion only)
//   kiwi dom <fileKey>    attach editor preview iframe, inject harvest agent
//   kiwi preview <fileKey>  capture the preview getPage bundle + asset Blobs (works unpublished)
//   kiwi replay [captureDir] rebuild a standalone site from a preview capture
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const [, , cmd, fileKey = process.env.FIGMA_FILE_KEY || ''] = process.argv;
const require2 = (id) => require(require.resolve(id, { paths: [`${homedir()}/.cache/figma-kiwi`, process.cwd()] }));

if (cmd === 'sync') {
  const { stealCookies, observeMultiplayerHandshake } = await import('../src/kiwi/cdp.mjs');
  const { fullSync, decodeFrames } = await import('../src/kiwi/client.mjs');
  const { getDecoder } = await import('../src/kiwi/decoder.mjs');
  const { extractCompressedSchema, writeFileSync: _w } = await import('../src/kiwi/wire.mjs');

  const cookies = await stealCookies(fileKey);
  if (!cookies.some(c => c.name === 'figma.session')) throw new Error('no figma.session cookie — login required');
  const multiplayerUrl = await observeMultiplayerHandshake(fileKey);
  const outDir = '/tmp/figma_kiwi_fullsync';
  mkdirSync(outDir, { recursive: true });
  const { frames, joinEnd, schemaFrame } = await fullSync({ fileKey, multiplayerUrl, cookies, outDir });
  if (!joinEnd || !schemaFrame) throw new Error(`incomplete sync (joinEnd=${joinEnd})`);
  const decoder = await getDecoder(new Uint8Array(extractCompressedSchema(new Uint8Array(schemaFrame))));
  const captured = readdirSync(outDir).filter(f => f.startsWith('fs_')).sort().map(f => readFileSync(`${outDir}/${f}`));
  const { nodeChanges } = decodeFrames(captured, decoder);
  const replacer = (_k, v) => {
    if (typeof v === 'bigint') return { __bigint: String(v) };
    if (v instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(v))) {
      return { __bytes: Buffer.from(v).toString('base64') };
    }
    return v;
  };
  writeFileSync(`/tmp/figma_kiwi_scenegraph.json`, JSON.stringify({ nodeChanges }, replacer));
  console.log(`synced: ${frames} frames → ${nodeChanges.length} nodes → /tmp/figma_kiwi_scenegraph.json`);
} else if (cmd === 'pack') {
  await import('../src/kiwi/pack.mjs');
} else if (cmd === 'pack-app') {
  await import('../src/kiwi/pack-app.mjs');
} else if (cmd === 'dom') {
  await import('../src/kiwi/dom-capture.mjs');
} else if (cmd === 'preview') {
  // Pipeline C: intercept the editor->preview MessagePort. Unlike `sync` this
  // needs no wire decoding, and unlike `dom` it captures data rather than DOM.
  const { capturePreview } = await import('../src/kiwi/preview-capture.mjs');
  const meta = await capturePreview({
    fileKey,
    outDir: process.argv[4] || 'rehearsal/preview-capture',
  });
  console.log(`captured ${meta.nodeCount} nodes, ${meta.routes.length} route(s), ${Object.keys(meta.assets).length} assets`);
} else if (cmd === 'replay') {
  const { buildReplay } = await import('../src/kiwi/replay-build.mjs');
  const report = await buildReplay({
    captureDir: process.argv[3] || 'rehearsal/preview-capture',
    outDir: process.argv[4] || 'rehearsal/replay',
  });
  console.log(JSON.stringify(report, null, 2));
} else {
  console.error('usage: kiwi <sync|pack|pack-app|dom|preview|replay> [fileKey] [dir]');
  process.exit(1);
}
