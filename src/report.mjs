/**
 * Top-level report assembly.
 *
 * README.md is the contract with whatever model reads this directory. It has to
 * answer, in order: what is this, what can I trust, what's broken, and where do
 * I go next. Everything else in the output tree hangs off it.
 */
import path from 'node:path'
import { round, humanBytes } from './util.mjs'
import { mdTable, fitGuidance } from './markdown.mjs'
import { tokensToCss } from './tokens.mjs'

export function renderReadme(result) {
  const {
    url, title, breakpoints, blocks, tokens, warnings, assetStats,
    segmentation, generatedAt, interactive = [], fonts = [],
  } = result

  const L = []
  L.push(`# ${title || 'Harvested site'}`)
  L.push('')
  L.push(`\`${url}\``)
  L.push('')
  L.push(
    '> Machine-generated design spec. Every number here was measured from the rendered page at ' +
      '1 CSS pixel = 1 image pixel, so values read off the screenshots need no conversion.',
  )
  L.push('')

  // --- What you're looking at -------------------------------------------
  L.push('## At a glance')
  L.push('')
  L.push(
    mdTable(
      ['field', 'value'],
      [
        { field: 'Source URL', value: url },
        { field: 'Captured', value: generatedAt },
        { field: 'Breakpoints', value: breakpoints.map((b) => `${b.name} (${b.width}px)`).join(', ') },
        { field: 'Blocks', value: blocks.length },
        { field: 'Segmentation', value: segmentation.strategy },
        {
          field: 'Coverage',
          value: `${round((segmentation.coverage?.ratio ?? 0) * 100, 1)}% of page height`,
        },
        { field: 'Assets', value: `${assetStats.total} (${humanBytes(assetStats.bytes)})` },
      ],
    ),
  )

  // --- Problems first ----------------------------------------------------
  const hardWarnings = warnings.filter((w) => w.deltaPct > 50)
  if (warnings.length) {
    L.push('## ⚠ Read this before writing CSS')
    L.push('')
    if (hardWarnings.length) {
      L.push(
        `**${hardWarnings.length} asset(s) cannot be made to fit their slot with any CSS.** ` +
          'The aspect ratio of the artwork and the box it is placed in disagree too much. ' +
          'No `object-fit` value solves this — the asset needs re-exporting. ' +
          'Flagging it now saves the rounds of CSS tweaking that would otherwise follow.',
      )
      L.push('')
    }
    L.push(
      mdTable(
        ['asset', 'content ratio', 'slot ratio', 'off by', 'used', 'verdict'],
        warnings.slice(0, 15).map((w) => ({
          asset: w.file || w.url.slice(-44),
          'content ratio': w.content.ratio,
          'slot ratio': w.slot.ratio,
          'off by': `${w.deltaPct}%`,
          used: w.occurrences > 1 ? `${w.occurrences}×` : '1×',
          verdict: w.verdict,
        })),
      ),
    )
    if (warnings.length > 15) L.push(`_… ${warnings.length - 15} more in \`warnings.json\`._\n`)
  }

  const gaps = (segmentation.coverage?.gapsFound || []).filter((g) => !g.sel)
  if (gaps.length) {
    L.push('## ⚠ Unclaimed page regions')
    L.push('')
    L.push(
      'These vertical ranges are not inside any captured block — no single element ' +
        'covered them. Check the full-page screenshot to see what lives there.',
    )
    L.push('')
    L.push(mdTable(['from y', 'to y', 'height'], gaps.map((g) => ({
      'from y': g.top, 'to y': g.bottom, height: round(g.bottom - g.top, 1),
    }))))
  }

  // --- Blocks ------------------------------------------------------------
  L.push('## Blocks')
  L.push('')
  L.push('Each block has its own spec sheet with screenshots, structure and responsive deltas.')
  L.push('')
  L.push(
    mdTable(
      ['#', 'block', 'size', 'spec', 'notes'],
      blocks.map((b) => ({
        '#': String(b.index + 1).padStart(2, '0'),
        block: b.heading || b.tag,
        size: `${round(b.box.w, 0)}×${round(b.box.h, 0)}`,
        spec: `[${b.dir}/block.md](blocks/${b.dir}/block.md)`,
        notes: [b.sticky ? 'sticky/fixed' : '', b.truncated ? 'truncated' : ''].filter(Boolean).join(', ') || '',
      })),
    ),
  )

  // --- Tokens ------------------------------------------------------------
  L.push('## Design tokens')
  L.push('')
  L.push('Full listing in [tokens.md](tokens.md); ready-to-use variables in [tokens.css](tokens.css).')
  L.push('')
  if (tokens.grid) {
    L.push(
      `Spacing appears to follow a **${tokens.grid.base}px grid** (${tokens.grid.conformance}% of observed values conform).`,
    )
    L.push('')
  }
  const topText = tokens.color.text.slice(0, 6)
  const topBg = tokens.color.background.slice(0, 6)
  L.push(
    mdTable(
      ['role', 'values (most used first)'],
      [
        { role: 'Text', 'values (most used first)': topText.map((c) => `\`${c.value}\``).join(' ') },
        { role: 'Background', 'values (most used first)': topBg.map((c) => `\`${c.value}\``).join(' ') },
        {
          role: 'Fonts',
          'values (most used first)': tokens.typography.families
            .slice(0, 3)
            .map((f) => `\`${f.value.split(',')[0].replace(/["']/g, '')}\``)
            .join(' '),
        },
        {
          role: 'Type scale',
          'values (most used first)': tokens.typography.scale
            .slice(0, 10)
            .map((t) => `${t.size}${t.lineHeight ? '/' + t.lineHeight : ''}`)
            .join(' · '),
        },
      ],
    ),
  )

  // --- Files -------------------------------------------------------------
  L.push('## Output layout')
  L.push('')
  L.push('```')
  L.push('README.md          this file')
  L.push('index.json         machine-readable manifest of everything below')
  L.push('tokens.md          design tokens, ranked by usage')
  L.push('tokens.css         the same tokens as CSS custom properties')
  L.push('responsive.md      every value that changes between breakpoints')
  L.push('interactions.md    clickable/focusable elements and their transitions')
  L.push('warnings.json      asset fit problems, in full')
  breakpoints.forEach((b) => L.push(`page-${b.name}.png    full-page screenshot at ${b.width}px`))
  L.push('blocks/<nn>-<name>/')
  L.push('  block.md         spec sheet — start here')
  L.push('  <bp>.png         screenshot per breakpoint')
  L.push('  tree.<bp>.json   exact computed values, full precision')
  L.push('assets/')
  L.push('  manifest.json    every asset: intrinsic size, content bbox, palette, usage')
  L.push('  <files>          deduplicated by content hash')
  L.push('```')
  L.push('')

  // --- How to use --------------------------------------------------------
  L.push('## How to use this')
  L.push('')
  L.push('**To rebuild one section:** read `blocks/<nn>-*/block.md`. It has the screenshot, the')
  L.push('structure as an indented tree with condensed styles, the copy, and the responsive deltas.')
  L.push('')
  L.push('**To rebuild the whole page:** start with `tokens.css`, then work through the blocks in')
  L.push('order. The block list above is in document order.')
  L.push('')
  L.push('**On the numbers:** styles shown are computed values with UA defaults, inherited values')
  L.push('and near-universal resets removed — what is listed is what differs and therefore what you')
  L.push('need to write. `tree.<bp>.json` has the unabridged version if a value looks wrong.')
  L.push('')
  L.push('**On assets:** `object-position` suggestions in the asset tables come from measuring the')
  L.push('alpha channel, not the file dimensions. An asset whose artwork sits off-centre inside a')
  L.push('padded canvas will crop wrong under a plain `center` — use the stated value.')
  L.push('')

  if (fonts.length) {
    L.push('## Webfonts')
    L.push('')
    L.push(mdTable(['file', 'size'], fonts.slice(0, 20).map((f) => ({
      file: f.file || f.url.slice(-50), size: humanBytes(f.bytes ?? 0),
    }))))
  }

  if (interactive.length) {
    L.push('## Interactive surface')
    L.push('')
    L.push(`${interactive.length} focusable/clickable elements — see [interactions.md](interactions.md).`)
    L.push('')
  }

  return L.join('\n')
}

