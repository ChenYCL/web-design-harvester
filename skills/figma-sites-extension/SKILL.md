---
name: figma-sites-extension
description: Load and use the Figma Sites Exporter Chrome MV3 extension to download CODE_FILE source ZIPs from a Sites/Make editor Preview. Use when the user wants one-click export, 框选, or to avoid CDP debug Chrome for Figma Sites source harvest.
---

# Figma Sites Exporter extension

## When to use

- User wants **one-click CODE_FILE ZIP** from Figma Sites / Make
- Product UX: Load unpacked → open file → click **Export ZIP**（不需要 CLI）

## Build & load

```bash
npm run extension:build
# Chrome → chrome://extensions → Developer mode → Load unpacked → ./extension
```

## Runtime flow（一键）

1. `hook-early.js`（MAIN world / document_start）+ `webRequest` 捕获 multiplayer URL
2. 用户点浮层或 toolbar popup 的 **Export ZIP**
3. 若尚未捕获 URL → 自动 reload 一次再继续
4. page-world wire sync → SW decode → `chrome.downloads` 下 ZIP
5. 可选框选 → `selection.json`

## Truth hierarchy

1. `site/` — Preview iframe WYSIWYG static capture (primary UX deliverable)
2. `code/` (CODE_FILE) — wire source truth for React/Make components
3. scenegraph / vectors / animations — layout + motion when CODE_FILE alone is incomplete

## Offline verify

```bash
# requires captured multiplayer frames (kiwi sync / extension hook)
npm run extension:test-pack
```

## Related

- Wire CLI: `skills/figma-kiwi/SKILL.md`
- Reverse notes: `docs/make-reverse-notes.md`
