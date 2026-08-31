#!/usr/bin/env node
// kiwi CLI — Figma Sites wire-protocol pipeline.
//   kiwi sync <fileKey>   cookie steal → standalone WS full sync → decode
//   kiwi pack             wire frames → lossless package (rehearsal/kiwi-package)
//   kiwi pack-app         package → app data (desktop subtree, format conversion only)
//   kiwi dom <fileKey>    attach editor preview iframe, inject harvest agent
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const [, , cmd, fileKey = 'oqjgSk2zVtR18Z1kXfU2DS'] = process.argv;
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
  writeFileSync(`/tmp/figma_kiwi_scenegraph.json`, JSON.stringify({ nodeChanges }));
  console.log(`synced: ${frames} frames → ${nodeChanges.length} nodes → /tmp/figma_kiwi_scenegraph.json`);
} else if (cmd === 'pack') {
  await import('../src/kiwi/pack.mjs');
} else if (cmd === 'pack-app') {
  await import('../src/kiwi/pack-app.mjs');
} else if (cmd === 'dom') {
  await import('../src/kiwi/dom-capture.mjs');
} else {
  console.error('usage: kiwi <sync|pack|pack-app|dom> [fileKey]');
  process.exit(1);
}
