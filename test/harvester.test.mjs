/**
 * Test suite. Run with: npm test
 *
 * Split in two:
 *   - pure unit tests over the parsing/derivation helpers (instant, no browser)
 *   - integration tests against a local fixture served from this process
 *
 * The fixture is served locally on purpose. Testing against a live site makes
 * the suite fail for reasons that have nothing to do with the code, and the
 * whole point of this tool is trustworthy measurements — the tests should be
 * held to the same standard.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'

const exec = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

import { parseBreakpoints, slugify, shortHash, round, pngSize, filenameFromUrl } from '../src/util.mjs'
import { normaliseColor, buildTokens, tokensToCss } from '../src/tokens.mjs'
import { styleDigest, renderTree, diffBreakpoints, mdTable, breakpointPairs } from '../src/markdown.mjs'
import { analyseFit } from '../src/assets.mjs'
import { analyseMedia, detectTools } from '../src/media.mjs'
import { parseArgs } from '../src/cli.mjs'

// --------------------------------------------------------------- unit ------

describe('every module loads', () => {
  // server.mjs and mcp.mjs are otherwise only reached through a subprocess, so
  // a syntax error in either would not surface until someone ran the daemon.
  const MODULES = [
    'util.mjs', 'browser.mjs', 'extract.mjs', 'capture.mjs', 'assets.mjs',
    'media.mjs', 'tokens.mjs', 'markdown.mjs', 'report.mjs', 'harvest.mjs',
    'cli.mjs', 'server.mjs', 'mcp.mjs',
  ]
  for (const m of MODULES) {
    test(m, async () => {
      const mod = await import(path.join(ROOT, 'src', m))
      assert.ok(mod, `${m} should export something`)
    })
  }

  test('the injected page agent is syntactically valid', async () => {
    // It ships as text and is eval'd in the browser, so nothing else type-checks it.
    const src = await readFile(path.join(ROOT, 'src', 'page-agent.js'), 'utf8')
    assert.doesNotThrow(() => new Function(src), 'page-agent.js must parse')
    assert.match(src, /window\.__HARVEST__/)
  })

  test('MCP advertises a schema for every tool it routes', async () => {
    const { TOOLS } = await import(path.join(ROOT, 'src', 'mcp.mjs'))
    for (const t of TOOLS) {
      assert.ok(t.name && t.description && t.inputSchema, `${t.name} is incomplete`)
      assert.equal(t.inputSchema.type, 'object')
    }
  })
})

describe('breakpointPairs', () => {
  const bp = (name, width) => ({ name, width })

  test('pairs adjacent breakpoints, not everything against the first', () => {
    const pairs = breakpointPairs([bp('desktop', 1440), bp('tablet', 768), bp('mobile', 375)])
    assert.equal(pairs.length, 2)
    assert.deepEqual(pairs.map(([a, b]) => `${a.name}->${b.name}`), [
      'desktop->tablet',
      'tablet->mobile',
    ])
  })

  test('two breakpoints give exactly one pair', () => {
    assert.equal(breakpointPairs([bp('desktop', 1440), bp('mobile', 375)]).length, 1)
  })

  test('a single breakpoint gives no pairs', () => {
    assert.equal(breakpointPairs([bp('desktop', 1440)]).length, 0)
  })

  test('four breakpoints give three steps', () => {
    const pairs = breakpointPairs([
      bp('desktop', 1440), bp('laptop', 1024), bp('tablet', 768), bp('mobile', 375),
    ])
    assert.equal(pairs.length, 3)
  })
})

describe('parseBreakpoints', () => {
  test('parses widths and assigns names', () => {
    const bps = parseBreakpoints('1440,375')
    assert.equal(bps.length, 2)
    assert.equal(bps[0].width, 1440)
    assert.equal(bps[0].name, 'desktop')
    assert.equal(bps[1].width, 375)
    assert.equal(bps[1].name, 'mobile')
  })

  test('accepts explicit heights', () => {
    const [bp] = parseBreakpoints('1280x1000')
    assert.equal(bp.width, 1280)
    assert.equal(bp.height, 1000)
  })

  test('gives mobile a realistic default height, not a ratio of width', () => {
    // Regression: width*0.66 produced a 247px-tall mobile viewport, which made
    // block screenshots truncate.
    const [bp] = parseBreakpoints('375')
    assert.ok(bp.height >= 600, `expected a realistic height, got ${bp.height}`)
  })

  test('disambiguates duplicate breakpoint names', () => {
    const bps = parseBreakpoints('414,375')
    assert.notEqual(bps[0].name, bps[1].name)
  })

  test('rejects nonsense', () => {
    assert.throws(() => parseBreakpoints('wide'), /Invalid breakpoint/)
  })
})

describe('slugify / hash / misc', () => {
  test('slugify produces filesystem-safe names', () => {
    assert.equal(slugify('Add interactions with a click!'), 'add-interactions-with-a-click')
    assert.equal(slugify('  '), 'block')
    assert.ok(!slugify('a'.repeat(200)).includes(' '))
  })

  test('slugify keeps CJK characters', () => {
    assert.ok(slugify('设计稿还原').length > 0)
  })

  test('shortHash is deterministic', () => {
    assert.equal(shortHash('abc'), shortHash('abc'))
    assert.notEqual(shortHash('abc'), shortHash('abd'))
  })

  test('round drops float noise', () => {
    assert.equal(round(1108.6199999, 2), 1108.62)
    assert.equal(round(12.5, 2), 12.5)
  })

  test('filenameFromUrl handles query strings and missing extensions', () => {
    assert.equal(filenameFromUrl('https://x.com/a/hero.png?w=800'), 'hero.png')
    // A path with no usable segment at all falls back to a hash.
    assert.ok(filenameFromUrl('https://x.com/').startsWith('asset-'))
    // A segment without an extension is kept — callers prefix a content hash,
    // so it does not need to be unique on its own.
    assert.equal(filenameFromUrl('https://x.com/a/'), 'a')
  })
})

describe('normaliseColor', () => {
  test('rgb -> hex', () => {
    assert.equal(normaliseColor('rgb(255, 255, 255)'), '#ffffff')
    assert.equal(normaliseColor('rgb(0,0,0)'), '#000000')
  })
  test('keeps alpha as a suffix', () => {
    assert.equal(normaliseColor('rgba(255,255,255,0.6)'), '#ffffff@0.6')
  })
  test('treats alpha 1 as opaque', () => {
    assert.equal(normaliseColor('rgba(0,0,0,1)'), '#000000')
  })
  test('expands short hex', () => {
    assert.equal(normaliseColor('#fff'), '#ffffff')
  })
  test('passes through modern colour functions untouched', () => {
    assert.match(normaliseColor('oklch(0.5 0.1 200)'), /^oklch/)
  })
})

describe('styleDigest', () => {
  test('condenses flex layout', () => {
    const d = styleDigest({
      display: 'flex', 'flex-direction': 'column',
      'row-gap': '64px', 'column-gap': '64px', 'align-items': 'center',
    })
    assert.match(d, /flex-col/)
    assert.match(d, /gap:64/)
    assert.match(d, /ai:center/)
  })

  test('collapses four paddings into shorthand', () => {
    const d = styleDigest({
      'padding-top': '96px', 'padding-right': '120px',
      'padding-bottom': '96px', 'padding-left': '120px',
    })
    assert.match(d, /pad:96\/120/)
  })

  test('emits font size/line-height as a pair', () => {
    const d = styleDigest({ 'font-size': '56px', 'line-height': '64px', 'font-weight': '700' })
    assert.match(d, /56\/64/)
    assert.match(d, /w700/)
  })

  test('is empty for an empty style', () => {
    assert.equal(styleDigest({}), '')
  })
})

describe('renderTree', () => {
  const tree = {
    sel: 'section#hero', tag: 'section', box: { x: 0, y: 0, w: 1440, h: 400 },
    style: { display: 'flex' },
    children: [
      { sel: 'h1', tag: 'h1', box: { x: 0, y: 0, w: 600, h: 64 },
        style: { 'font-size': '56px' }, text: 'Build faster' },
    ],
  }
  test('renders an indented outline containing text and sizes', () => {
    const out = renderTree(tree)
    assert.match(out, /section#hero/)
    assert.match(out, /Build faster/)
    assert.match(out, /1440×400/)
  })
  test('respects maxLines and says so', () => {
    const big = { ...tree, children: Array.from({ length: 50 }, () => tree.children[0]) }
    const out = renderTree(big, { maxLines: 5 })
    assert.match(out, /truncated/)
  })
})

describe('diffBreakpoints', () => {
  const mk = (fs, radius, h) => ({
    sel: '.card', tag: 'div', box: { x: 0, y: 0, w: 300, h },
    style: { 'font-size': fs, 'border-top-left-radius': radius },
  })
  test('reports only values that actually differ', () => {
    const rows = diffBreakpoints(mk('20px', '12px', 200), mk('16px', '6px', 180), 'desktop', 'mobile')
    const props = rows.map((r) => r.prop)
    assert.ok(props.includes('font-size'))
    assert.ok(props.includes('border-top-left-radius'))
    const fs = rows.find((r) => r.prop === 'font-size')
    assert.equal(fs.desktop, '20px')
    assert.equal(fs.mobile, '16px')
  })
  test('returns nothing when the breakpoints agree', () => {
    const rows = diffBreakpoints(mk('20px', '12px', 200), mk('20px', '12px', 200), 'a', 'b')
    assert.equal(rows.length, 0)
  })
})

describe('analyseFit', () => {
  test('flags an asset whose ratio cannot fit its slot', () => {
    // Content ratio 1.02 into a 1.63 slot is unsolvable — cover
    // discards 37% of the artwork. This must reach the "re-export" verdict,
    // not the softer focal-point advice.
    const manifest = {
      'https://x/a.webm': {
        file: 'a.webm', contentHash: 'h1',
        usage: [{ rendered: true, box: { w: 652, h: 400 }, sel: '.card' }],
      },
    }
    const info = { 'https://x/a.webm': { contentBox: { ratio: 1.02 } } }
    const w = analyseFit(manifest, info)
    assert.equal(w.length, 1)
    assert.match(w[0].verdict, /re-export/)
    assert.ok(w[0].deltaPct > 30, `expected a large crop, got ${w[0].deltaPct}%`)
  })

  test('uses the softer verdict for a moderate mismatch', () => {
    const manifest = {
      'https://x/d.png': {
        file: 'd.png', contentHash: 'h4',
        usage: [{ rendered: true, box: { w: 800, h: 500 }, sel: '.hero' }],
      },
    }
    const w = analyseFit(manifest, { 'https://x/d.png': { contentBox: { ratio: 1.28 } } })
    assert.equal(w.length, 1)
    assert.match(w[0].verdict, /focal point/)
  })

  test('stays quiet when the ratios agree', () => {
    const manifest = {
      'https://x/b.png': {
        file: 'b.png', contentHash: 'h2',
        usage: [{ rendered: true, box: { w: 800, h: 500 }, sel: '.hero' }],
      },
    }
    assert.equal(analyseFit(manifest, { 'https://x/b.png': { contentBox: { ratio: 1.6 } } }).length, 0)
  })

  test('collapses one asset used in many identical slots into one finding', () => {
    const usage = Array.from({ length: 8 }, (_, i) => ({
      rendered: true, box: { w: 400, h: 400 }, sel: `.card${i}`,
    }))
    const manifest = { 'https://x/c.png': { file: 'c.png', contentHash: 'same', usage } }
    const w = analyseFit(manifest, { 'https://x/c.png': { contentBox: { ratio: 1.5 } } })
    assert.equal(w.length, 1)
    assert.equal(w[0].occurrences, 8)
  })

  test('ignores streaming segments, which have no meaningful ratio', () => {
    const manifest = {
      'https://x/seg.mp4': {
        file: 'seg.mp4', contentHash: 'h3',
        usage: [{ rendered: true, box: { w: 900, h: 300 }, sel: 'video', natural: { w: 100, h: 100 } }],
      },
    }
    assert.equal(analyseFit(manifest, { 'https://x/seg.mp4': { streamingSegment: true } }).length, 0)
  })
})

describe('buildTokens', () => {
  const survey = {
    textColors: [{ value: 'rgb(0, 0, 0)', count: 40, samples: ['h1'] }],
    backgrounds: [{ value: 'rgb(255, 255, 255)', count: 10, samples: ['body'] }],
    fontFamilies: [{ value: 'Inter, sans-serif', count: 50, samples: ['p'] }],
    fontSizes: [
      { value: '56px / 64px', count: 2, samples: ['h1'] },
      { value: '16px / 24px', count: 30, samples: ['p'] },
    ],
    fontWeights: [{ value: '700', count: 5, samples: ['h1'] }],
    radii: [{ value: '12px', count: 6, samples: ['.card'] }],
    shadows: [],
    // inferGrid needs at least 4 observations before it will claim a grid —
    // guessing a system from two numbers would be noise, not inference.
    gaps: [
      { value: '24px', count: 9, samples: ['.grid'] },
      { value: '16px', count: 7, samples: ['.card'] },
      { value: '48px', count: 3, samples: ['section'] },
    ],
    paddings: [
      { value: '96px', count: 4, samples: ['section'] },
      { value: '32px', count: 6, samples: ['header'] },
    ],
  }

  test('refuses to infer a grid from too few observations', () => {
    const thin = { ...survey, gaps: [{ value: '24px', count: 2, samples: [] }], paddings: [] }
    assert.equal(buildTokens({ desktop: thin }).grid, null)
  })

  test('infers the spacing grid', () => {
    const t = buildTokens({ desktop: survey })
    assert.ok(t.grid)
    assert.equal(t.grid.base, 8)
  })

  test('sorts the type scale largest first and computes the ratio', () => {
    const t = buildTokens({ desktop: survey })
    assert.equal(t.typography.scale[0].size, 56)
    assert.equal(t.typography.scale[0].lineHeight, 64)
    assert.ok(t.typography.scale[0].ratio > 1)
  })

  test('merges the same value seen at two breakpoints', () => {
    const t = buildTokens({ desktop: survey, mobile: survey })
    assert.equal(t.color.text[0].total, 80)
    assert.equal(t.color.text[0].byBreakpoint.desktop, 40)
  })

  test('emits valid-looking CSS custom properties', () => {
    const css = tokensToCss(buildTokens({ desktop: survey }))
    assert.match(css, /^:root \{/)
    assert.match(css, /--color-text-1: #000000;/)
    assert.match(css, /\}\s*$/)
  })

  test('never leaks the internal @alpha notation into CSS', () => {
    // "#ffffff@0.6" is compact for the markdown tables but is not a colour any
    // browser understands — tokens.css claims to be directly usable.
    const withAlpha = {
      ...survey,
      textColors: [{ value: 'rgba(255,255,255,0.6)', count: 20, samples: [] }],
    }
    const css = tokensToCss(buildTokens({ desktop: withAlpha }))
    assert.ok(!css.includes('@0.6'), 'found internal @alpha notation in CSS output')
    assert.match(css, /rgba\(255, 255, 255, 0\.6\)/)
  })

  test('drops fully transparent and unresolvable colours', () => {
    const junk = {
      ...survey,
      backgrounds: [
        { value: 'rgba(0,0,0,0)', count: 99, samples: [] },
        { value: 'oklch(0 0 none / 0)', count: 50, samples: [] },
        { value: 'rgb(20, 20, 30)', count: 10, samples: [] },
      ],
    }
    const css = tokensToCss(buildTokens({ desktop: junk }))
    assert.ok(!css.includes('none'), 'unresolvable colour reached CSS')
    assert.match(css, /--color-bg-1: #14141e;/)
  })
})

describe('parseArgs', () => {
  test('parses flags, values and positionals', () => {
    const a = parseArgs(['https://x.com', '--out', './spec', '--clean', '--widths', '1440,375'])
    assert.equal(a._[0], 'https://x.com')
    assert.equal(a.out, './spec')
    assert.equal(a.clean, true)
    assert.equal(a.widths, '1440,375')
  })
  test('--persist works with and without a path', () => {
    assert.equal(parseArgs(['--persist']).persist, true)
    const a = parseArgs(['--persist', '/tmp/p'])
    assert.equal(a.profileDir, '/tmp/p')
  })
  test('camel-cases hyphenated flags', () => {
    assert.equal(parseArgs(['--max-nodes', '50']).maxNodes, '50')
  })
  test('--headed disables headless', () => {
    assert.equal(parseArgs(['--headed']).headless, false)
  })
})

describe('mdTable', () => {
  test('escapes pipes so tables cannot be broken by content', () => {
    const out = mdTable(['a'], [{ a: 'x | y' }])
    assert.match(out, /x \\\| y/)
  })
  test('handles an empty row set', () => {
    assert.match(mdTable(['a'], []), /_none_/)
  })
})

// -------------------------------------------------------- media (ffmpeg) ---

describe('media analysis', async () => {
  const tools = await detectTools()
  const skip = !tools.ffmpeg || !tools.ffprobe

  test('measures an off-centre content box in a padded canvas', { skip }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'harv-'))
    const png = path.join(dir, 'offcenter.png')
    // 1200x1200 canvas, opaque 900x600 block at (150,250).
    await exec('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black@0.0:s=1200x1200,format=rgba',
      '-f', 'lavfi', '-i', 'color=c=#cc3344:s=900x600,format=rgba',
      '-filter_complex', '[0][1]overlay=150:250', '-frames:v', '1', png,
    ])
    const info = await analyseMedia(png)
    assert.ok(info.contentBox, 'expected a content box')
    // Ground truth: ratio 1.5, centre 50% / 45.83%.
    assert.ok(Math.abs(info.contentBox.ratio - 1.5) < 0.05, `ratio ${info.contentBox.ratio}`)
    assert.ok(Math.abs(info.contentBox.centerXPct - 50) < 1.5)
    assert.ok(Math.abs(info.contentBox.centerYPct - 45.8) < 1.5)
    assert.equal(info.hasAlpha, true)
    await rm(dir, { recursive: true, force: true })
  })

  test('recovers alpha from VP9 WebM despite ffprobe reporting yuv420p', { skip }, async () => {
    // The decoder has to be forced or the alpha plane is invisible.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'harv-'))
    const webm = path.join(dir, 'alpha.webm')
    await exec('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black@0.0:s=1200x1200,format=rgba',
      '-f', 'lavfi', '-i', 'color=c=#2b7fff:s=1049x677,format=rgba',
      '-filter_complex', '[0][1]overlay=75:300', '-t', '1', '-r', '10',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', webm,
    ])
    const info = await analyseMedia(webm)
    assert.equal(info.pixFmt, 'yuv420p', 'ffprobe should still claim no alpha')
    assert.equal(info.hasAlpha, true, 'but we should have found the alpha plane')
    assert.ok(Math.abs(info.contentBox.ratio - 1.549) < 0.06, `ratio ${info.contentBox.ratio}`)
    assert.ok(info.dominantColor.startsWith('#'))
    await rm(dir, { recursive: true, force: true })
  })

  test('reads colours out of an SVG without rasterising it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'harv-'))
    const svg = path.join(dir, 'icon.svg')
    await (await import('node:fs/promises')).writeFile(
      svg,
      '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="#FF5733" d="M0 0h24v24H0z"/></svg>',
    )
    const info = await analyseMedia(svg)
    assert.equal(info.kind, 'svg')
    assert.equal(info.width, 24)
    assert.equal(info.dominantColor, '#ff5733')
    await rm(dir, { recursive: true, force: true })
  })
})

// ------------------------------------------------------- integration ------

describe('integration against a local fixture', async () => {
  let server
  let base
  let tmp

  before(async () => {
    const html = await readFile(path.join(HERE, 'fixture', 'index.html'))
    // A 1600x1000 PNG (ratio 1.6) placed into a 16:10 slot — should NOT warn.
    server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/index')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(html)
      }
      if (req.url.startsWith('/thumb')) {
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(ONE_PX_PNG)
      }
      res.writeHead(404).end('nope')
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}/`
    tmp = await mkdtemp(path.join(os.tmpdir(), 'harvest-out-'))
  })

  after(async () => {
    server?.close()
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  test('segments the fixture and covers the whole page', async () => {
    const { stdout } = await exec('node', [
      path.join(ROOT, 'bin', 'harvest.mjs'), 'blocks', base, '--widths', '1440', '--json',
    ], { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
    const seg = JSON.parse(stdout)
    // header + hero + features + footer
    assert.ok(seg.blocks.length >= 4, `expected >=4 blocks, got ${seg.blocks.length}`)
    assert.ok(seg.coverage.ratio > 0.95, `coverage ${seg.coverage.ratio}`)
    const sticky = seg.blocks.find((b) => b.sticky)
    assert.ok(sticky, 'the fixed header should be captured and marked sticky')
  })

  test('full harvest produces every documented artefact', async () => {
    const out = path.join(tmp, 'spec')
    await exec('node', [
      path.join(ROOT, 'bin', 'harvest.mjs'), base,
      '--out', out, '--widths', '1440,375', '--clean', '--quiet',
    ], { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 })

    const { access } = await import('node:fs/promises')
    for (const f of ['README.md', 'index.json', 'tokens.md', 'tokens.css',
                     'responsive.md', 'interactions.md', 'page-desktop.png', 'page-mobile.png']) {
      await access(path.join(out, f))
    }

    const index = JSON.parse(await readFile(path.join(out, 'index.json'), 'utf8'))
    assert.ok(index.blocks.length >= 4)
    assert.equal(index.breakpoints.length, 2)

    // The fixture deliberately changes card radius 12px -> 6px at mobile.
    const responsive = await readFile(path.join(out, 'responsive.md'), 'utf8')
    assert.match(responsive, /border-top-left-radius/, 'should detect the radius change')

    // Type scale should include the hero size.
    const tokens = await readFile(path.join(out, 'tokens.md'), 'utf8')
    assert.match(tokens, /56px/)
  })

  test('block screenshots are exactly the block size, not viewport-clipped', async () => {
    // Regression for the truncation bug: a block below the fold, or taller than
    // the viewport, used to come back silently cut off.
    const out = path.join(tmp, 'spec')
    const index = JSON.parse(await readFile(path.join(out, 'index.json'), 'utf8'))
    let checked = 0
    for (const b of index.blocks) {
      for (const bp of ['desktop', 'mobile']) {
        const png = path.join(out, 'blocks', b.dir, `${bp}.png`)
        const size = await pngSize(png)
        if (!size) continue
        const expectedW = bp === 'desktop' ? 1440 : 375
        assert.equal(size.width, expectedW, `${b.dir}/${bp}.png width`)
        assert.ok(size.height > 0, `${b.dir}/${bp}.png should not be empty`)
        checked++
      }
    }
    assert.ok(checked >= 8, `expected to check several screenshots, checked ${checked}`)
  })

  test('three breakpoints document every step, not just the first pair', async () => {
    // Regression: with --widths 1440,768,375 the delta analysis only compared
    // desktop and tablet, so the entire mobile specification vanished.
    const out = path.join(tmp, 'spec3')
    await exec('node', [
      path.join(ROOT, 'bin', 'harvest.mjs'), base,
      '--out', out, '--widths', '1440,768,375', '--clean', '--quiet', '--skip-assets',
    ], { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 })

    const index = JSON.parse(await readFile(path.join(out, 'index.json'), 'utf8'))
    assert.equal(index.breakpoints.length, 3)

    // Every block should carry two delta sets: desktop→tablet and tablet→mobile.
    for (const b of index.blocks) {
      assert.equal(b.deltaSets.length, 2, `${b.dir} should have 2 steps`)
      assert.deepEqual(
        b.deltaSets.map((d) => `${d.from}->${d.to}`),
        ['desktop->tablet', 'tablet->mobile'],
      )
    }

    const responsive = await readFile(path.join(out, 'responsive.md'), 'utf8')
    assert.match(responsive, /desktop → tablet/)
    assert.match(responsive, /tablet → mobile/)

    // The fixture's media query fires at 700px, so the real changes live in the
    // tablet→mobile step. If only the first pair were analysed this would fail.
    const mobileStep = responsive.slice(responsive.indexOf('# tablet → mobile'))
    assert.match(mobileStep, /border-top-left-radius/, 'mobile radius change must be reported')

    // All three screenshot sets and trees must exist per block.
    const { access } = await import('node:fs/promises')
    for (const b of index.blocks.slice(0, 3)) {
      for (const bp of ['desktop', 'tablet', 'mobile']) {
        await access(path.join(out, 'blocks', b.dir, `${bp}.png`))
        await access(path.join(out, 'blocks', b.dir, `tree.${bp}.json`))
      }
    }

    // tokens.md must break usage counts out per breakpoint.
    const tokens = await readFile(path.join(out, 'tokens.md'), 'utf8')
    assert.match(tokens, /\|\s*desktop\s*\|\s*tablet\s*\|\s*mobile\s*\|/)
  })

  test('captured styles exclude UA defaults and universal resets', async () => {
    const out = path.join(tmp, 'spec')
    const index = JSON.parse(await readFile(path.join(out, 'index.json'), 'utf8'))
    const hero = index.blocks.find((b) => /hero|build-faster/i.test(b.dir)) || index.blocks[1]
    const tree = JSON.parse(
      await readFile(path.join(out, 'blocks', hero.dir, 'tree.desktop.json'), 'utf8'),
    )
    // box-sizing is set on * in the fixture, so it must be hoisted out of nodes.
    assert.ok(tree.commonStyle, 'expected hoisted common styles')
    const flat = []
    ;(function walk(n) { flat.push(n); (n.children || []).forEach(walk) })(tree.tree)
    const withBoxSizing = flat.filter((n) => n.style['box-sizing']).length
    assert.equal(withBoxSizing, 0, 'box-sizing should be hoisted, not repeated per node')
    // And nothing should carry a bare UA default like display:block.
    assert.equal(flat.filter((n) => n.style.display === 'block').length, 0)
  })
})

// A minimal valid 1x1 PNG.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
