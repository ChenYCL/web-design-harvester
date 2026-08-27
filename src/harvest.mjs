/**
 * The harvest pipeline: URL in, spec directory out.
 *
 * Ordering matters here. Each breakpoint gets its own page and its own network
 * recorder, because which assets load and which blocks exist are both
 * breakpoint-dependent (a mobile layout may not request the desktop hero at
 * all). Blocks are then aligned across breakpoints so that "the pricing card"
 * is one entity with two measurements, not two unrelated captures.
 */
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { openSession, newPageAt } from './browser.mjs'
import {
  installAgent, gotoStable, getSegments, getBlockCapture,
  getTokenSurvey, getMediaRefs, getInteractive,
} from './extract.mjs'
import { capturePage, captureBlockShot, blockDirName } from './capture.mjs'
import { recordNetwork, downloadAssets, analyseFit } from './assets.mjs'
import { analyseMedia, detectTools } from './media.mjs'
import { buildTokens, tokensToCss } from './tokens.mjs'
import { renderBlockMd, diffBreakpoints, breakpointPairs } from './markdown.mjs'
import {
  renderReadme, renderTokensMd, renderResponsiveMd,
  renderInteractionsMd, renderAssetsMd,
} from './report.mjs'
import { ensureDir, writeJson, writeText, parseBreakpoints, createLogger, round } from './util.mjs'

/**
 * @param {string} url
 * @param {object} options
 */
