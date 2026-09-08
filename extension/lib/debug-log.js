/**
 * Fire-and-forget debug logger → local debug server.
 * Safe no-op if server is down.
 */
const DEBUG_URL = 'http://127.0.0.1:8788/log';
const DEFAULT_ON = true;

let enabled = DEFAULT_ON;
let seq = 0;
const queue = [];
let flushing = false;

export function setDebugEnabled(on) {
  enabled = !!on;
}

export function isDebugEnabled() {
  return enabled;
}

export function debugLog(source, message, data, level = 'info') {
  if (!enabled) return;
  const entry = {
    seq: ++seq,
    source,
    message: String(message || ''),
    level,
    data: data === undefined ? undefined : data,
    href: typeof location !== 'undefined' ? location.href : undefined,
    ts: Date.now(),
  };
  queue.push(entry);
  if (queue.length > 100) queue.shift();
  flushSoon();
}

function flushSoon() {
  if (flushing) return;
  flushing = true;
  setTimeout(flush, 0);
}

async function flush() {
  flushing = false;
  if (!enabled || !queue.length) return;
  const batch = queue.splice(0, queue.length);
  try {
    await fetch(DEBUG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.length === 1 ? batch[0] : batch),
      // extension SW / content script
      keepalive: true,
    });
  } catch {
    // server down — drop silently (avoid log storms)
  }
}

/** Content-script friendly global (non-module). */
export function installGlobalDebug(globalName = '__FSE_DEBUG__') {
  const api = {
    log: (message, data, level) => debugLog('page', message, data, level),
    setEnabled: setDebugEnabled,
    enabled: () => enabled,
  };
  if (typeof globalThis !== 'undefined') globalThis[globalName] = api;
  return api;
}
