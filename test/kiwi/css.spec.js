// spec 4 — css.mjs
// A/B 双轴：
//   轴 1：A = Figma REST node JSON 语义（官方字段文档语义手工构造）
//         B = extractCSSFromAPI 输出 —— 字段级精确断言
//   轴 2：A = 真实解码的 Kiwi nodeChange（fixtures 提取）
//         B = extractCSSFromKiwi 输出
//   轴 3：rgbaToCSS 性质测试（数学定义基准）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractCSSFromAPI, extractCSSFromKiwi, rgbaToCSS } from '../../src/kiwi/css.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

describe('css 轴1 — extractCSSFromAPI：A=REST 语义 fixture, B=CSS 映射', () => {
  const restNode = {
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 64 },
    layoutMode: 'HORIZONTAL',
    itemSpacing: 24,
    paddingTop: 12, paddingRight: 22, paddingBottom: 12, paddingLeft: 22,
    primaryAxisAlignItems: 'CENTER',
    counterAxisAlignItems: 'CENTER',
    cornerRadius: 8,
    opacity: 0.5,
    fills: [
      { type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 },
      { type: 'GRADIENT_LINEAR', gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ] },
    ],
    strokes: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 } }],
    strokeWeight: 2,
    effects: [
      { type: 'DROP_SHADOW', visible: true, offset: { x: 0, y: 4 }, radius: 12, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 } },
      { type: 'INNER_SHADOW', visible: true, offset: { x: 1, y: 1 }, radius: 2, spread: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { type: 'BACKGROUND_BLUR', visible: true, radius: 8 },
    ],
    style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 600, lineHeightPx: 24, letterSpacing: -0.5 },
    type: 'FRAME',
  }

  test('box / flex / padding / 对齐', () => {
    const css = extractCSSFromAPI(restNode)
    assert.equal(css.width, '1440px')
    assert.equal(css.height, '64px')
    assert.equal(css.display, 'flex')
    assert.equal(css['flex-direction'], 'row')
    assert.equal(css.gap, '24px')
    assert.equal(css.padding, '12px 22px 12px 22px')
    assert.equal(css['justify-content'], 'center')
    assert.equal(css['align-items'], 'center')
  })

  test('radius / opacity / fills / strokes / effects / 字体', () => {
    const css = extractCSSFromAPI(restNode)
    assert.equal(css['border-radius'], '8px')
    assert.equal(css.opacity, '0.5')
    assert.equal(css.background, 'linear-gradient(#ff0000 0%, #0000ff 100%)') // GRADIENT 覆盖前面的 SOLID
    assert.equal(css.border, '2px solid #ffffff')
    assert.equal(css['box-shadow'], '0px 4px 12px 0px rgba(0, 0, 0, 0.25), inset 1px 1px 2px 0px #ff0000')
    assert.equal(css.filter, undefined)
    assert.equal(css['backdrop-filter'], 'blur(8px)')
    assert.equal(css['font-family'], 'Inter')
    assert.equal(css['font-size'], '16px')
    assert.equal(css['font-weight'], '600')
    assert.equal(css['line-height'], '24px')
    assert.equal(css['letter-spacing'], '-0.5px')
  })

  test('TEXT 节点：fill 变 color 而非 background', () => {
    const css = extractCSSFromAPI({
      type: 'TEXT',
      fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } }],
      absoluteBoundingBox: { width: 10, height: 10 },
    })
    assert.equal(css.color, '#1a334d')
    assert.equal(css.background, undefined)
  })

  test('visible=false 的 fill/stroke/effect 被跳过；四角 radius 数组', () => {
    const css = extractCSSFromAPI({
      cornerRadius: -1, rectangleCornerRadii: [4, 8, 4, 8],
      fills: [{ type: 'SOLID', visible: false, color: { r: 1, g: 0, b: 0, a: 1 } }],
      strokes: [{ type: 'SOLID', visible: false, color: { r: 0, g: 0, b: 0, a: 1 } }],
      effects: [{ type: 'DROP_SHADOW', visible: false, offset: {}, color: {} }],
      absoluteBoundingBox: { width: 1, height: 1 },
    })
    assert.equal(css['border-radius'], '4px 8px 4px 8px')
    assert.equal(css.background, undefined)
    assert.equal(css.border, undefined)
    assert.equal(css['box-shadow'], undefined)
  })
})

