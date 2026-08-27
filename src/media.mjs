/**
 * Media analysis via ffprobe/ffmpeg.
 *
 * Answers three questions the DOM cannot:
 *
 *  1. What are this asset's real intrinsic dimensions? (ffprobe)
 *
 *  2. Where is the actual *content* inside the canvas? Design assets routinely
 *     ship as a 1200×1200 square with the artwork occupying an off-centre
 *     1049×677 region. Laying that out with object-contain wastes 64px a side;
 *     object-cover + centre crops it off-axis, because the content centre sits
 *     at 52.5% rather than 50%. You cannot see this from the file dimensions —
 *     you have to measure the alpha channel.
 *
 *  3. What colour is it? Icon sets often ship with meaningless filenames
 *     (icon-1.svg … icon-11.svg), but each tile's fill is usually unique, so
 *     colour becomes a usable identity key when the name is not.
 *
 * VP9-with-alpha is the sharp edge here: ffprobe reports pix_fmt=yuv420p and
 * shows no alpha channel at all, yet browsers composite it correctly. The alpha
 * only appears if you force the libvpx-vp9 decoder — see README.md.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { round } from './util.mjs'

const exec = promisify(execFile)

const RASTER = /\.(png|jpe?g|webp|avif|gif|bmp|tiff?)$/i
const VIDEO = /\.(webm|mp4|mov|m4v|ogv)$/i
const SVG = /\.svg$/i

let toolCache = null

/** Detect ffmpeg/ffprobe once; the tool degrades gracefully without them. */
export async function detectTools() {
  if (toolCache) return toolCache
  const has = async (bin) => {
    try {
      await exec(bin, ['-version'], { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }
  toolCache = { ffmpeg: await has('ffmpeg'), ffprobe: await has('ffprobe') }
  return toolCache
}

/**
 * Analyse one local asset file.
 * @returns {Promise<object|null>}
 */
export async function analyseMedia(file, { log } = {}) {
  const tools = await detectTools()
  const ext = path.extname(file)
  try {
    if (SVG.test(ext)) return await analyseSvg(file)
    if (!tools.ffprobe) return null
    if (RASTER.test(ext) || VIDEO.test(ext)) {
      const probe = await probeFile(file, VIDEO.test(ext))
      if (!probe) return null
      const pixels = tools.ffmpeg ? await samplePixels(file, probe, VIDEO.test(ext)) : null
      return { ...probe, ...(pixels || {}) }
    }
  } catch (err) {
    // Sites that stream video over MSE serve DASH/fMP4 *segments*, not files.
    // Each segment is a valid part of a stream but has no moov box of its own,
    // so ffprobe rejects it. That is expected, not a failure to report.
    if (isStreamingSegment(err.message)) {
      return {
        streamingSegment: true,
        note:
          'DASH/fMP4 media segment — only decodable as part of its stream, ' +
          'not a standalone file. Reference the manifest URL, not this fragment.',
      }
    }
    log?.debug?.(`media analyse failed for ${path.basename(file)}: ${err.message}`)
  }
  return null
}

function isStreamingSegment(msg = '') {
  return (
    /no tfhd was found/i.test(msg) ||
    /error reading header/i.test(msg) ||
    /moov atom not found/i.test(msg) ||
    /Invalid data found when processing input/i.test(msg)
  )
}

// ------------------------------------------------------------------ probe --

async function probeFile(file, isVideo) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt,codec_name,duration,nb_frames,r_frame_rate',
    '-show_entries', 'format=duration,size',
    '-of', 'json',
    file,
  ]
  const { stdout } = await exec('ffprobe', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  const j = JSON.parse(stdout)
  const s = (j.streams || [])[0]
  if (!s) return null
  const fmt = j.format || {}
  const fps = parseRate(s.r_frame_rate)
  const out = {
    width: s.width,
    height: s.height,
    codec: s.codec_name,
    pixFmt: s.pix_fmt,
    ratio: s.width && s.height ? round(s.width / s.height, 4) : null,
    bytes: Number(fmt.size) || (await stat(file)).size,
  }
  if (isVideo) {
    out.duration = round(Number(s.duration || fmt.duration) || 0, 3)
    out.fps = fps
    out.frames = Number(s.nb_frames) || null
    // The pix_fmt lie: yuv420p here does NOT mean "no alpha" for VP9.
    out.alphaSuspected = s.codec_name === 'vp9' || s.codec_name === 'vp8'
  }
  return out
}

function parseRate(r) {
  if (!r) return null
  const [n, d] = String(r).split('/').map(Number)
  return d ? round(n / d, 3) : n || null
}

// ----------------------------------------------------------- pixel sample --

const SAMPLE_MAX = 512 // long-edge cap; bbox ratios are scale-invariant

/**
 * Decode one frame to raw RGBA and derive: alpha content bbox, content centre,
 * dominant colour, and average colour — in a single pass over the buffer.
 */
async function samplePixels(file, probe, isVideo) {
  const w = probe.width
  const h = probe.height
  if (!w || !h) return null
  const scaleFactor = Math.min(1, SAMPLE_MAX / Math.max(w, h))
  const sw = Math.max(1, Math.round(w * scaleFactor))
  const sh = Math.max(1, Math.round(h * scaleFactor))

  const pre = []
  // Force the VP9/VP8 decoder so the alpha plane is actually produced.
  if (isVideo && probe.alphaSuspected) pre.push('-vcodec', probe.codec === 'vp8' ? 'libvpx' : 'libvpx-vp9')

  const args = [
    ...pre,
    '-i', file,
    '-frames:v', '1',
    '-vf', `scale=${sw}:${sh}:flags=bilinear`,
    '-pix_fmt', 'rgba',
    '-f', 'rawvideo',
    '-',
  ]

  let buf
  try {
    const res = await exec('ffmpeg', args, {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    })
    buf = res.stdout
  } catch (err) {
    // Animated/odd inputs sometimes need a seek to land on a real frame.
    if (!isVideo) return null
    try {
      const res = await exec(
        'ffmpeg',
        [...pre, '-ss', '0.1', '-i', file, '-frames:v', '1', '-vf', `scale=${sw}:${sh}`, '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'],
        { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      )
      buf = res.stdout
    } catch {
      return null
    }
  }

  if (!buf || buf.length < sw * sh * 4) return null
  return analyseRgba(buf, sw, sh, w, h)
}

/** One pass over RGBA bytes -> bbox, centre, colours, transparency stats. */
function analyseRgba(buf, sw, sh, origW, origH) {
  const ALPHA_MIN = 8 // ignore near-invisible antialiasing fringe
  let minX = sw, minY = sh, maxX = -1, maxY = -1
  let opaqueCount = 0
  let transparentCount = 0
  let rSum = 0, gSum = 0, bSum = 0

  // Coarse colour histogram: 4 bits per channel = 4096 buckets.
  const hist = new Map()

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4
      const a = buf[i + 3]
      if (a < ALPHA_MIN) {
        transparentCount++
        continue
      }
      opaqueCount++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      const r = buf[i], g = buf[i + 1], b = buf[i + 2]
      rSum += r; gSum += g; bSum += b
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      const cur = hist.get(key)
      if (cur) {
        cur.n++; cur.r += r; cur.g += g; cur.b += b
      } else {
        hist.set(key, { n: 1, r, g, b })
      }
    }
  }

  const total = sw * sh
  const hasAlpha = transparentCount > total * 0.01

  if (maxX < 0) {
    return { hasAlpha: true, fullyTransparent: true, contentBox: null }
  }

  // Scale the measured bbox back to the asset's true pixel dimensions.
  const kx = origW / sw
  const ky = origH / sh
  const bx = minX * kx
  const by = minY * ky
  const bw = (maxX - minX + 1) * kx
  const bh = (maxY - minY + 1) * ky

  const palette = [...hist.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((c) => ({
      hex: rgbHex(Math.round(c.r / c.n), Math.round(c.g / c.n), Math.round(c.b / c.n)),
      share: round(c.n / opaqueCount, 4),
    }))

  return {
    hasAlpha,
    transparentPct: round((transparentCount / total) * 100, 1),
    contentBox: {
      x: round(bx, 1),
      y: round(by, 1),
      w: round(bw, 1),
      h: round(bh, 1),
      ratio: round(bw / bh, 4),
      // Percentage of the canvas the content occupies, and where its centre sits.
      // These two numbers are what you actually write into object-position.
      coveragePct: round(((bw * bh) / (origW * origH)) * 100, 1),
      centerXPct: round(((bx + bw / 2) / origW) * 100, 1),
      centerYPct: round(((by + bh / 2) / origH) * 100, 1),
    },
    dominantColor: palette[0]?.hex ?? null,
    palette,
    averageColor: rgbHex(
      Math.round(rSum / opaqueCount),
      Math.round(gSum / opaqueCount),
      Math.round(bSum / opaqueCount),
    ),
  }
}

function rgbHex(r, g, b) {
  const c = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

// -------------------------------------------------------------------- svg --

/**
 * SVGs are text: read the fills directly rather than rasterising. Exact, fast,
 * and it preserves the authored colour values used for identity matching.
 */
async function analyseSvg(file) {
  const src = await readFile(file, 'utf8')
  const viewBox = (src.match(/viewBox=["']([^"']+)["']/) || [])[1] || null
  const wAttr = (src.match(/\bwidth=["']([\d.]+)/) || [])[1]
  const hAttr = (src.match(/\bheight=["']([\d.]+)/) || [])[1]
  let width = wAttr ? Number(wAttr) : null
  let height = hAttr ? Number(hAttr) : null
  if ((!width || !height) && viewBox) {
    const p = viewBox.split(/[\s,]+/).map(Number)
    if (p.length === 4) {
      width = width || p[2]
      height = height || p[3]
    }
  }

  const colors = new Map()
  const colorRe = /(?:fill|stop-color|stroke)\s*[:=]\s*["']?(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/gi
  let m
  while ((m = colorRe.exec(src))) {
    const v = m[1].toLowerCase()
    if (v === 'none' || v === 'transparent') continue
    colors.set(v, (colors.get(v) || 0) + 1)
  }

  const palette = [...colors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([hex, count]) => ({ hex, count }))

  return {
    kind: 'svg',
    width,
    height,
    viewBox,
    ratio: width && height ? round(width / height, 4) : null,
    bytes: Buffer.byteLength(src),
    dominantColor: palette[0]?.hex ?? null,
    palette,
    // Inline SVG has no alpha canvas to trim; the viewBox IS the content box.
    contentBox: width && height
      ? { x: 0, y: 0, w: width, h: height, ratio: round(width / height, 4),
          coveragePct: 100, centerXPct: 50, centerYPct: 50 }
      : null,
  }
}

/**
 * Extract a real alpha-preserved still from a VP9 WebM — the exact incantation
 * exposed so users can pull poster frames without rediscovering
 * the `-vcodec libvpx-vp9` requirement.
 */
export async function extractAlphaFrame(input, output, { at = 0 } = {}) {
  const tools = await detectTools()
  if (!tools.ffmpeg) throw new Error('ffmpeg not available')
  const args = [
    '-vcodec', 'libvpx-vp9',
    ...(at ? ['-ss', String(at)] : []),
    '-i', input,
    '-pix_fmt', 'rgba',
    '-frames:v', '1',
    '-y', output,
  ]
  await exec('ffmpeg', args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  return output
}
