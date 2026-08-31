// spec 7 — client.mjs + cdp.mjs + decoder.mjs 集成（全部 gated）
// A（权威）：wire 帧序列真值（JOIN_START → NODE_CHANGES flood → JOIN_END）
// B（被测）：fullSync 抓帧 + decodeFrames 解码 —— 计数与结构校验
// 运行条件（缺一则 skip）：
//   - Chrome 带 --remote-debugging-port=9222 且已打开目标 Figma 文件 tab
//   - ~/.cache/figma-kiwi 里已装 ws/fzstd、已生成解码器
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractCompressedSchema } from '../../src/kiwi/wire.mjs'
import { getDecoder } from '../../src/kiwi/decoder.mjs'
import { fullSync, decodeFrames } from '../../src/kiwi/client.mjs'
import { stealCookies, observeMultiplayerHandshake, findFigmaTab } from '../../src/kiwi/cdp.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FIX = `${HERE}fixtures`
const FILE_KEY = process.env.FIGMA_FILE_KEY || 'oqjgSk2zVtR18Z1kXfU2DS'

// 环境探测：无 CDP 则整组 skip
async function cdpReady() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(1500) })
    const targets = await res.json()
    return targets.some(t => t.type === 'page' && t.url?.includes(FILE_KEY))
  } catch { return false }
}

// 环境探测：无 CDP 则整组 skip（模块顶层 await，ESM 合法）
const ready = await cdpReady()

describe('live-sync — fullSync → decodeFrames（需要 CDP Chrome + Figma tab）', () => {

  test('离线路径：fixtures 帧序列走 decodeFrames，产出与逐帧解码一致', async () => {
    // A：已知真值 —— JOIN_START/JION_END/NODE_CHANGES(7)
    // B：decodeFrames 喂入 [join_start, delta, join_end]
    const decoder = await getDecoder(new Uint8Array(extractCompressedSchema(
      new Uint8Array(readFileSync(`${FIX}/schema_frame.bin`)))))
    const frames = [
      readFileSync(`${FIX}/join_start.bin`),
      readFileSync(`${FIX}/delta_node_changes.bin`),
      readFileSync(`${FIX}/join_end.bin`),
    ]
    const { nodeChanges, joinEnd } = decodeFrames(frames, decoder)
    assert.equal(joinEnd, true)
    assert.equal(nodeChanges.length, 7)
    // delta patch 为稀疏元数据（无 type/phase），但 guid 必须存在 —— 见 decoder.spec
    assert.ok(nodeChanges.every(nc => nc.guid))
  })

  test('fullSync 端到端：cookie 窃取 → WS 全量 → 解码计数一致',
    { skip: ready ? false : '9222 无 Figma tab（启动 Chrome --remote-debugging-port=9222 并打开文件）' },
    async () => {
      const outDir = '/tmp/figma_kiwi_sync_test'
      mkdirSync(outDir, { recursive: true })
      const cookies = await stealCookies(FILE_KEY)
      assert.ok(cookies.some(c => c.name === 'figma.session'), '必须拿到登录态 cookie')
      const multiplayerUrl = await observeMultiplayerHandshake(FILE_KEY)
      assert.ok(multiplayerUrl.includes(FILE_KEY), 'multiplayer URL 应含 fileKey')

      const { frames, joinEnd, schemaFrame } = await fullSync({ fileKey: FILE_KEY, multiplayerUrl, cookies, outDir, timeoutMs: 90000 })
      assert.equal(joinEnd, true, '必须收到 JOIN_END（全量完成标记）')
      assert.ok(schemaFrame, '首帧必须是 fig-wire schema')

      const decoder = await getDecoder(new Uint8Array(extractCompressedSchema(new Uint8Array(schemaFrame))))
      const captured = readdirSync(outDir).filter(f => f.startsWith('fs_')).sort()
        .map(f => readFileSync(`${outDir}/${f}`))
      const { nodeChanges } = decodeFrames(captured, decoder)
      assert.ok(nodeChanges.length > 1000, `全量 sync 节点数异常：${nodeChanges.length}`)
      const types = new Set(nodeChanges.map(n => n.type))
      assert.ok(types.has('FRAME') && types.has('TEXT') && types.has('CANVAS'))
    }, { timeout: 150000 })
})
