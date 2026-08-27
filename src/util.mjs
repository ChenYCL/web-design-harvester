/**
 * Small shared helpers. No dependencies beyond node builtins.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Deterministic short hash — used for asset filenames and block ids. */
export function shortHash(input, len = 8) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, len)
}

/** Turn arbitrary text into a filesystem/anchor-safe slug. */
export function slugify(text, max = 40) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/['"''""]/g, '')
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (s || 'block').slice(0, max).replace(/-+$/g, '')
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file))
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return file
}

export async function writeText(file, text) {
  await ensureDir(path.dirname(file))
  await writeFile(file, text, 'utf8')
  return file
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Round to at most `d` decimals, dropping trailing zeros ("12.50" -> 12.5). */
export function round(n, d = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n
  return Number(n.toFixed(d))
}

/** Pad a number for zero-prefixed ordinals: 1 -> "01". */
export function pad(n, width = 2) {
  return String(n).padStart(width, '0')
}

/** Human-readable byte size. */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${round(v, v < 10 && i > 0 ? 1 : 0)}${units[i]}`
}

/**
 * Retry an async fn with exponential backoff. Networked browser work is flaky
 * by nature; every external call in this tool goes through here.
 */
export async function retry(fn, { attempts = 3, baseMs = 500, label = 'op', onRetry } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i)
    } catch (err) {
      lastErr = err
      if (i === attempts - 1) break
      const wait = baseMs * Math.pow(2, i)
      onRetry?.(err, i + 1, wait)
      await sleep(wait)
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr?.message || lastErr}`, {
    cause: lastErr,
  })
}

/** Parse "1440,374" or "1440x900,374x812" into [{width,height,name}]. */
export function parseBreakpoints(spec) {
  const NAMES = [
    [1280, 'desktop'],
    [1024, 'laptop'],
    [768, 'tablet'],
    [0, 'mobile'],
  ]
  // Viewport height only affects how much loads before scrolling — captures are
  // full-page regardless. These are realistic device heights rather than a
  // ratio of the width, which produced absurdly short mobile viewports.
  const defaultHeight = (w) => (w >= 1280 ? 900 : w >= 768 ? 1024 : 812)
  return String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [w, h] = s.split(/[x×*]/i)
      const width = parseInt(w, 10)
      if (!Number.isFinite(width) || width <= 0) {
        throw new Error(`Invalid breakpoint "${s}" — expected e.g. 1440 or 1440x900`)
      }
      const height = h ? parseInt(h, 10) : defaultHeight(width)
      const name = NAMES.find(([min]) => width >= min)[1]
      return { width, height: Number.isFinite(height) ? height : 900, name }
    })
    .map((bp, i, all) => {
      // Disambiguate duplicate names (e.g. two mobile widths) by width suffix.
      const dupes = all.filter((o) => o.name === bp.name)
      return dupes.length > 1 ? { ...bp, name: `${bp.name}-${bp.width}` } : bp
    })
}

/** Extract a filename from a URL, falling back to a hash. */
export function filenameFromUrl(url, fallbackExt = '') {
  try {
    const u = new URL(url)
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base.replace(/[^\w.\-一-龥]/g, '_')
    if (base) return `${base.replace(/[^\w.\-]/g, '_')}${fallbackExt}`
  } catch {
    /* fall through to hash */
  }
  return `asset-${shortHash(url)}${fallbackExt}`
}

/**
 * Read a PNG's pixel dimensions straight from the IHDR chunk.
 * Used to verify that a capture actually came out the size it was asked for —
 * Chromium silently intersects clips with the viewport, so a screenshot can be
 * truncated without any error being raised.
 */
export async function pngSize(file) {
  const { open } = await import('node:fs/promises')
  let fh
  try {
    fh = await open(file, 'r')
    const buf = Buffer.alloc(24)
    const { bytesRead } = await fh.read(buf, 0, 24, 0)
    if (bytesRead < 24) return null
    if (buf.toString('ascii', 1, 4) !== 'PNG') return null
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Console logger with levels; quiet mode silences everything but errors. */export function createLogger({ quiet = false, verbose = false } = {}) {
  const stamp = () => new Date().toISOString().slice(11, 19)
  return {
    info: (...a) => !quiet && console.error(`[${stamp()}]`, ...a),
    step: (...a) => !quiet && console.error(`[${stamp()}] ▸`, ...a),
    warn: (...a) => !quiet && console.error(`[${stamp()}] ⚠`, ...a),
    error: (...a) => console.error(`[${stamp()}] ✗`, ...a),
    debug: (...a) => verbose && console.error(`[${stamp()}]  ·`, ...a),
    ok: (...a) => !quiet && console.error(`[${stamp()}] ✓`, ...a),
  }
}
