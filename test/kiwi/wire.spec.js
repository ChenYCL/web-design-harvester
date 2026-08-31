// spec 1 — wire.mjs
// A（权威）：fixtures/schema_frame.bin —— Sites 编辑器 WS 首帧原始字节
// B（被测）：wire.mjs 的 magic 检测 / schema 切片 / zstd 识别
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isFigWireFrame, extractCompressedSchema, isZstd } from '../../src/kiwi/wire.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const schemaFrame = new Uint8Array(readFileSync(`${HERE}fixtures/schema_frame.bin`))
const joinStart = new Uint8Array(readFileSync(`${HERE}fixtures/join_start.bin`))

describe('wire — A: 原始帧字节, B: 切片函数', () => {
  test('A 的 magic "fig-wire" 在偏移 0，B.isFigWireFrame 认可', () => {
    const magic = Buffer.from(schemaFrame.subarray(0, 8)).toString('ascii')
    assert.equal(magic, 'fig-wire')
    assert.equal(isFigWireFrame(schemaFrame), true)
  })

  test('A 的 offset 8..12 是 uint32 LE 版本号，B 切片从 12 开始', () => {
    const version = new DataView(schemaFrame.buffer, schemaFrame.byteOffset + 8, 4).getUint32(0, true)
    assert.equal(Number.isInteger(version), true, 'version must be an integer')
    const extracted = extractCompressedSchema(schemaFrame)
    assert.equal(extracted.length, schemaFrame.length - 12)
    // 逐字节：extracted[i] === frame[12+i]
    assert.deepEqual(extracted.subarray(0, 16), schemaFrame.subarray(12, 28))
  })

  test('A 的 schema 载荷是 zstd（28 B5 2F FD），B.isZstd 认可', () => {
    const payload = extractCompressedSchema(schemaFrame)
    assert.deepEqual([...payload.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd])
    assert.equal(isZstd(payload), true)
  })

  test('B 对非 fig-wire 帧返回 false（join_start 61B 数据帧作负例）', () => {
    assert.equal(isFigWireFrame(joinStart), false)
    assert.equal(isFigWireFrame(new Uint8Array(0)), false)
    assert.equal(isFigWireFrame(new Uint8Array(4)), false)
  })

  test('extractCompressedSchema 对非 fig-wire 帧抛错', () => {
    assert.throws(() => extractCompressedSchema(joinStart), /Not a fig-wire frame/)
  })

  test('wire 事实：所有帧都 zstd 压缩（含 61B 心跳级 JOIN_START）；非 zstd 缓冲为负例', () => {
    assert.equal(isZstd(joinStart), true, 'JOIN_START 也应压缩（协议约定）')
    assert.equal(isZstd(new Uint8Array([1, 2, 3, 4])), false)
    assert.equal(isZstd(new Uint8Array(3)), false)
  })
})
