/**
 * CLI surface.
 *
 * Subcommands:
 *   harvest <url>          full spec directory
 *   outline <url>          DOM recon — run this first on an unfamiliar page
 *   blocks  <url>          list the blocks that would be captured, and stop
 *   asset   <file...>      analyse local media files (content bbox, palette)
 *   serve                  long-lived HTTP daemon with a warm browser
 *   mcp                    MCP server on stdio, for direct model access
 */
import path from 'node:path'
import { harvest } from './harvest.mjs'
import { openSession, newPageAt } from './browser.mjs'
import { installAgent, gotoStable, getOutline, getSegments } from './extract.mjs'
import { capturePage, captureBlockShot } from './capture.mjs'
import { analyseMedia } from './media.mjs'
import { createLogger, parseBreakpoints, round, writeJson } from './util.mjs'

const HELP = `
web-design-harvester — turn a rendered page into an LLM-readable design spec

USAGE
  harvest <url> [options]              full harvest -> spec directory
  harvest outline <url> [options]      print the DOM outline (recon)
  harvest blocks <url> [options]       list blocks that would be captured
  harvest screenshot <url> --out f.png screenshot a page or block (1 CSS px = 1 px)
  harvest asset <file...>              analyse local media files
  harvest serve [--port 8787]          HTTP daemon, browser stays warm
  harvest mcp                          MCP server on stdio

OPTIONS
  --out <dir>        output directory                    (default ./out)
  --widths <list>    breakpoints, e.g. 1440,375          (default 1440,375)
  --selector <css>   force block boundaries              (default: auto-detect)
  --settle <ms>      extra wait after the page stabilises (default 800)
  --max-nodes <n>    per-block node cap                  (default 400)
  --max-depth <n>    per-block depth cap                 (default 14)
  --skip-assets      do not download or analyse assets
  --clean            wipe the output directory first
  --headed           show the browser window
  --persist [dir]    reuse a profile on disk, keeping logins between runs
  --cdp <endpoint>   attach to an already-running Chrome (port or ws:// URL)
  --concurrency <n>  parallel asset downloads            (default 6)
  --index <n>        with 'screenshot': capture one block instead of the page
  --port <n>         with 'serve': listen port           (default 8787)
  --host <addr>      with 'serve': bind address          (default 127.0.0.1)
  --json             machine-readable output on stdout
  --quiet            errors only
  --verbose          debug logging
  -h, --help         this text

EXAMPLES
  harvest https://example.figma.site --out ./spec --clean
  harvest outline https://example.figma.site --widths 1440
  harvest https://example.com --selector "main > section" --widths 1440,768,375
  harvest serve --port 8787

NOTE ON FIGMA SITES
  A published site (https://<name>.figma.site) is a normal public page and works
  directly. The editor's preview iframe (*-figmaiframepreview.figma.site) is NOT
  a page — it is an empty shell that only renders once a logged-in figma.com tab
  hands it a script over postMessage. To harvest an unpublished site, open it in
  Chrome yourself and attach with --cdp. See README.md.
`

export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') args.help = true
    else if (a === '--json') args.json = true
    else if (a === '--quiet') args.quiet = true
    else if (a === '--verbose') args.verbose = true
    else if (a === '--clean') args.clean = true
    else if (a === '--headed') args.headless = false
    else if (a === '--skip-assets') args.skipAssets = true
    else if (a === '--persist') {
      // Optional value: `--persist` alone uses the default profile dir.
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        args.persist = true
        args.profileDir = next
        i++
      } else args.persist = true
    } else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else {
        args[key] = next
        i++
      }
    } else args._.push(a)
  }
  return args
}

export async function main(argv) {
  const args = parseArgs(argv)
  if (args.help || (!args._.length && !args.help)) {
    if (!args._.length) {
      console.log(HELP)
      return args.help ? 0 : 1
    }
  }

  const cmd = args._[0]
  const log = createLogger({ quiet: args.quiet, verbose: args.verbose })

  const num = (v, d) => (v === undefined ? d : Number(v))
  const common = {
    out: args.out || './out',
    widths: args.widths || '1440,375',
    selector: args.selector || null,
    settle: num(args.settle, 800),
    headless: args.headless !== false,
    cdp: args.cdp || null,
    persist: !!args.persist,
    profileDir: args.profileDir,
    maxNodes: num(args.maxNodes, 400),
    maxDepth: num(args.maxDepth, 14),
    skipAssets: !!args.skipAssets,
    clean: !!args.clean,
    quiet: !!args.quiet,
    verbose: !!args.verbose,
    concurrency: num(args.concurrency, 6),
    log,
  }

  try {
    switch (cmd) {
      case 'outline':
        return await cmdOutline(args._[1], args, common, log)
      case 'blocks':
        return await cmdBlocks(args._[1], args, common, log)
      case 'asset':
        return await cmdAsset(args._.slice(1), args, log)
      case 'screenshot':
        return await cmdScreenshot(args._[1] || args.url, args, common, log)
      case 'serve': {
        const { serve } = await import('./server.mjs')
        await serve({ port: num(args.port, 8787), host: args.host || '127.0.0.1', log, common })
        return 0
      }
      case 'mcp': {
        const { runMcp } = await import('./mcp.mjs')
        await runMcp({ log, common })
        return 0
      }
      default: {
        if (!/^https?:\/\//i.test(cmd)) {
          log.error(`unknown command or invalid URL: ${cmd}`)
          console.log(HELP)
          return 1
        }
        const { outDir, result } = await harvest(cmd, common)
        if (args.json) {
          console.log(JSON.stringify({ outDir, blocks: result.blocks.length, warnings: result.warnings.length }, null, 2))
        }
        return 0
      }
    }
  } catch (err) {
    log.error(err.message)
    if (args.verbose) console.error(err.stack)
    return 1
  }
}

