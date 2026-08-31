// Pipeline B: DOM truth capture — attach to the logged-in editor tab,
// trigger Preview, find the preview iframe target, inject the harvest agent.
import { writeFileSync, readFileSync } from 'fs';

const FILE_KEY = process.argv[2] || 'oqjgSk2zVtR18Z1kXfU2DS';
const OUT = process.argv[3] || 'rehearsal/dom-package/dom.json';
const CDP = 'http://127.0.0.1:9222';

const targets = await fetch(`${CDP}/json`).then(r => r.json());
const tab = targets.find(t => t.type === 'page' && t.url?.includes(FILE_KEY));
if (!tab) { console.error('no editor tab'); process.exit(1); }

const page = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { page.addEventListener('open', res, { once: true }); page.addEventListener('error', rej, { once: true }); });
let id = 1;
const inflight = new Map();
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const i = id++;
  inflight.set(i, { resolve, reject });
  page.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
page.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && inflight.has(m.id)) {
    const { resolve, reject } = inflight.get(m.id);
    inflight.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});

// 1. 编辑器里找 Preview 按钮（Sites 编辑器是 DOM UI）
await cdp('Runtime.enable');
const findBtn = await cdp('Runtime.evaluate', {
  expression: `(() => {
    const btns = [...document.querySelectorAll('button, [role="button"], a')];
    const b = btns.find(x => /preview/i.test(x.getAttribute('aria-label') || '') || /^preview$/i.test(x.textContent.trim()));
    return b ? { found: true, label: b.getAttribute('aria-label') || b.textContent.trim() } : { found: false, candidates: btns.slice(0, 40).map(x => x.getAttribute('aria-label') || x.textContent.trim()).filter(Boolean).slice(0, 20) };
  })()`,
  returnByValue: true,
});
console.error('preview button:', JSON.stringify(findBtn.result.value).slice(0, 300));

if (findBtn.result.value?.found) {
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button, [role="button"], a')];
      const b = btns.find(x => /preview/i.test(x.getAttribute('aria-label') || '') || /^preview$/i.test(x.textContent.trim()));
      b?.click(); return true;
    })()`,
  });
  console.error('clicked preview, waiting for iframe...');
  await new Promise(r => setTimeout(r, 8000));
}

// 2. 列出 iframe 目标（OOPIF 会作为独立 target 出现）
const list = await fetch(`${CDP}/json/list`).then(r => r.json());
const frames = list.filter(t => (t.type === 'iframe' || t.type === 'page') && /figmaiframepreview|figma\.site/.test(t.url));
console.error('frame targets:', frames.map(f => f.url.slice(0, 80)));

if (!frames.length) {
  // 编辑器页面里直接枚举 iframe src
  const iframes = await cdp('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('iframe')].map(f => f.src).filter(s => s)`,
    returnByValue: true,
  });
  console.error('in-page iframes:', JSON.stringify(iframes.result.value));
  writeFileSync('rehearsal/dom-package/probe.json', JSON.stringify({ findBtn: findBtn.result.value, iframes: iframes.result.value }, null, 2));
  process.exit(2);
}

// 3. 注入采集 agent 到 iframe target
const frame = frames[0];
const targetId = frame.id || frame.targetId;
console.error('attaching to', frame.targetId);
const att = await cdp('Target.attachToTarget', { targetId, flatten: true });
console.error('attach result keys:', Object.keys(att || {}));
const sessionId = att.sessionId;
const r1 = await cdp('Runtime.enable', {}, sessionId);
console.error('runtime.enable ok', !!r1);
const agent = readFileSync(new URL('../page-agent.js', import.meta.url), 'utf8');
const inject = await cdp('Runtime.evaluate', {
  expression: agent + '\n;window.__HARVEST__ ? "agent-ok" : "agent-fail"',
  returnByValue: true,
}, sessionId).catch(e => ({ err: e.message }));
console.error('agent inject:', JSON.stringify(inject).slice(0, 200));

const harvest = await cdp('Runtime.evaluate', {
  expression: `window.__HARVEST__ ? JSON.stringify(window.__HARVEST__.outline()) : "no-agent"`,
  returnByValue: true,
}, sessionId).catch(e => ({ result: { value: '{"err":"' + e.message + '"}' } }));
writeFileSync(OUT.replace(/dom\.json$/, 'outline.json'), harvest.result.value ?? '{}');
console.error('outline bytes:', (harvest.result.value || '').length);
page.close();
