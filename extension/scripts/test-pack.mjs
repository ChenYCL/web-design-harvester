/**
 * Offline check: decode previously captured fullsync frames with the extension packer.
 * Frames dir: FIGMA_KIWI_FULLSYNC_DIR (default /tmp/figma_kiwi_fullsync).
 * Optional: PUBLISHED_URL to also mirror *.figma.site into published/.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCodeZip } from '../lib/pack-code.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frameDir = process.env.FIGMA_KIWI_FULLSYNC_DIR || '/tmp/figma_kiwi_fullsync';
let files = [];
try {
  files = readdirSync(frameDir).filter((f) => f.startsWith('fs_')).sort();
} catch {
  console.error('no frames dir', frameDir);
  process.exit(1);
}
if (!files.length) {
  console.error('no frames in', frameDir);
  process.exit(1);
}
const frames = files.map((f) => new Uint8Array(readFileSync(path.join(frameDir, f))));
const schemaFrame = frames.find((f) => new TextDecoder().decode(f.subarray(0, 8)) === 'fig-wire') || null;

const publishedUrl = process.env.PUBLISHED_URL || '';

const { base64, codeFiles, nodeCount, manifest, assetStats } = await buildCodeZip({
  fileKey: process.env.FIGMA_FILE_KEY || '',
  frames,
  schemaFrame,
  publishedUrl: publishedUrl || undefined,
  onProgress: (p) => console.error('[progress]', p.stage, p.message || ''),
});

const outDir = process.env.OUT_DIR || '/tmp/figma-ext-pack-smoke';
mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, 'export.zip');
writeFileSync(zipPath, Buffer.from(base64, 'base64'));
console.log('nodes', nodeCount);
console.log('codeFiles', codeFiles);
console.log('make', manifest.make);
console.log('assetStats', assetStats);
console.log('zip', zipPath, Buffer.from(base64, 'base64').length, 'bytes');
if (!codeFiles?.length) {
  console.error('FAIL: expected CODE_FILE entries');
  process.exit(2);
}
console.log('OK');
void root;
