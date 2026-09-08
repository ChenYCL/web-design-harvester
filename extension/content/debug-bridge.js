/**
 * Isolated-world debug bridge. Posts to local debug server.
 * Loaded before editor.js.
 */
(() => {
  const URL = 'http://127.0.0.1:8788/log';
  let enabled = true;
  let seq = 0;

  function send(entry) {
    if (!enabled) return;
    try {
      fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
        keepalive: true,
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  window.__fseDebug = function fseDebug(message, data, level) {
    send({
      seq: ++seq,
      source: 'content-editor',
      message: String(message || ''),
      level: level || 'info',
      data,
      href: location.href,
      ts: Date.now(),
    });
  };
  window.__fseDebug.setEnabled = (on) => {
    enabled = !!on;
  };
  window.__fseDebug.ping = () => {
    send({ source: 'content-editor', message: 'debug_bridge_ping', level: 'info', href: location.href, ts: Date.now() });
  };

  // Announce load
  window.__fseDebug('content_script_loaded', { path: location.pathname }, 'info');
})();
