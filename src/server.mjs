/**
 * Long-lived HTTP daemon.
 *
 * The reason this exists: a cold harvest spends most of its wall clock on
 * browser startup and first paint. If a model is iterating — "re-check that
 * block", "now at 768px", "what colour is that icon" — paying that cost per
 * question makes the tool unusable interactively.
 *
 * The daemon keeps a browser and a pool of loaded pages warm, so a follow-up
 * query against an already-open URL is fast. Pages are reaped when idle so a
 * daemon left running overnight doesn't hold a browser per URL it ever saw.
 *
 * Node's built-in http module only — no framework, nothing to keep patched.
 */
import http from 'node:http'
import path from 'node:path'
import { openSession, newPageAt } from './browser.mjs'
import {
  installAgent, gotoStable, getOutline, getSegments, getBlockCapture,
  getTokenSurvey, getMediaRefs, getInteractive,
} from './extract.mjs'
import { capturePage, captureBlockShot } from './capture.mjs'
import { analyseMedia } from './media.mjs'
import { harvest } from './harvest.mjs'
import { buildTokens } from './tokens.mjs'
import { renderTree, styleDigest } from './markdown.mjs'
import { parseBreakpoints, createLogger, ensureDir, round } from './util.mjs'

const IDLE_MS = 10 * 60 * 1000 // reap a page after 10 minutes unused
const SWEEP_MS = 60 * 1000

/**
 * Warm page pool keyed by `url@width`. Shared by the HTTP server and the MCP
 * server so both get the same reuse behaviour.
 */
export class PagePool {
  constructor(opts = {}) {
    this.opts = opts
    this.log = opts.log || createLogger({ quiet: true })
    this.session = null
    this.pages = new Map()
    this.timer = null
    this._starting = null
  }

  async session_() {
    if (this.session) return this.session
    // Guard against concurrent first-requests racing to launch two browsers.
    if (!this._starting) {
      this._starting = (async () => {
        const s = await openSession({
          cdp: this.opts.cdp,
          persist: this.opts.persist,
          headless: this.opts.headless !== false,
          log: this.log,
        })
        await installAgent(s.context)
        this.session = s
        this.log.info?.(`browser ready (${s.mode})`)
        return s
      })()
    }
    return this._starting
  }

  key(url, width) {
    return `${url}@${width}`
  }

  /** Get a settled page for this url+width, reusing one if we have it. */
  async acquire(url, width, { settle = 600, reload = false } = {}) {
    const k = this.key(url, width)
    const existing = this.pages.get(k)
    if (existing && !reload && !existing.page.isClosed()) {
      existing.lastUsed = Date.now()
      return existing.page
    }
    if (existing) {
      await existing.page.close().catch(() => {})
      this.pages.delete(k)
    }

    const session = await this.session_()
    const bps = parseBreakpoints(String(width))
    const page = await newPageAt(session, bps[0])
    await gotoStable(page, url, { settle, log: this.log })
    this.pages.set(k, { page, lastUsed: Date.now(), url, width })
    this.startSweeper()
    return page
  }

  startSweeper() {
    if (this.timer) return
    this.timer = setInterval(() => {
      const now = Date.now()
      for (const [k, v] of this.pages) {
        if (now - v.lastUsed > IDLE_MS) {
          this.pages.delete(k)
          v.page.close().catch(() => {})
          this.log.debug?.(`reaped idle page ${k}`)
        }
      }
    }, SWEEP_MS)
    this.timer.unref?.()
  }

  status() {
    return {
      browser: this.session ? this.session.mode : 'not started',
      pages: [...this.pages.values()].map((v) => ({
        url: v.url,
        width: v.width,
        idleSeconds: Math.round((Date.now() - v.lastUsed) / 1000),
      })),
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer)
    for (const v of this.pages.values()) await v.page.close().catch(() => {})
    this.pages.clear()
    await this.session?.close().catch(() => {})
    this.session = null
    this._starting = null
  }
}

// ------------------------------------------------------------ operations --

/**
 * The operations exposed by both the HTTP and MCP surfaces. Each takes a plain
 * params object and returns plain JSON — no transport concerns in here.
 */
