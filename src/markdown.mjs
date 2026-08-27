/**
 * Markdown rendering — the LLM-facing surface of the tool.
 *
 * Everything else produces facts; this decides how a model reads them. Two
 * constraints drive the format:
 *
 *  - Token budget. A JSON tree of 400 nodes is ~15k tokens and a model has to
 *    parse it before it can use it. The same tree as an indented outline with a
 *    condensed style digest is ~2k and is directly readable. JSON stays on disk
 *    for when exact values are needed; markdown is what gets read first.
 *
 *  - Decisions, not data. `object-position: 50% 52.5%` is the answer;
 *    "here is the alpha channel" is homework. Where the tool can compute the
 *    conclusion, it states the conclusion.
 */
import path from 'node:path'
import { round, humanBytes } from './util.mjs'
import { normaliseColor } from './tokens.mjs'

// ---------------------------------------------------------- style digest --

const SIDES = ['top', 'right', 'bottom', 'left']

/** Collapse four longhand sides into a CSS-shorthand-ish string, or null. */
function quad(style, prefix, suffix = '') {
  const v = SIDES.map((s) => style[`${prefix}-${s}${suffix}`] ?? '0px')
  if (v.every((x) => x === '0px' || x === '0')) return null
  const n = v.map((x) => (parseFloat(x) === 0 ? '0' : String(parseFloat(x))))
  if (n[0] === n[1] && n[1] === n[2] && n[2] === n[3]) return n[0]
  if (n[0] === n[2] && n[1] === n[3]) return `${n[0]}/${n[1]}`
  return n.join('/')
}

/**
 * Condense a distilled style object into a short, information-dense line.
 * This is lossy by design — `tree.<bp>.json` holds the exact values.
 */
export function styleDigest(style = {}) {
  const out = []
  const s = style

  // layout mode
  const disp = s.display
  if (disp === 'flex' || disp === 'inline-flex') {
    const dir = s['flex-direction'] === 'column' ? 'col' : 'row'
    out.push(`flex-${dir}`)
    if (s['flex-wrap'] === 'wrap') out.push('wrap')
  } else if (disp === 'grid' || disp === 'inline-grid') {
    out.push('grid')
    if (s['grid-template-columns']) out.push(`cols:${shortenTrack(s['grid-template-columns'])}`)
  } else if (disp && disp !== 'block') {
    out.push(disp)
  }

  const gapR = s['row-gap']
  const gapC = s['column-gap']
  if (gapR || gapC) {
    out.push(gapR === gapC || !gapC ? `gap:${num(gapR)}` : `gap:${num(gapR)}/${num(gapC)}`)
  }
  if (s['justify-content']) out.push(`jc:${shortAlign(s['justify-content'])}`)
  if (s['align-items']) out.push(`ai:${shortAlign(s['align-items'])}`)

  const pad = quad(s, 'padding')
  if (pad) out.push(`pad:${pad}`)
  const mar = quad(s, 'margin')
  if (mar) out.push(`mar:${mar}`)

  // position
  if (s.position && s.position !== 'static') {
    const offs = SIDES.filter((k) => s[k]).map((k) => `${k[0]}:${num(s[k])}`)
    out.push(s.position + (offs.length ? `(${offs.join(',')})` : ''))
  }
  if (s['z-index']) out.push(`z:${s['z-index']}`)

  // typography
  const fs = s['font-size']
  const lh = s['line-height']
  if (fs) out.push(lh ? `${num(fs)}/${num(lh)}` : `${num(fs)}px`)
  else if (lh) out.push(`lh:${num(lh)}`)
  if (s['font-weight']) out.push(`w${s['font-weight']}`)
  if (s['letter-spacing']) out.push(`ls:${num(s['letter-spacing'])}`)
  if (s['text-align']) out.push(`ta:${s['text-align']}`)
  if (s['text-transform']) out.push(s['text-transform'])
  if (s['font-family']) out.push(`ff:${shortFamily(s['font-family'])}`)

  // paint
  if (s.color) out.push(normaliseColor(s.color))
  if (s['background-color']) out.push(`bg:${normaliseColor(s['background-color'])}`)
  if (s['background-image']) out.push(`bgimg:${shortenImage(s['background-image'])}`)
  if (s['background-size']) out.push(`bgsize:${s['background-size']}`)
  if (s['object-fit']) out.push(`fit:${s['object-fit']}`)
  if (s['object-position']) out.push(`objpos:${s['object-position']}`)

  // border
  const rad = radiusDigest(s)
  if (rad) out.push(`r:${rad}`)
  const bw = quad(s, 'border', '-width')
  if (bw) {
    const col = s['border-top-color'] ? normaliseColor(s['border-top-color']) : ''
    out.push(`bd:${bw}${col ? ' ' + col : ''}`)
  }
  if (s['box-shadow']) out.push(`shadow:${shortenShadow(s['box-shadow'])}`)
  if (s.opacity) out.push(`op:${s.opacity}`)
  if (s.filter) out.push(`filter:${s.filter}`)
  if (s['backdrop-filter']) out.push(`backdrop:${s['backdrop-filter']}`)

  // motion
  if (s.transform) out.push(`tf:${shortenTransform(s.transform)}`)
  if (s['transition-duration'] && s['transition-duration'] !== '0s') {
    out.push(`trans:${s['transition-property'] || 'all'} ${s['transition-duration']}`)
  }
  if (s['animation-name']) out.push(`anim:${s['animation-name']} ${s['animation-duration'] || ''}`.trim())

  if (s.overflow_) out.push(s.overflow_)
  const ox = s['overflow-x']
  const oy = s['overflow-y']
  if (ox && ox === oy) out.push(`overflow:${ox}`)
  else {
    if (ox) out.push(`overflow-x:${ox}`)
    if (oy) out.push(`overflow-y:${oy}`)
  }

  if (s.fill) out.push(`fill:${normaliseColor(s.fill)}`)
  if (s.stroke) out.push(`stroke:${normaliseColor(s.stroke)}`)

  return out.join('  ')
}

