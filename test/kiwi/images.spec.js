// spec 6 — images.mjs
// Hermetic 部分：A=scenegraph fillPaints 的 40-hex sha1 扫描（正则定义）,
//                B=collectImageHashes 收集器 —— 集合相等
// Live 部分（gated by FIGMA_TOKEN）：
//   A=REST /v1/files/{key}/images 的 hash→URL 映射（Sites 文件可用，已验证）
//   B=collectImageHashes ⊆ A 的键集
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { collectImageHashes, fetchImageMap, downloadImage } from '../../src/kiwi/images.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FILE_KEY = process.env.FIGMA_FILE_KEY || 'oqjgSk2zVtR18Z1kXfU2DS'

describe('images — hermetic: 收集器 vs 手工字节/正则扫描', () => {
  test('Uint8Array 20 字节 hash → hex（主通道）；string hash 透传（回退）', () => {
    const rawHash = Uint8Array.from({ length: 20 }, (_, i) => i + 1) // 0102...14
    const rawHex = Buffer.from(rawHash).toString('hex')
    const nodes = [
      { guid: { sessionID: 1, localID: 10 }, fillPaints: [
        { type: 'IMAGE', image: { hash: rawHash } },
        { type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } },
      ] },
      { guid: { sessionID: 1, localID: 11 }, fillPaints: [
        { type: 'IMAGE', image: { hash: rawHash } }, // 重复 → 去重
      ] },
      { guid: { sessionID: 1, localID: 12 }, strokePaints: [
        { type: 'IMAGE', image: { hash: 'b'.repeat(40) } }, // 字符串形态（旧导出/回退）
      ] },
      { guid: { sessionID: 1, localID: 13 }, fillPaints: [{ type: 'SOLID', color: {} }] }, // 无图
    ]
    const { hashes, byNode } = collectImageHashes(nodes)
    assert.equal(hashes.length, 2)
    assert.deepEqual(hashes.sort(), [rawHex, 'b'.repeat(40)])
    assert.ok(byNode.get(rawHex).has('1:10'))
    assert.ok(byNode.get(rawHex).has('1:11'))
    assert.ok(byNode.get('b'.repeat(40)).has('1:12'))
  })

  test('34k 全量解码（可选 fixture）：收集数 == 手工字节扫描数', async () => {
    const candidates = [process.env.FIGMA_KIWI_FULLSYNC, '/tmp/figma_kiwi_sites/fullsync/fs_0002_3600414b.bin'].filter(Boolean)
    const path = candidates.find(p => { try { return existsSync(p) } catch { return false } })
    if (!path) {
      console.log('  skip: 大 fixture 不存在（设 FIGMA_KIWI_FULLSYNC）')
      return
    }
    // B 侧：内存解码 → 收集器
    const { getDecoder } = await import('../../src/kiwi/decoder.mjs')
    const { extractCompressedSchema, isZstd } = await import('../../src/kiwi/wire.mjs')
    const decoder = await getDecoder(new Uint8Array(extractCompressedSchema(
      new Uint8Array(readFileSync(`${HERE}fixtures/schema_frame.bin`)))))
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const fzstd = require(require.resolve('fzstd', { paths: [`${homedir()}/.cache/figma-kiwi`] }))
    const wire = new Uint8Array(readFileSync(path))
    const raw = isZstd(wire) ? new Uint8Array(fzstd.decompress(wire)) : wire
    const { nodeChanges } = decoder.decodeMessage(raw)
    const { hashes } = collectImageHashes(nodeChanges)
    // A 侧：独立手工扫描（字节通道 + 40-hex 字符串通道）
    const manual = new Set()
    const seen = (v) => {
      if ((v instanceof Uint8Array || v instanceof Buffer) && v.length === 20) manual.add(Buffer.from(v).toString('hex'))
      else if (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)) manual.add(v)
    }
    for (const nc of nodeChanges) {
      for (const key of ['fillPaints', 'strokePaints']) {
        for (const p of nc[key] || []) {
          seen(p?.image?.hash); seen(p?.imageHash)
        }
      }
    }
    assert.equal(hashes.length, manual.size)
    for (const h of hashes) assert.ok(manual.has(h))
  })
})

describe('images — live: REST /v1/files/{key}/images（需要 FIGMA_TOKEN + 网络）', () => {
  const hasToken = !!process.env.FIGMA_TOKEN

  test('REST 映射可用（Sites 文件不受节点端点 400 限制）', { skip: hasToken ? false : 'FIGMA_TOKEN 未设置' }, async () => {
    const map = await fetchImageMap(FILE_KEY)
    const keys = Object.keys(map)
    assert.ok(keys.length > 0, 'REST 应返回非空 hash→URL 映射')
    for (const [h, url] of Object.entries(map)) {
      assert.match(h, /^[0-9a-f]{40}$/)
      assert.match(url, /^https:\/\//)
    }
  }, { timeout: 30000 })

  test('A/B 闭环：wire 20 字节 hash hex 编码 ⊆ REST 键集（已验证 91/91）', { skip: hasToken ? false : 'FIGMA_TOKEN 未设置' }, async () => {
    const candidates = [process.env.FIGMA_KIWI_FULLSYNC, '/tmp/figma_kiwi_sites/fullsync/fs_0002_3600414b.bin'].filter(Boolean)
    const path = candidates.find(p => { try { return existsSync(p) } catch { return false } })
    if (!path) { console.log('  skip: 大 fixture 不存在'); return }
    const { getDecoder } = await import('../../src/kiwi/decoder.mjs')
    const { extractCompressedSchema, isZstd } = await import('../../src/kiwi/wire.mjs')
    const decoder = await getDecoder(new Uint8Array(extractCompressedSchema(
      new Uint8Array(readFileSync(`${HERE}fixtures/schema_frame.bin`)))))
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const fzstd = require(require.resolve('fzstd', { paths: [`${homedir()}/.cache/figma-kiwi`] }))
    const wire = new Uint8Array(readFileSync(path))
    const raw = isZstd(wire) ? new Uint8Array(fzstd.decompress(wire)) : wire
    const { nodeChanges } = decoder.decodeMessage(raw)
    const { hashes } = collectImageHashes(nodeChanges)
    const map = await fetchImageMap(FILE_KEY)
    const missing = hashes.filter(h => !(h in map))
    assert.equal(missing.length, 0, `未在 REST 映射解析的 hash: ${missing.slice(0, 3).join(', ')}`)
  }, { timeout: 60000 })

  test('签名 URL 可下载为图片字节', { skip: hasToken ? false : 'FIGMA_TOKEN 未设置' }, async () => {
    const map = await fetchImageMap(FILE_KEY)
    const first = Object.values(map)[0]
    const { buf } = await downloadImage(first)
    assert.ok(buf.length > 1000, '图片字节数应合理')
    assert.equal(buf[0], 0x89); assert.equal(buf[1], 0x50, '应为 PNG 魔数')
  }, { timeout: 30000 })
})
