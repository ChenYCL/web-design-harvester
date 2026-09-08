# Figma Sites / Make Exporter

Chrome MV3 extension + Kiwi wire toolkit that reverse-packs a Figma **Sites** or
**Make** file — including sites that have never been published.

## Three acquisition channels

| Channel | Gets you | Needs |
|---|---|---|
| **A. Editor wire** (`kiwi sync`) | full scenegraph, `CODE_FILE` source, blobs, animations | login cookie |
| **B. Preview bundle** (`kiwi preview`) | the renderer's own scene bundle + unpublished assets | login cookie |
| **C. Published mirror** | `_runtimes` / `_json` / `_components` / `_assets` as served | public URL |

Channel B is the one that reproduces an **unpublished** site exactly. See
[`docs/rehearsal/REPORT.md`](docs/rehearsal/REPORT.md) for the measured result.

## Why channel B reproduces exactly

Published sites and the editor Preview share one renderer, `SitesRuntime`. Only
the data source differs:

```js
env: 'published'  →  fetch(`/_json/${bundleId}${route}.json`)
env: 'preview'    →  sendMessage('getPage', {url}) over a MessagePort → { website, cmsBundle }
```

`website` is shape-compatible with a published `_index.json`. Capture it, write
it where the published path expects it, boot the same runtime — and the page
renders identically. Measured against a live site:

| Run | Pixel difference |
|---|---|
| published bundle replayed locally (control) | **0.0000 %** |
| preview bundle replayed locally | 0.053 % — entirely unpublished edits |

Unpublished binary assets never reach a CDN; the editor pushes them to the
preview as `pushAssetData` messages carrying `Blob`s, which we intercept too.

## Quick start — restore an unpublished site

```bash
npm install

# Chrome with the Sites file open and Figma logged in
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/figma-profile

npm run kiwi:preview -- <FILE_KEY>     # every route: bundles + asset Blobs
npm run kiwi:replay                    # build rehearsal/replay/
node rehearsal/replay/server.mjs       # serves with SPA fallback -> :8900

npm run kiwi:sync -- <FILE_KEY>        # wire sync, for CODE_FILE source
npm run kiwi:source                    # editable source package
```

`kiwi preview` is deterministic — it does not depend on knowing the site's
layout in advance:

1. Arms a `MessagePort.prototype.postMessage` hook at `document_start`, then
   reloads so the hook is guaranteed to precede the first message.
2. Captures the first `getPage` reply. Its `guidToUrl` **enumerates every
   route**, including unpublished ones.
3. For each route: restores the editor via `?node-id=<guid>`, polls for the
   preview control to mount (its `data-testid` disappears in a narrow window,
   so `aria-label="Present"` is matched too), clicks, then polls until a bundle
   arrives whose `roots[0]` matches that route's guid.
4. Labels each bundle from its own `roots` → `guidToUrl`. Replies carry no
   request arguments, so labels are derived from data, never guessed.
5. Drains that round's `pushAssetData` Blobs before the next reload wipes them.
6. Writes every route's outcome — captured or failed with the reason — to
   `capture-meta.json`. Failures are recorded, never silently skipped.

Restrict the run with `ROUTES='/,/page-2'`; tune with `CONTROL_WAIT_MS`,
`RENDER_WAIT_MS`, `WIN_W`/`WIN_H`.

## Extension

```bash
npm run extension:build
# Chrome → chrome://extensions → Developer mode → Load unpacked → ./extension
```

Open `/site/`, `/make/` or `/design/` and click **Export ZIP**:

- `site/` — Preview WYSIWYG capture (HTML + inlined computed styles + assets)
- `published/` — offline mirror of `*.figma.site`, when the site is published
- `code/` — `CODE_FILE` TSX from the wire (editable source truth)
- `scenegraph.full.json.gz`, `vectors.json`, `animations/`, `assets/`

v0.4.0 adds the preview-bundle channel: `content/preview-bundle-hook.js` records
the editor↔preview traffic from `document_start`, and
`CAPTURE_PREVIEW_BUNDLE` returns it packed into the published folder layout.

## CLI

```bash
npm run kiwi -- sync <fileKey>      # multiplayer full sync → decoded scenegraph
npm run kiwi -- pack                # wire frames → lossless package
npm run kiwi -- preview <fileKey>   # every route's bundle + unpublished assets
npm run kiwi -- replay              # capture → standalone multi-route replay
npm run kiwi -- source              # capture + wire → editable source package
```

## Source for secondary development

The replay is exact but it is data plus runtime, not code you can refactor.
`kiwi source` packs what is genuinely editable:

| Folder | Contents |
|---|---|
| `code/` | `CODE_FILE.sourceCode` off the wire — unminified TSX/TS. `manifest.json` maps each runtime virtual path to its file and lists every `CODE_INSTANCE`'s `codeExportName`. |
| `components/` | `compiledCode` (esbuild bundle) and `globalStyles` (Tailwind) as the runtime receives them. |
| `interactions/` | Every node carrying `interactions`, flattened: event, action, target, easing, duration. |
| `design/` | Per-route node inventory with text, geometry and type styles. |

Files importing `figma:react` only run inside Figma's runtime; ones importing
plain `react` are portable as-is. Interactions need no reimplementation in the
replay — it runs the same `SitesRuntime`, so hover, click and smart-animate
behave as designed.

## Tests

```bash
npm run test:kiwi          # wire/decoder units, offline fixtures
npm run test:e2e:replay -- <fileKey> [publishedUrl]   # capture → replay → pixel gate
npm run test:e2e:preview   # older DOM-clone restore path (plateaus ~16% diff)
```

`test:e2e:replay` needs ffmpeg for the pixel comparison; `test:kiwi` is hermetic.

## Reverse notes

[`docs/make-reverse-notes.md`](docs/make-reverse-notes.md) covers Make vs Sites
formats, the framing/compression breakdown (there is **no AES** — payloads are
zstd + Kiwi), the preview MessagePort protocol, and the preview Service Worker's
asset-URL map.

## Scope

Extension-first. The old DOM-only CLI harvest paths were removed in favour of
the wire and preview-bundle channels, which carry data rather than rendered markup.
