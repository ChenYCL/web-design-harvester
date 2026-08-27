# web-design-harvester

Turn a rendered web page into a design spec an LLM can build from: per-section
screenshots, distilled computed CSS, design tokens, responsive deltas, and
assets analysed down to their alpha channel.

Built for reproducing Figma Sites pages, but nothing in it is Figma-specific —
it works on any URL that renders.

```bash
npm install
node bin/harvest.mjs https://example.figma.site --out ./spec --clean
# then point a model at ./spec/README.md
```

---

## Why this exists

Reproducing a design used to go: select a block in Figma → *Copy all CSS* →
paste 2000+ lines into a chat → the model digs out the handful of values that
matter → screenshot the mismatch → repeat, seven or eight times.

Every step of that is mechanical, and the source material is worse than it looks:
Figma's CSS export carries rotated frames with unreadable negative coordinates,
`display: none` placeholder layers, and desktop and mobile variants interleaved.

The rendered DOM has none of those problems. `getComputedStyle()` on a live page
is the *resolved* truth, at any breakpoint you like, with the network's asset
list attached. This tool reads that and writes it down.

### Figma's REST API is not an option

`GET /v1/files/{key}` returns **400 "File type not supported by this endpoint"**
for files with `editorType: "sites"` or `"make"`. Only classic `design` files are
readable. Check `/v1/files/{key}/meta` before planning any extraction — `/meta`
and `/styles` work for all types, the node endpoints do not.

---

## Getting the page in front of the browser

This is the part that trips people up, so it is worth being precise.

| What you have | Does it work? | How |
|---|---|---|
| **Published site** `https://<name>.figma.site` | ✅ Yes | Just pass the URL. It's an ordinary public page. |
| **Preview iframe** `https://<uuid>-v2-figmaiframepreview.figma.site` | ❌ **No** | See below. |
| **Unpublished site, open in your Chrome** | ✅ Yes | `--cdp` — see below. |
| Any other site, localhost, staging | ✅ Yes | Just pass the URL. |

### The preview iframe URL does not work standalone

It looks like a page and returns HTTP 200, but fetching it gives you a ~3.6KB
shell containing only a `postMessage` listener. It has no content of its own:

```js
// what that URL actually serves, in full:
window.addEventListener('message', (e) => {
  if (isAllowedOrigin(e.origin)) {          // only figma.com and friends
    if (e.data.type === 'iframe-init') {
      script.src = e.data.initScriptURL      // ← the real app comes from the parent
```

The site's code arrives over a `MessagePort` from a **logged-in figma.com tab**.
Load the URL directly and you get a blank document, no matter how long you wait.
There is no token to supply and no header to set — the content simply isn't there.

### For an unpublished site: attach to your own browser

Start Chrome with remote debugging, log into Figma, open the site's Preview, then
point the harvester at that tab:

```bash
# 1. Chrome with a debugging port (use a separate profile to avoid clobbering yours)
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/figma-profile

# 2. Log into figma.com in that window, open your Sites file, hit Preview.

# 3. Harvest the rendered iframe
node bin/harvest.mjs "https://<uuid>-v2-figmaiframepreview.figma.site" \
  --cdp 9222 --out ./spec
```

With `--cdp` the tool attaches to your browser and never launches or closes
anything. The simpler alternative, if you can: **publish the site** and harvest
the public URL.

For sites behind a login that you'd rather not re-enter every run, `--persist`
keeps a profile on disk between runs.

---

## Usage

```
harvest <url> [options]              full harvest -> spec directory
harvest outline <url>                print the DOM outline (recon)
harvest blocks <url>                 list blocks that would be captured
harvest asset <file...>              analyse local media files
harvest serve [--port 8787]          HTTP daemon, browser stays warm
harvest mcp                          MCP server on stdio
```