export function renderTokensMd(tokens, breakpointNames) {
  const L = []
  L.push('# Design tokens')
  L.push('')
  L.push('Ranked by how often each value appears in the rendered page. The most-used value')
  L.push('in each group is almost always the one to define first; long tails are usually')
  L.push('one-offs and can often be dropped.')
  L.push('')
  if (tokens.grid) {
    L.push(`**Spacing grid:** ${tokens.grid.base}px (${tokens.grid.conformance}% conformance)`)
    L.push('')
  }

  const bpCols = breakpointNames || []
  const withCounts = (rows, valueLabel = 'value') =>
    mdTable(
      [valueLabel, 'uses', ...bpCols, 'example'],
      rows.map((r) => ({
        [valueLabel]: `\`${r.value}\``,
        uses: r.total,
        ...Object.fromEntries(bpCols.map((b) => [b, r.byBreakpoint?.[b] ?? 0])),
        example: (r.samples?.[0] || '').slice(0, 54),
      })),
    )

  L.push('## Colour — text')
  L.push('')
  L.push(withCounts(tokens.color.text, 'colour'))
  L.push('## Colour — backgrounds')
  L.push('')
  L.push(withCounts(tokens.color.background, 'colour'))

  L.push('## Type scale')
  L.push('')
  L.push(
    mdTable(
      ['size', 'line-height', 'ratio', 'uses', ...bpCols, 'example'],
      tokens.typography.scale.map((t) => ({
        size: `${t.size}px`,
        'line-height': t.lineHeight ? `${t.lineHeight}px` : 'normal',
        ratio: t.ratio ?? '—',
        uses: t.count,
        ...Object.fromEntries(bpCols.map((b) => [b, t.byBreakpoint?.[b] ?? 0])),
        example: (t.samples?.[0] || '').slice(0, 44),
      })),
    ),
  )

  L.push('## Font families')
  L.push('')
  L.push(withCounts(tokens.typography.families, 'family'))
  L.push('## Font weights')
  L.push('')
  L.push(withCounts(tokens.typography.weights, 'weight'))
  L.push('## Radii')
  L.push('')
  L.push(withCounts(tokens.radii, 'radius'))
  L.push('## Shadows')
  L.push('')
  L.push(withCounts(tokens.shadows, 'shadow'))
  L.push('## Spacing — gaps')
  L.push('')
  L.push(withCounts(tokens.spacing.gaps, 'gap'))
  L.push('## Spacing — paddings')
  L.push('')
  L.push(withCounts(tokens.spacing.paddings, 'padding'))

  return L.join('\n')
}

