/**
 * Page driving: navigate reliably, install the in-page agent, wait for the page
 * to actually settle, and expose the agent's methods as typed async calls.
 *
 * "Settle" is the crux of stability. A Figma Sites page is not done when `load`
 * fires: fonts stream in, hero video decodes, scroll-driven reveals only run
 * once you scroll past them, and layout shifts for a second or two afterwards.
 * Screenshotting too early produces subtly wrong measurements, which is exactly
 * the class of error this tool exists to eliminate.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { retry, sleep } from './util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let AGENT_SRC = null

async function agentSource() {
  if (!AGENT_SRC) AGENT_SRC = await readFile(path.join(HERE, 'page-agent.js'), 'utf8')
  return AGENT_SRC
}

/** Install the agent so it survives navigations and exists in every frame. */
export async function installAgent(pageOrContext) {
  const src = await agentSource()
  await pageOrContext.addInitScript({ content: src })
}

/** Ensure the agent is present right now (covers pages loaded before install). */
export async function ensureAgent(page) {
  const has = await page.evaluate(() => !!window.__HARVEST__).catch(() => false)
  if (!has) await page.evaluate(await agentSource())
}

/**
 * Navigate and wait until the page is visually stable.
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 */
export async function gotoStable(page, url, opts = {}) {
  const {
    settle = 800,
    timeout = 60_000,
    prime = true,
    stabilityTimeout = 15_000,
    log = console,
  } = opts

  await retry(
    () => page.goto(url, { waitUntil: 'domcontentloaded', timeout }),
    { attempts: 3, label: `navigate ${url}`, onRetry: (e, n) => log.warn?.(`nav retry ${n}: ${e.message}`) },
  )

  // networkidle can never fire on pages with polling/analytics — treat as best effort.
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
  await page.evaluate(() => document.fonts?.ready).catch(() => {})

  await ensureAgent(page)

  if (prime) {
    // Scroll the page to force lazy images, IntersectionObserver reveals and
    // scroll-driven animations to run, then return to the top.
    await page.evaluate(() => window.__HARVEST__.primeLazyContent()).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
  }

  await waitForLayoutStable(page, { timeout: stabilityTimeout, log })
  if (settle > 0) await sleep(settle)
  return page
}

/**
 * Poll document height + a cheap layout fingerprint until it stops changing.
 * Far more reliable than a fixed sleep, and much faster in the common case.
 */
export async function waitForLayoutStable(page, { timeout = 15_000, quietMs = 600, log } = {}) {
  const start = Date.now()
  let last = null
  let stableSince = null
  while (Date.now() - start < timeout) {
    const fp = await page
      .evaluate(() => {
        const d = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
        const n = document.querySelectorAll('body *').length
        const imgs = Array.from(document.images)
        const pending = imgs.filter((i) => !i.complete).length
        return `${d}|${n}|${pending}`
      })
      .catch(() => null)
    if (fp == null) break
    if (fp === last) {
      if (stableSince == null) stableSince = Date.now()
      if (Date.now() - stableSince >= quietMs) return true
    } else {
      last = fp
      stableSince = null
    }
    await sleep(150)
  }
  log?.debug?.('layout did not fully settle within timeout — continuing')
  return false
}

// --------------------------------------------------------------- agent API --

const call = (page, method, arg) =>
  page.evaluate(
    ([m, a]) => window.__HARVEST__[m](a),
    [method, arg ?? null],
  )

export const getOutline = (page, opts) => call(page, 'outline', opts)
export const getSegments = (page, opts) => call(page, 'segment', opts)
export const getBlockCapture = (page, opts) => call(page, 'captureBlock', opts)
export const getTokenSurvey = (page, opts) => call(page, 'surveyTokens', opts)
export const getMediaRefs = (page) => call(page, 'collectMediaRefs')
export const getInteractive = (page) => call(page, 'collectInteractive')
export const freezeMotion = (page) => call(page, 'freezeMotion')
export const unfreezeMotion = (page) => call(page, 'unfreezeMotion')

/**
 * Resolve a block element handle by the box recorded during segmentation.
 * Atomic hashed class names are not unique, so geometry is the reliable key.
 */
export async function blockHandle(page, box) {
  const handle = await page.evaluateHandle(
    (b) => window.__HARVEST__.elementAtBox(b),
    box,
  )
  const el = handle.asElement()
  if (!el) {
    await handle.dispose()
    return null
  }
  return el
}
