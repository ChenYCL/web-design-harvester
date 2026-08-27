/**
 * Browser acquisition + lifecycle.
 *
 * Three modes, in order of "how much state do you need":
 *   launch      — fresh headless Chromium. Fastest, zero state. Default.
 *   persistent  — a real profile dir on disk, so logins (Figma, staging basic-auth)
 *                 survive across runs. This is what makes repeat harvests reliable.
 *   cdp         — attach to a Chrome you already have open and logged in
 *                 (`--cdp http://127.0.0.1:9222`). Nothing is launched or closed.
 *
 * Everything else in the tool takes a `Session` and does not care which mode
 * produced it.
 */
import { chromium, devices } from 'playwright'
import path from 'node:path'
import os from 'node:os'
import { ensureDir, retry } from './util.mjs'

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

/** Default profile location for `--persist` with no explicit path. */
export function defaultProfileDir() {
  return path.join(os.homedir(), '.cache', 'web-design-harvester', 'profile')
}

/**
 * @typedef {Object} Session
 * @property {import('playwright').Browser|null} browser
 * @property {import('playwright').BrowserContext} context
 * @property {'launch'|'persistent'|'cdp'} mode
 * @property {() => Promise<void>} close
 */

/**
 * @returns {Promise<Session>}
 */
export async function openSession(opts = {}) {
  const {
    cdp = null,
    persist = false,
    profileDir = defaultProfileDir(),
    headless = true,
    log = console,
    timeout = 60_000,
  } = opts

  // --- Mode: attach to an already-running Chrome -------------------------
  if (cdp) {
    const endpoint = normaliseCdpEndpoint(cdp)
    const browser = await retry(() => chromium.connectOverCDP(endpoint, { timeout }), {
      attempts: 3,
      label: `connect to CDP ${endpoint}`,
      onRetry: (e, n) => log.warn?.(`CDP attach retry ${n}: ${e.message}`),
    })
    const context = browser.contexts()[0] ?? (await browser.newContext())
    log.debug?.(`attached over CDP to ${endpoint}`)
    return {
      browser,
      context,
      mode: 'cdp',
      // Detach, never kill — the user's browser is not ours to close.
      close: async () => {
        await browser.close().catch(() => {})
      },
    }
  }

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--font-render-hinting=none', // stable text metrics across machines
    '--disable-lcd-text',
    '--force-color-profile=srgb', // stable screenshot colour
    '--autoplay-policy=no-user-gesture-required', // let .webm hero media start
  ]

  // --- Mode: persistent profile ------------------------------------------
  if (persist) {
    await ensureDir(profileDir)
    const context = await retry(
      () =>
        chromium.launchPersistentContext(profileDir, {
          headless,
          args: launchArgs,
          userAgent: DEFAULT_UA,
          timeout,
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 1,
        }),
      { attempts: 2, label: 'launch persistent context' },
    )
    log.debug?.(`persistent profile at ${profileDir}`)
    return {
      browser: null,
      context,
      mode: 'persistent',
      close: async () => {
        await context.close().catch(() => {})
      },
    }
  }

  // --- Mode: fresh launch (default) --------------------------------------
  const browser = await retry(
    () => chromium.launch({ headless, args: launchArgs, timeout }),
    { attempts: 2, label: 'launch chromium' },
  )
  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  })
  return {
    browser,
    context,
    mode: 'launch',
    close: async () => {
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    },
  }
}

function normaliseCdpEndpoint(cdp) {
  const s = String(cdp).trim()
  if (/^\d+$/.test(s)) return `http://127.0.0.1:${s}`
  if (/^wss?:\/\//i.test(s) || /^https?:\/\//i.test(s)) return s
  return `http://${s}`
}

/**
 * Create a page sized for one breakpoint.
 *
 * deviceScaleFactor is pinned to 1 on purpose: combined with
 * `screenshot({ scale: 'css' })` it guarantees 1 screenshot pixel == 1 CSS pixel,
 * so measurements taken off the PNG need no conversion factor. — see "Screenshots are 1 CSS pixel" in README.md.
 */
export async function newPageAt(session, breakpoint, { isMobile = null } = {}) {
  const mobile = isMobile ?? breakpoint.width < 600
  const page = await session.context.newPage()
  await page.setViewportSize({ width: breakpoint.width, height: breakpoint.height })
  if (mobile) {
    // Touch capability changes which media queries match; Figma Sites uses them.
    await page.emulateMedia({ media: 'screen' })
  }
  return page
}

export { devices }
