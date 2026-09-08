/**
 * Pipeline C, stage 3 — assemble an editable source package.
 *
 * The replay reproduces the site exactly, but it is data + runtime, not code
 * you can refactor. This packs what *is* real source:
 *
 *   code/          CODE_FILE.sourceCode from the multiplayer wire — genuine
 *                  TSX/TS, unminified, with imports and logic intact.
 *   components/    compiledCode (esbuild output of the code layers) and
 *                  globalStyles (Tailwind), taken from the preview bundle.
 *   interactions/  every node carrying `interactions`, flattened to a table:
 *                  event type, action, transition target, easing, duration.
 *   design/        per-route node inventory: text content, geometry, fills.
 *
 * `code/manifest.json` ties them together: virtual filesystem path ->
 * CODE_FILE guid -> emitted file, plus each CODE_INSTANCE's `codeExportName`
 * so a component on the canvas can be traced to its source.
 *
 *   node src/kiwi/pack-source.mjs <captureDir> <wireScenegraph.json> [outDir]
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const log = (...a) => console.error('[pack-source]', ...a);
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);

/** Wire guids are {sessionID, localID}; scene bundles use "sid:lid" strings. */
const guidStr = (g) =>
  g && typeof g === 'object' && 'sessionID' in g ? `${g.sessionID}:${g.localID}` : String(g ?? '');

function collectInteractions(bundle, route) {
  const rows = [];
  for (const [id, node] of Object.entries(bundle.nodeById || {})) {
    const its = node.interactions;
    if (!its || !its.length) continue;
    for (const it of its) {
      for (const action of it.actions || []) {
        rows.push({
          route,
          nodeId: id,
          nodeName: node.name || null,
          nodeType: node.type || null,
          event: it.event?.interactionType || null,
          connection: action.connectionType || null,
          navigation: action.navigationType || null,
          target: guidStr(action.transitionNodeID) || null,
          targetUrl: action.connectionURL || null,
          transition: action.transitionType || null,
          duration: action.transitionDuration ?? null,
          easing: action.easingType || null,
        });
      }
    }
  }
  return rows;
}

