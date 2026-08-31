// 从无损 kiwi-package 生成应用消费的 desktop.json —— 纯格式转换，不裁剪：
// 二进制→base64/hex、渐变矩阵→CSS、effects→box-shadow/filter、几何 blob→SVG path。
// 规则：desktop 子树内全部节点、全部视觉字段。
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { nid } from '../kiwi/wire.mjs';

const PKG = 'rehearsal/kiwi-package';
const OUT = 'rehearsal/nestto-app/public/data';
mkdirSync(OUT, { recursive: true });

const sg = JSON.parse(readFileSync(`${PKG}/scenegraph.full.json`, 'utf8'));
const tree = JSON.parse(readFileSync(`${PKG}/tree.json`, 'utf8'));
const vectors = JSON.parse(readFileSync(`${PKG}/vectors.json`, 'utf8'));
const bytes = (v) => v?.__bytes ? Buffer.from(v.__bytes, 'base64') : (v instanceof Uint8Array || Buffer.isBuffer(v) ? Buffer.from(v) : null);

// ---- 颜色/渐变/effects 转换 ----
const hex = (c, a = 1) => {
  const r = Math.round((c?.r ?? 0) * 255), g = Math.round((c?.g ?? 0) * 255), b = Math.round((c?.b ?? 0) * 255);
  const al = (c?.a ?? 1) * a;
  return al < 1 ? `rgba(${r},${g},${b},${Number(al.toFixed(3))})` : `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
};
function paintToCSS(p) {
  if (p.visible === false) return null;
  if (p.type === 'SOLID') return hex(p.color, p.opacity ?? 1);
  if (p.type?.includes('GRADIENT')) {
    const stops = (p.gradientStops || []).map(s => `${hex(s.color)} ${Math.round((s.position ?? 0) * 100)}%`).join(', ');
    // gradientTransform [[a,b,tx],[c,d,ty]] 把单位渐变空间映射到节点空间
    const m = p.gradientTransform ?? [[0, 1, 0], [1, 0, 0]];
    const ang = Math.atan2(m[1][0], m[0][0]) * 180 / Math.PI;
    const deg = Math.round(((90 - ang) + 360) % 360);
    return p.type.includes('RADIAL')
      ? `radial-gradient(${stops})`
      : `linear-gradient(${deg}deg, ${stops})`;
  }
  if (p.type === 'IMAGE') {
    const h = bytes(p.image?.hash);
    return h ? { image: h.toString('hex'), scaleMode: p.scaleMode ?? 'FILL' } : null;
  }
  return null;
}
function effectsToCSS(effects) {
  const shadows = [], filters = [];
  for (const e of effects || []) {
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      shadows.push(`${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.radius ?? 0}px ${e.spread ?? 0}px ${hex(e.color)}`);
    } else if (e.type === 'LAYER_BLUR') filters.push(`blur(${e.radius ?? 0}px)`);
    else if (e.type === 'BACKGROUND_BLUR') filters.push(`backdrop-blur(${e.radius ?? 0}px)`);
  }
  return { boxShadow: shadows.join(', ') || null, filter: filters.filter(f => f.startsWith('blur')).join(' ') || null, backdropFilter: filters.filter(f => f.startsWith('backdrop')).join(' ') || null };
}

// ---- 桌面断点子树收集（无剪枝） ----
const byId = new Map();
for (const nc of sg.nodeChanges) {
  const id = nid(nc.guid);
  const prev = byId.get(id);
  if (!prev || (nc.parentIndex && !prev.parentIndex)) byId.set(id, nc);
}
const kidsOf = new Map();
for (const [pid, arr] of Object.entries(tree)) kidsOf.set(pid, arr);

const DESKTOP = '1:10007';
const inSubtree = new Set();
const symbolFor = new Map(); // instanceId -> symbolId
(function walk(id) {
  inSubtree.add(id);
  for (const c of kidsOf.get(id) || []) walk(c);
})(DESKTOP);
// INSTANCE → symbolData.symbolID 定义子树嫁接（多轮：新 symbol 里可能还有 instance）
let grew = true;
while (grew) {
  grew = false;
  for (const id of [...inSubtree]) {
    const nc = byId.get(id);
    if (!nc) continue;
    const symId = nc.symbolData?.symbolID ? nid(nc.symbolData.symbolID) : (nc.backingCodeComponentId?.guid ? nid(nc.backingCodeComponentId.guid) : null);
    if (!symId || symbolFor.has(id)) continue;
    symbolFor.set(id, symId);
    if (!inSubtree.has(symId)) {
      inSubtree.add(symId);
      (function walk2(sid) {
        for (const c of kidsOf.get(sid) || []) if (!inSubtree.has(c)) { inSubtree.add(c); walk2(c); grew = true; }
      })(symId);
    }
  }
}
console.error(`desktop subtree nodes: ${inSubtree.size - 1}`);

function convert(nc) {
  const t = nc.transform || {};
  const node = { children: [] };
  const fills = (nc.fillPaints || []).map(paintToCSS).filter(Boolean);
  const solid = fills.find(f => typeof f === 'string');
  const imageFill = fills.find(f => typeof f === 'object');
  const gradient = (nc.fillPaints || []).map(paintToCSS).find(f => typeof f === 'string' && f.includes('-gradient'));
  const fx = effectsToCSS(nc.effects);
  const text = nc.textData?.characters ?? null;
  const isText = nc.type === 'TEXT';
  const textColor = isText ? (fills.find(f => typeof f === 'string') ?? null) : null;
  const font = nc.fontName?.style?.toLowerCase?.() ?? '';
  const weightMap = { thin: 100, extralight: 200, light: 300, regular: 400, medium: 500, semibold: 600, 'semi bold': 600, bold: 700, extrabold: 800, 'extra bold': 800, black: 900 };
  Object.assign(node, {
    id: nid(nc.guid),
    name: nc.name ?? '',
    type: nc.type,
    visible: nc.visible !== false,
    x: t.m02 ?? 0, y: t.m12 ?? 0,
    w: nc.size?.x ?? 0, h: nc.size?.y ?? 0,
    stackMode: nc.stackMode ?? null,
    stackGap: nc.stackSpacing ?? null,
    pad: [nc.stackVerticalPadding ?? null, nc.stackHorizontalPadding ?? null, nc.stackPaddingBottom ?? null, nc.stackPaddingRight ?? null],
    alignSelf: nc.stackChildAlignSelf ?? null,
    primarySizing: nc.stackPrimarySizing ?? null,
    counterSizing: nc.stackCounterSizing ?? null,
    counterAlign: nc.stackCounterAxisAlignItems ?? null,
    primaryAlign: nc.stackPrimaryAxisAlignItems ?? null,
    radius: nc.cornerRadius ?? null,
    radii: nc.rectangleCornerRadiiIndependent ?? null,
    fill: isText ? null : (solid ?? null),
    gradient: isText ? null : (gradient ?? null),
    image: imageFill ?? null,
    textColor,
    stroke: (nc.strokePaints || []).length && nc.strokeWeight ? `${nc.strokeWeight}px solid ${hex((nc.strokePaints[0] || {}).color)}` : null,
    opacity: nc.opacity === 1 ? null : nc.opacity ?? null,
    clip: nc.type === 'FRAME' ? nc.frameMaskDisabled !== true : false,
    text,
    fontSize: nc.fontSize ?? null,
    fontWeight: weightMap[font] ?? null,
    fontName: nc.fontName ? `${nc.fontName.family} ${nc.fontName.style}` : null,
    lineHeight: nc.lineHeight?.value ?? null,
    letterSpacing: nc.letterSpacing?.value ?? null,
    textAlign: nc.textAlignHorizontal ?? null,
    boxShadow: fx.boxShadow,
    filter: fx.filter,
    backdropFilter: fx.backdropFilter,
    paths: vectors[nid(nc.guid)] ?? null,
    blendMode: nc.blendMode && nc.blendMode !== 'NORMAL' ? nc.blendMode : null,
  });
  return node;
}

const nodes = [];
const index = new Map();
for (const id of inSubtree) {
  if (id === DESKTOP) continue;
  const nc = byId.get(id);
  if (!nc) continue;
  const n = convert(nc);
  nodes.push(n);
  index.set(n.id, n);
}
// 挂 children（按 tree.json 顺序）；INSTANCE 的孩子 = symbol 定义子树（应用 overrides 后相对定位归零）
const roots = [];
for (const n of nodes) {
  const nc = byId.get(n.id);
  let pid = nc.parentIndex?.guid ? nid(nc.parentIndex.guid) : null;
  if (pid === DESKTOP) { roots.push(n); continue; }
  if (pid && index.has(pid)) { index.get(pid).children.push(n); continue; }
  // 父不在子树 → 可能是嫁接进来的 symbol 根：挂到引用它的 instance
  const host = [...symbolFor.entries()].find(([, sid]) => sid === pid);
  if (host && index.has(host[0])) {
    // 定义根节点坐标归零（原点是 instance 的位置）
    n.x = 0; n.y = 0;
    n.w = index.get(host[0]).w; n.h = index.get(host[0]).h;
    index.get(host[0]).children.push(n);
    continue;
  }
  roots.push(n);
}

const site = JSON.parse(readFileSync(`${PKG}/site.json`, 'utf8'));
writeFileSync(`${OUT}/desktop.json`, JSON.stringify({
  site, desktop: { id: DESKTOP, size: { w: byId.get(DESKTOP)?.size?.x, h: byId.get(DESKTOP)?.size?.y } },
  nodes, childrenOf: Object.fromEntries([...kidsOf.entries()].filter(([k]) => inSubtree.has(k))),
}));
console.error(`desktop.json: ${(JSON.stringify(nodes).length / 1048576).toFixed(1)}MB, nodes=${nodes.length}`);
