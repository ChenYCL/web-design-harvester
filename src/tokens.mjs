/**
 * Design token derivation.
 *
 * Turns a raw style survey ("here are 340 distinct font-size/line-height pairs")
 * into something a person or an LLM can actually implement against: a ranked,
 * deduplicated, named token set with an inferred spacing grid.
 *
 * The ranking is by usage count, not by value. A colour used 200 times is the
 * body colour; one used twice is an accent. Sorting by frequency means the top
 * of every list is the thing you should define first.
 */
import { round } from './util.mjs'

/** Normalise any CSS colour Chrome emits into #rrggbb / rgba() form. */
export function normaliseColor(input) {
  if (!input) return null
  const s = String(input).trim().toLowerCase()
  let m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/)
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((n) => Math.round(Number(n)))
    let a = m[4] == null ? 1 : m[4].endsWith('%') ? Number(m[4]) / 100 : Number(m[4])
    const hex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
    return a >= 0.999 ? hex : `${hex}@${round(a, 3)}`
  }
  m = s.match(/^#([0-9a-f]{3,8})$/)
  if (m) {
    let h = m[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    if (h.length === 4) h = h.split('').map((c) => c + c).join('')
    if (h.length === 6) return '#' + h
    if (h.length === 8) {
      const a = parseInt(h.slice(6), 16) / 255
      return a >= 0.999 ? '#' + h.slice(0, 6) : `#${h.slice(0, 6)}@${round(a, 3)}`
    }
  }
  return s // oklch(), color-mix(), gradients — pass through verbatim
}

const px = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Infer the base unit of the spacing system (usually 4 or 8).
 * Picks the largest candidate that divides most observed values cleanly.
 */
function inferGrid(values) {
  const nums = values.map(px).filter((n) => n != null && n > 0 && n < 400)
  if (nums.length < 4) return null
  let best = null
  for (const base of [8, 4, 6, 5, 3, 2]) {
    const hits = nums.filter((n) => Math.abs(n % base) < 0.51 || Math.abs((n % base) - base) < 0.51)
    const ratio = hits.length / nums.length
    if (ratio >= 0.75) {
      best = { base, conformance: round(ratio * 100, 1) }
      break
    }
  }
  return best
}

/** Merge the same token seen at several breakpoints into one row. */
function mergeByValue(perBreakpoint, key) {
  const merged = new Map()
  for (const [bp, survey] of Object.entries(perBreakpoint)) {
    for (const item of survey?.[key] || []) {
      const id = item.value
      if (!merged.has(id)) {
        merged.set(id, { value: id, total: 0, byBreakpoint: {}, samples: item.samples || [] })
      }
      const rec = merged.get(id)
      rec.total += item.count
      rec.byBreakpoint[bp] = item.count
    }
  }
  return [...merged.values()].sort((a, b) => b.total - a.total)
}

/**
 * Build the token set from per-breakpoint surveys.
 * @param {Record<string, object>} perBreakpoint  e.g. { desktop: survey, mobile: survey }
 */
export function buildTokens(perBreakpoint) {
  const colorRows = (key) =>
    mergeByValue(perBreakpoint, key)
      .map((r) => ({ ...r, value: normaliseColor(r.value) }))
      .reduce((acc, row) => {
        const hit = acc.find((a) => a.value === row.value)
        if (hit) {
          hit.total += row.total
          for (const [bp, n] of Object.entries(row.byBreakpoint)) {
            hit.byBreakpoint[bp] = (hit.byBreakpoint[bp] || 0) + n
          }
        } else acc.push({ ...row })
        return acc
      }, [])
      .sort((a, b) => b.total - a.total)

  const textColors = colorRows('textColors')
  const backgrounds = colorRows('backgrounds')
  const fontFamilies = mergeByValue(perBreakpoint, 'fontFamilies')
  const fontSizes = mergeByValue(perBreakpoint, 'fontSizes')
  const fontWeights = mergeByValue(perBreakpoint, 'fontWeights')
  const radii = mergeByValue(perBreakpoint, 'radii')
  const shadows = mergeByValue(perBreakpoint, 'shadows')
  const gaps = mergeByValue(perBreakpoint, 'gaps')
  const paddings = mergeByValue(perBreakpoint, 'paddings')

  // Type scale: split "16px / 24px" into size + leading, keep the dominant
  // leading per size, and sort descending so it reads as a scale.
  const typeScale = []
  for (const row of fontSizes) {
    const [sizeRaw, lhRaw] = String(row.value).split('/').map((s) => s.trim())
    const size = px(sizeRaw)
    if (size == null) continue
    const lh = px(lhRaw)
    const existing = typeScale.find((t) => t.size === size && t.lineHeight === lh)
    if (existing) {
      existing.count += row.total
    } else {
      typeScale.push({
        size,
        lineHeight: lh,
        ratio: lh && size ? round(lh / size, 3) : null,
        count: row.total,
        byBreakpoint: row.byBreakpoint,
        samples: row.samples.slice(0, 2),
      })
    }
  }
  typeScale.sort((a, b) => b.size - a.size || b.count - a.count)

  const spacingValues = [...gaps, ...paddings].map((r) => r.value)

  return {
    grid: inferGrid(spacingValues),
    color: {
      text: textColors.slice(0, 20),
      background: backgrounds.slice(0, 20),
    },
    typography: {
      families: fontFamilies.slice(0, 8),
      scale: typeScale.slice(0, 24),
      weights: fontWeights.slice(0, 8),
    },
    spacing: {
      gaps: gaps.slice(0, 20),
      paddings: paddings.slice(0, 24),
    },
    radii: radii.slice(0, 14),
    shadows: shadows.slice(0, 10),
  }
}

/**
 * Convert the internal `#rrggbb@alpha` notation back into valid CSS.
 *
 * The `@` form is compact and diffs well in the markdown tables, but it is not
 * a colour any browser understands — it must never reach tokens.css.
 */
export function toCssColor(value) {
  if (!value) return null
  const m = String(value).match(/^#([0-9a-f]{6})@([\d.]+)$/i)
  if (!m) return value
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
  return `rgba(${r}, ${g}, ${b}, ${Number(m[2])})`
}

/** Colours that carry no visual information and should never become tokens. */
function isUselessColor(value) {
  if (!value) return true
  const s = String(value).toLowerCase()
  if (s === 'transparent') return true
  // Fully transparent in any notation: "#fff@0", "rgba(…, 0)", "oklch(… / 0)".
  if (/@0(\.0+)?$/.test(s)) return true
  if (/[/,]\s*0(\.0+)?\s*\)$/.test(s)) return true
  // Chrome emits `none` components for unresolvable oklch values.
  if (s.includes('none')) return true
  return false
}

/**
 * Emit the token set as CSS custom properties — a directly usable artefact
 * rather than a table someone has to retype.
 */
export function tokensToCss(tokens) {
  const lines = [':root {']
  const seen = new Set()
  const put = (name, value) => {
    if (seen.has(name) || value == null) return
    seen.add(name)
    lines.push(`  ${name}: ${value};`)
  }

  lines.push('  /* colour — ranked by usage */')
  tokens.color.text
    .filter((c) => !isUselessColor(c.value))
    .slice(0, 10)
    .forEach((c, i) => put(`--color-text-${i + 1}`, toCssColor(c.value)))
  tokens.color.background
    .filter((c) => !isUselessColor(c.value))
    .slice(0, 10)
    .forEach((c, i) => put(`--color-bg-${i + 1}`, toCssColor(c.value)))

  lines.push('', '  /* typography */')
  tokens.typography.families.slice(0, 3).forEach((f, i) =>
    put(`--font-family-${i + 1}`, f.value),
  )
  tokens.typography.scale.slice(0, 12).forEach((t) => {
    put(`--font-size-${t.size}`, `${t.size}px`)
    if (t.lineHeight) put(`--line-height-${t.size}`, `${t.lineHeight}px`)
  })

  if (tokens.grid) {
    lines.push('', `  /* spacing — inferred ${tokens.grid.base}px grid (${tokens.grid.conformance}% conformance) */`)
    put('--space-unit', `${tokens.grid.base}px`)
  } else {
    lines.push('', '  /* spacing */')
  }
  const spaceVals = [
    ...new Set(
      [...tokens.spacing.gaps, ...tokens.spacing.paddings]
        .map((s) => parseFloat(s.value))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ].sort((a, b) => a - b)
  spaceVals.slice(0, 14).forEach((v) => put(`--space-${v}`, `${v}px`))

  if (tokens.radii.length) {
    lines.push('', '  /* radii */')
    tokens.radii.slice(0, 8).forEach((r) => {
      const n = parseFloat(r.value)
      if (Number.isFinite(n)) put(`--radius-${n}`, `${n}px`)
    })
  }

  if (tokens.shadows.length) {
    lines.push('', '  /* elevation */')
    tokens.shadows
      .filter((s) => !String(s.value).includes('none'))
      .slice(0, 6)
      .forEach((s, i) => put(`--shadow-${i + 1}`, s.value))
  }

  lines.push('}')
  return lines.join('\n') + '\n'
}
