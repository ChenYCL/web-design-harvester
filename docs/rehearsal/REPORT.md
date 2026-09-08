# Rehearsal: restoring an unpublished Figma Sites page

Run date: 2026-09-08 · sample file `<FILE_KEY>` (`editorType: "sites"`)
Target: **`/page-2`** — a page that exists in the editor and has never been published.

## What was proven

Published Figma Sites and the editor Preview run the **same renderer**
(`SitesRuntime`). Only the data source differs. Capture the preview's data and
feed it back into that renderer and the page reproduces exactly — no DOM
cloning, no computed-style guessing.

| Run | Reference | Result |
|---|---|---|
| Control — published bundle replayed locally | live published site | **0.0000 %** pixel difference |
| `/` — preview bundle replayed locally | live published site | 0.053 %, all unpublished edits |
| **`/page-2`** — preview bundle replayed locally | never published | renders 1303 elements, 15 images, 16 videos, zero console errors |

`/page-2` has no public counterpart to diff against, so its verification is
structural plus visual: 4760 captured nodes hydrate into a page whose hero,
email capture and dashboard match the design frame exactly.

| | `/` | `/page-2` |
|---|---|---|
| Bundle nodes | 2013 | 4760 |
| Bundle size | 5.5 MB | 9.7 MB |
| Pushed asset Blobs | 176 | 743 |
| `sourceCodeHash` | `a60397c2…` | `2f26cad7…` |

## The general method

Route discovery, labelling and verification all come from the data, so the
procedure does not depend on knowing a site's layout in advance:

1. **Arm** a `MessagePort.prototype.postMessage` hook at `document_start`, then
   reload so the hook is guaranteed to precede the first message.
2. **Enumerate** — the first `getPage` reply carries `guidToUrl`, which lists
   every route including unpublished ones.
3. **Visit** each route by restoring the editor with `?node-id=<guid>`, polling
   for the preview control to mount, then clicking it.
4. **Label from the payload**: `bundle.guidToUrl[bundle.roots[0]]`. Replies
   carry no request arguments, so a label is never inferred from the request.
   This doubles as verification — ask for `/page-2`, assert the arriving bundle
   has `roots[0] === '501:85181'`.
5. **Drain** that round's `pushAssetData` Blobs before the next reload clears them.
6. **Record** every route's outcome in `capture-meta.json`; failures carry a
   reason and are never silently skipped.

```bash
npm run kiwi:preview -- <FILE_KEY>          # all routes, or ROUTES='/page-2'
PUBLISHED_URL=https://<slug>.figma.site npm run kiwi:replay
node rehearsal/replay/server.mjs            # SPA fallback, :8900
npm run kiwi:sync -- <FILE_KEY> && npm run kiwi:source
```

## Constraints worth keeping

**The runtime is versioned with the bundle.** `sites-runtime.<sha256>.js` is not
interchangeable between sites. A mismatch dies inside hydration with
`TypeError: Cannot convert undefined or null to object` at `Object.entries`.
Take the runtime from the site's own published host; the builder warns when it
has to fall back.

**One `getPage` per route.** `_index.json` is only the entry page. Each route is
a separate fetch with its own `roots`, node set and often its own
`sourceCodeHash`, so a replay needs one JSON per route plus a matching
`_components/v2/<hash>.{js,css}` pair.

**The preview control changes shape.** Wide toolbar exposes
`data-testid="present-sites-full-preview"`; in a narrow window the testid is
gone. A bare `aria-label="Present"` is the multiplayer spotlight button, not the
site preview — clicking it produces no port traffic at all, which is how the
tool tells the two failure modes apart.

**Hook the editor, not the iframe.** The preview is an out-of-process iframe
whose CDP session rejects `Page.reload` ("Command can only be executed on
top-level targets"), so a hook cannot reliably precede its first paint there.

**`pushAssetData` values are `Blob`s.** They serialise as `{}` and fail
`instanceof ArrayBuffer`; keep the reference and `await blob.arrayBuffer()`
outside the synchronous patch.

**Unpublished videos are signed S3 URLs** (`X-Amz-Expires=604800`). Reduce to the
basename the runtime requests and fetch the bytes within seven days.

**Cloudflare 403s default tool user agents** on `*.figma.site`; send a browser UA.

## Source for secondary development

`kiwi source` produces an editable package rather than runtime data:

| Folder | Contents |
|---|---|
| `code/` | 13 `CODE_FILE` sources off the wire — real TSX including a motion-based `Typewriter.tsx` and two `main.tsx` component trees, plus SVG path modules. `manifest.json` maps runtime virtual paths to files and lists each `CODE_INSTANCE`'s `codeExportName`. |
| `components/` | `compiledCode` (esbuild) and `globalStyles` (Tailwind v4) per `sourceCodeHash`. |
| `interactions/` | 254 interactions flattened: 179 `ON_HOVER`, 47 `ON_CLICK`, 28 `ON_PRESS`, with targets, easing and durations. |
| `design/` | Per-route inventory — `/page-2` alone carries 712 text nodes with geometry and type styles. |

Interactions need no reimplementation in the replay: it runs the same
`SitesRuntime`, so hover, click and smart-animate behave as designed.
The table is for porting them elsewhere. Files importing `figma:react` only run
inside Figma's runtime; ones importing plain `react` are portable as-is.