| Option | Default | |
|---|---|---|
| `--out <dir>` | `./out` | output directory |
| `--widths <list>` | `1440,375` | breakpoints, e.g. `1440,768,375` || `--selector <css>` | auto | force block boundaries |
| `--settle <ms>` | `800` | extra wait after the page stabilises |
| `--max-nodes <n>` | `400` | per-block node cap |
| `--skip-assets` | | skip downloading and analysing assets |
| `--clean` | | wipe the output directory first |
| `--headed` | | show the browser window |
| `--persist [dir]` | | reuse a profile, keeping logins between runs |
| `--cdp <endpoint>` | | attach to a running Chrome (port or ws:// URL) |
| `--json` | | machine-readable stdout |

**Start with `outline` or `blocks`** on an unfamiliar page. They're fast and tell
you whether the automatic segmentation found sensible sections before you commit
to a full run.

```bash
node bin/harvest.mjs blocks https://figma.site --widths 1440
```
```
strategy: semantic-landmarks
coverage: 100% (11248 of 11248px)

  01  header.fig-suku18       1440×78 @0  [sticky]  What you can do in figma
  02  section.fig-lqoz33    1440×1109 @78            Figma Sites
  03  section.fig-15ba1hq   1440×1117 @1187          Perfect websites every time…
  …
```

If the boundaries are wrong, pass `--selector "main > section"`.

---

## Output

```
spec/
  README.md          ← start here; index, warnings, token summary
  index.json         machine-readable manifest
  tokens.md          design tokens ranked by usage
  tokens.css         the same tokens as CSS custom properties
  responsive.md      every value that changes between breakpoints
  interactions.md    clickable/focusable elements and their transitions
  warnings.json      asset fit problems, in full
  page-desktop.png   full-page screenshot per breakpoint
  page-mobile.png
  blocks/
    02-figma-sites/
      block.md       ← spec sheet for one section
      desktop.png    screenshot, exactly the block's size
      mobile.png
      tree.desktop.json   exact computed values, full precision
      tree.mobile.json
  assets/
    README.md        every asset with content box and fit guidance
    manifest.json
    <files>          deduplicated by content hash
```

A `block.md` looks like this:

```
section.fig-lqoz33            1440×1108.6  pad:0/0/32/0  relative  bg:#ffffff
└─ div.fig-umtrpl             1440×1076.6  flex-col  gap:64  pad:64/0/0/0
   ├─ h1.fig-6late5              660×72     mar:0/0/32/0  72/72  ls:-1.44  "Figma Sites"
   └─ a.fig-1jz30fp            135×46.4     flex-row  jc:center  pad:12/22
                                            #ffffff  bg:#000000  r:8  href:/site/new
```

plus geometry per breakpoint, the copy, the assets used, and a responsive delta
table. The JSON alongside it has the unabridged values if something looks off.

---

## What it does that a screenshot doesn't

**Screenshots are 1 CSS pixel = 1 image pixel.** `deviceScaleFactor: 1` plus
`scale: 'css'` means a distance measured off the PNG is a CSS pixel. No
conversion factor, so no conversion mistakes. (Figma's `@2x` exports put 1798
image pixels against a 1440px design — every measurement needed dividing by
1.2486 first, and getting it wrong produced plausible, wrong numbers.)

**Computed styles are distilled, not dumped.** Three filters run over every
element: UA defaults for that tag are dropped, inherited values the parent
already states are dropped, and declarations appearing on nearly every node
(`box-sizing: border-box` and friends) are hoisted out and stated once. What
survives is what differs, which is what you actually have to write. In practice
this is roughly an order of magnitude smaller than a raw dump.

**Assets are measured, not assumed.** For every image and video the tool decodes
a frame and finds the *content* bounding box from the alpha channel. Design
assets routinely ship as a 1200×1200 square with the artwork occupying an
off-centre 1049×677 region — from the file dimensions alone that is invisible,
and both `object-contain` (dead space) and `object-cover` + centre (crops
off-axis) get it wrong. The output states the `object-position` to use.

VP9 WebM with alpha is handled specially: `ffprobe` reports `pix_fmt=yuv420p`
and shows no alpha channel, but browsers composite it correctly. The alpha only
appears if you force the `libvpx-vp9` decoder.

**Impossible layouts are called out on run 1.** When an asset's content ratio and
the box it sits in disagree badly, no `object-fit` value fixes it — the asset
needs re-exporting. The README flags that immediately, with the percentage of
artwork `cover` would discard, instead of letting you spend six rounds tweaking
CSS to fix an export problem.

**Both breakpoints, because half the spec is in the difference.** Card radius
12px → 6px, title 20/30 → 16/24, header padding 32px → 32px (unchanged). None of
that is derivable by scaling; `responsive.md` lists every value that moves.

**Any number of breakpoints.** `--widths 1440,768,375` captures three, and
everything scales with it: a screenshot and a style tree per breakpoint, usage
counts broken out per breakpoint in `tokens.md`, and delta tables for each
*adjacent pair* — `desktop → tablet`, then `tablet → mobile`. Adjacent rather
than everything-against-desktop, because that mirrors how the media queries are
written: each step only restates what changed since the previous one.
`responsive.md` opens with a matrix of which blocks change at which step.

**Nothing is dropped silently.** After segmentation the tool checks that the
blocks tile the page, hunts for an element covering any gap, and reports the
coverage ratio. Regions it genuinely can't claim are listed rather than ignored.
Screenshot dimensions are verified against what was requested, because a
truncated capture is worse than a failed one — it looks fine and every
measurement off it is quietly wrong.

---

## Serving it to a model

A cold run spends most of its time on browser startup and first paint. If a model
is iterating — *re-check that block, now at 768px, what colour is that icon* —
paying that per question makes the tool unusable. Both server modes keep a
browser and its loaded pages warm.

Measured on `https://figma.site`: **26.8s cold → 0.03s warm.**

### MCP (stdio)

```json
{
  "mcpServers": {
    "web-design-harvester": {
      "command": "node",
      "args": ["/absolute/path/to/web-design-harvester/bin/harvest.mjs", "mcp"]
    }
  }
}
```

Tools: `harvest_outline`, `harvest_blocks`, `harvest_block`, `harvest_tokens`,
`harvest_assets`, `harvest_screenshot`, `harvest_analyse_asset`, `harvest_site`,
`harvest_status`.

The typical loop is `harvest_blocks` to find the section, then `harvest_block`
for its structure — the second call lands in tens of milliseconds because the
page is already open.

### HTTP daemon

```bash
node bin/harvest.mjs serve --port 8787
curl "http://127.0.0.1:8787/blocks?url=https://figma.site&width=1440"
curl "http://127.0.0.1:8787/block?url=https://figma.site&index=4"
```

Binds to loopback only — it fetches arbitrary URLs and writes files where told,
so it shouldn't be reachable off-box. Pass `--host` if you really want that.
Idle pages are closed after 10 minutes.

---

## Requirements

- **Node 18+**
- **Playwright Chromium** — `npm install` fetches it via the postinstall hook
- **ffmpeg / ffprobe** *(optional)* — needed for content boxes, palettes and
  video analysis. Without it everything else still runs; asset intelligence is
  skipped with a warning. `brew install ffmpeg`

```bash
npm test    # 46 tests, ~10s, hermetic (local fixture, no network)
```

---

## Known limits

- **Cross-origin iframes** are holes in both the DOM and the screenshot. The tool
  detects them and lists their size, origin and `src` in `block.md`, but it
  cannot see inside. Whatever the frame renders has to be handled separately.
- **Hover and focus styles** aren't captured — they need live interaction.
  `interactions.md` gives you each element's transition property and duration,
  which tells you what animates and how fast, but not the end state.
- **Streaming video** (DASH/fMP4) arrives as segments that aren't valid
  standalone files. These are labelled rather than reported as corrupt.
- **Canvas and WebGL** content is captured as pixels in the screenshot; there is
  no structure to extract.
- **Scroll-driven animation** is sampled at one point. The page is scrolled
  end-to-end first to trigger reveals, then returned to the top; a section whose
  appearance depends on scroll position may not be at its final state.
