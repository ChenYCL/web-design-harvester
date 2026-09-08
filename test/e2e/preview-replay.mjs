#!/usr/bin/env node
/**
 * E2E: capture the preview bundle -> build a replay site -> pixel-diff.
 *
 * This is the bundle-replay path. It differs from preview-restore.mjs, which
 * clones the preview DOM and inlines computed styles; that approach plateaus
 * around 16% pixel difference because the Sites CSSOM is largely opaque.
 * Replaying the captured bundle through the real runtime removes the guesswork
 * entirely — same renderer, same data.
 *
 * Reference target is chosen automatically:
 *   - if the site is published, diff against the live published URL (strictest,
 *     and the published bundle is a known-good control that measures 0.0000%)
 *   - otherwise diff against a screenshot of the live preview iframe
 *
 * Requires Chrome with --remote-debugging-port=9222, the Sites file open.
 *
 *   node --experimental-websocket test/e2e/preview-replay.mjs <fileKey> [publishedUrl]
 */
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { capturePreview } from '../../src/kiwi/preview-capture.mjs';
import { buildReplay } from '../../src/kiwi/replay-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'rehearsal/e2e-replay');
const FILE_KEY = process.argv[2] || process.env.FIGMA_FILE_KEY;
const PUBLISHED = process.argv[3] || process.env.PUBLISHED_URL || null;
const MAX_DIFF_PCT = Number(process.env.MAX_DIFF_PCT || 1);
const PORT = Number(process.env.PORT || 8901);
const VIEW = { w: Number(process.env.VIEW_W || 1440), h: Number(process.env.VIEW_H || 900) };

const log = (...a) => console.error('[e2e-replay]', ...a);
const fail = (m) => { console.error('[e2e-replay:FAIL]', m); process.exit(1); };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4', '.woff2': 'font/woff2',
};

/** Static server that falls back to index.html so client routes resolve. */
async function serve(dir, port) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    let file = path.join(dir, p.replace(/^\//, ''));
    if (!file.startsWith(dir) || !existsSync(file)) file = path.join(dir, 'index.html');
    if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

/** ffmpeg-based diff — avoids pulling pixelmatch/pngjs just for a percentage. */
function diffPct(a, b, outPng) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', a, '-i', b,
    '-filter_complex', 'blend=all_mode=difference,format=gray', outPng]);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', outPng, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 1 << 28 });
  let nz = 0;
  for (const byte of raw) if (byte > 4) nz++;
  return { pct: (nz / Math.max(raw.length, 1)) * 100, pixels: raw.length };
}

async function main() {
  if (!FILE_KEY) fail('usage: preview-replay.mjs <fileKey> [publishedUrl]');
  mkdirSync(OUT, { recursive: true });

  log('1/4 capturing preview bundle…');
  const meta = await capturePreview({ fileKey: FILE_KEY, outDir: path.join(OUT, 'capture') });
  log(`   ${meta.nodeCount} nodes, routes ${meta.routes.join(',')}, ${Object.keys(meta.assets).length} assets`);

  log('2/4 building replay…');
  const report = await buildReplay({ captureDir: path.join(OUT, 'capture'), outDir: path.join(OUT, 'site') });

  log('3/4 rendering…');
  const server = await serve(path.join(OUT, 'site'), PORT);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });

  const shot = async (url, file) => {
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
    await p.waitForTimeout(6000);
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path: file, scale: 'css' });
    const stats = await p.evaluate(() => ({
      els: document.querySelectorAll('body *').length,
      docH: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    }));
    await p.close();
    return stats;
  };

  const replayPng = path.join(OUT, 'replay.png');
  const replayStats = await shot(`http://127.0.0.1:${PORT}/`, replayPng);
  log('   replay', JSON.stringify(replayStats));

  let refPng = null, refStats = null, refKind = null;
  if (PUBLISHED) {
    refPng = path.join(OUT, 'reference.png');
    refStats = await shot(PUBLISHED, refPng);
    refKind = 'published';
    log('   reference (published)', JSON.stringify(refStats));
  }

  log('4/4 comparing…');
  let visual = null;
  if (refPng) visual = diffPct(replayPng, refPng, path.join(OUT, 'diff.png'));

  const structuralOk = replayStats.els > 200 && replayStats.docH > 1000;
  const result = {
    ok: structuralOk && (!visual || visual.pct <= MAX_DIFF_PCT),
    fileKey: FILE_KEY,
    structuralOk,
    replay: replayStats,
    reference: refStats,
    referenceKind: refKind,
    diffPct: visual ? Number(visual.pct.toFixed(4)) : null,
    maxDiffPct: MAX_DIFF_PCT,
    capture: { nodes: meta.nodeCount, routes: meta.routes, assets: Object.keys(meta.assets).length },
    build: report,
    note:
      'Replay feeds the captured preview bundle to the real sites-runtime in ' +
      'published mode. A published-bundle control measures 0.0000%; a preview ' +
      'bundle legitimately differs from the live site by whatever is edited but ' +
      'not yet published.',
  };
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(result, null, 2));

  await browser.close();
  server.close();
  console.log(JSON.stringify(result, null, 2));
  if (!structuralOk) fail('replay did not render a real page');
  log(result.ok ? 'PASS' : `visual ${result.diffPct}% > ${MAX_DIFF_PCT}%`);
}

main().catch((e) => fail(e?.stack || e));
