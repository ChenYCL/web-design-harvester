/**
 * MCP server over stdio.
 *
 * Implements the JSON-RPC subset MCP actually needs (initialize, tools/list,
 * tools/call) directly rather than pulling in the SDK — it is about 80 lines of
 * protocol and avoids a dependency that would have to be kept in step with the
 * host.
 *
 * The tools deliberately mirror the CLI subcommands and share the same warm
 * PagePool, so a model asking six questions about one page pays for one page
 * load. Responses are markdown-shaped where a human-readable answer is more
 * useful than raw JSON, because the caller is a language model.
 *
 * This is a thin transport over the src/server.mjs ops — no logic is duplicated
 * here, and it shares the same warm PagePool as the HTTP daemon.
 */
import { PagePool, createOps } from './server.mjs'
import { createLogger } from './util.mjs'

const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  {
    name: 'harvest_outline',
    description:
      'Inspect a page\'s DOM structure before harvesting it. Returns the element tree with ' +
      'sizes and positions. Run this first on an unfamiliar page to decide whether the ' +
      'automatic block segmentation will work or whether you need a custom selector.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page URL (http/https)' },
        width: { type: 'number', description: 'Viewport width in px. Default 1440.' },
        maxDepth: { type: 'number', description: 'Tree depth to report. Default 4.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'harvest_blocks',
    description:
      'List the blocks (page sections) a URL would be split into, with their sizes, headings ' +
      'and a coverage figure. Use this to find the index of the section you care about, then ' +
      'pass that index to harvest_block.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        width: { type: 'number', description: 'Viewport width in px. Default 1440.' },
        selector: { type: 'string', description: 'CSS selector to force block boundaries.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'harvest_block',
    description:
      'Get one block\'s full structure: an indented tree of every visible element with its box ' +
      'and its distilled computed styles (UA defaults, inherited values and universal resets ' +
      'removed). This is the primary tool for reproducing a section in code.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        index: { type: 'number', description: 'Block index from harvest_blocks (0-based).' },
        width: { type: 'number', description: 'Viewport width in px. Default 1440.' },
        selector: { type: 'string' },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'markdown (compact, default) or json (exact values).',
        },
        maxNodes: { type: 'number', description: 'Node cap. Default 400.' },
      },
      required: ['url', 'index'],
    },
  },
  {
    name: 'harvest_tokens',
    description:
      'Extract design tokens from a page: colours, type scale, font families and weights, ' +
      'spacing, radii and shadows — each ranked by how often it is used, across one or more ' +
      'breakpoints. Returns the inferred spacing grid too.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        widths: { type: 'string', description: 'Comma-separated widths, e.g. "1440,375".' },
      },
      required: ['url'],
    },
  },
  {
    name: 'harvest_assets',
    description:
      'List every image, video and background asset the page references, with the box each is ' +
      'rendered into and its intrinsic size. Use harvest_analyse_asset on a downloaded file to ' +
      'get its content bounding box.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        width: { type: 'number' },
      },
      required: ['url'],
    },
  },
  {
    name: 'harvest_screenshot',
    description:
      'Screenshot a page or one of its blocks to a PNG file at 1 CSS pixel = 1 image pixel, so ' +
      'measurements taken off the image need no scaling. Returns the file path.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        out: { type: 'string', description: 'Output .png path.' },
        index: { type: 'number', description: 'Block index; omit for the full page.' },
        width: { type: 'number' },
      },
      required: ['url', 'out'],
    },
  },
  {
    name: 'harvest_analyse_asset',
    description:
      'Analyse a local image or video file. Returns intrinsic size plus the content bounding ' +
      'box measured from the alpha channel — the artwork\'s real extent inside its canvas, its ' +
      'centre as a percentage (use it directly as object-position), and its dominant colour. ' +
      'Correctly handles VP9 WebM with alpha, which ffprobe reports as having no alpha.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Path to a local media file.' } },
      required: ['file'],
    },
  },
  {
    name: 'harvest_site',
    description:
      'Run a full harvest and write a complete spec directory to disk: per-block screenshots ' +
      'and spec sheets, design tokens, responsive deltas, downloaded assets with fit analysis, ' +
      'and a README.md index. Slower than the targeted tools — use those for iteration and ' +
      'this when you want the whole artefact.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        out: { type: 'string', description: 'Output directory. Default ./out' },
        widths: { type: 'string', description: 'Comma-separated widths. Default "1440,375".' },
        selector: { type: 'string' },
        clean: { type: 'boolean', description: 'Wipe the output directory first.' },
        skipAssets: { type: 'boolean' },
      },
      required: ['url'],
    },
  },
  {
    name: 'harvest_status',
    description: 'Report the daemon\'s browser mode and which pages are currently warm.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const OP_FOR_TOOL = {
  harvest_outline: 'outline',
  harvest_blocks: 'blocks',
  harvest_block: 'block',
  harvest_tokens: 'tokens',
  harvest_assets: 'assets',
  harvest_screenshot: 'screenshot',
  harvest_analyse_asset: 'asset',
  harvest_site: 'harvest',
  harvest_status: 'status',
}

