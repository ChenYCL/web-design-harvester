# Make / Sites reverse notes

Research date: 2026-08-31  
Sample Sites fileKey: `<FILE_KEY>`  
Published: https://<slug>.figma.site/  
Scope: read-only OSINT + repo survey + live published-site probe. No destructive ops.

> Bottom line: there is **no AES/WebCrypto on the multiplayer wire or in Kiwi blobs**. What people call “encryption” is almost always **zstd compression**, **Kiwi binary framing**, **time-signed S3 URLs** for REST image fills, or **minified published JS**. Make offline files use magic `fig-makee` (not `fig-kiwi`); published Make/Sites share `*.figma.site` hosting with an `isFigmake` runtime flag.

---

## 1. Repo coverage: Make vs Sites

### What already works (Sites-validated)

| Layer | Location | Status |
|---|---|---|
| Multiplayer WS full sync | `src/kiwi/client.mjs`, extension `lib/page-sync-inject.js` | ✅ Sites (`JOIN_START` → `NODE_CHANGES` → `JOIN_END`) |
| fig-wire schema frame | `src/kiwi/wire.mjs`, `extension/lib/wire.js` | ✅ `"fig-wire"` + u32le + zstd schema |
| Vendored Kiwi decoder | `extension/vendor/decoder.js` | ✅ Generated against captured Sites schema |
| `CODE_FILE` → ZIP `code/` | `extension/lib/pack-code.js` | ✅ Plaintext `sourceCode` strings |
| Geometry blobs → SVG | `extension/lib/svg.js`, `src/kiwi/svg.mjs` | ✅ `commandsBlob` / `vectorNetworkBlob` indexes into `Message.blobs[].bytes` |
| Image fills | `src/kiwi/images.mjs`, pack-code REST `/images` | ✅ Wire 20-byte sha1 hex ↔ signed S3 map (Sites 200) |
| Preview WYSIWYG | `extension/content/preview.js` + `lib/capture-site.js` | ✅ Needs live editor-fed iframe (standalone preview shell empty) |
| URL detection | `extension/content/editor.js` | ✅ Auto-panel on `/site/`, `/make/`, `/design/` |

### Schema already knows Make

From `extension/vendor/decoder.js`:

- `EditorType`: `SITES=4`, `FIGMAKE=7` (also DESIGN, WHITEBOARD, SLIDES, …)
- `NodeType`: `CODE_LIBRARY`, `CODE_FILE`, `CODE_COMPONENT`, `CODE_INSTANCE`, `CODE_LAYER`, `BINARY_FILE`, `RESPONSIVE_SET`, `WEBPAGE`, …
- Make-ish NodeChange fields: `sourceCode`, `isEntrypointCodeFile`, `belongsToCodeLibraryId`, `usedMakeLibraries`, `isMakeKit`, `makeLibraryComponentId`, `makeContentState` (`EMPTY|POPULATED|SEEDED`), `sourceCodeLibraryKey(s)`, `codePreviewSettings`

### Gaps / not covered for Make

1. **No live Make file validated** in this repo — fixtures & e2e target Sites `<FILE_KEY>`.
2. **No `fig-makee` / `.make` ZIP offline parser** (community has one; see §4).
3. Extension decoder is **vendored & static** — comments say “future: regenerate from sync schema”; Make schema drift could break decode without rebuild.
4. `pack-code.js` treats any file with `CODE_FILE` the same; does **not** specially assemble Make’s `App.tsx` + `package.json` + `figma:asset` graph into a runnable Vite app.
5. ~~Published-site structured mirror~~ — **added in extension v0.3.2** (`extension/lib/pack-published.js` → ZIP `published/`). Popup accepts Published URL. Still need auto-discovery of publish URL from editor.
6. Preview iframe for Make may differ (code preview device vs Sites Full preview) — untested.

---

## 2. How Make differs from Sites

### Product shape

| | **Figma Sites** | **Figma Make** |
|---|---|---|
| Editor URL | `figma.com/site/<KEY>/…` | `figma.com/make/<KEY>/…` |
| Mental model | Canvas site + code layers/components | Prompt-to-app; multi-file React project |
| Code units | `CODE_LAYER` / `CODE_COMPONENT` instances on pages | Full app: `App.tsx`, many `CODE_FILE`s under `CODE_LIBRARY` |
| Official export | No whole-site ZIP | “Download code” in code UI (UI path; REST still rejects file type) |
| REST `/v1/files/:key` | 400 unsupported | 400 unsupported |
| Published host | `*.figma.site` (Cloudflare → AWS) | Same domain family |

### Offline file format

