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

npm run kiwi:preview -- <FILE_KEY>     # capture bundle + asset Blobs
npm run kiwi:replay                    # build rehearsal/replay/
python3 -m http.server -d rehearsal/replay 8900
```

`kiwi preview` reloads the editor tab with a hook armed, clicks **Full preview**,
and records the `getPage` reply plus every `pushAssetData` Blob.

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
npm run kiwi -- preview <fileKey>   # preview bundle + unpublished assets
npm run kiwi -- replay              # capture → standalone replay site
```

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