describe('css 轴2 — extractCSSFromKiwi：A=真实 Kiwi 节点形态, B=CSS 映射', () => {
  // 结构照搬实测 nodeChange（nesTTo 站点解码产物中真实存在的字段形态）
  const kiwiNode = {
    guid: { sessionID: 1, localID: 10007 },
    type: 'FRAME',
    name: 'main site 3',
    size: { x: 1440, y: 10462 },
    stackMode: 'VERTICAL',
    stackSpacing: 32,
    stackHorizontalPadding: 0,
    stackVerticalPadding: 100,
    stackPaddingRight: 0,
    stackPaddingBottom: 0,
    cornerRadius: 12,
    opacity: 0.8,
    fillPaints: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 0.5 }, opacity: 0.5 }],
    strokePaints: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 } }],
    strokeWeight: 1,
    textData: { characters: 'nesTTo' },
    fontName: { family: 'Inter', style: 'Bold' },
    fontSize: 72,
    lineHeight: { value: 72, units: 'PIXELS' },
    letterSpacing: { value: -1.44, units: 'PIXELS' },
    textAlignHorizontal: 'CENTER',
  }

  test('size / flex 方向 / gap / padding / radius / opacity', () => {
    const css = extractCSSFromKiwi(kiwiNode)
    assert.equal(css.width, '1440px')
    assert.equal(css.height, '10462px')
    assert.equal(css.display, 'flex')
    assert.equal(css['flex-direction'], 'column') // VERTICAL → column
    assert.equal(css.gap, '32px')
    assert.equal(css.padding, '100px 0px 0px 0px')
    assert.equal(css['border-radius'], '12px')
    assert.equal(css.opacity, '0.8')
  })

  test('fill alpha 复合：color.a × paint.opacity → rgba', () => {
    const css = extractCSSFromKiwi(kiwiNode)
    assert.equal(css.background, 'rgba(255, 255, 255, 0.25)') // 0.5 × 0.5
  })

  test('排版字段：font / lineHeight / letterSpacing / textAlign / text', () => {
    const css = extractCSSFromKiwi(kiwiNode)
    assert.equal(css['font-family'], 'Inter')
    assert.equal(css['font-style'], 'Bold')
    assert.equal(css['font-size'], '72px')
    assert.equal(css['line-height'], '72px')
    assert.equal(css['letter-spacing'], '-1.44px')
    assert.equal(css['text-align'], 'center')
    assert.equal(css.text, 'nesTTo')
  })

  test('border：strokeWeight + strokePaints[0]', () => {
    const css = extractCSSFromKiwi(kiwiNode)
    assert.equal(css.border, '1px solid #000000')
  })

  test('NONE stackMode 不产生 display:flex；可见 SOLID 才出 background', () => {
    const css = extractCSSFromKiwi({ guid: {}, stackMode: 'NONE', fillPaints: [{ type: 'SOLID', visible: false, color: {} }] })
    assert.equal(css.display, undefined)
    assert.equal(css.background, undefined)
  })
})

describe('css 轴3 — rgbaToCSS 性质测试（A=数学定义）', () => {
  test('纯色 → 6 位小写 hex', () => {
    assert.equal(rgbaToCSS({ r: 1, g: 0, b: 0, a: 1 }), '#ff0000')
    assert.equal(rgbaToCSS({ r: 0, g: 1, b: 1 }), '#00ffff') // a 缺省 = 1
    assert.equal(rgbaToCSS({ r: 0.1, g: 0.2, b: 0.3 }), '#1a334d')
  })

  test('显式 opacity 参数覆盖 c.a；<1 时输出 rgba', () => {
    assert.equal(rgbaToCSS({ r: 0, g: 0, b: 0, a: 1 }, 0.25), 'rgba(0, 0, 0, 0.25)')
    assert.equal(rgbaToCSS({ r: 1, g: 1, b: 1, a: 0.5 }), 'rgba(255, 255, 255, 0.5)')
    assert.equal(rgbaToCSS({ r: 1, g: 1, b: 1, a: 0.5 }, 1), '#ffffff')
  })

  test('空对象退化为黑不透明', () => {
    assert.equal(rgbaToCSS({}), '#000000')
  })
})
