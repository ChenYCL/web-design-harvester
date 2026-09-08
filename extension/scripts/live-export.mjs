/**
 * Live E2E: Chrome for Testing + unpacked extension + cookies from debug Chrome,
 * open Sites file, wait for multiplayer URL, click Export, verify ZIP.
 */
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'rehearsal/extension-live');
const FILE_KEY = process.env.FIGMA_FILE_KEY || '';
const SITE_URL = `https://www.figma.com/site/${FILE_KEY}`;
const CDP_COOKIE_SOURCE = process.env.CDP_HTTP || 'http://127.0.0.1:9222';

mkdirSync(OUT, { recursive: true });

async function stealCookiesViaCdp() {
  const targets = await fetch(`${CDP_COOKIE_SOURCE}/json/list`).then((r) => r.json());
  const tab =
    targets.find((t) => t.type === 'page' && (t.url || '').includes(FILE_KEY)) ||
    targets.find((t) => t.type === 'page' && /figma\.com/.test(t.url || ''));
  if (!tab) throw new Error(`No Figma tab on ${CDP_COOKIE_SOURCE} — open Sites file in debug Chrome first`);

  // Use Playwright connect to evaluate cookies more reliably
  const browser = await chromium.connectOverCDP(CDP_COOKIE_SOURCE);
  const context = browser.contexts()[0];
  const cookies = await context.cookies('https://www.figma.com');
  await browser.close(); // detach only
  if (!cookies.some((c) => c.name === 'figma.session')) {
    throw new Error('figma.session missing in source Chrome');
  }
  return cookies;
}

function log(...a) {
  console.error('[live-export]', ...a);
}

async function pageWaitForExtension(context, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const workers = context.serviceWorkers();
    const extWorker = workers.find((w) => (w.url() || '').startsWith('chrome-extension://'));
    if (extWorker) {
      log('extension SW', extWorker.url());
      return extWorker;
    }
    // Playwright sometimes exposes via backgroundPages for MV2 only; poll waitForEvent
    await new Promise((r) => setTimeout(r, 500));
  }
  log(
    'no extension SW yet; workers=',
    context.serviceWorkers().map((w) => w.url()),
  );
  return null;
}

const cookies = await stealCookiesViaCdp();
log('cookies', cookies.length);

const userDataDir = `/tmp/figma-ext-pw-${Date.now()}`;
mkdirSync(userDataDir, { recursive: true });
log('userDataDir', userDataDir);
log('extension', EXT);

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: undefined, // force bundled Chrome for Testing (supports --load-extension)
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--enable-extensions',
  ],
  ignoreDefaultArgs: ['--disable-extensions'],
  acceptDownloads: true,
  viewport: { width: 1440, height: 900 },
});

await pageWaitForExtension(context);

await context.addCookies(
  cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite === 'None' ? 'None' : c.sameSite === 'Lax' ? 'Lax' : 'Lax',
  })),
);

const page = context.pages()[0] || (await context.newPage());
log('goto', SITE_URL);
await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(12000);

// Wait for extension panel
const panel = page.locator('#fse-panel');
try {
  await panel.waitFor({ state: 'visible', timeout: 20000 });
  log('panel visible');
} catch {
  // try toggle via evaluating content script state / inject hint
  log('panel not auto-visible; checking DOM');
  const has = await page.evaluate(() => !!document.getElementById('fse-root'));
  log('fse-root present?', has);
  if (!has) {
    // Content script may not have injected — list extensions via service workers
    const workers = context.serviceWorkers();
    log(
      'serviceWorkers',
      workers.map((w) => w.url()),
    );
    throw new Error('Extension content script not injected — load-extension may have failed');
  }
  await page.evaluate(() => {
    const p = document.getElementById('fse-panel');
    if (p) p.style.display = 'block';
  });
}

// Nudge UI so multiplayer WS is created if not yet
await page.mouse.click(400, 400).catch(() => {});
await page.waitForTimeout(3000);

// Poll meta until multiplayer captured (or timeout)
let meta = '';
for (let i = 0; i < 40; i++) {
  meta = await page.locator('#fse-meta').innerText().catch(() => '');
  log('meta', meta.replace(/\n/g, ' | '));
  if (/multiplayer.*captured/i.test(meta)) break;
  // click canvas / slight pan to encourage WS
  await page.mouse.click(500 + (i % 5) * 10, 420).catch(() => {});
  await page.waitForTimeout(2000);
}
if (!/multiplayer.*captured/i.test(meta)) {
  // Fallback: read from page hook state via injected probe
  const url = await page.evaluate(() => {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 2000);
      const onMsg = (ev) => {
        if (ev.data?.source === 'figma-sites-exporter' && ev.data?.type === 'MULTIPLAYER_URL') {
          clearTimeout(t);
          window.removeEventListener('message', onMsg);
          resolve(ev.data.url);
        }
      };
      window.addEventListener('message', onMsg);
      // If hook already saw one, we can't replay — try patching again by reading performance entries
      const entries = performance.getEntriesByType?.('resource') || [];
      resolve(null);
    });
  });
  log('fallback multiplayer', url);
  if (!url) {
    writeFileSync(path.join(OUT, 'fail-meta.txt'), meta);
    await page.screenshot({ path: path.join(OUT, 'fail.png'), fullPage: false });
    throw new Error('multiplayerUrl not captured');
  }
}

// Start download waiter before click
const downloadPromise = page.waitForEvent('download', { timeout: 180000 }).catch((e) => ({ error: e }));

log('click export');
await page.locator('#fse-export').click();

// Watch progress
for (let i = 0; i < 90; i++) {
  const prog = await page.locator('#fse-progress').innerText().catch(() => '');
  log('progress', prog.replace(/\n/g, ' '));
  if (/\[done\]/i.test(prog) || /\[error\]/i.test(prog)) break;
  await page.waitForTimeout(2000);
}

const download = await downloadPromise;
if (download?.error) {
  const prog = await page.locator('#fse-progress').innerText().catch(() => '');
  writeFileSync(path.join(OUT, 'fail-progress.txt'), prog);
  await page.screenshot({ path: path.join(OUT, 'fail-progress.png') });
  throw new Error('download event missing: ' + download.error.message + ' progress=' + prog);
}

const zipPath = path.join(OUT, await download.suggestedFilename());
await download.saveAs(zipPath);
log('saved', zipPath);

const zip = await JSZip.loadAsync(readFileSync(zipPath));
const codeNames = Object.keys(zip.files).filter((n) => n.startsWith('code/') && !n.endsWith('/'));
log('zip code files', codeNames);
const expectedDir = path.join(ROOT, 'rehearsal/kiwi-package/code');
const expected = existsSync(expectedDir) ? readdirSync(expectedDir) : [];
const got = codeNames.map((n) => n.slice('code/'.length));
const missing = expected.filter((n) => !got.includes(n));
writeFileSync(
  path.join(OUT, 'result.json'),
  JSON.stringify({ zipPath, codeNames: got, missing, expected }, null, 2),
);
if (missing.length) {
  throw new Error('missing CODE_FILE vs rehearsal: ' + missing.join(','));
}
log('OK export matches rehearsal code names');
await context.close();