export async function runMcp({ log, common = {} } = {}) {
  // stdout is the protocol channel — every diagnostic must go to stderr.
  const logger = log || createLogger({ quiet: true })
  const pool = new PagePool({ ...common, log: logger })
  const ops = createOps(pool, common)

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  async function handle(msg) {
    const { id, method, params } = msg
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'web-design-harvester', version: '0.1.0' },
        })

      case 'notifications/initialized':
      case 'initialized':
        return // notification: no response

      case 'ping':
        return reply(id, {})

      case 'tools/list':
        return reply(id, { tools: TOOLS })

      case 'tools/call': {
        const name = params?.name
        const opName = OP_FOR_TOOL[name]
        if (!opName) return fail(id, -32602, `unknown tool: ${name}`)
        try {
          const result = await ops[opName](params?.arguments || {})
          return reply(id, {
            content: [{ type: 'text', text: formatResult(name, result) }],
          })
        } catch (err) {
          // Tool errors are reported in-band so the model can react and retry,
          // rather than as protocol errors which it never sees.
          return reply(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          })
        }
      }

      default:
        if (id === undefined) return // unknown notification
        return fail(id, -32601, `method not found: ${method}`)
    }
  }

  // Newline-delimited JSON-RPC.
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        logger.warn?.('dropped malformed JSON-RPC line')
        continue
      }
      handle(msg).catch((err) => {
        logger.error?.(`handler error: ${err.message}`)
        if (msg?.id !== undefined) fail(msg.id, -32603, err.message)
      })
    }
  })

  const shutdown = async () => {
    await pool.close()
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  logger.info?.('MCP server ready on stdio')
  await new Promise(() => {})
}

/**
 * Shape each result for a model reader. Where a table or tree is clearer than
 * JSON, emit that; keep JSON for genuinely structured payloads.
 */
function formatResult(tool, result) {
  switch (tool) {
    case 'harvest_blocks': {
      const lines = [
        `strategy: ${result.strategy}`,
        `coverage: ${((result.coverage?.ratio ?? 0) * 100).toFixed(1)}% of page height`,
        '',
        'idx  size          y      block',
      ]
      for (const b of result.blocks) {
        lines.push(
          `${String(b.index).padStart(3)}  ${`${Math.round(b.box.w)}×${Math.round(b.box.h)}`.padEnd(12)} ` +
            `${String(Math.round(b.box.y)).padStart(6)}  ${b.heading || b.sel}${b.sticky ? '  [sticky]' : ''}`,
        )
      }
      const unclaimed = (result.coverage?.gapsFound || []).filter((g) => !g.sel)
      if (unclaimed.length) {
        lines.push('', 'Unclaimed regions (not in any block):')
        for (const g of unclaimed) lines.push(`  y ${g.top} → ${g.bottom}`)
      }
      return lines.join('\n')
    }

    case 'harvest_block': {
      if (typeof result.tree !== 'string') return JSON.stringify(result, null, 2)
      const out = [`# ${result.meta.heading || result.meta.sel}`, '']
      out.push(`box: ${Math.round(result.meta.box.w)}×${Math.round(result.meta.box.h)} at y=${Math.round(result.meta.box.y)}`)
      out.push(`nodes: ${result.nodeCount} of ${result.totalNodes}${result.truncated ? ' (truncated)' : ''}`)
      if (result.commonStyle && Object.keys(result.commonStyle).length) {
        out.push('', 'Applies to most nodes below (omitted from each line):')
        for (const [k, v] of Object.entries(result.commonStyle)) out.push(`  ${k}: ${v};`)
      }
      out.push('', '```', result.tree, '```')
      return out.join('\n')
    }

    case 'harvest_analyse_asset': {
      if (result.streamingSegment) return result.note
      const L = [`${result.width}×${result.height}  ${result.codec || result.kind || ''}`]
      if (result.contentBox) {
        const cb = result.contentBox
        L.push(`content box: ${Math.round(cb.w)}×${Math.round(cb.h)} (ratio ${cb.ratio}, covers ${cb.coveragePct}% of canvas)`)
        L.push(`content centre: ${cb.centerXPct}% / ${cb.centerYPct}%`)
        if (Math.abs(cb.centerXPct - 50) > 2 || Math.abs(cb.centerYPct - 50) > 2) {
          L.push(`=> use object-position: ${cb.centerXPct}% ${cb.centerYPct}%  (artwork is not centred in its canvas)`)
        }
      }
      if (result.hasAlpha) L.push(`alpha: yes, ${result.transparentPct}% transparent`)
      if (result.dominantColor) L.push(`dominant colour: ${result.dominantColor}`)
      if (result.palette?.length) {
        L.push('palette: ' + result.palette.map((p) => p.hex).join(' '))
      }
      return L.join('\n')
    }

    case 'harvest_site':
      return [
        `Harvest complete: ${result.outDir}`,
        `blocks: ${result.blocks}`,
        `asset warnings: ${result.warnings}`,
        `coverage: ${((result.coverage ?? 0) * 100).toFixed(1)}%`,
        '',
        `Start by reading ${result.readme}`,
      ].join('\n')

    default:
      return JSON.stringify(result, null, 2)
  }
}

export { TOOLS }
