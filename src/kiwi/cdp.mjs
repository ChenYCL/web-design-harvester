// CDP helpers: discover the Figma tab and steal figma.com cookies from a
// Chrome started with --remote-debugging-port=9222. Reuses the user's login.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function getWebSocket() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  for (const base of [process.cwd(), `${process.env.HOME}/.cache/figma-kiwi`]) {
    try { return require(require.resolve('ws', { paths: [base] })); } catch { /* next */ }
  }
  throw new Error('WebSocket 不可用：Node<21 需 npm i ws 或 --experimental-websocket');
}

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';

async function cdpCall(pageWs, id, method, params) {
  pageWs.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        pageWs.removeEventListener('message', h);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    pageWs.addEventListener('message', h);
  });
}

export async function findFigmaTab(fileKey) {
  const targets = await fetch(`${CDP_HTTP}/json`).then(r => r.json());
  if (fileKey) return targets.find(t => t.type === 'page' && t.url?.includes(fileKey));
  return targets.find(t => t.type === 'page' && /figma\.com\/(design|site|make)\//.test(t.url));
}

export async function stealCookies(fileKey) {
  const tab = await findFigmaTab(fileKey);
  if (!tab) throw new Error(`No figma.com tab found${fileKey ? ` for ${fileKey}` : ''} — open the file in Chrome with --remote-debugging-port=9222`);
  const pageWs = new (getWebSocket())(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    pageWs.addEventListener('open', res, { once: true });
    pageWs.addEventListener('error', rej, { once: true });
  });
  let id = 1;
  const cookies = (await cdpCall(pageWs, id++, 'Network.getAllCookies', {})).cookies
    .filter(c => c.domain === 'figma.com' || c.domain === '.figma.com' || c.domain.endsWith('.figma.com'));
  pageWs.close();
  return cookies;
}

export async function observeMultiplayerHandshake(fileKey) {
  // Reload the tab once and capture the exact multiplayer WS URL the editor
  // builds (query params are server-verified; do not reconstruct by hand).
  const tab = await findFigmaTab(fileKey);
  if (!tab) throw new Error(`No figma.com tab found for ${fileKey}`);
  const pageWs = new (getWebSocket())(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    pageWs.addEventListener('open', res, { once: true });
    pageWs.addEventListener('error', rej, { once: true });
  });
  let id = 1;
  const urls = [];
  pageWs.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.webSocketCreated' && /multiplayer/.test(m.params.url)) {
      urls.push(m.params.url);
    }
  });
  await cdpCall(pageWs, id++, 'Network.enable', {});
  await cdpCall(pageWs, id++, 'Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 12000));
  pageWs.close();
  const url = urls.find(u => u.includes(fileKey)) || urls[0];
  if (!url) throw new Error('No multiplayer WebSocket observed after reload');
  return url;
}
