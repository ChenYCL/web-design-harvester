# figma-kiwi — Figma Sites 逆向双管线

> 通过逆向 Figma 二进制 wire 协议 + 渲染 DOM 采集，产出 LLM 可直接消费的
> 完整设计产物包。不依赖 REST 节点端点（Sites 文件 400），不受 Dev Mode 付费限制。

## 何时用

- 给 Figma Sites / Make / 普通设计文件的链接，要"还原/复刻/提取设计"
- 需要全部节点 guid、断点、动效 keyframe、变量 token、CODE_FILE 源码、站点 meta
- 需要像素级 CSS 真值（computed style）

## 双管线架构（为什么是两条）

| | A: Kiwi wire 协议 | B: 渲染 DOM |
|---|---|---|
| 产出 | 全部节点+全字段（无损）、动效、token、代码、站点 meta | 像素级 computed CSS、任意断点截图 |
| 原理 | 编辑器 WS 全量 sync，zstd(Kiwi) 帧解码，schema 随帧下发 | 预览 iframe 注入采集 agent，getComputedStyle |
| 局限 | 渲染映射需自建（遮罩/布尔/文字塑形是 Figma 渲染器的活） | 拿不到 guid/断点 override/动效/未渲染状态 |

**wire 管"设计与语义"，DOM 管"像素与 CSS"。产物包合并两源。**

## 前置（一次性）

```bash
# Chrome 带调试端口 + 登录 Figma + 打开目标文件
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/figma-kiwi-profile \
  "https://www.figma.com/site/<FILE_KEY>/<name>"
npm run kiwi:setup   # ~/.cache/figma-kiwi 装 ws/fzstd/kiwi-schema
```

## 管线 A：wire 全量 sync（无损）

```bash
# 1. 全量 sync：偷 cookie → 独立 WS → JOIN_START→NODE_CHANGES→JOIN_END
node bin/kiwi.mjs sync <FILE_KEY>            # 3.6MB wire → 34,035 节点 + 4,460 blobs

# 2. 无损打包（不蒸馏：不剪枝、不限深、不选字段）
node src/kiwi/pack.mjs                        # → rehearsal/kiwi-package/
#   scenegraph.full.json  全节点全字段（字节→base64 可逆）107MB
#   vectors.json          15,077 条 SVG path（几何 blob 确定性解码）
#   animations.json       全部 KEYFRAME/TRACK/PRESET 原始节点
#   site.json             responsiveSetSettings（title/lang/GA/customCode/scaling）
#   code/                 CODE_FILE 源码（Sites 生成的真实 React）
#   images.json+assets/   hash→S3 签名 URL→下载（REST /images 对 Sites 可用）
#   tree.json             id→children 纯索引

# 3. 应用数据（机械格式转换：渐变矩阵→CSS、effects→shadow、symbol 嫁接）
node src/kiwi/pack-app.mjs                    # → nestto-app/public/data/desktop.json
```

关键协议事实（已 A/B 测试固化，见 test/kiwi/TESTPLAN.md）：
- 所有帧 zstd 压缩；唯一例外 12B 的 JOIN_END 裸 Kiwi
- 全新连接才有全量 sync；重载只发稀疏 delta（无 type/phase）
- wire hash = 20 字节 raw sha1，hex 即 REST `/v1/files/{key}/images` 键（91/91 验证）
- INSTANCE 内容在 SYMBOL 定义子树（symbolData.symbolID），需嫁接+overrides

## 管线 B：渲染 DOM 真值

预览 iframe 内容必须由编辑器父页喂入（postMessage init），standalone 打开是空壳。

```bash
# 1. 在编辑器里手动点一次 Preview（面板出现活 iframe）
# 2. 自动撑大 iframe + 注入采集 agent + 抓 outline
node --experimental-websocket src/kiwi/dom-capture.mjs <FILE_KEY>
# TODO: 接 bin/harvest.mjs 的 computed-style 全量采集（page-agent 已注入成功）
```

## 产物消费（LLM 视角）

```
rehearsal/kiwi-package/
  README→本文件        scenegraph.full.json 大，按需查：jq '.nodeChanges[0]'
  tree.json            从任意 guid 走子树
  vectors.json         guid → path（配 fillPaints 上色）
  code/                Sites 真实源码，可直接参考实现
  animations.json      easing/value/timing 全在
nestto-app/            wire 直渲染的 React 参照物（数据驱动，非手写）
```

## 渲染保真度现状（诚实清单）

已解决：绝对定位坐标、stack(auto-layout) 全套、渐变+矩阵方向、effects 阴影/模糊、
图片填充(hash→下载)、矢量 path、文字全排版字段、TEXT fill≠background、
INSTANCE symbol 嫁接、CODE_INSTANCE(nav) 定义解析。

未解决（按影响排序）：
1. symbolOverrides 未应用（instance 换图/换色 → 黑卡）
2. derivedTextData 文本变体双渲染（个别标题重叠）
3. 遮罩(isMask)、布尔运算合成、blendMode 部分缺失
4. stackWrap(WRAP) 网格、文字 auto-width 与 Figma 塑形差异
5. 管线 B 未完成 computed-style 合并（agent 注入已通）

## 相关文件

- CLI: bin/kiwi.mjs / src/kiwi/{cdp,client,decoder,pack,pack-app,dom-capture,images,svg}.mjs
- 测试: test/kiwi/*.spec.js（43 用例）+ TESTPLAN.md（A/B 对照表）
- 已验证样例: oqjgSk2zVtR18Z1kXfU2DS（nesTTo Sites，REST 拒读的文件）
