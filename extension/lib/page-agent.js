/* eslint-disable */
/**
 * In-page agent. Installed via addInitScript so it exists on every frame and
 * survives navigation. Defines window.__HARVEST__.
 *
 * Everything here runs in the browser. No imports, no build step — it is read
 * as text by src/extract.mjs and injected verbatim.
 *
 * The single most important job in this file is noise reduction. A raw
 * getComputedStyle() dump is ~340 properties per element; a real page has
 * thousands of elements. Feeding that to an LLM is useless. We cut it three ways:
 *
 *   1. allowlist  — only properties that affect visual reproduction
 *   2. tag default diff — drop anything equal to a bare <tag>'s UA default
 *   3. inheritance diff — drop inherited properties the parent already states
 *
 * Together these take a typical block from ~40k tokens to ~1.5k.
 */
;(function () {
  if (window.__HARVEST__) return

  // ---------------------------------------------------------------- props --

  // Properties worth reproducing. Order matters: output is grouped in this order
  // so a reader sees layout before decoration.
  const PROP_GROUPS = {
    layout: [
      'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
      'box-sizing', 'overflow-x', 'overflow-y', 'aspect-ratio', 'content-visibility',
    ],
    box: [
      'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    ],
    flexgrid: [
      'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content',
      'align-self', 'justify-self', 'place-items', 'place-content',
      'row-gap', 'column-gap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
      'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
      'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
      'grid-auto-flow', 'grid-auto-rows', 'grid-auto-columns',
    ],
    typography: [
      'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
      'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
      'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
      'text-decoration-thickness', 'text-underline-offset', 'text-overflow',
      'white-space', 'word-break', 'overflow-wrap', 'text-indent', 'vertical-align',
      'font-variant-numeric', 'font-feature-settings', '-webkit-line-clamp',
      'text-shadow', 'text-wrap', 'writing-mode',
    ],
    paint: [
      'color', 'background-color', 'background-image', 'background-size',
      'background-position', 'background-repeat', 'background-clip',
      'background-attachment', 'background-origin', 'opacity', 'mix-blend-mode',
      'filter', 'backdrop-filter', 'box-shadow', 'object-fit', 'object-position',
    ],
    border: [
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'border-top-left-radius', 'border-top-right-radius',
      'border-bottom-right-radius', 'border-bottom-left-radius',
      'outline-width', 'outline-style', 'outline-color', 'outline-offset',
    ],
    motion: [
      'transform', 'transform-origin', 'transform-style', 'perspective',
      'rotate', 'scale', 'translate',
      'transition-property', 'transition-duration', 'transition-timing-function',
      'transition-delay', 'animation-name', 'animation-duration',
      'animation-timing-function', 'animation-iteration-count', 'animation-delay',
      'animation-fill-mode', 'animation-direction', 'will-change',
    ],
    interaction: ['cursor', 'pointer-events', 'user-select', 'visibility', 'resize'],
    svg: ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'],
    misc: ['list-style-type', 'list-style-position', 'table-layout', 'border-collapse'],
  }

  const ALL_PROPS = []
  const PROP_GROUP_OF = {}
  for (const [group, props] of Object.entries(PROP_GROUPS)) {
    for (const p of props) {
      ALL_PROPS.push(p)
      PROP_GROUP_OF[p] = group
    }
  }

  // Inherited properties: if the parent already says it, the child repeating it
  // is pure noise. (visibility/cursor included — they inherit in practice.)
  const INHERITED = new Set([
    'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
    'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
    'text-indent', 'white-space', 'word-break', 'overflow-wrap', 'visibility', 'cursor',
    'list-style-type', 'list-style-position', 'text-shadow', 'font-variant-numeric',
    'font-feature-settings', 'text-wrap', 'writing-mode', 'fill', 'stroke',
    'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'border-collapse',
  ])

  // Values that mean "nothing here" regardless of tag.
  const NULLISH = new Set([
    'none', 'auto', 'normal', '0px', '0', 'static', 'visible', 'initial',
    'rgba(0, 0, 0, 0)', 'transparent', 'repeat', '0% 0%', 'start', 'baseline',
    'currentcolor', 'nonzero',
  ])

  // ------------------------------------------------------------- defaults --

  /** Per-tag UA default styles, computed once in a clean sandbox iframe. */
  const defaultCache = new Map()
  let sandboxDoc = null

  function getSandboxDoc() {
    if (sandboxDoc && sandboxDoc.body) return sandboxDoc
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText =
      'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:-9999px'
    document.documentElement.appendChild(iframe)
    try {
      sandboxDoc = iframe.contentDocument
      // No author styles in here — whatever we read is the UA default.
      sandboxDoc.open()
      sandboxDoc.write('<!doctype html><html><body></body></html>')
      sandboxDoc.close()
    } catch (e) {
      sandboxDoc = null
    }
    return sandboxDoc
  }

  function defaultsForTag(tagName, isSvg) {
    const key = (isSvg ? 'svg:' : '') + tagName
    if (defaultCache.has(key)) return defaultCache.get(key)
    const out = {}
    const doc = getSandboxDoc()
    if (doc && doc.body) {
      try {
        const el = isSvg
          ? doc.createElementNS('http://www.w3.org/2000/svg', tagName)
          : doc.createElement(tagName)
        doc.body.appendChild(el)
        const cs = doc.defaultView.getComputedStyle(el)
        for (const p of ALL_PROPS) out[p] = cs.getPropertyValue(p)
        el.remove()
      } catch (e) {
        /* unknown element — leave defaults empty, allowlist+NULLISH still filter */
      }
    }
    defaultCache.set(key, out)
    return out
  }

  // -------------------------------------------------------------- helpers --

  function isSvgEl(el) {
    return el.namespaceURI === 'http://www.w3.org/2000/svg'
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect()
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      w: r.width,
      h: r.height,
    }
  }

  function r2(n) {
    return Math.round(n * 100) / 100
  }

  function roundRect(r) {
    return { x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) }
  }

  function isVisible(el, cs) {
    const s = cs || getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden') return false
    if (parseFloat(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 || r.height > 0
  }

  /** Short, stable-ish CSS path for a node — for human/LLM orientation, not querying. */
  function describe(el) {
    const tag = el.tagName.toLowerCase()
    const id = el.id ? '#' + el.id : ''
    // Figma Sites emits atomic hashed classes (fig-1czkxn0) — keep at most 3,
    // they are useless as semantics but useful as identity anchors.
    let cls = ''
    if (el.classList && el.classList.length) {
      cls = '.' + Array.from(el.classList).slice(0, 3).join('.')
    }
    return tag + id + cls
  }

  function textOf(el, max) {
    max = max || 80
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    return t.length > max ? t.slice(0, max) + '…' : t
  }

  /** Direct text of this element, excluding descendants' — identifies leaf copy. */
  function ownText(el) {
    let s = ''
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.nodeValue
    }
    return s.replace(/\s+/g, ' ').trim()
  }

  // -------------------------------------------------------- style capture --

  /**
   * Distilled computed style for one element.
   * @param {Element} el
   * @param {CSSStyleDeclaration|null} parentCs computed style of the styling parent
   */
  function styleOf(el, parentCs) {
    const cs = getComputedStyle(el)
    const tag = el.tagName.toLowerCase()
    const defs = defaultsForTag(tag, isSvgEl(el))
    const out = {}
    for (const p of ALL_PROPS) {
      let v = cs.getPropertyValue(p)
      if (v === '' || v == null) continue
      v = v.trim()
      if (defs[p] !== undefined && v === defs[p]) continue // UA default
      if (NULLISH.has(v)) continue // semantically empty
      if (parentCs && INHERITED.has(p) && v === parentCs.getPropertyValue(p).trim()) continue
      out[p] = v
    }

    // transform-origin resolves to the element's own centre on every element in
    // the document. It only carries information when a transform is present.
    if (out['transform-origin'] && !out.transform && !out.rotate && !out.scale) {
      delete out['transform-origin']
    }

    // Resolved width/height restate the box rect we already emit. Keep them only
    // when they genuinely disagree (transform scaling, subpixel constraints).
    const r = el.getBoundingClientRect()
    if (out.width && Math.abs(parseFloat(out.width) - r.width) < 1.5) delete out.width
    if (out.height && Math.abs(parseFloat(out.height) - r.height) < 1.5) delete out.height

    // For positioned elements Chrome resolves all four offsets, but only the
    // authored ones carry intent — the opposite pair is derived from the
    // containing block. Drop an offset that is exactly what geometry implies.
    const pos = cs.position
    if (pos === 'fixed' || pos === 'absolute') {
      let cb = null
      if (pos === 'fixed') {
        cb = { w: window.innerWidth, h: window.innerHeight, x: 0, y: 0 }
      } else {
        const op = el.offsetParent
        if (op) {
          const opr = op.getBoundingClientRect()
          cb = { w: opr.width, h: opr.height, x: opr.left, y: opr.top }
        }
      }
      if (cb) {
        const relLeft = r.left - cb.x
        const relTop = r.top - cb.y
        if (out.right && Math.abs(parseFloat(out.right) - (cb.w - relLeft - r.width)) < 1.5) {
          delete out.right
        }
        if (out.bottom && Math.abs(parseFloat(out.bottom) - (cb.h - relTop - r.height)) < 1.5) {
          delete out.bottom
        }
      }
    }

    // place-items / place-content are shorthands Chrome echoes alongside the
    // longhands we already captured. Redundant by construction.
    if (out['place-items'] && (out['align-items'] || out['justify-items'])) delete out['place-items']
    if (out['place-content'] && (out['align-content'] || out['justify-content'])) {
      delete out['place-content']
    }

    return { style: out, cs }
  }

  /**
   * Hoist declarations that appear on nearly every node into a shared block.
   * `box-sizing: border-box` on 400 nodes is a reset, not a design decision —
   * stating it once is both smaller and more truthful.
   */
  function hoistCommon(nodes, threshold) {
    threshold = threshold || 0.8
    // Worth doing even for small blocks: `box-sizing: border-box` repeated on
    // four nodes is still four lines of noise that say nothing about the design.
    if (nodes.length < 3) return {}
    const counts = new Map()
    for (const n of nodes) {
      for (const [k, v] of Object.entries(n.style || {})) {
        const key = k + ' ' + v
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    const common = {}
    const min = Math.ceil(nodes.length * threshold)
    for (const [key, count] of counts) {
      if (count < min) continue
      const idx = key.indexOf(' ')
      const prop = key.slice(0, idx)
      // Never hoist properties whose whole point is per-element variation.
      if (HOIST_DENY.has(prop)) continue
      common[prop] = key.slice(idx + 1)
    }
    for (const n of nodes) {
      for (const [k, v] of Object.entries(common)) {
        if (n.style && n.style[k] === v) delete n.style[k]
      }
    }
    return common
  }

  const HOIST_DENY = new Set([
    'width', 'height', 'top', 'right', 'bottom', 'left', 'transform',
    'background-image', 'color', 'background-color', 'font-size', 'grid-column-start',
    'grid-column-end', 'grid-row-start', 'grid-row-end',
  ])

  // ------------------------------------------------------------- outline ---

  /**
   * Structural recon: what does this page's DOM actually look like?
   * Used by `harvest outline` before committing to a segmentation strategy.
   */
  function outline(opts) {
    opts = opts || {}
    const maxDepth = opts.maxDepth != null ? opts.maxDepth : 4
    const minHeight = opts.minHeight != null ? opts.minHeight : 24

    function walk(el, depth) {
      const cs = getComputedStyle(el)
      const rect = rectOf(el)
      const kids = []
      if (depth < maxDepth) {
        for (const child of el.children) {
          if (!isVisible(child)) continue
          const cr = child.getBoundingClientRect()
          if (cr.height < minHeight && child.children.length === 0) continue
          kids.push(walk(child, depth + 1))
        }
      }
      return {
        sel: describe(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        box: roundRect(rect),
        display: cs.display,
        position: cs.position,
        bg: cs.backgroundColor,
        childCount: el.children.length,
        text: textOf(el, 60),
        depth: depth,
        children: kids,
      }
    }

    const root = document.body
    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      ),
      scrollContainer: describe(findScrollRoot()),
      tree: walk(root, 0),
    }
  }

  // -------------------------------------------------------- segmentation ---

  /**
   * Find the element that actually holds the page's vertical run of sections.
   * Figma Sites wraps content in several full-height divs before the real
   * section list, so we descend while a single child dominates its parent.
   */
  function findScrollRoot() {
    let el = document.body
    for (let i = 0; i < 8; i++) {
      const visibleKids = Array.from(el.children).filter((c) => isVisible(c))
      if (visibleKids.length !== 1) break
      const kid = visibleKids[0]
      const kr = kid.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      // Only descend if the child really is the whole parent.
      if (kr.height >= er.height * 0.9 && kr.width >= er.width * 0.9) el = kid
      else break
    }
    return el
  }

  /**
   * Split the page into blocks (sections).
   *
   * Strategy, in priority order:
   *   1. explicit selector, if the caller supplies one
   *   2. semantic landmarks (section/header/footer/main > *) when they cover the page
   *   3. children of the dominant scroll root, filtered by size
   */
  function segment(opts) {
    opts = opts || {}
    const minHeight = opts.minHeight != null ? opts.minHeight : 80
    const minWidthRatio = opts.minWidthRatio != null ? opts.minWidthRatio : 0.5
    const vw = window.innerWidth

    let els = []
    let strategy = ''

    if (opts.selector) {
      els = Array.from(document.querySelectorAll(opts.selector))
      strategy = 'selector:' + opts.selector
    }

    if (!els.length) {
      const semantic = Array.from(
        document.querySelectorAll('body section, body header, body footer, body main > *, body article'),
      ).filter((el) => {
        const r = el.getBoundingClientRect()
        return isVisible(el) && r.height >= minHeight && r.width >= vw * minWidthRatio
      })
      // Only trust semantics if they tile most of the page.
      const doc = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
      const covered = semantic.reduce((a, el) => a + el.getBoundingClientRect().height, 0)
      if (semantic.length >= 2 && covered >= doc * 0.5) {
        els = dropNested(semantic)
        strategy = 'semantic-landmarks'
      }
    }

    if (!els.length) {
      const root = findScrollRoot()
      els = Array.from(root.children).filter((el) => {
        const r = el.getBoundingClientRect()
        return isVisible(el) && r.height >= minHeight && r.width >= vw * minWidthRatio
      })
      strategy = 'scroll-root-children (' + describe(root) + ')'
    }

    els = dropNested(els).sort(byTop)

    // A single block wrapping the whole page is technically correct and
    // practically useless — it happens on table- and wrapper-div-based layouts
    // where there are no semantic sections. Walk down through single-child
    // chains (table > tbody > tr, or nested wrapper divs) until the page
    // actually branches, then use that level as the block list.
    if (els.length === 1) {
      let cursor = els[0]
      const trail = []
      for (let hop = 0; hop < 8; hop++) {
        const kids = Array.from(cursor.children).filter(function (el) {
          const kr = el.getBoundingClientRect()
          return isVisible(el) && kr.height >= minHeight && kr.width >= vw * minWidthRatio
        })
        if (kids.length >= 2) {
          els = dropNested(kids).sort(byTop)
          trail.push(describe(cursor))
          strategy += ' > descended through ' + trail.join(' > ')
          break
        }
        if (kids.length === 1) {
          trail.push(describe(cursor))
          cursor = kids[0]
          continue
        }
        break // leaf — one block really is the answer
      }
    }

    // Coverage denominator: the real content extent, not scrollHeight.
    // On a short page the document stretches to the viewport height, so
    // measuring against scrollHeight reports a spurious low coverage for a page
    // that is in fact fully captured.
    const scrollH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    const contentH = contentBottom()
    const docH = Math.min(scrollH, Math.max(contentH, 1))

    // Deliberately lower than minHeight: a 78px sticky nav is not a "block" by
    // size, but losing it silently would be a real defect.
    const gapThreshold = opts.gapThreshold != null ? opts.gapThreshold : 40
    const gaps = findGaps(els, docH, gapThreshold)
    const filled = []
    for (const gap of gaps) {
      const el = bestElementForRange(gap.top, gap.bottom, Math.min(gapThreshold, 24), minWidthRatio * vw)
      if (el && !els.includes(el) && !els.some((o) => o.contains(el) || el.contains(o))) {
        els.push(el)
        filled.push({ top: r2(gap.top), bottom: r2(gap.bottom), sel: describe(el) })
      } else {
        filled.push({ top: r2(gap.top), bottom: r2(gap.bottom), sel: null })
      }
    }
    els = dropNested(els).sort(byTop)

    const coveredPx = mergedHeight(els)

    return {
      strategy: strategy,
      coverage: {
        documentHeight: r2(docH),
        scrollHeight: r2(scrollH),
        contentHeight: r2(contentH),
        coveredHeight: r2(coveredPx),
        ratio: docH ? r2(Math.min(1, coveredPx / docH)) : 0,
        gapsFound: filled,
      },
      blocks: els.map(function (el, i) {
        const cs = getComputedStyle(el)
        return {
          index: i,
          sel: describe(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || null,
          box: roundRect(rectOf(el)),
          sticky: cs.position === 'sticky' || cs.position === 'fixed',
          bg: cs.backgroundColor,
          heading: headingOf(el),
          text: textOf(el, 120),
          nodeCount: el.querySelectorAll('*').length,
        }
      }),
    }
  }

  function byTop(a, b) {
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    return ra.top + window.scrollY - (rb.top + window.scrollY)
  }

  /** Bottom edge of the lowest visible content, ignoring empty page stretch. */
  function contentBottom() {
    let max = 0
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      // Fixed elements ride the viewport and say nothing about document length.
      if (cs.position === 'fixed') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const bottom = r.bottom + window.scrollY
      if (bottom > max) max = bottom
    }
    return max
  }

  /** Vertical ranges of the document not covered by any chosen block. */
  function findGaps(els, docH, minHeight) {
    const spans = els
      .map((el) => {
        const r = rectOf(el)
        return { top: r.y, bottom: r.y + r.h }
      })
      .sort((a, b) => a.top - b.top)
    const gaps = []
    let cursor = 0
    for (const s of spans) {
      if (s.top - cursor >= minHeight) gaps.push({ top: cursor, bottom: s.top })
      cursor = Math.max(cursor, s.bottom)
    }
    if (docH - cursor >= minHeight) gaps.push({ top: cursor, bottom: docH })
    return gaps
  }

  /** Largest sensible element occupying an uncovered vertical range. */
  function bestElementForRange(top, bottom, minHeight, minWidth) {
    let best = null
    let bestArea = 0
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue
      const r = rectOf(el)
      if (r.h < minHeight || r.w < minWidth) continue
      // Must sit essentially inside the gap, not straddle it.
      if (r.y < top - 4 || r.y + r.h > bottom + 4) continue
      const area = r.w * r.h
      if (area > bestArea) {
        bestArea = area
        best = el
      }
    }
    return best
  }

  /** Total vertical extent covered by a set of elements, overlaps merged. */
  function mergedHeight(els) {
    const spans = els
      .map((el) => {
        const r = rectOf(el)
        return [r.y, r.y + r.h]
      })
      .sort((a, b) => a[0] - b[0])
    let total = 0
    let curStart = null
    let curEnd = null
    for (const [s, e] of spans) {
      if (curEnd == null || s > curEnd) {
        if (curEnd != null) total += curEnd - curStart
        curStart = s
        curEnd = e
      } else {
        curEnd = Math.max(curEnd, e)
      }
    }
    if (curEnd != null) total += curEnd - curStart
    return total
  }

  /** Remove elements that are descendants of another element in the list. */
  function dropNested(list) {
    return list.filter(function (el) {
      return !list.some(function (other) {
        return other !== el && other.contains(el)
      })
    })
  }

  function headingOf(el) {
    const h = el.querySelector('h1, h2, h3, [role="heading"]')
    if (h) return textOf(h, 60)
    return ''
  }

  // -------------------------------------------------------- block capture --

  /**
   * Full structured capture of one block's subtree.
   * Returns a tree of { sel, box, style, text, ... } with distilled styles.
   */
  function captureBlock(opts) {
    opts = opts || {}
    const el = resolveBlockEl(opts)
    if (!el) return null
    const maxNodes = opts.maxNodes != null ? opts.maxNodes : 400
    const maxDepth = opts.maxDepth != null ? opts.maxDepth : 14
    let count = 0
    let truncated = false

    function walk(node, parentCs, depth, flat) {
      if (count >= maxNodes) {
        truncated = true
        return null
      }
      count++
      const res = styleOf(node, parentCs)
      const rect = rectOf(node)
      const own = ownText(node)
      const out = {
        sel: describe(node),
        tag: node.tagName.toLowerCase(),
        box: roundRect(rect),
        style: res.style,
      }
      flat.push(out)
      const role = node.getAttribute && node.getAttribute('role')
      if (role) out.role = role
      const aria = node.getAttribute && node.getAttribute('aria-label')
      if (aria) out.ariaLabel = aria
      if (own) out.text = own.length > 200 ? own.slice(0, 200) + '…' : own
      if (node.tagName === 'IMG') {
        out.src = node.currentSrc || node.src || null
        out.alt = node.getAttribute('alt') || ''
        out.natural = { w: node.naturalWidth, h: node.naturalHeight }
      }
      if (node.tagName === 'VIDEO') {
        out.src = node.currentSrc || node.src || srcOfChildSource(node)
        out.natural = { w: node.videoWidth, h: node.videoHeight }
        out.loop = node.loop
        out.autoplay = node.autoplay
        out.muted = node.muted
      }
      if (node.tagName === 'A') out.href = node.getAttribute('href')
      if (node.tagName === 'IFRAME') {
        // An iframe's content lives in another document — it is not in this
        // tree and does not appear in a screenshot if it failed to load. Say so
        // explicitly rather than leaving an unexplained empty rectangle.
        out.src = node.getAttribute('src') || node.getAttribute('data-src') || null
        out.iframe = true
        out.loading = node.getAttribute('loading') || null
        out.title = node.getAttribute('title') || null
        try {
          // Same-origin frames are readable; cross-origin ones throw.
          out.crossOrigin = !node.contentDocument
        } catch (e) {
          out.crossOrigin = true
        }
      }
      if (node.tagName === 'SVG' || node.tagName === 'svg') {
        out.svgViewBox = node.getAttribute('viewBox')
      }

      if (depth < maxDepth) {
        const kids = []
        for (const child of node.children) {
          if (!isVisible(child)) continue
          const sub = walk(child, res.cs, depth + 1, flat)
          if (sub) kids.push(sub)
        }
        if (kids.length) out.children = kids
      }
      return out
    }

    const parent = el.parentElement
    const flat = []
    const tree = walk(el, parent ? getComputedStyle(parent) : null, 0, flat)
    const common = hoistCommon(flat)
    return {
      tree: tree,
      commonStyle: common,
      truncated: truncated,
      nodeCount: count,
      totalNodes: el.querySelectorAll('*').length + 1,
    }
  }

  function srcOfChildSource(video) {
    const s = video.querySelector('source')
    return s ? s.src || s.getAttribute('src') : null
  }

  /** Locate a block element by selector, explicit box, or segmentation index. */
  function resolveBlockEl(opts) {
    if (opts.selector) {
      const found = document.querySelector(opts.selector)
      if (found) return found
    }
    // Preferred path: the caller already segmented and hands us the geometry.
    // Avoids re-running segmentation once per block.
    if (opts.box) {
      const el = elementAtBox(opts.box)
      if (el) return el
    }
    if (opts.index != null) {
      const seg = segment(opts.segmentOpts || {})
      const meta = seg.blocks[opts.index]
      if (!meta) return null
      // Re-resolve by geometry — selectors from atomic classes are not unique.
      return elementAtBox(meta.box)
    }
    return null
  }

  /** Find the element whose page box matches, used to re-acquire after resize. */
  function elementAtBox(box) {
    const all = document.querySelectorAll('body *')
    let best = null
    let bestScore = Infinity
    for (const el of all) {
      const r = rectOf(el)
      const score =
        Math.abs(r.x - box.x) + Math.abs(r.y - box.y) +
        Math.abs(r.w - box.w) + Math.abs(r.h - box.h)
      if (score < bestScore) {
        bestScore = score
        best = el
      }
    }
    return bestScore < 8 ? best : null
  }

  // ---------------------------------------------------------- page facts ---

  /** Fonts, colours, spacing — the raw material for a design token file. */
  function surveyTokens(opts) {
    opts = opts || {}
    const colors = new Map()
    const bgs = new Map()
    const fonts = new Map()
    const sizes = new Map()
    const weights = new Map()
    const radii = new Map()
    const shadows = new Map()
    const gaps = new Map()
    const pads = new Map()

    function bump(map, key, el) {
      if (!key) return
      const cur = map.get(key)
      if (cur) {
        cur.count++
        if (cur.samples.length < 3) cur.samples.push(sampleOf(el))
      } else {
        map.set(key, { count: 1, samples: [sampleOf(el)] })
      }
    }
    function sampleOf(el) {
      const t = textOf(el, 30)
      return t ? describe(el) + ' "' + t + '"' : describe(el)
    }

    const all = document.querySelectorAll('body *')
    for (const el of all) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue

      const hasText = ownText(el).length > 0
      if (hasText) {
        bump(colors, cs.color, el)
        bump(fonts, cs.fontFamily, el)
        bump(sizes, cs.fontSize + ' / ' + cs.lineHeight, el)
        bump(weights, cs.fontWeight, el)
      }
      if (cs.backgroundColor && !NULLISH.has(cs.backgroundColor)) bump(bgs, cs.backgroundColor, el)
      const rad = cs.borderTopLeftRadius
      if (rad && rad !== '0px') bump(radii, rad, el)
      if (cs.boxShadow && cs.boxShadow !== 'none') bump(shadows, cs.boxShadow, el)
      if (cs.rowGap && cs.rowGap !== 'normal' && cs.rowGap !== '0px') bump(gaps, cs.rowGap, el)
      if (cs.columnGap && cs.columnGap !== 'normal' && cs.columnGap !== '0px') bump(gaps, cs.columnGap, el)
      for (const side of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
        const v = cs[side]
        if (v && v !== '0px') bump(pads, v, el)
      }
    }

    function top(map, n) {
      return Array.from(map.entries())
        .map(([value, info]) => ({ value, count: info.count, samples: info.samples }))
        .sort((a, b) => b.count - a.count)
        .slice(0, n || 30)
    }

    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      textColors: top(colors, 24),
      backgrounds: top(bgs, 24),
      fontFamilies: top(fonts, 10),
      fontSizes: top(sizes, 30),
      fontWeights: top(weights, 10),
      radii: top(radii, 16),
      shadows: top(shadows, 12),
      gaps: top(gaps, 20),
      paddings: top(pads, 24),
    }
  }

  /** Every media/image URL the DOM currently references, with its render box. */
  function collectMediaRefs() {
    const out = []
    function push(url, kind, el, extra) {
      if (!url || url.startsWith('data:')) return
      const r = el ? rectOf(el) : null
      // A 0x0 box means the asset is preloaded or hidden at this breakpoint —
      // still worth listing, but it must not be mistaken for a laid-out image.
      const rendered = !!(r && r.w > 0 && r.h > 0)
      out.push(
        Object.assign(
          {
            url: absolutise(url),
            kind: kind,
            sel: el ? describe(el) : null,
            box: r ? roundRect(r) : null,
            rendered: rendered,
          },
          extra || {},
        ),
      )
    }
    for (const img of document.querySelectorAll('img')) {
      push(img.currentSrc || img.src, 'img', img, {
        natural: { w: img.naturalWidth, h: img.naturalHeight },
        alt: img.getAttribute('alt') || '',
        srcset: img.getAttribute('srcset') || null,
      })
    }
    for (const v of document.querySelectorAll('video')) {
      push(v.currentSrc || v.src || srcOfChildSource(v), 'video', v, {
        natural: { w: v.videoWidth, h: v.videoHeight },
        poster: v.getAttribute('poster') || null,
      })
    }
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      const bi = cs.backgroundImage
      if (bi && bi !== 'none') {
        const m = bi.match(/url\((['"]?)(.*?)\1\)/g) || []
        for (const raw of m) {
          const u = raw.replace(/^url\((['"]?)/, '').replace(/(['"]?)\)$/, '')
          push(u, 'background', el, { backgroundSize: cs.backgroundSize })
        }
      }
    }
    // Inline <svg> is content, not a fetched asset — record it separately.
    return out
  }

  function absolutise(u) {
    try {
      return new URL(u, location.href).href
    } catch (e) {
      return u
    }
  }

  /** Freeze CSS animations/transitions so screenshots are deterministic. */
  function freezeMotion() {
    const style = document.createElement('style')
    style.id = '__harvest_freeze__'
    style.textContent =
      '*,*::before,*::after{animation-play-state:paused !important;' +
      'transition:none !important;caret-color:transparent !important;}'
    document.documentElement.appendChild(style)
    for (const v of document.querySelectorAll('video')) {
      try {
        v.pause()
        // Seek to a representative frame rather than 0. Many hero videos open
        // on a blank or fade-in frame, so t=0 screenshots an empty box while
        // the page visibly has content. Mid-clip is both meaningful and
        // deterministic across runs.
        if (v.readyState >= 1 && v.duration && isFinite(v.duration) && v.duration > 0) {
          v.currentTime = Math.min(v.duration * 0.5, 2)
        }
      } catch (e) {}
    }
    return true
  }

  function unfreezeMotion() {
    const s = document.getElementById('__harvest_freeze__')
    if (s) s.remove()
    return true
  }

  /** Scroll the whole page to trigger lazy-loading and scroll-driven reveals. */
  async function primeLazyContent(stepRatio, pauseMs) {
    stepRatio = stepRatio || 0.8
    pauseMs = pauseMs || 120
    const doc = () =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    const step = Math.max(200, window.innerHeight * stepRatio)
    let y = 0
    let guard = 0
    while (y < doc() && guard++ < 200) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, pauseMs))
      y += step
    }
    window.scrollTo(0, doc())
    await new Promise((r) => setTimeout(r, pauseMs))
    window.scrollTo(0, 0)
    await new Promise((r) => setTimeout(r, pauseMs * 2))
    return doc()
  }

  /** Interactive surface: what a user can click/type, for interaction specs. */
  function collectInteractive() {
    const sels = 'a[href],button,[role="button"],input,textarea,select,summary,[tabindex]:not([tabindex="-1"]),[onclick]'
    const out = []
    for (const el of document.querySelectorAll(sels)) {
      if (!isVisible(el)) continue
      const cs = getComputedStyle(el)
      out.push({
        sel: describe(el),
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        role: el.getAttribute('role') || null,
        label: textOf(el, 40) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
        href: el.getAttribute('href') || null,
        box: roundRect(rectOf(el)),
        cursor: cs.cursor,
        transition: cs.transitionProperty !== 'all' && cs.transitionProperty !== 'none'
          ? cs.transitionProperty + ' ' + cs.transitionDuration + ' ' + cs.transitionTimingFunction
          : (cs.transitionDuration !== '0s'
              ? cs.transitionProperty + ' ' + cs.transitionDuration + ' ' + cs.transitionTimingFunction
              : null),
      })
    }
    return out
  }

  window.__HARVEST__ = {
    outline: outline,
    segment: segment,
    captureBlock: captureBlock,
    surveyTokens: surveyTokens,
    collectMediaRefs: collectMediaRefs,
    collectInteractive: collectInteractive,
    freezeMotion: freezeMotion,
    unfreezeMotion: unfreezeMotion,
    primeLazyContent: primeLazyContent,
    elementAtBox: elementAtBox,
    findScrollRoot: function () {
      return describe(findScrollRoot())
    },
    version: 1,
  }
})()
