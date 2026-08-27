/**
 * Screenshot capture.
 *
 * The whole point of this module is that 1 image pixel == 1 CSS pixel.
 *
 * Background: the previous manual workflow used Figma's `@2x` PNG exports, where
 * 1798px of image mapped to 1440px of design — every measurement had to be
 * divided by K=1.2486 before use, and getting that wrong silently produced
 * plausible-but-wrong values. Pinning deviceScaleFactor=1 and scale:'css' makes
 * K exactly 1, so a pixel measured off the PNG is a CSS pixel, full stop.
 */
import path from 'node:path'
import { ensureDir, pad, slugify, pngSize } from './util.mjs'
import { freezeMotion, unfreezeMotion } from './extract.mjs'

/**
 * Full-page screenshot at CSS scale.
 * @returns {Promise<{file: string, width: number, height: number}>}
 */
export async function capturePage(page, outFile, { freeze = true } = {}) {
  await ensureDir(path.dirname(outFile))
  if (freeze) await freezeMotion(page).catch(() => {})
  try {
    await page.screenshot({ path: outFile, fullPage: true, scale: 'css', animations: 'disabled' })
  } finally {
    if (freeze) await unfreezeMotion(page).catch(() => {})
  }
  const dims = await page.evaluate(() => ({
    width: window.innerWidth,
    height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
  }))
  return { file: outFile, ...dims }
}

/**
 * Screenshot one block by its page-space box.
 *
 * Uses a page-space clip rather than elementHandle.screenshot(): an element
 * screenshot scrolls the element into view, which re-triggers scroll-driven
 * animation and lets a `position: fixed` header land on top of whatever block
 * happens to be under it. A clip against the already-settled full page is both
 * more deterministic and much faster.
 */
export async function captureBlockShot(page, box, outFile, { freeze = true, hideFixed = true } = {}) {
  await ensureDir(path.dirname(outFile))
  const clip = normaliseClip(box)
  if (!clip) return null

  if (freeze) await freezeMotion(page).catch(() => {})
  let restore = null
  if (hideFixed) restore = await hideFixedOverlays(page, clip)
  try {
    // fullPage is required even though we are clipping: without it Chromium
    // intersects the clip with the viewport, so any block taller than the
    // viewport (or starting below its fold) comes back silently truncated.
    await page.screenshot({
      path: outFile,
      clip,
      fullPage: true,
      scale: 'css',
      animations: 'disabled',
    })
  } finally {
    if (restore) await restore().catch(() => {})
    if (freeze) await unfreezeMotion(page).catch(() => {})
  }

  // Verify rather than assume. A truncated capture is worse than a failed one:
  // it looks fine, and every measurement taken from it is quietly wrong.
  const actual = await pngSize(outFile)
  if (actual && (actual.width !== clip.width || actual.height !== clip.height)) {
    return {
      file: outFile,
      ...clip,
      actual,
      truncated: true,
      note: `requested ${clip.width}×${clip.height}, got ${actual.width}×${actual.height}`,
    }
  }
  return { file: outFile, ...clip, actual }
}

function normaliseClip(box) {
  const x = Math.max(0, Math.floor(box.x))
  const y = Math.max(0, Math.floor(box.y))
  const width = Math.floor(box.w)
  const height = Math.floor(box.h)
  if (width < 1 || height < 1) return null
  // Chromium refuses absurd captures; clamp rather than throw so one oversized
  // block cannot fail an entire harvest.
  return { x, y, width: Math.min(width, 16384), height: Math.min(height, 16384) }
}

/**
 * Temporarily hide sticky/fixed overlays that are not themselves the block
 * being captured, so they don't stamp a floating nav across every section.
 * Returns a restore function.
 */
async function hideFixedOverlays(page, clip) {
  const hid = await page.evaluate((c) => {
    const marked = []
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue
      const r = el.getBoundingClientRect()
      const top = r.top + window.scrollY
      // If the overlay IS the block we're capturing, leave it alone.
      const isTarget = Math.abs(top - c.y) < 2 && Math.abs(r.height - c.height) < 2
      if (isTarget) continue
      if (r.width === 0 || r.height === 0) continue
      el.setAttribute('data-harvest-hidden', el.style.visibility || '__none__')
      el.style.visibility = 'hidden'
      marked.push(1)
    }
    return marked.length
  }, clip)

  if (!hid) return null
  return async () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-harvest-hidden]')) {
        const prev = el.getAttribute('data-harvest-hidden')
        el.style.visibility = prev === '__none__' ? '' : prev
        el.removeAttribute('data-harvest-hidden')
      }
    })
}

/** Stable on-disk name for a block: "03-add-interactions-with-a-click". */
export function blockDirName(block) {
  const label = block.heading || block.role || block.tag || 'block'
  return `${pad(block.index + 1)}-${slugify(label, 36)}`
}