async function withPage(url, common, log, fn) {
  const bps = parseBreakpoints(common.widths)
  const session = await openSession({
    cdp: common.cdp, persist: common.persist, headless: common.headless, log,
  })
  await installAgent(session.context)
  try {
    const page = await newPageAt(session, bps[0])
    await gotoStable(page, url, { settle: common.settle, log })
    return await fn(page, bps[0])
  } finally {
    await session.close().catch(() => {})
  }
}

async function cmdOutline(url, args, common, log) {
  if (!url) {
    log.error('outline requires a URL')
    return 1
  }
  const data = await withPage(url, common, log, (page) =>
    getOutline(page, { maxDepth: Number(args.maxDepth) || 4 }),
  )
  if (args.json) {
    console.log(JSON.stringify(data, null, 2))
    return 0
  }
  console.log(`\n${data.title}`)
  console.log(`${data.url}`)
  console.log(`viewport ${data.viewport.w}×${data.viewport.h} · document height ${data.scrollHeight}px`)
  console.log(`scroll root: ${data.scrollContainer}\n`)
  printOutline(data.tree, '')
  console.log(
    '\nIf the natural block boundaries are not the top-level children shown above,\n' +
      'pass --selector to force them, e.g. --selector "main > section".\n',
  )
  return 0
}

function printOutline(node, prefix, depth = 0) {
  const size = `${round(node.box.w, 0)}×${round(node.box.h, 0)}`
  const pos = `@${round(node.box.y, 0)}`
  const text = node.text ? `  "${node.text.slice(0, 44)}"` : ''
  console.log(
    `${prefix}${node.sel.padEnd(40 - Math.min(prefix.length, 20))} ${size.padStart(11)} ${pos.padStart(8)}  ${node.display}${node.position !== 'static' ? '/' + node.position : ''}${text}`,
  )
  const kids = node.children || []
  kids.forEach((k, i) => printOutline(k, prefix + '  ', depth + 1))
}

async function cmdBlocks(url, args, common, log) {
  if (!url) {
    log.error('blocks requires a URL')
    return 1
  }
  const seg = await withPage(url, common, log, (page) =>
    getSegments(page, { selector: common.selector }),
  )
  if (args.json) {
    console.log(JSON.stringify(seg, null, 2))
    return 0
  }
  console.log(`\nstrategy: ${seg.strategy}`)
  console.log(
    `coverage: ${round((seg.coverage?.ratio ?? 0) * 100, 1)}% ` +
      `(${round(seg.coverage?.coveredHeight ?? 0, 0)} of ${round(seg.coverage?.documentHeight ?? 0, 0)}px)\n`,
  )
  for (const b of seg.blocks) {
    console.log(
      `  ${String(b.index + 1).padStart(2, '0')}  ${b.sel.padEnd(30)} ` +
        `${(round(b.box.w, 0) + '×' + round(b.box.h, 0)).padStart(12)} @${round(b.box.y, 0)}` +
        `${b.sticky ? '  [sticky]' : ''}  ${b.heading || ''}`,
    )
  }
  const unfilled = (seg.coverage?.gapsFound || []).filter((g) => !g.sel)
  if (unfilled.length) {
    console.log('\n  ⚠ unclaimed regions:')
    for (const g of unfilled) console.log(`     y ${g.top} → ${g.bottom}`)
  }
  console.log('')
  return 0
}

/**
 * Screenshot a page or one of its blocks. Same 1 CSS px = 1 image px guarantee
 * as a full harvest, so an output PNG can be diffed against a harvested one
 * without any scaling.
 */
async function cmdScreenshot(url, args, common, log) {
  if (!url) {
    log.error('screenshot requires a URL (positional or --url)')
    return 1
  }
  const out = path.resolve(args.out || `./screenshot-${Date.now()}.png`)
  const result = await withPage(url, common, log, async (page) => {
    if (args.index !== undefined) {
      const seg = await getSegments(page, { selector: common.selector })
      const meta = seg.blocks[Number(args.index)]
      if (!meta) {
        throw new Error(`block ${args.index} not found — page has ${seg.blocks.length} blocks (0..${seg.blocks.length - 1})`)
      }
      return captureBlockShot(page, meta.box, out)
    }
    return capturePage(page, out)
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`${out}`)
    const dims = result.actual || result
    console.log(`  ${dims.width}×${dims.height} CSS px`)
    if (result.truncated) log.warn(result.note)
  }
  return 0
}

async function cmdAsset(files, args, log) {  if (!files.length) {
    log.error('asset requires at least one file')
    return 1
  }
  const out = {}
  for (const f of files) {
    const info = await analyseMedia(path.resolve(f), { log })
    out[f] = info
    if (!args.json) {
      console.log(`\n${f}`)
      if (!info) {
        console.log('  (could not analyse — is ffmpeg installed?)')
        continue
      }
      console.log(`  ${info.width}×${info.height}  ${info.codec || info.kind || ''}  ${info.pixFmt || ''}`)
      if (info.contentBox) {
        const cb = info.contentBox
        console.log(`  content box  ${round(cb.w, 0)}×${round(cb.h, 0)}  ratio ${cb.ratio}  covers ${cb.coveragePct}%`)
        console.log(`  centre       ${cb.centerXPct}% / ${cb.centerYPct}%   -> object-position: ${cb.centerXPct}% ${cb.centerYPct}%`)
      }
      if (info.dominantColor) console.log(`  dominant     ${info.dominantColor}`)
      if (info.hasAlpha) console.log(`  alpha        yes (${info.transparentPct}% transparent)`)
    }
  }
  if (args.json) console.log(JSON.stringify(out, null, 2))
  return 0
}

export { HELP }