export async function harvest(url, options = {}) {
  const {
    out = './out',
    widths = '1440,375',
    selector = null,
    settle = 800,
    headless = true,
    cdp = null,
    persist = false,
    maxNodes = 400,
    maxDepth = 14,
    skipAssets = false,
    clean = false,
    quiet = false,
    verbose = false,
    concurrency = 6,
  } = options

  const log = options.log || createLogger({ quiet, verbose })
  const breakpoints = parseBreakpoints(widths)
  const outDir = path.resolve(out)
  if (clean) await rm(outDir, { recursive: true, force: true })
  await ensureDir(outDir)

  const tools = await detectTools()
  if (!tools.ffprobe) {
    log.warn('ffprobe not found — asset dimensions and content boxes will be unavailable.')
    log.warn('Install with: brew install ffmpeg')
  }

  log.step(`harvesting ${url}`)
  log.info(`breakpoints: ${breakpoints.map((b) => `${b.name}@${b.width}`).join(', ')}`)

  const session = await openSession({ cdp, persist, headless, log })
  await installAgent(session.context)

  /** @type {Record<string, any>} */
  const perBp = {}
  const networkAll = new Map()
  let title = ''
  let primarySegmentation = null

  try {
    for (const bp of breakpoints) {
      log.step(`breakpoint ${bp.name} (${bp.width}px)`)
      const page = await newPageAt(session, bp)
      const rec = recordNetwork(page, { log })
      try {
        await gotoStable(page, url, { settle, log })
        title = title || (await page.title().catch(() => ''))

        const seg = await getSegments(page, { selector })
        log.info(`  ${seg.blocks.length} blocks via ${seg.strategy} — coverage ${round((seg.coverage?.ratio ?? 0) * 100, 1)}%`)
        if (!primarySegmentation) primarySegmentation = seg

        // Full-page reference shot.
        const pageShot = path.join(outDir, `page-${bp.name}.png`)
        await capturePage(page, pageShot)
        log.debug(`  page screenshot -> ${path.basename(pageShot)}`)

        // Per-block capture + screenshot.
        const blockData = []
        for (const b of seg.blocks) {
          const cap = await getBlockCapture(page, { box: b.box, maxNodes, maxDepth })
          if (!cap) {
            log.warn(`  block ${b.index} (${b.heading || b.tag}) could not be re-resolved — skipped`)
            continue
          }
          blockData.push({ meta: b, cap })
        }
        log.info(`  captured ${blockData.length}/${seg.blocks.length} blocks`)

        const survey = await getTokenSurvey(page)
        const mediaRefs = await getMediaRefs(page)
        const interactive = await getInteractive(page)

        for (const [u, e] of rec.entries) {
          if (!networkAll.has(u)) networkAll.set(u, e)
        }

        perBp[bp.name] = { bp, seg, blockData, survey, mediaRefs, interactive, pageShot, page }
      } finally {
        rec.detach()
      }
    }

    // ---- Align blocks across breakpoints ---------------------------------
    const aligned = alignBlocks(perBp, breakpoints)
    log.step(`aligned ${aligned.length} blocks across ${breakpoints.length} breakpoint(s)`)

    // ---- Block screenshots (needs the still-open pages) -------------------
    const blocksDir = path.join(outDir, 'blocks')
    for (const blk of aligned) {
      const dir = path.join(blocksDir, blk.dir)
      await ensureDir(dir)
      for (const bp of breakpoints) {
        const per = blk.byBreakpoint[bp.name]
        if (!per) continue
        const file = path.join(dir, `${bp.name}.png`)
        const shot = await captureBlockShot(perBp[bp.name].page, per.meta.box, file).catch((e) => {
          log.warn(`  screenshot failed for ${blk.dir}/${bp.name}: ${e.message}`)
          return null
        })
        if (shot) {
          per.shot = file
          if (shot.truncated) log.warn(`  ${blk.dir}/${bp.name}.png ${shot.note}`)
        }
      }
    }
    log.info('block screenshots done')

    // ---- Assets ----------------------------------------------------------
    const assetsDir = path.join(outDir, 'assets')
    const allRefs = breakpoints.flatMap((b) => perBp[b.name]?.mediaRefs || [])
    let manifest = {}
    let mediaInfo = {}
    if (!skipAssets) {
      log.step(`downloading ${networkAll.size} asset(s)`)
      const anyPage = perBp[breakpoints[0].name].page
      manifest = await downloadAssets(anyPage, networkAll, allRefs, assetsDir, { log, concurrency })
      const downloaded = Object.values(manifest).filter((m) => m.file && !m.duplicateOf)
      log.info(`  ${downloaded.length} unique file(s) after content-hash dedupe`)

      log.step('analysing media')
      for (const [u, rec] of Object.entries(manifest)) {
        if (!rec.file) continue
        const info = await analyseMedia(path.join(assetsDir, rec.file), { log })
        if (info) mediaInfo[u] = info
      }
      log.info(`  analysed ${Object.keys(mediaInfo).length} asset(s)`)
    }

    const warnings = analyseFit(manifest, mediaInfo)
    if (warnings.length) log.warn(`${warnings.length} asset fit problem(s) — see README.md`)

    // ---- Tokens ----------------------------------------------------------
    const surveys = Object.fromEntries(breakpoints.map((b) => [b.name, perBp[b.name]?.survey]))
    const tokens = buildTokens(surveys)

    // ---- Write block spec sheets -----------------------------------------
    const assetByUrl = manifest
    for (const blk of aligned) {
      const dir = path.join(blocksDir, blk.dir)
      const captures = {}
      const shots = {}
      for (const bp of breakpoints) {
        const per = blk.byBreakpoint[bp.name]
        if (!per) continue
        captures[bp.name] = per.cap
        if (per.shot) shots[bp.name] = per.shot
        await writeJson(path.join(dir, `tree.${bp.name}.json`), per.cap)
      }

      const blockAssets = collectBlockAssets(blk, assetByUrl, mediaInfo, breakpoints)
      const md = renderBlockMd(
        { ...blk.meta, index: blk.index, heading: blk.heading },
        { breakpoints, captures, shots, assets: blockAssets, warnings, siteTitle: title, url },
      )
      await writeText(path.join(dir, 'block.md'), md)

      // Deltas reused by responsive.md — one set per consecutive breakpoint
      // pair, so a three-breakpoint run documents both steps rather than
      // dropping everything past the first pair.
      blk.deltaSets = breakpointPairs(breakpoints)
        .map(([a, b]) => {
          const ca = captures[a.name]
          const cb = captures[b.name]
          if (!ca || !cb) return null
          return {
            from: a.name,
            to: b.name,
            fromWidth: a.width,
            toWidth: b.width,
            rows: diffBreakpoints(ca.tree, cb.tree, a.name, b.name),
          }
        })
        .filter(Boolean)
    }
    log.info(`wrote ${aligned.length} block spec sheet(s)`)

    // ---- Top-level docs ---------------------------------------------------
    const assetStats = {
      total: Object.values(manifest).filter((m) => m.file && !m.duplicateOf).length,
      bytes: Object.values(manifest).reduce((a, m) => a + (m.duplicateOf ? 0 : m.bytes || 0), 0),
    }
    const fonts = Object.values(manifest).filter((m) =>
      /font/.test(m.contentType || '') || /\.(woff2?|ttf|otf)$/i.test(m.file || ''),
    )

    const result = {
      url,
      title,
      generatedAt: new Date().toISOString(),
      breakpoints,
      segmentation: primarySegmentation,
      blocks: aligned.map((b) => ({
        index: b.index,
        heading: b.heading,
        dir: b.dir,
        tag: b.meta.tag,
        box: b.meta.box,
        sticky: b.meta.sticky,
        truncated: Object.values(b.byBreakpoint).some((v) => v.cap.truncated),
        deltaSets: b.deltaSets || [],
      })),
      tokens,
      warnings,
      assetStats,
      fonts,
      interactive: perBp[breakpoints[0].name]?.interactive || [],
    }

    await writeText(path.join(outDir, 'README.md'), renderReadme(result))
    await writeText(
      path.join(outDir, 'tokens.md'),
      renderTokensMd(tokens, breakpoints.map((b) => b.name)),
    )
    await writeText(path.join(outDir, 'tokens.css'), tokensToCss(tokens))
    await writeText(
      path.join(outDir, 'responsive.md'),
      renderResponsiveMd(result.blocks, breakpoints),
    )
    await writeText(
      path.join(outDir, 'interactions.md'),
      renderInteractionsMd(
        Object.fromEntries(breakpoints.map((b) => [b.name, perBp[b.name]?.interactive || []])),
      ),
    )
    if (!skipAssets) {
      await writeText(path.join(assetsDir, 'README.md'), renderAssetsMd(manifest, mediaInfo))
      await writeJson(path.join(assetsDir, 'manifest.json'), { manifest, mediaInfo })
    }
    await writeJson(path.join(outDir, 'warnings.json'), warnings)
    await writeJson(path.join(outDir, 'index.json'), {
      ...result,
      // index.json is the machine surface; keep the heavy nested trees out of it.
      blocks: result.blocks.map((b) => ({
        ...b,
        deltaSets: (b.deltaSets || []).map((d) => ({
          from: d.from, to: d.to, changes: d.rows.length,
        })),
      })),
    })

    log.ok(`harvest complete -> ${outDir}`)
    log.info(`  start at ${path.join(outDir, 'README.md')}`)
    return { outDir, result }
  } finally {
    await session.close().catch(() => {})
  }
}

