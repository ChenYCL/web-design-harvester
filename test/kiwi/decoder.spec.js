// spec 2 — decoder.mjs
// A（黄金基准）：evanw/kiwi CLI 生成的解码器（figma_decoder.js 路径，已验证可解 34k 节点）
// B（被测 A/B 对照）：npm kiwi-schema 的 decodeBinarySchema + compileSchema 运行时编译
//
// 已知分歧（2026-08-31 记录）：对 34k 大消息，B 在 decodeClientRenderedMetadata 处
// 抛 "Attempted to parse invalid message"；A 正常解出 34035 节点。
// 该分歧作为显式断言固化 —— 若 upstream 修复，本测试会失败提醒翻转断言。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isFigWireFrame, extractCompressedSchema } from '../../src/kiwi/wire.mjs'
import { getDecoder } from '../../src/kiwi/decoder.mjs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = fileURLToPath(new URL('.', import.meta.url))
const FIX = `${HERE}fixtures`

// 黄金解码器：CI 首跑会用 CLI 现场生成（需要 git + npx tsx），之后走缓存
const schemaFrame = new Uint8Array(readFileSync(`${FIX}/schema_frame.bin`))
const joinStart = new Uint8Array(readFileSync(`${FIX}/join_start.bin`))
const joinEnd = new Uint8Array(readFileSync(`${FIX}/join_end.bin`))
const deltaNodeChanges = new Uint8Array(readFileSync(`${FIX}/delta_node_changes.bin`))

// 大全量帧（3.6MB, 34035 节点）：不在 git 里，按需探测
const BIG_CANDIDATES = [
  process.env.FIGMA_KIWI_FULLSYNC,
  '/tmp/figma_kiwi_sites/fullsync/fs_0002_3600414b.bin',
].filter(Boolean)
const bigFramePath = BIG_CANDIDATES.find(p => existsSync(p))

let A // 黄金解码器（惰性）
async function gold() {
  if (!A) A = await getDecoder(new Uint8Array(extractCompressedSchema(schemaFrame)))
  return A
}

function compileB() {
  const kiwi = require(require.resolve('kiwi-schema', { paths: [gold.pathCacheDir] }))
  const schema = kiwi.decodeBinarySchema(inflate(new Uint8Array(extractCompressedSchema(schemaFrame))))
  return kiwi.compileSchema(schema)
}
// 让 B 能拿到 fzstd/kiwi-schema：用缓存目录的 node_modules
import { homedir } from 'node:os'
gold.pathCacheDir = `${homedir()}/.cache/figma-kiwi`

const ZSTD = [0x28, 0xb5, 0x2f, 0xfd]
function inflate(u8) {
  const fzstd = require(require.resolve('fzstd', { paths: [gold.pathCacheDir] }))
  return ZSTD.every((b, i) => u8[i] === b) ? new Uint8Array(fzstd.decompress(u8)) : u8
}

describe('decoder — A: wire 真值 + 黄金解码器', () => {
  test('schema 帧检测与提取（前置）', () => {
    assert.equal(isFigWireFrame(schemaFrame), true)
  })

  test('A 解码 JOIN_START 帧 → type=JOIN_START（全量 sync 的 join 标记）', async () => {
    const dec = await gold()
    const m = dec.decodeMessage(inflate(joinStart))
    assert.equal(m.type, 'JOIN_START')
  })

  test('A 解码 JOIN_END 帧 → type=JOIN_END（全量 sync 完成标记）', async () => {
    const dec = await gold()
    const m = dec.decodeMessage(inflate(joinEnd))
    assert.equal(m.type, 'JOIN_END')
  })

  test('A 解码重放 delta NODE_CHANGES：7 个稀疏元数据 patch（无 type/phase）', async () => {
    const dec = await gold()
    const m = dec.decodeMessage(inflate(deltaNodeChanges))
    assert.equal(m.type, 'NODE_CHANGES')
    assert.equal(m.nodeChanges.length, 7)
    // wire 事实：重载 delta 是 journal 重放的稀疏 patch —— 无 type/phase，
    // 携带 editInfo/editScopeInfo（协作元数据）或 textData 增量。
    for (const nc of m.nodeChanges) {
      assert.equal(nc.type, undefined, 'delta patch 不应携带 type')
      assert.equal(nc.phase, undefined, 'delta patch 不应携带 phase（phase=CREATED 仅属全量 sync）')
      assert.ok(nc.guid, 'patch 必须有 guid')
    }
    assert.ok(m.nodeChanges.some(nc => nc.editInfo), '至少一个 patch 带 editInfo')
    assert.ok(m.nodeChanges.some(nc => nc.textData), '至少一个 patch 带 textData 增量')
  })
})

describe('decoder — A/B: CLI 黄金 vs npm kiwi-schema 编译', () => {
  test('B 路径能编译同一 schema 并解出 JOIN_START，与 A 深比较等价', async () => {
    const dec = await gold()
    const mA = dec.decodeMessage(inflate(joinStart))
    const mB = compileB().decodeMessage(inflate(joinStart))
    assert.deepEqual(JSON.parse(JSON.stringify(mB)), JSON.parse(JSON.stringify(mA)))
  })

  test('[A/B 深比较] 34k 大消息：CLI 黄金与 npm 编译输出等价（34k 节点级）', async () => {
    if (!bigFramePath) {
      console.log('  skip: 大 fixture 不存在（设 FIGMA_KIWI_FULLSYNC 或重新 sync）')
      return
    }
    const big = new Uint8Array(readFileSync(bigFramePath))
    const dec = await gold()
    const mA = dec.decodeMessage(inflate(big))
    assert.equal(mA.nodeChanges.length, 34035)
    // 历史：2026-08-31 早期 npm kiwi-schema 版本在 decodeClientRenderedMetadata
    // 抛 "Attempted to parse invalid message"；当前缓存版本可完整解码。
    // 断言升级为 34k 节点级深比较 —— 若再出分歧此测试即失败。
    const mB = compileB().decodeMessage(inflate(big))
    assert.equal(mB.nodeChanges?.length, 34035)
    const norm = (m) => JSON.stringify(m, (k, v) => typeof v === 'bigint' ? Number(v) : v)
    assert.equal(norm(mB).length, norm(mA).length, '序列化长度应一致')
    assert.equal(norm(mB), norm(mA), 'A/B 输出应逐字段一致')
  })
})

describe('decoder — 缓存稳定性', () => {
  test('同 schema 两次取解码器命中同一缓存文件', async () => {
    const d1 = await gold()
    const d2 = await getDecoder(new Uint8Array(extractCompressedSchema(schemaFrame)))
    assert.equal(d1, d2, 'require 缓存应返回同一实例')
  })
})
