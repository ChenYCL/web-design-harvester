// Extract CSS-like properties from Figma nodes — both REST API format and
// decoded Kiwi (nodeChange) format. Pure functions.

export function rgbaToCSS(c, opacity) {
  const r = Math.round((c.r || 0) * 255);
  const g = Math.round((c.g || 0) * 255);
  const b = Math.round((c.b || 0) * 255);
  const a = opacity !== undefined ? opacity : (c.a ?? 1);
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(2))})`;
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

const LAYOUT_ALIGN = {
  MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between',
};

export function extractCSSFromAPI(node) {
  const css = {};
  const bb = node.absoluteBoundingBox;
  if (bb) {
    css.width = `${bb.width || 0}px`;
    css.height = `${bb.height || 0}px`;
  }
  if (node.cornerRadius > 0) css['border-radius'] = `${node.cornerRadius}px`;
  else if (node.rectangleCornerRadii) css['border-radius'] = node.rectangleCornerRadii.map(r => `${r}px`).join(' ');
  if (node.opacity != null && node.opacity < 1) css.opacity = String(Number(node.opacity.toFixed(2)));
  if (node.layoutMode) {
    css.display = 'flex';
    css['flex-direction'] = node.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
    if (node.itemSpacing > 0) css.gap = `${node.itemSpacing}px`;
    const pt = node.paddingTop || 0, pr = node.paddingRight || 0, pb = node.paddingBottom || 0, pl = node.paddingLeft || 0;
    if (pt || pr || pb || pl) css.padding = `${pt}px ${pr}px ${pb}px ${pl}px`;
    if (node.primaryAxisAlignItems in LAYOUT_ALIGN) css['justify-content'] = LAYOUT_ALIGN[node.primaryAxisAlignItems];
    if (node.counterAxisAlignItems in LAYOUT_ALIGN) css['align-items'] = LAYOUT_ALIGN[node.counterAxisAlignItems];
  }
  for (const fill of node.fills || []) {
    if (fill.visible === false) continue;
    if (fill.type === 'SOLID') css.background = rgbaToCSS(fill.color, fill.opacity);
    else if (fill.type?.includes('GRADIENT')) {
      const stops = (fill.gradientStops || []).map(s =>
        `${rgbaToCSS(s.color)} ${((s.position ?? 0) * 100).toFixed(0)}%`);
      css.background = fill.type.includes('RADIAL')
        ? `radial-gradient(${stops.join(', ')})`
        : `linear-gradient(${stops.join(', ')})`;
    } else if (fill.type === 'IMAGE') css.background = `url(<image:${fill.imageRef || '?'}>)`;
  }
  for (const s of node.strokes || []) {
    if (s.visible === false) continue;
    if (s.type === 'SOLID') css.border = `${node.strokeWeight || 1}px solid ${rgbaToCSS(s.color, s.opacity)}`;
  }
  const shadows = [];
  for (const e of node.effects || []) {
    if (!e.visible) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const o = e.offset || {};
      shadows.push(`${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${o.x || 0}px ${o.y || 0}px ${e.radius || 0}px ${e.spread || 0}px ${rgbaToCSS(e.color || {})}`);
    } else if (e.type === 'LAYER_BLUR') css.filter = `blur(${e.radius || 0}px)`;
    else if (e.type === 'BACKGROUND_BLUR') css['backdrop-filter'] = `blur(${e.radius || 0}px)`;
  }
  if (shadows.length) css['box-shadow'] = shadows.join(', ');
  const style = node.style || {};
  if (style.fontFamily) css['font-family'] = style.fontFamily;
  if (style.fontSize) css['font-size'] = `${style.fontSize}px`;
  if (style.fontWeight) css['font-weight'] = String(Math.round(style.fontWeight));
  if (style.lineHeightPx) css['line-height'] = `${style.lineHeightPx}px`;
  if (style.letterSpacing) css['letter-spacing'] = `${style.letterSpacing}px`;
  if (node.type === 'TEXT') {
    for (const f of node.fills || []) {
      if (f.type === 'SOLID' && f.visible !== false) { css.color = rgbaToCSS(f.color, f.opacity); delete css.background; break; }
    }
  }
  return css;
}

export function extractCSSFromKiwi(raw) {
  const css = {};
  const size = raw.size;
  if (size) {
    css.width = `${size.x || 0}px`;
    css.height = `${size.y || 0}px`;
  }
  const sm = raw.stackMode;
  if (sm && sm !== 'NONE') {
    css.display = 'flex';
    css['flex-direction'] = sm === 'VERTICAL' ? 'column' : 'row';
  }
  const spacing = raw.stackSpacing;
  if (spacing != null) css.gap = `${spacing}px`;
  const pt = raw.stackVerticalPadding ?? raw.stackPadding ?? 0;
  const pl = raw.stackHorizontalPadding ?? raw.stackPadding ?? 0;
  const pb = raw.stackPaddingBottom ?? pt;
  const pr = raw.stackPaddingRight ?? pl;
  if (pt || pl || pb || pr) css.padding = `${pt}px ${pr}px ${pb}px ${pl}px`;
  if (raw.cornerRadius) css['border-radius'] = `${raw.cornerRadius}px`;
  if (raw.opacity != null && raw.opacity !== 1) css.opacity = String(Number(raw.opacity.toFixed(2)));
  for (const fill of raw.fillPaints || []) {
    if (fill.visible === false || fill.type !== 'SOLID') continue;
    const c = fill.color || {};
    const alpha = (c.a ?? 1) * (fill.opacity ?? 1);
    css.background = alpha < 1
      ? `rgba(${Math.round((c.r || 0) * 255)}, ${Math.round((c.g || 0) * 255)}, ${Math.round((c.b || 0) * 255)}, ${Number(alpha.toFixed(2))})`
      : rgbaToCSS(c, 1);
  }
  const td = raw.textData;
  if (td?.characters) css.text = td.characters.slice(0, 200);
  const fn = raw.fontName;
  if (fn) {
    css['font-family'] = fn.family || '';
    css['font-style'] = fn.style || '';
  }
  if (raw.fontSize) css['font-size'] = `${raw.fontSize}px`;
  const lh = raw.lineHeight;
  if (lh?.value) css['line-height'] = `${lh.value}px`;
  const ls = raw.letterSpacing;
  if (ls?.value) css['letter-spacing'] = ls.units === 'PERCENT' ? `${Number(ls.value.toFixed(1))}%` : `${Number(ls.value.toFixed(2))}px`;
  const ta = raw.textAlignHorizontal;
  if (ta && ta !== 'LEFT') css['text-align'] = ta.toLowerCase();
  const strokes = raw.strokePaints || [];
  const sw = raw.strokeWeight;
  if (sw && strokes.length > 0) {
    css.border = `${sw}px solid ${rgbaToCSS(strokes[0].color || {}, 1)}`;
  }
  return css;
}
