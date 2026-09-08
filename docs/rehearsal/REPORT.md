# Rehearsal: restoring a Figma Site from the preview bundle

Run date: 2026-09-08 · sample file `<FILE_KEY>` (Figma Sites, `editorType: "sites"`)

## What was proven

Published Figma Sites and the editor Preview run the **same renderer**
(`SitesRuntime`). Only the data source differs. Capture the preview's data and
feed it back into that renderer and the page reproduces exactly — no DOM
cloning, no computed-style guessing.

| Run | Reference | Pixel difference |
|---|---|---|
| **Control** — published bundle replayed locally | live `<slug>.figma.site` | **0.0000 %** |
| **Target** — preview bundle replayed locally | live published site | 0.053 % |

The control measuring exactly zero is the important number: it shows the replay
path itself introduces no error. The 0.053 % on the preview run is not loss — it
is **183 text nodes that exist in the editor but have not been published yet**
(`"Decides - What each movement was…"`, `"Reconciled and posted, before you close"`,
and so on). Restoring content the public site does not have is the point.

Screenshots were taken at 1440×900 with `deviceScaleFactor: 1`, so one image
pixel is one CSS pixel and the diff needs no rescaling. The images are not
committed — they render a customer site — but the run is reproducible with the
commands below, and `test:e2e:replay` re-derives the same numbers.

What the control run shows: the replayed page and the live page are
indistinguishable, down to font rasterisation and video poster frames. The
difference map is uniformly black.

What the preview run shows: identical layout and chrome, with differences
confined to copy blocks that carry unpublished edits. The difference map is
black except for text runs in the lower two thirds of the page.

## How it works

```
editor (figma.com/site/<KEY>)                 preview iframe (OOPIF)
  │                                             *-v2-figmaiframepreview.figma.site
  │  MessageChannel: port2 transferred ──────▶  window.messagePort
  │
  │  ◀── { method:'getPage', args:{url:'/'} }
  ├─────▶ { method:'getPage', return:{ website, cmsBundle } }   ← the scene bundle
  │
  ├─────▶ { method:'pushAssetData', args:{ files:{ '<sha1>.svg': Blob } } } × N
  │                                             └─▶ Service Worker maps
  │                                                 virtual path → URL
  ▼
new SitesRuntime({ env:'preview', getPage, getAssetURL, sendMessage, … })
```

The published site does the same thing with a different `getPage`:

```js
// sites-runtime.js, published mode
defaultGetPage = async (route) =>
  (await fetch(`/_json/${this.bundleId}${route === '/' ? '/_index' : route}.json`)).json()
```

So a captured `website` object can be written to `_json/<id>/_index.json` and
booted with `env:'published'`. That is the whole restore.

## What the preview bundle has that the published one does not

| Key | Published | Preview |
|---|---|---|
| `nodeById` | 1990 nodes | **2013 nodes** |
| `guidToUrl` | 8 routes | **11 routes** (3 unpublished pages) |
| `compiledCode` | — | 2.94 MB esbuild output |
| `globalStyles` | — | 15.8 KB Tailwind v4.1.3 |
| `codeFilesystemMetadata` | — | 40 code-file entries |
| Assets | public CDN | 176 Blobs pushed over the port |

## Reproducing

```bash
# Chrome with the file open and Figma logged in
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/figma-profile

npm run kiwi:preview -- <FILE_KEY>          # capture bundle + asset Blobs
npm run kiwi:replay                         # build rehearsal/replay/
python3 -m http.server -d rehearsal/replay 8900

# end-to-end with pixel gate
npm run test:e2e:replay -- <FILE_KEY> https://<slug>.figma.site/
```

## Gotchas worth keeping

1. **Hook the editor, not the iframe.** The preview is an out-of-process iframe;
   `Page.reload` on its own CDP session fails with *"Command can only be executed
   on top-level targets"*, so a hook cannot reliably be installed before its first
   paint. The editor tab reloads fine and sends both message types.
2. **`pushAssetData` values are `Blob`s.** `JSON.stringify` renders them as `{}`
   and `instanceof ArrayBuffer` is false. Keep the reference, then
   `await blob.arrayBuffer()` outside the synchronous postMessage patch.
3. **Unpublished videos are signed S3 URLs**, `X-Amz-Expires=604800`. Reduce to
   the basename for the runtime and fetch the bytes within 7 days.
4. **`wasServerRendered: false`** for replay — there is no pre-rendered DOM.
5. **Cloudflare 403s default tool user agents** on `*.figma.site`. Send a browser
   UA; `curl` works out of the box, `urllib` does not.
6. **One `getPage` per route.** Capturing every page means visiting every route
   in the preview while the hook is armed.
