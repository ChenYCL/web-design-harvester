/**
 * document_start MAIN world: patch WebSocket before Figma connects.
 * Use subclass so static constants / instanceof keep working (avoids remount loops).
 */
(() => {
  if (window.__FIGMA_MP_HOOK__) return;
  window.__FIGMA_MP_HOOK__ = true;

  const Native = window.WebSocket;
  // Keep a pristine reference for our own full-sync socket.
  window.__FSE_NATIVE_WS__ = Native;
  class HookedWebSocket extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      try {
        const href = typeof url === 'string' ? url : url && url.url ? String(url.url) : String(url || '');
        if (/multiplayer/i.test(href)) {
          window.__FSE_LAST_MP__ = href;
          window.postMessage({ source: 'figma-sites-exporter', type: 'MULTIPLAYER_URL', url: href }, '*');
        }
      } catch { /* ignore */ }
    }
  }
  window.WebSocket = HookedWebSocket;
})();