export function renderResponsiveMd(blocks, breakpoints) {
  const L = []
  L.push('# Responsive deltas')
  L.push('')
  if (breakpoints.length < 2) {
    L.push('_Only one breakpoint was captured — run with `--widths 1440,768,375` to get deltas._')
    return L.join('\n')
  }

  L.push(
    'Captured at ' + breakpoints.map((b) => `**${b.name}** (${b.width}px)`).join(', ') + '.',
  )
  L.push('')
  L.push('Each section below covers one *step* between adjacent breakpoints, which is how the')
  L.push('media queries are written — a step only has to restate what changed since the previous')
  L.push('one. These are the values you cannot get by scaling: a radius that halves, a type size')
  L.push('that drops a step, a padding that stays put.')
  L.push('')

  // Summary matrix first: which blocks change at which step.
  const pairs = []
  for (let i = 0; i < breakpoints.length - 1; i++) {
    pairs.push(`${breakpoints[i].name} → ${breakpoints[i + 1].name}`)
  }
  L.push('## Where the changes are')
  L.push('')
  L.push(
    mdTable(
      ['block', ...pairs],
      blocks.map((blk) => {
        const row = { block: `${String(blk.index + 1).padStart(2, '0')} · ${blk.heading || blk.tag}` }
        for (const d of blk.deltaSets || []) {
          row[`${d.from} → ${d.to}`] = d.rows?.length ? `${d.rows.length} changes` : 'fluid only'
        }
        return row
      }),
    ),
  )

  // Then the detail, grouped by step so a reader building the mobile layout can
  // read one section rather than filtering a mixed table.
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const a = breakpoints[i]
    const b = breakpoints[i + 1]
    const stepKey = `${a.name} → ${b.name}`
    L.push(`# ${stepKey}  (${a.width}px → ${b.width}px)`)
    L.push('')

    let any = false
    for (const blk of blocks) {
      const d = (blk.deltaSets || []).find((x) => x.from === a.name && x.to === b.name)
      if (!d?.rows?.length) continue
      any = true
      L.push(`## ${String(blk.index + 1).padStart(2, '0')} · ${blk.heading || blk.tag}`)
      L.push('')
      L.push(mdTable(['sel', 'prop', a.name, b.name], d.rows))
    }
    if (!any) {
      L.push(`_Nothing changes between ${a.name} and ${b.name} — the layout is purely fluid here._`)
      L.push('')
      continue
    }

    const fluid = blocks.filter((blk) => {
      const d = (blk.deltaSets || []).find((x) => x.from === a.name && x.to === b.name)
      return d && !d.rows.length
    })
    if (fluid.length) {
      L.push(`## Fluid-only blocks (${stepKey})`)
      L.push('')
      L.push('These reflow by width alone, with no style changes at this step:')
      L.push('')
      for (const blk of fluid) {
        L.push(`- ${String(blk.index + 1).padStart(2, '0')} · ${blk.heading || blk.tag}`)
      }
      L.push('')
    }
  }
  return L.join('\n')
}

