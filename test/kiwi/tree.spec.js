// spec 3 — tree.mjs
// A（权威）：raw nodeChanges（真实解码产物）
// B（被测）：collectNodes / buildTree / childIds / flattenTree / nodeBox
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { collectNodes, buildTree, childIds, flattenTree, nodeBox } from '../../src/kiwi/tree.mjs'
import { nid } from '../../src/kiwi/wire.mjs'
import { getDecoder } from '../../src/kiwi/decoder.mjs'
import { extractCompressedSchema } from '../../src/kiwi/wire.mjs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)
const HERE = fileURLToPath(new URL('.', import.meta.url))
const FIX = `${HERE}fixtures`
const CACHE = `${homedir()}/.cache/figma-kiwi`

async function decodeDelta() {
  const decoder = await getDecoder(new Uint8Array(extractCompressedSchema(
    new Uint8Array(readFileSync(`${FIX}/schema_frame.bin`)))))
  const fzstd = require(require.resolve('fzstd', { paths: [CACHE] }))
  const raw = new Uint8Array(readFileSync(`${FIX}/delta_node_changes.bin`))
  const data = [0x28, 0xb5, 0x2f, 0xfd].every((b, i) => raw[i] === b)
    ? new Uint8Array(fzstd.decompress(raw)) : raw
  return decoder.decodeMessage(data).nodeChanges
}

describe('tree — A: raw nodeChanges (delta 7 节点), B: collect/build', () => {
  test('collectNodes：入参 7 → byId 7，id 无重复', async () => {
    const changes = await decodeDelta()
    assert.equal(changes.length, 7)
    const { byId } = collectNodes(changes)
    assert.equal(byId.size, 7)
    const ids = changes.map(nc => nid(nc.guid))
    assert.equal(new Set(ids).size, ids.length, 'fixture 内 guid 应唯一')
    for (const id of ids) assert.ok(byId.has(id))
  })

  test('父子一致：每个带 parentIndex 的节点，其父在树中且子列表含它', async () => {
    const changes = await decodeDelta()
    const { byId, children } = collectNodes(changes)
    for (const nc of byId.values()) {
      const pi = nc.parentIndex
      if (!pi?.guid) continue
      const pid = nid(pi.guid)
      const cid = nid(nc.guid)
      if (pid === cid) continue
      assert.ok(byId.has(pid), `父 ${pid} 应存在`)
      const kids = (children.get(pid) || []).map(k => nid(k.guid))
      assert.ok(kids.includes(cid), `子 ${cid} 应列于父 ${pid}`)
    }
  })

  test('position 排序：children 内 position 单调不减', async () => {
    const changes = await decodeDelta()
    const { children } = collectNodes(changes)
    for (const [, arr] of children) {
      const poss = arr.map(k => k.parentIndex?.position ?? '')
      const sorted = [...poss].sort()
      assert.deepEqual(poss, sorted)
    }
  })

  test('展平回写：flattenTree(root) 的 id 集 == 可达节点集且无重复', async () => {
    const changes = await decodeDelta()
    const model = collectNodes(changes)
    const tree = buildTree(model)
    const roots = [...tree.values()].filter(n => {
      const nc = model.byId.get(n.id)
      return !nc.parentIndex || !model.byId.has(nid(nc.parentIndex.guid))
    })
    const visited = new Set()
    let total = 0
    for (const r of roots) {
      const flat = flattenTree(tree, r.id)
      total += flat.length
      for (const id of flat) visited.add(id)
    }
    assert.equal(visited.size, total, '无重复访问')
    assert.equal(total, 7, '森林展平覆盖全部节点')
  })

  test('nodeBox：从 transform.m02/m12 与 size 读出 x/y/w/h', () => {
    const nc = {
      guid: { sessionID: 1, localID: 2 },
      size: { x: 1440, y: 10462 },
      transform: { m00: 1, m01: 0, m02: -10310, m10: 0, m11: 1, m12: -108 },
    }
    assert.deepEqual(nodeBox(nc), { x: -10310, y: -108, w: 1440, h: 10462 })
    assert.deepEqual(nodeBox({ guid: { sessionID: 0, localID: 0 } }), { x: 0, y: 0, w: 0, h: 0 })
  })
})

// 大全量 fixture 存在时，追加 34k 级别的一致性校验
describe('tree — 34k 全量一致性（可选 fixture）', () => {
  test('全量 nodeChanges → 树：覆盖数 == 唯一 id 数；DOCUMENT 唯一根', async () => {
    const candidates = [process.env.FIGMA_KIWI_FULLSYNC, '/tmp/figma_kiwi_sites/scenegraph.json'].filter(Boolean)
    const path = candidates.find(p => {
      try { return existsSync(p) } catch { return false }
    })
    if (!path) {
      console.log('  skip: 全量 fixture 不存在（FIGMA_KIWI_FULLSYNC 或 /tmp scenegraph.json）')
      return
    }
    const { nodeChanges } = JSON.parse(readFileSync(path, 'utf8'))
    const { byId } = collectNodes(nodeChanges)
    assert.equal(byId.size, 34035)
    const docRoots = [...byId.values()].filter(nc => nc.type === 'DOCUMENT')
    assert.equal(docRoots.length, 1)
    assert.equal(nid(docRoots[0].guid), '0:0')
    const canvases = [...byId.values()].filter(nc => nc.type === 'CANVAS')
    assert.equal(canvases.length, 2)
  })
})

import { existsSync } from 'node:fs'