| Kind | Magic / container | Notes |
|---|---|---|
| Design `.fig` | ZIP → `canvas.fig` with `fig-kiwi` (8B) + version + length-prefixed chunks | Chunk0 schema usually deflate; chunk1+ message often zstd |
| Make `.make` | ZIP → `canvas.fig` with **`fig-makee` (9B) + 3B pad** | Then uint32 chunk sizes; schema **deflate**, data **zstd**; plus `meta.json`, `ai_chat.json`, `images/`, `blob_store/` |
| Sites local copy | Not deeply probed here; editor wire is the practical path | Same multiplayer stack as Design/Make |

Evidence: [albertsikkema/figma-make-extractor](https://github.com/albertsikkema/figma-make-extractor) + OpenFig research (`fig-makee` listed alongside `fig-kiwi`).

### Editor wire (shared)

Both open:

```text
wss://www.figma.com/api/multiplayer/<FILE_KEY>?…
```

Frame0: ASCII `fig-wire` + u32le version + **zstd-compressed Kiwi schema**.  
Later: zstd → Kiwi `Message` (`NODE_CHANGES`, `JOIN_*`, `SIGNAL`, …).  
`JOIN_END` is the rare **uncompressed** 12-byte Kiwi frame.

`CODE_FILE.sourceCode` is a normal Kiwi string field (field id 414 in vendored schema) — **not sealed**.

### Published delivery (Sites probe of sample)

HTML boot (excerpt from live sample):

```js
import {SitesRuntime} from '/_runtimes/sites-runtime.<hash>.js';
new SitesRuntime({
  container: document.getElementById('container'),
  env: 'published',
  bundleId: '024cbc56-ffae-4665-a2b2-dbf7d4d0b338',
  loadComponentsOverNetwork: true,
  assetsVersion: 'v11',
  fontsVersion: 'v1',
  videosVersion: 'v1',
  codeComponentsVersion: 'v2',
  isFigmake: false,          // ← Make published builds set true
  enableMetaTags: true,
  // …
});
```

Public paths observed:

| Path | Role |
|---|---|
| `/_runtimes/sites-runtime.<hash>.js` | Shared runtime (~1.1MB); branches on `isFigmake` |
| `/_components/v2/<sourceCodeHash>.js` (+ `.css`) | Bundled code-component JS (minified React) |
| `/_json/<bundleId>/_index.json` | Published scenegraph-ish JSON (~2.5MB): `roots`, `nodeById`, `guidToUrl`, `assets`, `fonts`, `siteSettings`, `sourceCodeHash` |
| `/_json/<bundleId>/_cms….json` | CMS companion (runtime references; Make may skip some fetches) |
| `/_assets/v11/<sha>.{png,svg,…}` | Public assets; Cloudflare cache `max-age=2592000`; optional `?w=` resize |
| `/_woff/v2/…` | Fonts |

Runtime string evidence: when `isFigmake` is true, at least one JSON prefetch becomes `Promise.resolve(null)` instead of `fetch(/_json/…)`. Make published apps are therefore **not identical** to Sites scenegraph hydration — expect a thicker component/app bundle and thinner or alternate JSON.

Published `_index.json` does **not** contain raw `CODE_FILE` source. It has layout nodes + `CODE_INSTANCE` stubs with `codeExportName` (e.g. `Code169_16032.default`) linking into the `/_components` bundle. Source truth remains editor wire (or `.make` / Download code).

---

## 3. “Encryption” claim — dissected

| Layer | What it is | Crypto? |
|---|---|---|
| **(a) Transport / file compression** | zstd (`28 B5 2F FD`) on wire frames & Make data chunk; deflate/zlib on schema chunks | **No** — compression only |
| **(b) Binary schema framing** | Kiwi self-describing schema + `Message` / `NodeChange` | **No** — serialization (evanw/kiwi) |
| **(c) Actual crypto / gating** | REST `/v1/files/{key}/images` returns **time-limited signed S3 URLs**; needs `FIGMA_TOKEN` to *mint* the map. Cookie auth gates multiplayer WS. | **Signing / auth**, not payload ciphertext. Once you have the URL, bytes download in clear. |
| **(d) Published JS** | esbuild/minify style bundles under `/_runtimes` and `/_components` | **Obfuscation-by-bundler**, reversible enough for behavior; not encryption |

### Blobs are not encrypted

Vendored decoder:

```js
exports["decodeBlob"] = function (bb) {
  var result = {};
  result["bytes"] = bb.readByteArray();
  return result;
};
```

`pack-code.js` / `svg.js` treat `blobs[i].bytes` as raw geometry (commandsBlob path opcodes, etc.). No AES unwrap, no WebCrypto, no sealed blob envelope in-schema.

Image fills: wire stores **raw 20-byte SHA-1**; hex form is the REST map key. That is content-addressing + CDN auth, not encrypted blobs.

---

## 4. Public prior art (OSINT)

| Project | Relevance |
|---|---|
| [albertsikkema/figma-make-extractor](https://github.com/albertsikkema/figma-make-extractor) | **Best Make offline path**: unzip `.make` → decode `fig-makee` → extract `CODE_FILE` → rebuild Vite app; documents `CODE_LIBRARY` tree |
| [allan-simon/figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol) | fig-wire + WS read/write; Kaitai specs for commandsBlob / vectorNetworkBlob |
| [OpenFig-org/openfig-core](https://github.com/OpenFig-org/openfig-core) | Isomorphic `.fig` parser; docs list `fig-makee` as Make signature |
| [evanw/kiwi](https://github.com/evanw/kiwi) | Canonical schema codec (this repo’s decoder path) |
| sketch-hq `fig-kiwi` / yagudaev `figma-to-json` / Photopea writeups | Classic `.fig` ZIP + kiwi |
| DEV: “How Figma stores your design files” | Chunk compression sniffing (deflate vs zstd) |
| Community wget mirrors of `*.figma.site` | Published Sites are statically mirrorable (`/_assets`, HTML, CSS) |

Official docs confirm: Make & Sites both publish to `three-words.figma.site`; hosting AWS + Cloudflare; REST file endpoints exclude Make/Sites/Slides/Buzz.

---

## 5. Evidence log (this session)

### Wire / extension

- Fixtures & TESTPLAN: all frames zstd except 12B `JOIN_END`; Sites full sync ~34k nodes / thousands of blobs.
- `pack-code.js` requires `JOIN_END` + ≥1 `CODE_FILE` or throws.
- Decoder `Blob` = `{ bytes }` only.

### Published Sites sample `<slug>.figma.site`

- `cf-cache-status: HIT`, header `x-site-id: 337576e4-…`
- HTML comment: `<!-- Created in Figma Sites -->`
- `_index.json` top keys: `roots`, `nodeById`, `assetIdToGuid`, `guidToUrl`, `fonts`, `assets`, `stablePathToAssetInfo`, `animateRootIds`, `siteSettings`, `sourceCodeHash`
- Node type counts (sample): FRAME 552, TEXT 448, KEYFRAME 264, SVG 173, INSTANCE 104, CODE_INSTANCE 4, WEBPAGE 1, …
- `sourceCodeHash` == component bundle id `8eb7be9f03b1f626e38341b6e14d3aec0232130a`
- Asset PNG served as public `image/png` with long cache; CSP on asset responses is restrictive for embedding tricks but download works with plain GET
- Runtime contains `isFigmake` branches and asset URL builder `` `/_assets/${version}/${hash}` ``

### Make published

- Not live-probed (no Make publish URL in hand). Highest-priority next experiment: open any published Make URL, dump `SitesRuntime({… isFigmake: true …})` and compare network waterfall to Sites.

---

## 6. Acquisition model (complete site)

Think in **four channels**, merge by priority:

```text
A. Editor wire (auth cookie)
   → full scenegraph + CODE_FILE source + blobs + anims
   → REST /images (token) for fill hashes

B. Editor preview iframe (postMessage-fed)
   → WYSIWYG HTML/CSS/computed assets (extension site/)

C. Published *.figma.site (often public)
   → HTML + sites-runtime + /_json + /_components + /_assets + /_woff
   → best for “what users see online”; poor for editable source

D. Offline .make / Download code (Make only)
   → fig-makee canvas + images/ + package.json graph
   → best for runnable React app without live session
```

**Truth hierarchy (repo skill already states):**  
`code/` (CODE_FILE) > offline kiwi-package > preview DOM > published bundles.

For **Make-made** apps specifically: D or A beat C for source; C still needed for production asset CDN URLs and runtime wiring when you only have a public link.

---

## 7. Prioritized attack plan (Chrome extension)

### P0 — Confirm Make wire parity (1 session)

1. Open `https://www.figma.com/make/<MAKE_KEY>/…` with extension loaded.
2. Capture multiplayer URL + full sync frames (existing path).
3. Assert: `JOIN_END`, `EditorType`/`pageType` if present, counts of `CODE_FILE` / `CODE_LIBRARY` / `BINARY_FILE`.
4. Diff node-type histogram vs Sites sample; dump `package.json` / `App.tsx` / `isEntrypointCodeFile` nodes into ZIP.
5. If decode throws: regenerate decoder from that session’s fig-wire schema (close the “static vendor” gap).

### P1 — Published Make vs Sites waterfall

1. Find a published Make URL (`isFigmake: true` in HTML).
2. Record: runtime args, which `/_json` calls are skipped, whether `/_components` is a full app chunk, asset version prefixes.
3. Add extension mode **“Mirror published”**: enumerate boot URLs + rewrite to local (complement preview capture).

### P2 — Structured published Sites harvest (sample already public)

1. Parse HTML → `bundleId`, `sourceCodeHash`, version pins (`v11`/`v2`).
2. Fetch `/_json/<bundleId>/_index.json` (+ page routes from `guidToUrl`).
3. Fetch `/_components/v2/<sourceCodeHash>.{js,css}` and every `/_assets/…` referenced.
4. Emit `published/` folder alongside `code/` + `site/` in ZIP.
5. Optional: map `codeExportName` → component exports for cross-walk with wire `CODE_FILE` names.

### P3 — Make offline `.make` ingest (optional CLI/extension drop)

1. Vendor or reimplement albertsikkema pipeline: ZIP → `fig-makee` → kiwi → `CODE_FILE`.
2. Resolve `figma:asset` / `images/` / `blob_store/` into static URLs.
3. Prefer this when user has local Save / Download code and no need for live preview DOM.

### P4 — Hardening

1. Dynamic schema compile in SW/offscreen from live fig-wire (stop relying on stale `vendor/decoder.js`).
2. Detect Make vs Sites (`location.pathname`, `EditorType`, `isMakeKit`, published `isFigmake`) and switch pack profiles:
   - Sites: scenegraph + code layers + responsive sets
   - Make: app file tree + package.json + entrypoint flags
3. Preserve `BINARY_FILE` / blob bytes in package (not only geometry indexes).
4. Document pitfall: preview `*-figmaiframepreview.figma.site` without editor bridge = shell (`messagePort` / `allowedOrigins`).

### P5 — Do not waste cycles on

- Searching for AES keys on wire blobs (none in schema).
- REST node document endpoints for Make/Sites (known 400).
- Treating published `/_components` JS as source-of-truth for editing (use wire/`CODE_FILE`).

---

## 8. Concrete extension tickets (suggested order)

1. **`detectEditorKind()`** → `sites | make | design` from URL + first decoded message metadata.  
2. **Make pack profile**: keep all `CODE_FILE` names; prefer larger collaborative versions (already in pack-code); write `code/manifest.json` listing entrypoints (`isEntrypointCodeFile`).  
3. **`publishedMirror`**: content-script on `*.figma.site` (non-iframepreview) to snapshot runtime config + asset list into export.  
4. **Schema refresh script**: `npm run extension:regen-decoder -- <schema_frame.bin>`.  
5. **E2E**: one Make fileKey fixture + assert `App.tsx` or entrypoint present (parallel to Sites rehearsal).

---

## 9. Quick reference — magic & endpoints

```text
Wire magic:     "fig-wire" (8) + u32le ver + zstd(schema)
Design file:    "fig-kiwi" (8) + …
Make file:      "fig-makee" (9) + 3 zero pad + …
Zstd magic:     28 B5 2F FD
WS:             wss://www.figma.com/api/multiplayer/<FILE_KEY>
Images map:     GET https://api.figma.com/v1/files/<KEY>/images  (X-FIGMA-TOKEN)
Published:      https://<slug>.figma.site/
  runtime       /_runtimes/sites-runtime.<hash>.js
  components    /_components/v2/<sourceCodeHash>.js
  scene json    /_json/<bundleId>/_index.json
  assets        /_assets/<ver>/<hash>
```

---

## 10. Open questions

1. Exact published Make HTML boot when `isFigmake: true` — which JSON endpoints remain?
2. Does Make multiplayer send the same schema definition set as Sites, or extra Make-only types requiring decoder regen?
3. Are Make kit / private npm registry packages present only as lockfile refs, or inlined in `CODE_FILE` / blobs?
4. Preview OOPIF host differences for Make code preview vs Sites Full preview.
5. Whether `BINARY_FILE` nodes carry wasm/fonts/raw assets beyond `images/` hashes.

---

*Generated for figma-sites-harvester. Update this file when P0 Make wire capture lands.*

---

# Addendum — the preview data channel (2026-09-08)

Closes open question §10.4 and supersedes the "preview iframe = shell" note in
§7 P4.4: the shell is not a dead end, it is one half of a documented protocol.

## Same renderer, two data sources

`SitesRuntime` is shared between published sites and the editor preview. The
only difference is how it obtains a page:

```js
// published (inlined in the site HTML)
new SitesRuntime({ env: 'published', bundleId, wasServerRendered: true, … })
//   internally: fetch(`/_json/${bundleId}${route === '/' ? '/_index' : route}.json`)

// preview (webpack-artifacts/assets/preview_iframe-<hash>.min.js)
new SitesRuntime({
  env: 'preview',
  getPage: async (url) => {
    const n = await this.dependencies.sendMessage('getPage', { url });
    this.pageBundle = n.website;
    return { resource: n.website, cmsResource: n.cmsBundle };
  },
  getAssetURL, getFontURL, history, onPageRendered, sendMessage, renderOptions, …
})
```

`website` is shape-compatible with a published `_index.json`, so a captured
preview bundle can be replayed through the published path verbatim.

## Message inventory (editor → preview, one page load)

| method | count | payload |
|---|---|---|
| `pushAssetData` | 176 | `{ files: { "<sha1>.<ext>": Blob } }` — real `Blob`s with MIME |
| `heartbeat` | 6–17 | keepalive |
| `perfEvent` | 3 | timing marks |
| `status` | 2–3 | `init-received` / `ready` |
| `resize`, `setLocation` | 2 each | viewport + route |
| `getPage` | **1 per route** | reply carries the scene bundle |
| `setOptions`, `serviceWorkerStatus`, `pageRendered` | 1 each | |

## The preview Service Worker

`/preview_service_worker.js` on the preview origin (note the `.js`; without it
the host serves the shell HTML for every path). It does **not** carry scene
data — only binary assets:

```js
self.addEventListener('fetch', (event) => {
  if (!shouldInterceptRequest(request, self.location.origin)) return;
  const s3Url = assetUrlMap.get(pathname);
  if (s3Url) { event.respondWith(fetch(s3Url)); return; }          // proxy to S3
  if (shouldWaitForAssetMap(pathname, clientId)) {
    void requestAssetUrlMapRehydration(self.clients, clientId, pathname);
    event.respondWith(waitForAsset(pathname, request, clientId));   // 30s timeout → 408
  }
});
```

`assetUrlMap` is filled by an `update-asset-url-map` message from the page.
Pending requests resolve when the matching path arrives.

## Preview bundle vs published bundle (sample file)

| | published | preview |
|---|---|---|
| nodes | 1990 | 2013 |
| TEXT | 448 | 470 |
| routes | 8 | 11 |
| `compiledCode` | absent | 2.94 MB |
| `globalStyles` | absent | 15.8 KB (Tailwind v4.1.3) |
| `codeFilesystemMetadata` | absent | 40 entries |
| `sourceCodeHash` | `8eb7be9f…` | `a60397c2…` |

Published `_components/v2/<hash>.js` is a *further minified* build of the same
code (638 KB vs 2.94 MB), so the preview copy is closer to source.

## Verified fidelity

Replaying a captured bundle through the real runtime, screenshotted at 1440×900
with `deviceScaleFactor: 1`:

- published bundle replayed vs live site — **0.0000 %** pixel difference
- preview bundle replayed vs live site — 0.053 %, entirely accounted for by 183
  unpublished text nodes

See `docs/rehearsal/REPORT.md` for images and the reproduction commands.

## Implementation

| Piece | Location |
|---|---|
| Capture (CDP) | `src/kiwi/preview-capture.mjs`, `kiwi preview <fileKey>` |
| Replay builder | `src/kiwi/replay-build.mjs`, `kiwi replay` |
| Extension hook | `extension/content/preview-bundle-hook.js` (MAIN, document_start) |
| Extension packer | `extension/lib/pack-preview-bundle.js` |
| E2E + pixel gate | `test/e2e/preview-replay.mjs`, `npm run test:e2e:replay` |

## Practical notes

- Hook `MessagePort.prototype.postMessage` on the **editor** tab. The preview is
  an OOPIF: `Page.addScriptToEvaluateOnNewDocument` succeeds on its session but
  `Page.reload` returns *"Command can only be executed on top-level targets"*, so
  the hook cannot be guaranteed to precede its first paint.
- `pushAssetData` values are `Blob`s. They serialise as `{}` and fail
  `instanceof ArrayBuffer`; keep references and `await blob.arrayBuffer()` later.
- Unpublished `VIDEO_ASSET.url` is an absolute **signed** S3 URL
  (`X-Amz-Expires=604800`). Reduce to basename for the runtime, fetch within 7 days.
- `*.figma.site` sits behind Cloudflare and 403s default tool user agents.
  Send a browser UA.
- Published sites also expose `/_videos/v1/<sha1>` (no extension) — video assets
  are *not* under `/_assets/<ver>/`.
