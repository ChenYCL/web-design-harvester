# E2E: Preview iframe → restore → visual diff

## Command

```bash
# Chrome must be running with Sites + Full preview:
#   --remote-debugging-port=9222
npm run test:e2e:preview
MAX_DIFF_PCT=20 npm run test:e2e:preview
```

## Pipeline

1. CDP attach to live Preview OOPIF
2. Screenshot iframe → `rehearsal/e2e/ref-iframe.png`
3. Capture DOM+styles+assets → `rehearsal/e2e/site/`
4. Serve site/, screenshot → `rehearsal/e2e/restored-site.png`
5. pixelmatch → `rehearsal/e2e/diff.png` + `report.json`

## Current fidelity notes

Figma Sites Preview CSSOM is largely opaque; naive clone loses layout.
Computed-style inlining improves structure but is not yet pixel-identical.
Treat visual `%` as a regression signal; also assert:

- capture produces non-trivial HTML (>50KB)
- assets downloaded > 0
- restored page contains key marketing copy (set `E2E_BRAND` to a distinctive string from the site)

## Pass criteria (iterating)

| Gate | Target |
|---|---|
| Structural | htmlBytes > 50_000, assets.ok >= 5, text includes brand |
| Visual | diffPct <= MAX_DIFF_PCT (default 8; use 20 while tightening capture) |

## Latest run (2026-08-31)

- structuralOk: true (html ~1.2MB, brand text present, 19/20 assets)
- diffPct: **16.51%** (threshold 20 → PASS)
- artifacts: `rehearsal/e2e/{ref-iframe,restored-site,diff}.png`, `report.json`

```bash
MAX_DIFF_PCT=20 npm run test:e2e:preview
```

---

## E2E 路径二：preview-replay.mjs（bundle 回放，v0.4.0）

`preview-restore.mjs` 克隆 DOM + 内联 computed style，天花板约 16% 像素差
（Sites CSSOM 大部分不可读）。`preview-replay.mjs` 走 bundle 通道：抓
`getPage` 回包喂给真实 `sites-runtime`，构造上就是同一渲染器 + 同一数据。

```bash
npm run test:e2e:replay -- <FILE_KEY> [publishedUrl]
```

已发布 bundle 回放对照线上实测 **0.0000%** 像素差；预览 bundle 回放差
0.053%（全部来自未发布的编辑）。像素比较用 ffmpeg，无需 pixelmatch。
见 `docs/rehearsal/REPORT.md`。