const num = (v) => (v == null ? '' : String(round(parseFloat(v), 2)))

function radiusDigest(s) {
  const corners = [
    s['border-top-left-radius'],
    s['border-top-right-radius'],
    s['border-bottom-right-radius'],
    s['border-bottom-left-radius'],
  ]
  if (corners.every((c) => !c)) return null
  const n = corners.map((c) => (c ? String(round(parseFloat(c), 2)) : '0'))
  return n.every((x) => x === n[0]) ? n[0] : n.join('/')
}

function shortAlign(v) {
  return String(v).replace('flex-', '').replace('space-', 'sp-')
}
function shortFamily(v) {
  return String(v).split(',')[0].replace(/["']/g, '').trim()
}
function shortenTrack(v) {
  const s = String(v)
  return s.length > 44 ? s.slice(0, 41) + '…' : s
}
function shortenImage(v) {
  const s = String(v)
  const m = s.match(/url\((['"]?)(.*?)\1\)/)
  if (m) {
    const file = m[2].split('/').pop().split('?')[0]
    return `url(${file.length > 30 ? file.slice(0, 27) + '…' : file})`
  }
  return s.length > 50 ? s.slice(0, 47) + '…' : s
}
function shortenShadow(v) {
  const s = String(v)
  return s.length > 46 ? s.slice(0, 43) + '…' : s
}
function shortenTransform(v) {
  const s = String(v)
  return s.length > 40 ? s.slice(0, 37) + '…' : s
}

// ------------------------------------------------------------ tree render --

/**
 * Render a captured subtree as an indented outline.
 * Columns: selector (padded) · size · style digest · text
 */
export function renderTree(node, { maxDepth = 8, maxLines = 220 } = {}) {
  const lines = []
  let truncated = false

  function walk(n, prefix, isLast, depth) {
    if (lines.length >= maxLines) {
      truncated = true
      return
    }
    const branch = depth === 0 ? '' : isLast ? '└─ ' : '├─ '
    const label = prefix + branch + n.sel
    const size = `${round(n.box.w, 1)}×${round(n.box.h, 1)}`
    const digest = styleDigest(n.style)
    const text = n.text ? `  "${n.text.replace(/"/g, "'").slice(0, 60)}"` : ''
    const extra = []
    if (n.src) extra.push(`src:${String(n.src).split('/').pop().split('?')[0].slice(0, 34)}`)
    if (n.iframe) extra.push(n.crossOrigin ? 'IFRAME(cross-origin)' : 'IFRAME')
    if (n.href) extra.push(`href:${String(n.href).slice(0, 40)}`)
    if (n.natural?.w) extra.push(`natural:${n.natural.w}×${n.natural.h}`)
    if (n.ariaLabel) extra.push(`aria:"${n.ariaLabel.slice(0, 30)}"`)

    lines.push(
      `${label.padEnd(46)} ${size.padStart(13)}  ${digest}${extra.length ? '  ' + extra.join(' ') : ''}${text}`,
    )

    if (depth >= maxDepth || !n.children?.length) return
    const kids = n.children
    const childPrefix = prefix + (depth === 0 ? '' : isLast ? '   ' : '│  ')
    kids.forEach((k, i) => walk(k, childPrefix, i === kids.length - 1, depth + 1))
  }

  walk(node, '', true, 0)
  if (truncated) lines.push(`… truncated at ${maxLines} lines — see tree JSON for the rest`)
  return lines.join('\n')
}

/** Flatten a tree into positional paths so breakpoints can be compared. */
function flattenWithPath(node, pathStr = '0', out = new Map()) {
  out.set(pathStr, node)
  ;(node.children || []).forEach((c, i) => flattenWithPath(c, `${pathStr}.${i}`, out))
  return out
}

/**
 * Diff two breakpoint captures of the same block.
 *
 * Worked example: card radius went 12px -> 6px and title 20/30 -> 16/24 between the
 * 1440 and 374 frames, while header padding stayed at 32px. Those are not
 * derivable by scaling — they have to be measured at both widths, and the
 * differences are the actual responsive spec.
 */
export function diffBreakpoints(aTree, bTree, aName, bName, { maxRows = 60 } = {}) {
  if (!aTree || !bTree) return []
  const A = flattenWithPath(aTree)
  const B = flattenWithPath(bTree)
  const rows = []
  for (const [p, an] of A) {
    const bn = B.get(p)
    if (!bn || an.tag !== bn.tag) continue
    const props = new Set([...Object.keys(an.style || {}), ...Object.keys(bn.style || {})])
    for (const prop of props) {
      const av = an.style?.[prop]
      const bv = bn.style?.[prop]
      if (av === bv) continue
      // Ignore pure reflow noise: a width that simply follows the viewport.
      if (prop === 'width' || prop === 'height') continue
      rows.push({ sel: an.sel, prop, [aName]: av ?? '—', [bName]: bv ?? '—' })
    }
    // Box changes are worth one row, not four.
    if (Math.abs(an.box.h - bn.box.h) > 2) {
      rows.push({ sel: an.sel, prop: 'box height', [aName]: round(an.box.h, 1), [bName]: round(bn.box.h, 1) })
    }
  }
  return rows.slice(0, maxRows)
}

/**
 * Consecutive breakpoint pairs: [desktop→tablet, tablet→mobile].
 *
 * Consecutive rather than everything-against-desktop, because that is how the
 * media queries are actually written — each step only has to restate what
 * changed since the previous one. With two breakpoints this degenerates to the
 * single pair you'd expect.
 */
export function breakpointPairs(breakpoints) {
  const pairs = []
  for (let i = 0; i < breakpoints.length - 1; i++) {
    pairs.push([breakpoints[i], breakpoints[i + 1]])
  }
  return pairs
}

// ------------------------------------------------------------- md helpers --

export function mdTable(headers, rows) {
  if (!rows.length) return '_none_\n'
  const esc = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${headers.map((h) => esc(r[h])).join(' | ')} |`).join('\n')
  return [head, sep, body].join('\n') + '\n'
}

export function swatch(color) {
  const c = normaliseColor(color)
  return c || '—'
}

// ------------------------------------------------------------ block page --

/**
 * One block's spec sheet. This is the file an LLM is pointed at when asked to
 * build a single section.
 */
export function renderBlockMd(block, ctx) {
  const { breakpoints, captures, shots, assets = [], warnings = [], siteTitle, url } = ctx
  const L = []
  const title = block.heading || `${block.tag} block`

  L.push(`# ${String(block.index + 1).padStart(2, '0')} · ${title}`)
  L.push('')
  L.push(`> Section ${block.index + 1} of "${siteTitle}" — ${url}`)
  L.push('')

  // Screenshots first: the model should see the target before the numbers.
  const shotLines = breakpoints
    .filter((bp) => shots[bp.name])
    .map((bp) => `![${bp.name}](${path.basename(shots[bp.name])})`)
  if (shotLines.length) {
    L.push('## Reference')
    L.push('')
    L.push(...shotLines)
    L.push('')
  }

  // Geometry across breakpoints.
  L.push('## Geometry')
  L.push('')
  L.push(
    mdTable(
      ['breakpoint', 'width', 'size', 'y offset', 'position'],
      breakpoints
        .filter((bp) => captures[bp.name])
        .map((bp) => {
          const c = captures[bp.name]
          return {
            breakpoint: bp.name,
            width: `${bp.width}px`,
            size: `${round(c.tree.box.w, 1)}×${round(c.tree.box.h, 1)}`,
            'y offset': round(c.tree.box.y, 1),
            position: c.tree.style?.position || 'static',
          }
        }),
    ),
  )

  // Shared resets, stated once.
  const primary = captures[breakpoints[0]?.name]
  if (primary?.commonStyle && Object.keys(primary.commonStyle).length) {
    L.push('## Applies to most nodes in this block')
    L.push('')
    L.push('```css')
    for (const [k, v] of Object.entries(primary.commonStyle)) L.push(`${k}: ${v};`)
    L.push('```')
    L.push('')
    L.push('_Omitted from the per-node listings below to keep them readable._')
    L.push('')
  }

  // Structure per breakpoint.
  for (const bp of breakpoints) {
    const cap = captures[bp.name]
    if (!cap) continue
    L.push(`## Structure — ${bp.name} (${bp.width}px)`)
    L.push('')
    L.push('```')
    L.push(renderTree(cap.tree))
    L.push('```')
    if (cap.truncated) {
      L.push('')
      L.push(`⚠ Capture truncated at ${cap.nodeCount} of ${cap.totalNodes} nodes.`)
    }
    L.push('')
  }

  // Responsive deltas, one table per consecutive breakpoint pair. With three or
  // more breakpoints every step gets its own table — comparing only the first
  // two would silently drop the mobile spec entirely.
  for (const [a, b] of breakpointPairs(breakpoints)) {
    const ca = captures[a.name]
    const cb = captures[b.name]
    if (!ca || !cb) continue
    const rows = diffBreakpoints(ca.tree, cb.tree, a.name, b.name)
    L.push(`## Responsive deltas — ${a.name} (${a.width}px) → ${b.name} (${b.width}px)`)
    L.push('')
    if (rows.length) {
      L.push(
        '_Values that change between these two breakpoints. These are the ones you cannot derive by scaling._',
      )
      L.push('')
      L.push(mdTable(['sel', 'prop', a.name, b.name], rows))
    } else {
      L.push(`_No style differences — this block only reflows by width between ${a.name} and ${b.name}._`)
      L.push('')
    }
  }

  // Copy.
  const texts = collectText(primary?.tree)
  if (texts.length) {
    L.push('## Copy')
    L.push('')
    for (const t of texts.slice(0, 40)) L.push(`- ${t.tag}: "${t.text}"`)
    L.push('')
  }

  // Assets used here.
  if (assets.length) {
    L.push('## Assets in this block')
    L.push('')
    L.push(
      mdTable(
        ['file', 'intrinsic', 'rendered', 'fit guidance'],
        assets.map((a) => ({
          file: a.file ? `[${a.file}](../../assets/${a.file})` : a.url.slice(0, 50),
          intrinsic: a.info?.width ? `${a.info.width}×${a.info.height}` : '—',
          rendered: a.box ? `${round(a.box.w, 0)}×${round(a.box.h, 0)}` : '—',
          'fit guidance': fitGuidance(a),
        })),
      ),
    )
  }

  // Embedded frames. Worth calling out explicitly: an iframe is a hole in both
  // the DOM tree and the screenshot, so a reader who isn't told will interpret
  // the resulting empty rectangle as a capture failure or as genuine blank space.
  const frames = collectFrames(primary?.tree)
  if (frames.length) {
    L.push('## Embedded frames')
    L.push('')
    L.push(
      'This block contains `<iframe>` elements. Their content belongs to another document, so ' +
        'it is **not** in the structure above and may be blank in the screenshot. Whatever the ' +
        'frame renders has to be reproduced separately.',
    )
    L.push('')
    L.push(
      mdTable(
        ['size', 'origin', 'loading', 'src'],
        frames.map((f) => ({
          size: `${round(f.box.w, 0)}×${round(f.box.h, 0)}`,
          origin: f.crossOrigin ? 'cross-origin' : 'same-origin',
          loading: f.loading || 'eager',
          src: f.src ? String(f.src).slice(0, 70) : '—',
        })),
      ),
    )
  }

  const blockWarnings = warnings.filter((w) =>
    assets.some((a) => (w.file && a.file === w.file) || a.url === w.url),
  )
  if (blockWarnings.length) {
    L.push('## ⚠ Asset problems')
    L.push('')
    for (const w of blockWarnings) {
      L.push(`- **${w.file || w.url.slice(0, 40)}** — content ratio ${w.content.ratio} vs slot ${w.slot.ratio} (${w.deltaPct}% off). ${w.verdict}`)
    }
    L.push('')
  }

  return L.join('\n')
}

/**
 * Turn a measured content box into the CSS you should actually write.
 * This is the payoff of the alpha analysis: not "here are the numbers" but
 * "here is the object-position value that centres this correctly".
 */
export function fitGuidance(a) {
  const cb = a.info?.contentBox
  if (!cb) return '—'
  const bits = []
  if (cb.coveragePct < 92) {
    bits.push(`content fills ${cb.coveragePct}% of canvas`)
  }
  const offCentre = Math.abs(cb.centerXPct - 50) > 2 || Math.abs(cb.centerYPct - 50) > 2
  if (offCentre) {
    bits.push(`**object-position: ${cb.centerXPct}% ${cb.centerYPct}%**`)
  }
  if (a.box?.w && a.box?.h) {
    const slot = a.box.w / a.box.h
    const d = Math.abs(cb.ratio - slot) / slot
    if (d > 0.25) bits.push(`⚠ ratio ${cb.ratio} vs slot ${round(slot, 2)}`)
    else if (!bits.length) bits.push('cover/contain both fine')
  }
  return bits.join('; ') || 'centred, full-bleed'
}

function collectText(node, out = []) {
  if (!node) return out
  if (node.text) out.push({ tag: node.tag, text: node.text })
  for (const c of node.children || []) collectText(c, out)
  return out
}

function collectFrames(node, out = []) {
  if (!node) return out
  if (node.iframe) out.push(node)
  for (const c of node.children || []) collectFrames(c, out)
  return out
}

export { humanBytes }
