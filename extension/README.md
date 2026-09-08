# Figma Sites / Make Exporter (extension)

**v0.4.0** — 全量在扩展内完成，新增**未发布站点**的预览 bundle 通道。

ZIP 交付：

- `preview-bundle/` — **新增**：预览通道抓到的场景 bundle + 未发布资源，按已发布站点
  的目录结构摆好（`_json/` / `_components/` / `_assets/`），静态起服务即可用真实
  runtime 渲染
- `site/` — Preview 所见即所得（`index.html` + `styles.css` + `assets/`）
- `published/` — 发布站 `*.figma.site` 离线镜像
- `code/` — wire `CODE_FILE`（TSX，可编辑源码真值）
- `scenegraph.full.json.gz` / `vectors.json` / `animations/` / `assets/`

## 预览通道怎么工作

`content/preview-bundle-hook.js` 在 `document_start` 的 MAIN world 里给
`MessagePort.prototype.postMessage` 打补丁，编辑器发给预览 iframe 的两类消息全部记下：

| 消息 | 内容 |
|---|---|
| `getPage` 回包 | `{ website, cmsBundle }` —— 与已发布 `_index.json` 同构的场景 bundle |
| `pushAssetData` | `{ files: { "<sha1>.<ext>": Blob } }` —— 未发布的二进制资源 |

**必须 hook 编辑器而不是 iframe**：预览是 OOPIF，对它自己的 CDP session 调
`Page.reload` 会被拒（"Command can only be executed on top-level targets"），没法保证
钩子早于首帧。编辑器是顶层页，reload 正常，而且两类消息都由它发出。

`pushAssetData` 的值是 `Blob`，`JSON.stringify` 会变成 `{}`，`instanceof ArrayBuffer`
也是 false。只能先留引用，之后在同步补丁之外 `await blob.arrayBuffer()`。

## Install

```bash
npm run extension:build
```

1. Chrome → `chrome://extensions`
2. Developer mode → **Load unpacked** → `./extension`
3. Popup 可填 `FIGMA_TOKEN`（拉 wire 图片）和 Published URL

## Use

1. 同一 Chrome 登录 Figma
2. 打开 `/site/`、`/make/` 或 `/design/` 文件
3. 点 **Full preview**（预览通道需要它渲染一次）
4. 浮层或 popup → **Export ZIP**

只取预览 bundle（不跑整包导出）：

```js
chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_PREVIEW_BUNDLE' })
// → { ok, meta, textFiles, assetsB64 }
```

## Rebuild

```bash
npm run extension:build
# chrome://extensions → Reload
```