/**
 * Match the same block across breakpoints.
 *
 * Heading text is the strongest signal and survives layout changes; index is
 * the fallback. Matching by geometry would be wrong here — the whole point is
 * that geometry differs between breakpoints.
 */
function alignBlocks(perBp, breakpoints) {
  const primary = perBp[breakpoints[0].name]
  if (!primary) return []

  const aligned = primary.blockData.map((bd, i) => ({
    index: i,
    heading: bd.meta.heading || '',
    meta: bd.meta,
    dir: blockDirName({ ...bd.meta, index: i }),
    byBreakpoint: { [breakpoints[0].name]: bd },
  }))

  for (const bp of breakpoints.slice(1)) {
    const other = perBp[bp.name]
    if (!other) continue
    const pool = [...other.blockData]
    // Pass 1: exact heading match.
    for (const blk of aligned) {
      if (!blk.heading) continue
      const hit = pool.findIndex((o) => o.meta.heading && o.meta.heading === blk.heading)
      if (hit >= 0) {
        blk.byBreakpoint[bp.name] = pool[hit]
        pool.splice(hit, 1)
      }
    }
    // Pass 2: positional fallback for whatever is left.
    for (const blk of aligned) {
      if (blk.byBreakpoint[bp.name]) continue
      const hit = pool.findIndex((o) => o.meta.index === blk.meta.index)
      const idx = hit >= 0 ? hit : pool.findIndex((o) => o.meta.tag === blk.meta.tag)
      if (idx >= 0) {
        blk.byBreakpoint[bp.name] = pool[idx]
        pool.splice(idx, 1)
      }
    }
  }
  return aligned
}

/** Assets whose render box falls inside this block, at any breakpoint. */
function collectBlockAssets(blk, manifest, mediaInfo, breakpoints) {
  const out = []
  const seen = new Set()
  for (const bp of breakpoints) {
    const per = blk.byBreakpoint[bp.name]
    if (!per) continue
    const box = per.meta.box
    for (const [url, rec] of Object.entries(manifest)) {
      for (const use of rec.usage || []) {
        if (!use.rendered || !use.box) continue
        const cy = use.box.y + use.box.h / 2
        if (cy < box.y || cy > box.y + box.h) continue
        const key = url + '|' + use.sel
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          url,
          file: rec.duplicateOf || rec.file,
          box: use.box,
          sel: use.sel,
          info: mediaInfo[url] || null,
        })
      }
    }
  }
  return out
}
