---
name: web-design-harvester
description: Reproduce a rendered web page (Figma Sites, any URL) as high-fidelity code. Harvests per-section screenshots, distilled computed CSS, design tokens, responsive deltas and alpha-measured assets into a spec directory, then works through it block by block. Use when asked to rebuild/clone/复刻 a site or section from a URL, when handed a *.figma.site or *-figmaiframepreview.figma.site link, when Figma's REST API returns "File type not supported" for a Sites/Make file, or when you need exact measured CSS values rather than eyeballed ones from a screenshot.
---

# Harvesting a page into high-fidelity code

## When to use this

Use it when you have a **URL that renders** and need to reproduce it accurately.
Not for static design files — for those, Figma's REST API works and is better.

Check first: `GET /v1/files/{key}/meta` reports `editorType`. If it's `sites` or
`make`, the node endpoints return **400 "File type not supported by this
endpoint"** and this tool is the way in. If it's `design`, use the API.

## Step 0 — can the browser reach the page?

| URL | Works? | What to do |
|---|---|---|
| `https://<name>.figma.site` | ✅ | Use directly. |
| `https://<uuid>-v2-figmaiframepreview.figma.site` | ❌ | Not a page — see below. |
| localhost, staging, any public site | ✅ | Use directly. |

The `-figmaiframepreview` URL returns HTTP 200 and a ~3.6KB shell with nothing in
it. The real site is handed to it over `postMessage` by a **logged-in figma.com
tab**; loaded directly it stays blank forever. Waiting longer will not help.

Two ways forward — ask the user which:
1. **Publish the site** and harvest the public `*.figma.site` URL. Simplest.
2. **Attach to their browser.** They start Chrome with
   `--remote-debugging-port=9222`, log into Figma, open Preview; you harvest with
   `--cdp 9222`.

## Step 1 — recon before committing

```bash
node bin/harvest.mjs blocks <url> --widths 1440
```

Read the output before harvesting:

- **Coverage < 90%** → the page isn't fully claimed. Check the unclaimed regions.
- **One giant block** → segmentation failed to find sections. Pass
  `--selector "main > section"` or whatever the outline suggests.
- **Blocks don't match the visual sections** → same fix.
- **Headings look right and coverage is ~100%** → proceed.

`node bin/harvest.mjs outline <url>` gives the raw DOM tree if you need to work
out a selector.

## Step 2 — harvest

```bash
node bin/harvest.mjs <url> --out ./spec --widths 1440,375 --clean
```

Always capture **at least two** breakpoints. Roughly half the specification lives
in the difference between them, and it is not derivable by scaling.

Add a tablet width when the design has one: `--widths 1440,768,375`. You get a
screenshot and style tree per breakpoint, plus delta tables for each adjacent
step (`desktop → tablet`, `tablet → mobile`) — which is exactly the order you
write the media queries in. Check `responsive.md`'s opening matrix to see which
blocks actually change at which step; blocks marked "fluid only" need no query
at that step at all.

## Step 3 — read the output in this order

1. **`spec/README.md`** — index, coverage, and the warnings. Read the warnings
   before writing any CSS.
2. **`spec/tokens.css`** — drop straight into the project; it's the colour, type
   and spacing system ranked by actual usage.
3. **`spec/blocks/<nn>-<name>/block.md`** — one section at a time.
4. **`spec/responsive.md`** — when wiring up the breakpoints.

Work **one block at a time**. Read its `block.md`, write that section, move on.
Don't try to hold the whole page at once.

## Reading a block.md

The structure tree is the spec:

```
section.fig-lqoz33          1440×1108.6  pad:0/0/32/0  relative  bg:#ffffff
└─ div.fig-umtrpl           1440×1076.6  flex-col  gap:64  pad:64/0/0/0
   ├─ h1.fig-6late5            660×72     mar:0/0/32/0  72/72  ls:-1.44  "Figma Sites"
```

- `1440×1108.6` — the measured box. Sizes are CSS pixels, 1:1 with the PNG.
- `72/72` — `font-size`/`line-height`. `w700` is `font-weight`.
- `pad:0/0/32/0` — top/right/bottom/left. `pad:96/120` means vertical/horizontal.
- `gap:64`, `r:8`, `ls:-1.44` — gap, border-radius, letter-spacing.
- Class names like `fig-lqoz33` are Figma's generated atoms. They're identity
  anchors for cross-referencing the tree, **not** names to reproduce. Use your
  own semantic classes.

The digest is intentionally lossy. When a value matters exactly, read
`tree.desktop.json` in the same directory.

## The things that actually cause rework

**Assets are not centred in their canvas.** A 1200×1200 file often holds artwork
in an off-centre 1049×677 region. The asset table gives you the answer directly:

> `object-position: 50% 52.5%` — content fills 49% of canvas

Use that value. Defaulting to `center` crops off-axis, and `contain` wastes the
padding as dead space on both sides.

**Some assets cannot be made to fit.** When README.md says:

> unsolvable in CSS — cover discards 37% of the artwork; re-export at the slot ratio

believe it and **tell the user**. No `object-fit` value solves a 1.02 content
ratio in a 1.63 slot. Attempting CSS fixes here burns rounds and cannot succeed.
Flag it and move on to the parts that are solvable.

**Cross-origin iframes are holes.** If `block.md` has an "Embedded frames"
section, that rectangle's content is not in the tree and may be blank in the
screenshot. Don't reproduce it as empty space and don't guess — ask.

**Meaningless asset filenames.** When a dozen icons are all `icon-*.svg`, match
them by colour: `assets/README.md` has a colour index, and each tile's fill is
usually unique. Faster and more reliable than guessing from order.

## Iterating with the servers

For back-and-forth work, don't re-run the CLI — each cold start costs ~25s. Start
the daemon or use the MCP tools, and follow-up queries land in ~30ms because the
page stays loaded.

```bash
node bin/harvest.mjs serve --port 8787          # then GET /blocks, /block, /tokens
node bin/harvest.mjs mcp                        # MCP over stdio
```

MCP tools: `harvest_blocks` → find the section index, then `harvest_block` for its
structure. `harvest_analyse_asset` on any local file gives the content box and
`object-position` without a full harvest.

## Verifying your work

Compare against the captured screenshot, not your memory of it:

```bash
node bin/harvest.mjs screenshot --url http://localhost:3000 --out ./mine.png
# then diff ./mine.png against spec/blocks/<nn>/desktop.png
```

Because both are 1 CSS pixel = 1 image pixel, you can measure a discrepancy
directly off the images with no scaling factor.

## Don't

- Don't paste the whole `tree.*.json` into context — that's what `block.md` is for.
- Don't reproduce `fig-*` class names.
- Don't harvest at one breakpoint and infer the other.
- Don't skip the README warnings; they are the expensive-to-rediscover problems.
- Don't retry a `-figmaiframepreview` URL hoping it loads. It won't.