export function createOps(pool, common = {}) {
  const width = (p) => Number(p.width) || 1440

  return {
    async status() {
      return pool.status()
    },

    /** Structural recon — what does this page's DOM look like? */
    async outline(p) {
      requireUrl(p)
      const page = await pool.acquire(p.url, width(p), { reload: p.reload })
      return getOutline(page, { maxDepth: Number(p.maxDepth) || 4 })
    },

    /** The blocks this page would be split into. */
    async blocks(p) {
      requireUrl(p)
      const page = await pool.acquire(p.url, width(p), { reload: p.reload })
      return getSegments(page, { selector: p.selector || null })
    },

    /**
     * One block's structure. `format: "markdown"` returns the indented tree,
     * which is what a model should normally ask for; "json" returns exact values.
     */
    async block(p) {
      requireUrl(p)
      const page = await pool.acquire(p.url, width(p), { reload: p.reload })
      const seg = await getSegments(page, { selector: p.selector || null })
      const idx = Number(p.index)
      const meta = seg.blocks[idx]
      if (!meta) {
        throw new HttpError(404, `block ${idx} not found — page has ${seg.blocks.length} blocks (0..${seg.blocks.length - 1})`)
      }
      const cap = await getBlockCapture(page, {
        box: meta.box,
        maxNodes: Number(p.maxNodes) || 400,
        maxDepth: Number(p.maxDepth) || 14,
      })
      if (!cap) throw new HttpError(500, `block ${idx} could not be captured`)
      if (p.format === 'json') return { meta, ...cap }
      return {
        meta,
        commonStyle: cap.commonStyle,
        nodeCount: cap.nodeCount,
        totalNodes: cap.totalNodes,
        truncated: cap.truncated,
        tree: renderTree(cap.tree),
      }
    },

    /** Design tokens for a single page, without writing anything to disk. */
    async tokens(p) {
      requireUrl(p)
      const widths = p.widths ? parseBreakpoints(p.widths) : [{ width: width(p), name: 'desktop' }]
      const surveys = {}
      for (const bp of widths) {
        const page = await pool.acquire(p.url, bp.width, { reload: p.reload })
        surveys[bp.name] = await getTokenSurvey(page)
      }
      return buildTokens(surveys)
    },

    /** Assets referenced by the page, with their render boxes. */
    async assets(p) {
      requireUrl(p)
      const page = await pool.acquire(p.url, width(p), { reload: p.reload })
      const refs = await getMediaRefs(page)
      return { count: refs.length, assets: refs }
    },

    async interactive(p) {
      requireUrl(p)
      const page = await pool.acquire(p.url, width(p), { reload: p.reload })
      return { elements: await getInteractive(page) }
    },

    /** Screenshot to a file; returns the path. */
    async screenshot(p) {
      requireUrl(p)
      const page = await pool.acquire(p.url, width(p), { reload: p.reload })
      const out = path.resolve(p.out || `./shot-${Date.now()}.png`)
      await ensureDir(path.dirname(out))
      if (p.index != null) {
        const seg = await getSegments(page, { selector: p.selector || null })
        const meta = seg.blocks[Number(p.index)]
        if (!meta) throw new HttpError(404, `block ${p.index} not found`)
        const r = await captureBlockShot(page, meta.box, out)
        return { file: out, ...r }
      }
      const r = await capturePage(page, out)
      return { file: out, ...r }
    },

    /** Analyse a local media file. */
    async asset(p) {
      if (!p.file) throw new HttpError(400, 'file is required')
      const info = await analyseMedia(path.resolve(p.file))
      if (!info) throw new HttpError(422, 'could not analyse (is ffmpeg installed?)')
      return info
    },

    /** Full harvest to disk. Slower; use the targeted ops for iteration. */
    async harvest(p) {
      requireUrl(p)
      const { outDir, result } = await harvest(p.url, {
        ...common,
        out: p.out || './out',
        widths: p.widths || '1440,375',
        selector: p.selector || null,
        clean: !!p.clean,
        skipAssets: !!p.skipAssets,
        log: pool.log,
      })
      return {
        outDir,
        readme: path.join(outDir, 'README.md'),
        blocks: result.blocks.length,
        warnings: result.warnings.length,
        coverage: result.segmentation?.coverage?.ratio ?? null,
      }
    },
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function requireUrl(p) {
  if (!p?.url) throw new HttpError(400, 'url is required')
  if (!/^https?:\/\//i.test(p.url)) throw new HttpError(400, `url must be http(s): got "${p.url}"`)
}

// ----------------------------------------------------------- http server --

const ROUTES = `
web-design-harvester daemon

  GET  /status
  GET  /outline?url=&width=&maxDepth=
  GET  /blocks?url=&width=&selector=
  GET  /block?url=&index=&width=&format=markdown|json
  GET  /tokens?url=&widths=1440,375
  GET  /assets?url=&width=
  GET  /interactive?url=&width=
  GET  /screenshot?url=&out=&index=
  GET  /asset?file=
  POST /harvest        {"url":"…","out":"./out","widths":"1440,375"}

Any endpoint also accepts POST with a JSON body.
Add &reload=1 to force a fresh page load instead of reusing the warm one.
`

export async function serve({ port = 8787, host = '127.0.0.1', log, common = {} } = {}) {
  const logger = log || createLogger({})
  const pool = new PagePool({ ...common, log: logger })
  const ops = createOps(pool, common)

  const server = http.createServer(async (req, res) => {
    const started = Date.now()
    let url
    try {
      url = new URL(req.url, `http://localhost:${port}`)
    } catch {
      return send(res, 400, { error: 'bad request URL' })
    }
    const name = url.pathname.replace(/^\/+|\/+$/g, '') || 'index'

    if (name === 'index') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(ROUTES)
    }

    const op = ops[name]
    if (!op) return send(res, 404, { error: `no such endpoint: /${name}`, help: ROUTES.trim() })

    try {
      const params = Object.fromEntries(url.searchParams)
      if (req.method === 'POST') Object.assign(params, await readJson(req))
      const result = await op(params)
      logger.debug?.(`${req.method} /${name} ${Date.now() - started}ms`)
      send(res, 200, result)
    } catch (err) {
      logger.warn?.(`/${name}: ${err.message}`)
      send(res, err.status || 500, { error: err.message })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is already in use — pass --port to pick another`))
      } else reject(err)
    })
    // Bind to loopback by default. This daemon fetches arbitrary URLs and writes
    // files where it is told, so it should not be reachable off-box unless the
    // operator explicitly asks for that with --host.
    server.listen(port, host, resolve)
  })

  logger.ok?.(`daemon listening on http://${host}:${port}`)
  logger.info?.('browser starts on first request and stays warm; Ctrl-C to stop')

  const shutdown = async () => {
    logger.info?.('shutting down…')
    server.close()
    await pool.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep the process alive.
  await new Promise(() => {})
}

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'body too large')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

export { HttpError, styleDigest, round }
