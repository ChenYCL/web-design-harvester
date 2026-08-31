// spec 5 — anims.mjs
// A（权威）：真实解码的 KEYFRAME / KEYFRAME_TRACK / ANIMATION_PRESET_INSTANCE 原始节点
//           （字段形态取自 nesTTo 站点 34k 全量解码产物）
// B（被测）：distillAnimations 蒸馏描述符
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { distillAnimations, distillKeyframe, distillPresetInstance, distillTrack } from '../../src/kiwi/anims.mjs'

// ---- A 侧 fixture：照抄真实解码节点（keyframeValue/easingData/componentPropAssignments
//      的字段名与类型均来自 wire 真值，见 test/kiwi/TESTPLAN.md） ----
const KEYFRAME_RAW = {
  guid: { sessionID: 234, localID: 16969 },
  phase: 'CREATED',
  parentIndex: { guid: { sessionID: 234, localID: 16968 }, position: '!' },
  type: 'KEYFRAME',
  name: 'Keyframe',
  visible: true,
  overrideKey: { sessionID: 381, localID: 96859 },
  keyframeValue: { value: { floatValue: 0 }, valueType: 'FLOAT' },
  easingData: { easingType: 'OUT_CUBIC' },
}

const TRACK_RAW = {
  guid: { sessionID: 234, localID: 16968 },
  phase: 'CREATED',
  parentIndex: { guid: { sessionID: 381, localID: 96857 }, position: 'a' },
  type: 'KEYFRAME_TRACK',
  name: 'opacity track',
  visible: true,
  overrideKey: { sessionID: 381, localID: 96859 },
  keyframeOperation: 'SET',
}

const PRESET_RAW = {
  guid: { sessionID: 234, localID: 16967 },
  phase: 'CREATED',
  parentIndex: { guid: { sessionID: 0, localID: 2 }, position: '~~~~~~~~~~~~~~~~~~~Z' },
  type: 'ANIMATION_PRESET_INSTANCE',
  name: 'motion.preset_name.opacity',
  version: '238:57',
  userFacingVersion: '238:57',
  componentPropAssignments: [
    { defID: { sessionID: 22, localID: 45 }, varValue: { value: { floatValue: 7.052000045776367 }, dataType: 'FLOAT', resolvedDataType: 'TIMING' } },
    { defID: { sessionID: 22, localID: 46 }, varValue: { value: { floatValue: 0.009999999776482582 }, dataType: 'FLOAT', resolvedDataType: 'TIMING' } },
  ],
  visible: true,
  opacity: 1,
  size: { x: 100, y: 100 },
  transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
  overrideKey: { sessionID: 381, localID: 96857 },
  backingCodeComponentId: { assetRef: { key: '9e966ddc10569b1c9b528894a592669604838d33', version: '22:13' } },
  codeSnapshot: { state: 'INITIAL', invalidatedAt: 1787285066 },
  timelineOffset: 250,
}

describe('anims — A: 真实节点, B: 蒸馏描述符', () => {
  test('KEYFRAME：id/property/value/valueType/easing 全保留', () => {
    const d = distillKeyframe(KEYFRAME_RAW)
    assert.equal(d.id, '234:16969')
    assert.equal(d.parent, '234:16968')
    assert.equal(d.property, '381:96859')
    assert.deepEqual(d.value, { valueType: 'FLOAT', value: 0 })
    assert.equal(d.easing, 'OUT_CUBIC')
  })

  test('KEYFRAME_TRACK：property + operation 保留', () => {
    const d = distillTrack(TRACK_RAW)
    assert.equal(d.id, '234:16968')
    assert.equal(d.property, '381:96859')
    assert.equal(d.operation, 'SET')
  })

  test('ANIMATION_PRESET_INSTANCE：timing props（duration/delay 语义）+ 代码组件引用', () => {
    const d = distillPresetInstance(PRESET_RAW)
    assert.equal(d.name, 'motion.preset_name.opacity')
    assert.equal(d.presetVersion, '238:57')
    assert.equal(d.timelineOffset, 250)
    assert.equal(d.backingCodeComponentId, '9e966ddc10569b1c9b528894a592669604838d33')
    assert.equal(d.props.length, 2)
    assert.equal(d.props[0].type, 'TIMING') // resolvedDataType 优先
    assert.ok(Math.abs(d.props[0].value - 7.052) < 1e-6)
    assert.ok(Math.abs(d.props[1].value - 0.01) < 1e-6)
  })

  test('distillAnimations 汇总：counts 与分桶一致；非动画节点不混入', () => {
    const out = distillAnimations([KEYFRAME_RAW, TRACK_RAW, PRESET_RAW,
      { guid: { sessionID: 1, localID: 1 }, type: 'FRAME', name: 'x' }])
    assert.equal(out.counts.keyframes, 1)
    assert.equal(out.counts.tracks, 1)
    assert.equal(out.counts.presets, 1)
    assert.equal(out.keyframes[0].easing, 'OUT_CUBIC')
    assert.ok(!out.keyframes.some(k => k.id === '1:1'))
  })

  test('类型不匹配返回 null（防御）', () => {
    assert.equal(distillKeyframe(TRACK_RAW), null)
    assert.equal(distillTrack(PRESET_RAW), null)
    assert.equal(distillPresetInstance(KEYFRAME_RAW), null)
  })
})