export function renderInteractionsMd(byBreakpoint) {
  const L = []
  L.push('# Interactive surface')
  L.push('')
  L.push('Everything a user can click, focus or type into, with the transition each one declares.')
  L.push('Hover and focus styles are not captured — they need a live browser — but the transition')
  L.push('property and duration tell you what is animated and how fast.')
  L.push('')
  for (const [bp, items] of Object.entries(byBreakpoint)) {
    if (!items?.length) continue
    L.push(`## ${bp}`)
    L.push('')
    L.push(
      mdTable(
        ['element', 'label', 'size', 'cursor', 'transition', 'href'],
        items.slice(0, 120).map((i) => ({
          element: i.sel,
          label: i.label || i.role || '',
          size: `${round(i.box.w, 0)}×${round(i.box.h, 0)}`,
          cursor: i.cursor,
          transition: i.transition || '—',
          href: i.href ? String(i.href).slice(0, 40) : '',
        })),
      ),
    )
  }
  return L.join('\n')
}

export function renderAssetsMd(manifest, mediaInfo) {
  const L = []
  L.push('# Assets')
  L.push('')
  L.push('Deduplicated by content hash — the same bytes served from several URLs appear once.')
  L.push('')
  L.push('`content box` is the artwork\'s real extent measured from the alpha channel, which is')
  L.push('often smaller and off-centre relative to the file canvas. Use the stated `object-position`')
  L.push('rather than assuming the artwork is centred.')
  L.push('')
  const rows = []
  for (const [url, rec] of Object.entries(manifest)) {
    if (rec.duplicateOf) continue
    const info = mediaInfo[url]
    const use = rec.usage?.find((u) => u.rendered) || rec.usage?.[0]
    rows.push({
      file: rec.file ? `[${rec.file}](${rec.file})` : url.slice(-40),
      type: rec.contentType || '—',
      intrinsic: info?.width ? `${info.width}×${info.height}` : '—',
      'content box': info?.contentBox
        ? `${round(info.contentBox.w, 0)}×${round(info.contentBox.h, 0)} @ ${info.contentBox.centerXPct}%/${info.contentBox.centerYPct}%`
        : '—',
      ratio: info?.contentBox?.ratio ?? info?.ratio ?? '—',
      colour: info?.dominantColor || '—',
      size: humanBytes(rec.bytes ?? 0),
      guidance: fitGuidance({ info, box: use?.box }),
    })
  }
  rows.sort((a, b) => String(a.file).localeCompare(String(b.file)))
  L.push(
    mdTable(
      ['file', 'type', 'intrinsic', 'content box', 'ratio', 'colour', 'size', 'guidance'],
      rows,
    ),
  )

  // Colour index: when filenames are meaningless (icon-1.svg …
  // icon-11.svg), the fill colour is the only usable identity key.
  const colored = rows.filter((r) => r.colour && r.colour !== '—')
  if (colored.length > 3) {
    L.push('## Colour index')
    L.push('')
    L.push('Assets keyed by dominant colour. When filenames carry no meaning, matching an')
    L.push('asset to its slot by colour is usually faster and more reliable than guessing.')
    L.push('')
    const byColor = new Map()
    for (const r of colored) {
      if (!byColor.has(r.colour)) byColor.set(r.colour, [])
      byColor.get(r.colour).push(r.file)
    }
    L.push(
      mdTable(
        ['colour', 'assets'],
        [...byColor.entries()].map(([c, files]) => ({ colour: `\`${c}\``, assets: files.join(', ') })),
      ),
    )
  }
  return L.join('\n')
}

export { tokensToCss }