export async function packSource({ captureDir, wirePath, outDir }) {
  captureDir = captureDir || 'rehearsal/preview-capture';
  outDir = outDir || 'rehearsal/source-package';
  mkdirSync(path.join(outDir, 'code'), { recursive: true });
  mkdirSync(path.join(outDir, 'components'), { recursive: true });
  mkdirSync(path.join(outDir, 'interactions'), { recursive: true });
  mkdirSync(path.join(outDir, 'design'), { recursive: true });

  // ---- 1. CODE_FILE source from the wire ---------------------------------
  const emitted = {};
  const byGuid = {};
  if (wirePath && existsSync(wirePath)) {
    const wire = JSON.parse(readFileSync(wirePath, 'utf8'));
    const nodes = wire.nodeChanges || wire.nodes || [];
    for (const n of nodes) {
      if (n?.type !== 'CODE_FILE' || !n.sourceCode) continue;
      const name = String(n.name || 'code.ts');
      const id = sha(name + n.sourceCode);
      const file = `${id}-${name}`;
      if (!emitted[file]) {
        writeFileSync(path.join(outDir, 'code', file), n.sourceCode);
        emitted[file] = { name, bytes: n.sourceCode.length, guids: [] };
      }
      const g = guidStr(n.guid);
      emitted[file].guids.push(g);
      byGuid[g] = file;
    }
    log(`code files: ${Object.keys(emitted).length} unique from ${nodes.length} wire nodes`);
  } else {
    log('no wire scenegraph supplied — code/ will be empty (run `kiwi sync` first)');
  }

  // ---- 2. Bundles: components, interactions, design inventory ------------
  const bundleFiles = readdirSync(captureDir).filter((f) => /^bundle_.*\.json$/.test(f));
  const allInteractions = [];
  const routeSummary = [];
  const vfs = {};
  const instances = [];
  let wroteComponents = false;

  for (const bf of bundleFiles) {
    const bundle = JSON.parse(readFileSync(path.join(captureDir, bf), 'utf8'));
    const rootGuid = (bundle.roots || [])[0];
    const route = (bundle.guidToUrl || {})[rootGuid] || '/';

    if (!wroteComponents && (bundle.compiledCode || bundle.globalStyles)) {
      if (bundle.compiledCode) {
        writeFileSync(path.join(outDir, 'components', `${bundle.sourceCodeHash || 'compiled'}.js`), bundle.compiledCode);
      }
      if (bundle.globalStyles) {
        writeFileSync(path.join(outDir, 'components', `${bundle.sourceCodeHash || 'global'}.css`), bundle.globalStyles);
      }
      Object.assign(vfs, bundle.codeFilesystemMetadata || {});
      wroteComponents = true;
    }

    allInteractions.push(...collectInteractions(bundle, route));

    for (const [id, n] of Object.entries(bundle.nodeById || {})) {
      if (n.type === 'CODE_INSTANCE') {
        instances.push({ route, nodeId: id, exportName: n.codeExportName || null, size: n.size || null, name: n.name || null });
      }
    }

    const texts = [];
    for (const [id, n] of Object.entries(bundle.nodeById || {})) {
      if (n.type === 'TEXT' && n.characters) {
        texts.push({ id, text: n.characters, size: n.size || null, style: n.style?.fontSize ? { fontSize: n.style.fontSize, fontFamily: n.style.fontFamily, weight: n.style.fontWeight } : null });
      }
    }
    const name = route === '/' ? '_index' : route.replace(/^\//, '').replace(/\//g, '_');
    writeFileSync(path.join(outDir, 'design', `${name}.json`), JSON.stringify({
      route, rootGuid, nodes: Object.keys(bundle.nodeById || {}).length, texts,
    }, null, 1));
    routeSummary.push({ route, nodes: Object.keys(bundle.nodeById || {}).length, texts: texts.length });
  }

  // ---- 3. Manifest tying the layers together -----------------------------
  const vfsMapped = Object.entries(vfs).map(([vpath, v]) => ({
    virtualPath: vpath,
    codeFileGuid: v.codeFileNodeGUID || null,
    sourceFile: byGuid[v.codeFileNodeGUID] || null,
  }));
  writeFileSync(path.join(outDir, 'code', 'manifest.json'), JSON.stringify({
    files: emitted, virtualFilesystem: vfsMapped, codeInstances: instances,
    note: 'virtualPath is how the runtime addresses the file; sourceFile is the emitted copy in this folder.',
  }, null, 2));

  writeFileSync(path.join(outDir, 'interactions', 'interactions.json'), JSON.stringify(allInteractions, null, 1));
  const byEvent = allInteractions.reduce((a, r) => { a[r.event || 'none'] = (a[r.event || 'none'] || 0) + 1; return a; }, {});

  writeFileSync(path.join(outDir, 'README.md'), `# Source package

Extracted from a Figma Sites file. Three layers, most editable first.

## code/
Real \`CODE_FILE\` source pulled off the multiplayer wire — unminified TSX/TS
with imports and logic intact. ${Object.keys(emitted).length} unique files.
\`manifest.json\` maps each runtime virtual path to its emitted copy and lists
every \`CODE_INSTANCE\` with its \`codeExportName\`, so a component placed on the
canvas can be traced back to source.

Files importing \`figma:react\` only run inside Figma's runtime; ones importing
plain \`react\` are portable as-is.

## components/
\`compiledCode\` (esbuild bundle of the code layers) and \`globalStyles\`
(Tailwind) exactly as the runtime receives them. Use when you need the built
artefact rather than sources.

## interactions/
Every node carrying \`interactions\`, flattened: event, action, transition
target, easing, duration. ${allInteractions.length} rows.
Events seen: ${JSON.stringify(byEvent)}

The replay site reproduces these natively — it runs the same \`SitesRuntime\`,
so hover/click/smart-animate behave as designed without reimplementation.
This table is for porting them somewhere else.

## design/
Per-route node inventory: text content with geometry and type styles.
Routes: ${routeSummary.map((r) => `${r.route} (${r.nodes} nodes, ${r.texts} texts)`).join(', ')}
`);

  const report = { outDir, codeFiles: Object.keys(emitted).length, interactions: allInteractions.length, byEvent, routes: routeSummary, codeInstances: instances.length };
  writeFileSync(path.join(outDir, 'pack-report.json'), JSON.stringify(report, null, 2));
  log(`done: ${report.codeFiles} code files, ${report.interactions} interactions, ${routeSummary.length} routes -> ${outDir}`);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  packSource({ captureDir: process.argv[2], wirePath: process.argv[3], outDir: process.argv[4] })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error('[pack-source:FAIL]', e?.stack || e); process.exit(1); });
}
