# Kiwi 解码管线 — API ↔ A/B 测试对照表

运行：`npm run test:kiwi`（等价 `node --test test/kiwi/*.spec.js`）

## A/B 测试约定

- **A（权威基准）**：wire 原始字节、evanw/kiwi 官方参考实现产出、Figma REST API 真值
- **B（被测实现）**：`src/kiwi/*` 的输出
- 通过标准：B 与 A 在语义上等价（深比较 / 集合包含 / 计数一致）
- 大体积/需登录的 fixture 缺失时 skip 并打印原因，不算失败

## 对照表（2026-08-31 全部通过：43/43）

| # | API (`src/kiwi/`) | A 基准 | B 被测 | spec | 状态 |
|---|---|---|---|---|---|
| 1 | `wire.isFigWireFrame` / `extractCompressedSchema` / `isZstd` | 原始 fig-wire 帧（fixtures/schema_frame.bin, 30585B）+ 负例 | 切片结果与手算偏移逐字节比对 | `wire.spec.js` | ✅ |
| 2 | `decoder.getDecoder`（evanw/kiwi CLI 路径） | wire 真值：全量 sync 帧 type=JOIN_START；重载帧 type=JOIN_START_JOURNALED | CLI 生成解码器 decodeMessage 输出 | `decoder.spec.js` | ✅ |
| 3 | `decoder` A/B：CLI 解码器 vs npm kiwi-schema 编译 | A=CLI 解码器输出（黄金，34k 节点） | B=npm `compileSchema(decodeBinarySchema(...))` | `decoder.spec.js` | ✅（34k 节点级深比较一致；历史版本 npm 包曾抛 `clientRenderedMetadata` 错误，当前缓存版本无此问题） |
| 4 | `tree.buildTree` / `collectNodes` | A=raw nodeChanges（delta 7 patch + 可选 34k 全量） | B=树结构：id 唯一、父子一致、position 排序、森林展平全覆盖 | `tree.spec.js` | ✅ |
| 5 | `css.extractCSSFromAPI` | A=Figma REST node JSON 语义 fixture | B=CSS 属性映射精确断言（flex/padding/渐变/阴影/字体/图片填充） | `css.spec.js` | ✅ |
| 6 | `css.extractCSSFromKiwi` | A=真实解码 Kiwi 节点（fillPaints alpha 复合、stackMode、textData） | B=字段级断言 | `css.spec.js` | ✅ |
| 7 | `css.rgbaToCSS`（性质测试） | A=数学定义 r/g/b/a→hex/rgba | B=换算输出；alpha 复合 `fill.opacity × color.a` | `css.spec.js` | ✅ |
| 8 | `anims.distillAnimations` | A=真实 KEYFRAME（easing=OUT_CUBIC）/ KEYFRAME_TRACK / ANIMATION_PRESET_INSTANCE（TIMING props） | B=蒸馏描述符全保留 | `anims.spec.js` | ✅ |
| 9 | `images.collectImageHashes`（hermetic） | A=独立手工扫描（**wire 20 字节 raw sha1 → hex** 主通道 + 40-hex 字符串回退） | B=收集器集合相等 | `images.spec.js` | ✅ |
| 10 | `images.fetchImageMap`（live, gated） | A=REST `/v1/files/{key}/images`（**Sites 文件可用**，已验证 200 + 402 个映射） | B=**A/B 闭环：wire hash hex ⊆ REST 键集（91/91 实测命中）** | `images.spec.js` | ✅ |
| 11 | `client.fullSync`→`decodeFrames`（live, gated） | A=wire 帧序列（JOIN_START→NODE_CHANGES flood→JOIN_END） | B=cookie 窃取→WS 全量→解码，joinEnd=true + 节点计数 | `live-sync.spec.js` | ✅ |
| 12 | `export.buildPackage`（未实现） | A=scenegraph raw | B=页面树覆盖率和/资源清单 | `export.spec.js` | 待实现 |

## 测试中确立的 wire 事实（修正记录）

1. **所有帧都 zstd 压缩**（含 61B 心跳级 JOIN_START）；唯一例外是 12B 的 JOIN_END 裸 Kiwi 帧
2. **JOIN_START（全新全量 sync） vs JOIN_START_JOURNALED（重载续传 delta）** —— 两种会话形态
3. **重载 delta = 稀疏元数据 patch**：无 `type`/`phase`，携带 `editInfo`/`editScopeInfo`/`textData` 增量；`phase='CREATED'` 只出现在全量 sync 节点上
4. **hash 空间同一性**：wire 上 `fillPaints[].image.hash` 是 20 字节原始 sha1，hex 编码后 == REST `/v1/files/{key}/images` 映射键（91/91）—— 早前 0 相交是因为序列化把字节丢成了占位符
5. npm `kiwi-schema` 运行时编译与 evanw/kiwi CLI 生成解码器在 34k 节点上输出一致（旧版本存在 clientRenderedMetadata 解析分歧）

## Fixtures

| 文件 | 大小 | 来源 | 提交 |
|---|---|---|---|
| `fixtures/schema_frame.bin` | ~30KB | Sites 编辑器 WS 首帧（fig-wire + zstd schema） | ✅ |
| `fixtures/join_start.bin` | 61B | 全量 sync 帧序列 | ✅ |
| `fixtures/delta_node_changes.bin` | 5.5KB | 重载增量 NODE_CHANGES（7 节点） | ✅ |
| `fixtures/join_end.bin` | 12B | 同上 | ✅ |
| 大全量帧（3.6MB, 34035 节点） | — | `/tmp/figma_kiwi_sites/fullsync/fs_0002_*.bin`，可用 `FIGMA_KIWI_FULLSYNC` 指定 | ❌（体积原因，缺失时相关用例 skip） |

重新捕获大 fixture：
```bash
node bin/kiwi.mjs sync oqjgSk2zVtR18Z1kXfU2DS   # 需要 CDP Chrome + 已登录 Figma tab
```
