/**
 * Asset harvesting.
 *
 * Two sources, deliberately combined:
 *   - the network log  (catches everything actually fetched, incl. CSS url() and
 *     video segments the DOM never names)
 *   - the DOM media refs (catches how each asset is *used*: render box, alt,
 *     object-fit, natural size — which is what you need to reproduce it)
 *
 * Downloads go through the page's own request context so cookies, referer and
 * auth carry over; a CDN that 403s a bare curl will serve the browser.
 */
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { ensureDir, filenameFromUrl, shortHash, retry, round } from './util.mjs'

const ASSET_TYPES = /^(image|video|audio|font)\//i
const ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|m4v|ogg|mp3|wav|woff2?|ttf|otf|eot)(\?|#|$)/i

/**
 * Attach a network recorder to a page. Call before navigating.
 * @returns {{ entries: Map<string, object>, detach: () => void }}
 */
export function recordNetwork(page, { log } = {}) {
  const entries = new Map()

  const onResponse = (res) => {
    try {
      const url = res.url()
      if (url.startsWith('data:') || url.startsWith('blob:')) return
      const headers = res.headers()
      const ct = headers['content-type'] || ''
      const isAsset = ASSET_TYPES.test(ct) || ASSET_EXT.test(url)
      if (!isAsset) return
      const prev = entries.get(url)
      const entry = {
        url,
        status: res.status(),
        contentType: ct.split(';')[0].trim(),
        contentLength: Number(headers['content-length']) || null,
        fromCache: res.fromServiceWorker?.() || false,
        resourceType: res.request().resourceType(),
      }
      entries.set(url, prev ? { ...prev, ...entry } : entry)
    } catch (e) {
      log?.debug?.(`network record error: ${e.message}`)
    }
  }

  const onFailed = (req) => {
    const url = req.url()
    if (!ASSET_EXT.test(url)) return
    entries.set(url, {
      url,
      status: 0,
      failed: req.failure()?.errorText || 'request failed',
      resourceType: req.resourceType(),
    })
  }

  page.on('response', onResponse)
  page.on('requestfailed', onFailed)
  return {
    entries,
    detach: () => {
      page.off('response', onResponse)
      page.off('requestfailed', onFailed)
    },
  }
}

/**
 * Merge network entries with DOM usage, download each asset once, and return a
 * manifest keyed by URL.
 *
 * @param {import('playwright').Page} page
 * @param {Map<string,object>} networkEntries
 * @param {Array<object>} domRefs  from collectMediaRefs()
 * @param {string} assetsDir
 */
export async function downloadAssets(page, networkEntries, domRefs, assetsDir, opts = {}) {
  const { log = console, concurrency = 6, maxBytes = 40 * 1024 * 1024, skipDownload = false } = opts
  await ensureDir(assetsDir)

  // Index DOM usage by URL — one asset can be used in several places.
  const usageByUrl = new Map()
  for (const ref of domRefs || []) {
    if (!usageByUrl.has(ref.url)) usageByUrl.set(ref.url, [])
    usageByUrl.get(ref.url).push(ref)
  }

  const urls = new Set([...networkEntries.keys(), ...usageByUrl.keys()])
  const manifest = {}
  const list = [...urls].filter((u) => !u.startsWith('data:') && !u.startsWith('blob:'))

  // Content-hash dedupe: CDNs serve the same bytes under many URLs
  // (regionalized/, ?w=800 variants). We want one file on disk per unique image.
  const byContentHash = new Map()
  let done = 0

  async function handle(url) {
    const net = networkEntries.get(url) || {}
    const usage = usageByUrl.get(url) || []
    const rec = {
      url,
      contentType: net.contentType || null,
      status: net.status ?? null,
      resourceType: net.resourceType || (usage[0]?.kind ?? null),
      usage: usage.map((u) => ({
        kind: u.kind,
        sel: u.sel,
        box: u.box,
        rendered: u.rendered,
        natural: u.natural || null,
        alt: u.alt || undefined,
        backgroundSize: u.backgroundSize || undefined,
        poster: u.poster || undefined,
      })),
    }
    if (net.failed) rec.error = net.failed

    if (!skipDownload && !net.failed) {
      try {
        const body = await retry(
          async () => {
            const resp = await page.request.get(url, { timeout: 30_000, maxRedirects: 5 })
            if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`)
            return await resp.body()
          },
          { attempts: 3, baseMs: 400, label: `download ${url.slice(0, 80)}` },
        )
        if (body.length > maxBytes) {
          rec.error = `skipped: ${body.length} bytes exceeds maxBytes`
        } else {
          const hash = shortHash(body, 12)
          rec.bytes = body.length
          rec.contentHash = hash
          if (byContentHash.has(hash)) {
            rec.file = byContentHash.get(hash)
            rec.duplicateOf = rec.file
          } else {
            const name = uniqueName(url, rec.contentType, hash)
            const dest = path.join(assetsDir, name)
            await writeFile(dest, body)
            rec.file = name
            byContentHash.set(hash, name)
          }
        }
      } catch (err) {
        rec.error = err.message
      }
    }
    manifest[url] = rec
    done++
    if (done % 10 === 0) log.debug?.(`assets: ${done}/${list.length}`)
  }

  await pool(list, concurrency, handle)
  return manifest
}

function uniqueName(url, contentType, hash) {
  const extFromCt = contentType ? '.' + (contentType.split('/')[1] || '').replace(/\+xml$/, '') : ''
  let base = filenameFromUrl(url, extFromCt)
  if (!/\.[a-z0-9]{2,5}$/i.test(base) && extFromCt.length > 1) base += extFromCt
  // Prefix with the content hash so distinct assets never collide on name.
  return `${hash}-${base}`.slice(0, 120)
}

/** Bounded-concurrency map. Keeps a big page from opening 200 sockets. */
async function pool(items, limit, fn) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Compare each asset's intrinsic aspect ratio against the box it is rendered
 * into, and flag combinations that cannot be solved in CSS.
 *
 * Worked example: an asset with a content ratio of 1.02 rendered into a
 * 1.63 slot. No object-fit value makes that work — cover crops ~84px off,
 * contain leaves dead space. That is an asset-export problem, and the only
 * cheap fix is to find out on run 1 instead of after six rounds of CSS tweaks.
 *
 * `delta` here is literally the fraction of the artwork that `cover` discards,
 * which is why the thresholds are set where they are: losing a third of an
 * image is a re-export, not a focal-point tweak. The 1.02-into-1.63 case works
 * out at 37%, and must land in the "unsolvable" bucket to match the document.
 */
const FIT_WARN = 0.15 // noticeable crop
const FIT_UNSOLVABLE = 0.33 // a third of the artwork lost

export function analyseFit(manifest, mediaInfo = {}) {
  const found = new Map()
  for (const [url, rec] of Object.entries(manifest)) {
    const info = mediaInfo[url]
    if (info?.streamingSegment) continue
    for (const use of rec.usage || []) {
      if (!use.rendered || !use.box || !use.box.w || !use.box.h) continue
      const slotRatio = use.box.w / use.box.h
      // Prefer the measured content bbox (alpha-trimmed) over the raw canvas.
      const contentRatio =
        info?.contentBox?.ratio ??
        (use.natural?.w && use.natural?.h ? use.natural.w / use.natural.h : null)
      if (!contentRatio || !Number.isFinite(contentRatio)) continue
      const delta = Math.abs(contentRatio - slotRatio) / Math.max(contentRatio, slotRatio)
      if (delta <= FIT_WARN) continue

      // One finding per (asset bytes, slot shape). The same image served from
      // several CDN URLs into the same-shaped slot is one problem, not eight.
      const key = `${rec.contentHash || rec.file || url}|${round(slotRatio, 2)}`
      const existing = found.get(key)
      if (existing) {
        existing.occurrences++
        if (!existing.selectors.includes(use.sel)) existing.selectors.push(use.sel)
        continue
      }
      found.set(key, {
        url,
        file: rec.duplicateOf || rec.file || null,
        sel: use.sel,
        selectors: [use.sel],
        occurrences: 1,
        slot: { w: use.box.w, h: use.box.h, ratio: round(slotRatio, 3) },
        content: { ratio: round(contentRatio, 3), box: info?.contentBox || null },
        deltaPct: round(delta * 100, 1),
        cropPct: round(delta * 100, 1),
        verdict:
          delta > FIT_UNSOLVABLE
            ? `unsolvable in CSS — cover discards ${round(delta * 100, 0)}% of the artwork; re-export at the slot ratio`
            : 'cover will crop noticeably; check the focal point',
      })
    }
  }
  return [...found.values()].sort((a, b) => b.deltaPct - a.deltaPct)
}
