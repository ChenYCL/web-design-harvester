/**
 * Breakthrough exporter (no --load-extension required).
 *
 * Uses the logged-in debug Chrome (CDP):
 *   1. observeMultiplayerHandshake → exact multiplayer WS URL
 *   2. inject extension page-sync into the Sites editor tab
 *   3. full sync in page world (correct Origin)
 *   4. pack CODE_FILE ZIP with extension/lib/pack-code.js
 *
 *   npm run extension:export
 *   node extension/scripts/cdp-export.mjs [fileKey]
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { observeMultiplayerHandshake } from '../../src/kiwi/cdp.mjs';
import { buildCodeZip } from '../lib/pack-code.js';
import { isFigWireFrame } from '../lib/wire.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE_KEY = process.argv[2] || process.env.FIGMA_FILE_KEY || '';
const CDP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const OUT = path.join(ROOT, 'rehearsal/extension-live');
mkdirSync(OUT, { recursive: true });

const syncInject = readFileSync(path.join(ROOT, 'extension/lib/page-sync-inject.js'), 'utf8');

function log(...a) {
  console.error('[cdp-export]', ...a);
}

log('observing multiplayer handshake…');
const multiplayerUrl = await observeMultiplayerHandshake(FILE_KEY);
log('multiplayer', multiplayerUrl.slice(0, 140));

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
const page =
  context.pages().find((p) => p.url().includes(FILE_KEY) && /figma\.com\/(site|make)/.test(p.url())) ||
  context.pages().find((p) => p.url().includes(FILE_KEY));
if (!page) throw new Error(`No Sites tab for ${FILE_KEY} on ${CDP}`);
log('page', page.url());
await page.bringToFront();

await page.evaluate((syncSrc) => {
  // eslint-disable-next-line no-eval
  (0, eval)(syncSrc);
}, syncInject);

log('page-world sync…');
const syncResult = await page.evaluate(async (mp) => {
  return await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const d = ev.data;
      if (!d || d.source !== 'figma-sites-exporter' || d.type !== 'SYNC_EVENT') return;
      if (d.event === 'progress') window.__FSE_SYNC_PROGRESS__ = d;
      else if (d.event === 'done') {
        window.removeEventListener('message', onMsg);
        resolve(d);
      } else if (d.event === 'error') {
        window.removeEventListener('message', onMsg);
        reject(new Error(d.message || 'sync error'));
      }
    };
    window.addEventListener('message', onMsg);
    window.postMessage(
      { source: 'figma-sites-exporter', type: 'START_PAGE_SYNC', multiplayerUrl: mp, timeoutMs: 180000 },
      '*',
    );
  });
}, multiplayerUrl);

log(
  'frames',
  syncResult.frames?.length,
  'joinEnd',
  syncResult.joinEnd,
  'MB',
  ((syncResult.dataBytes || 0) / 1048576).toFixed(1),
);
if (!syncResult.joinEnd) throw new Error('JOIN_END missing');

const frames = syncResult.frames.map((b64) => Uint8Array.from(Buffer.from(b64, 'base64')));
const schemaFrame = frames.find((f) => isFigWireFrame(f)) || null;

const { base64, codeFiles, nodeCount, manifest } = await buildCodeZip({
  fileKey: FILE_KEY,
  editorUrl: page.url(),
  frames,
  schemaFrame,
  onProgress: (p) => log(p.stage, p.message || ''),
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const zipPath = path.join(OUT, `figma-sites-${FILE_KEY.slice(0, 10)}-${stamp}.zip`);
writeFileSync(zipPath, Buffer.from(base64, 'base64'));
writeFileSync(path.join(OUT, 'figma-sites-export.zip'), Buffer.from(base64, 'base64'));
writeFileSync(path.join(OUT, 'last-manifest.json'), JSON.stringify({ ...manifest, codeFiles, zipPath }, null, 2));

const expectedDir = path.join(ROOT, 'rehearsal/kiwi-package/code');
const expected = existsSync(expectedDir) ? readdirSync(expectedDir) : [];
const got = codeFiles.map((c) => c.name);
const missing = expected.filter((n) => !got.includes(n));
log('CODE_FILE', got.join(', '));
log('missing', missing);
log('wrote', zipPath);

await browser.close();
if (missing.length) process.exit(2);
console.log(JSON.stringify({ ok: true, zipPath, codeFiles, nodeCount }, null, 2));
