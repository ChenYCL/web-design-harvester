# Figma Sites / Make Exporter (extension)

**v0.5.0** — 预览通道升级为**确定性多路由抓取**，未发布站点整站可还原。

ZIP 交付：

- `preview-bundle/` — **全部路由**的场景 bundle + 未发布资源 + 视频，按已发布站点
  目录结构摆好；自带 `server.mjs`（SPA fallback + 首次启动自动补齐 runtime/字体）
- `site/` — Preview 所见即所得（`index.html` + `styles.css` + `assets/`）
- `published/` — 发布站 `*.figma.site` 离线镜像
- `code/` — wire `CODE_FILE`（TSX，可编辑源码真值）
- `scenegraph.full.json.gz` / `vectors.json` / `animations/` / `assets/`

## 预览通道：通用方法（不依赖预知站点结构）

popup 里点 **Capture preview → ZIP (all routes)**，`content/preview-bundle-bridge.js`
执行下面的确定性流程：

1. **枚举**：先保证当前页 bundle 存在（没有就打开 Full preview）。它的 `guidToUrl`
   列出**全部路由**，含未发布页。
2. **持久化**：计划写 `sessionStorage`，抓到的数据写 IndexedDB——两者都扛得住接下来的页面导航。
3. **逐路由访问**：`location.href = ?node-id=<guid>`。这是整页加载，
   `document_start` 的钩子会自动重新武装，bridge 再次运行、读到计划、继续。
4. **等待并校验**：轮询预览控件出现（宽工具栏有 `data-testid`；窄窗口只剩
   `aria-label`/`title` 里含 "full preview"——注意单独的 `aria-label="Present"` 是
   多人协作聚光灯，**不是**站点预览），点击，然后等 `PREVIEW_BUNDLE_CAPTURED` 事件且
   `rootGuid` 等于我们要的那个。bundle 用自身 `guidToUrl[roots[0]]` 自标签——回包不带
   请求参数，标签只能从数据来。
5. **每轮抽干** Blob 进 IndexedDB 再导航——重载会清空 MAIN world 的存储。
6. **收尾**：拉视频（签名 URL 在 `www.figma.com` 同源，content script 能取）、打包、
   ZIP、下载。每条路由成败写进 `preview-meta.json.walk`，失败带原因，不静默跳过。

`chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_ALL_ROUTES', routes: ['/page-2'] })`
可以只抓指定路由；不传 `routes` 就是整站。

### 为什么 ZIP 里没有 runtime

`*.figma.site` 不返回 CORS 头，figma.com 上的 content script 拉不到它。而且
**runtime 与 bundle 版本绑定**——用别站的 runtime 会在 hydration 阶段崩在
`Object.entries(undefined)`。所以 `server.mjs` 首次启动时从站点**自己的**发布域名拉
runtime、字体和缺失视频（Node 无 CORS 限制）：

```bash
cd preview-bundle
node server.mjs                                   # popup 里填过 Published URL 时
PUBLISHED_URL=https://<slug>.figma.site node server.mjs   # 没填时手动带上
# → http://127.0.0.1:8900/          根路由
# → http://127.0.0.1:8900/page-2    任意路由，含未发布页
```

**为什么不能直接双击 `index.html`**：

1. runtime 不在 ZIP 里（上面的 CORS + 版本绑定），首次启动由 `server.mjs` 补齐
2. `import { SitesRuntime }` 是 ES module，`file://` 协议加载不了
3. `/page-2` 这类客户端路由需要 SPA fallback，普通静态服务器会 404

首次启动会把 runtime、字体、缺失视频拉到本地，之后离线可用。popup 里填过
Published URL 的话它已写进 `preview-meta.json`，`node server.mjs` 不用带参数。

若主导出时填了 Published URL，`published/_runtimes/` 里已有配套 runtime，复制过来也行。

### 实现拆分

| 文件 | world | 职责 |
|---|---|---|
| `content/preview-bundle-hook.js` | MAIN, document_start | patch `MessagePort.prototype.postMessage`；bundle 按 `roots[0]` 存、自标签；留 Blob 引用 |
| `lib/drain-preview.js` | MAIN（按需注入） | 把 bundle/Blob 分块 postMessage 回隔离世界 |
| `content/preview-bundle-bridge.js` | isolated, document_idle | 路由遍历、IndexedDB/sessionStorage 持久化、跨导航恢复、打包下载 |
| `lib/pack-preview-bundle.js` | ESM | 多路由 → 已发布目录布局；每个 `sourceCodeHash` 一对组件文件；内嵌 `server.mjs` |
| `lib/zip-store.js` | ESM | STORE 模式 ZIP 写入 + `<a download>`（content script 没有 `chrome.downloads`） |

坑：控件匹配必须排除本扩展自己的浮层（`#fse-root` 上也有一个「打开 Full preview」按钮，点它等于空操作）；中文 UI 的原生按钮可能只有可见文本「打开 Full preview」、没有 testid / aria-label。`pushAssetData` 的值是 `Blob`（`JSON.stringify` 变 `{}`），必须留引用异步读；
hook 要打在编辑器顶层页（预览 iframe 是 OOPIF，`Page.reload` 被拒）。

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
3. popup → **Capture preview → ZIP (all routes)**（预览通道，自动遍历路由）
4. 或浮层/popup → **Export ZIP**（wire + site/ + published/ 全量包）

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
