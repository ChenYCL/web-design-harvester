// kiwi pack — 无损产物打包器
// 输入：捕获的 wire 帧（fullsync/*.bin）
// 输出：rehearsal/kiwi-package/
//   scenegraph.full.json   全部节点（Uint8Array→{__bytes:base64} 可逆），含消息级 blobs
//   vectors.json           guid → SVG path（几何 blob 确定性解码，格式转换非裁剪）
//   site.json              responsiveSetSettings 站点元数据
//   animations.json        全部 KEYFRAME/TRACK/PRESET 原始节点
//   code/*.tsx|ts          CODE_FILE 源码
//   images.json + assets/  hash→URL→下载字节
//   tree.json              id→children 索引（纯机械索引）
// 规则：不 prune、不限深度、不选字段。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { getDecoder } from './decoder.mjs';
import { extractCompressedSchema, isZstd, nid } from './wire.mjs';
import { commandsBlobToPath } from './svg.mjs';
import { collectImageHashes, fetchImageMap, downloadImage } from './images.mjs';
import { createRequire } from 'module';
import { homedir } from 'os';

const require = createRequire(import.meta.url);
const FILE_KEY = process.env.FIGMA_FILE_KEY || 'oqjgSk2zVtR18Z1kXfU2DS';
const FRAME_DIR = process.env.FIGMA_KIWI_FULLSYNC_DIR || '/tmp/figma_kiwi_sites/fullsync';
const OUT = process.env.KIWI_PACKAGE_DIR || 'rehearsal/kiwi-package';

const require2 = (id) => require(require.resolve(id, { paths: [`${homedir()}/.cache/figma-kiwi`, process.cwd()] }));

// ---- 1. 解码全部帧 ----
const decoder = await getDecoder(new Uint8Array(extractCompressedSchema(
  new Uint8Array(readFileSync(`${process.env.FIGMA_KIWI_FIXTURES || 'test/kiwi/fixtures'}/schema_frame.bin`)))));
const fzstd = require2('fzstd');

let nodeChanges = [], blobs = [], joinEnd = false;
for (const f of readdirSync(FRAME_DIR).filter(f => /^fs_/.test(f)).sort()) {
  const wire = new Uint8Array(readFileSync(`${FRAME_DIR}/${f}`));
  if (wire[0] === 0x66 && wire[1] === 0x69 && wire[2] === 0x67) continue; // fig-wire schema
  const raw = isZstd(wire) ? new Uint8Array(fzstd.decompress(wire)) : wire;
  const m = decoder.decodeMessage(raw);
  if (m.type === 'NODE_CHANGES') { nodeChanges.push(...m.nodeChanges); blobs.push(...(m.blobs || [])); }
  if (m.type === 'JOIN_END') joinEnd = true;
}
if (!joinEnd) throw new Error('JOIN_END missing — capture incomplete');
console.error(`decoded: ${nodeChanges.length} nodeChanges, ${blobs.length} blobs`);

// ---- 2. 无损序列化 ----
const replacer = (k, v) => {
  if (v instanceof Uint8Array || v instanceof Buffer) return { __bytes: Buffer.from(v).toString('base64') };
  if (typeof v === 'bigint') return { __bigint: String(v) };
  return v;
};
mkdirSync(`${OUT}/code`, { recursive: true });
mkdirSync(`${OUT}/assets`, { recursive: true });
writeFileSync(`${OUT}/scenegraph.full.json`, JSON.stringify({ nodeChanges, blobs }, replacer));

// ---- 3. 树索引（机械） ----
const byId = new Map(), children = new Map();
for (const nc of nodeChanges) {
  const id = nid(nc.guid);
  if (!byId.has(id) || (nc.parentIndex && !byId.get(id).parentIndex)) byId.set(id, nc);
}
for (const nc of byId.values()) {
  const pi = nc.parentIndex;
  if (!pi?.guid) continue;
  const pid = nid(pi.guid);
  if (pid === nid(nc.guid)) continue;
  if (!children.has(pid)) children.set(pid, []);
  children.get(pid).push(nid(nc.guid));
}
for (const [, arr] of children) {
  arr.sort((a, b) => {
    const pa = byId.get(a).parentIndex?.position ?? '', pb = byId.get(b).parentIndex?.position ?? '';
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
}
writeFileSync(`${OUT}/tree.json`, JSON.stringify(Object.fromEntries(children)));

// ---- 4. 矢量几何：blob 索引 → SVG path（确定性转换） ----
const vectors = {};
for (const nc of byId.values()) {
  if (!nc.fillGeometry?.length) continue;
  const paths = [];
  for (const g of nc.fillGeometry) {
    const bytes = Number.isInteger(g?.commandsBlob) ? blobs[g.commandsBlob]?.bytes : g?.commandsBlob;
    if (!bytes || bytes.length < 4) continue;
    try { const d = commandsBlobToPath(bytes); if (d) paths.push(d); } catch { /* keep others */ }
  }
  if (paths.length) vectors[nid(nc.guid)] = paths;
}
writeFileSync(`${OUT}/vectors.json`, JSON.stringify(vectors));
console.error(`vectors: ${Object.keys(vectors).length}`);

// ---- 5. 站点元数据 / 动效 / 代码 ----
const siteRoot = [...byId.values()].find(n => n.type === 'RESPONSIVE_SET' && n.responsiveSetSettings);
writeFileSync(`${OUT}/site.json`, JSON.stringify(siteRoot?.responsiveSetSettings ?? {}, replacer, 2));

const anims = nodeChanges.filter(n => ['KEYFRAME', 'KEYFRAME_TRACK', 'ANIMATION_PRESET_INSTANCE'].includes(n.type));
writeFileSync(`${OUT}/animations.json`, JSON.stringify(anims, replacer, 1));

const seenCode = new Set();
for (const nc of byId.values()) {
  if (nc.type !== 'CODE_FILE' || !nc.sourceCode?.length) continue;
  const key = nc.name + ':' + nc.sourceCode.length;
  if (seenCode.has(key)) continue;
  seenCode.add(key);
  writeFileSync(`${OUT}/code/${nc.name}`, nc.sourceCode);
}

// ---- 6. 图片 ----
const { hashes } = collectImageHashes([...byId.values()]);
try {
  const map = await fetchImageMap(FILE_KEY);
  const entries = {};
  for (const h of hashes) if (map[h]) entries[h] = map[h];
  writeFileSync(`${OUT}/images.json`, JSON.stringify(entries, null, 1));
  let ok = 0;
  for (const [h, url] of Object.entries(entries)) {
    if (existsSync(`${OUT}/assets/${h}.png`)) { ok++; continue; }
    try { const { buf } = await downloadImage(url); writeFileSync(`${OUT}/assets/${h}.png`, buf); ok++; } catch (e) { console.error('dl fail', h.slice(0, 8)); }
  }
  console.error(`assets: ${ok}/${hashes.length}`);
} catch (e) { console.error('images skipped:', e.message.slice(0, 80)); }

console.error(`package → ${OUT}`);
