/**
 * Runs in the Figma editor *page world* so WebSocket Origin is https://www.figma.com.
 * Posts progress + base64 frames back via window.postMessage.
 *
 * Usage: content script injects this file's text, then posts START_SYNC.
 */
(() => {
  if (window.__FSE_PAGE_SYNC__) return;
  window.__FSE_PAGE_SYNC__ = true;

  function rotateTrackingSessionId(multiplayerUrl) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += (b % 36).toString(36);
    const newTSID = s.slice(0, 16);
    return multiplayerUrl
      .replace(/tracking_session_id=[^&]+/, `tracking_session_id=${newTSID}`)
      .replace(/&reconnect-key=[^&]+/g, '')
      .replace(/&reconnect-sequence-number=\d+/g, '');
  }

  function u8ToB64(u8) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function emit(payload) {
    window.postMessage({ source: 'figma-sites-exporter', type: 'SYNC_EVENT', ...payload }, '*');
  }

  async function fullSync(multiplayerUrl, timeoutMs) {
    const wsUrl = rotateTrackingSessionId(multiplayerUrl);
    const frames = [];
    let joinEnd = false;
    let dataBytes = 0;
    // Prefer pristine WebSocket — hooked subclass can interfere with full sync.
    const WS = window.__FSE_NATIVE_WS__ || window.WebSocket;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(
        () => finish(new Error(`fullSync timeout (joinEnd=${joinEnd}, frames=${frames.length}, bytes=${dataBytes})`)),
        timeoutMs || 120000,
      );
      emit({ event: 'progress', frames: 0, dataBytes: 0, joinEnd: false, phase: 'ws_connecting' });
      const ws = new WS(wsUrl);
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => {
        emit({ event: 'progress', frames: 0, dataBytes: 0, joinEnd: false, phase: 'ws_open' });
      });
      ws.addEventListener('error', () => finish(new Error('multiplayer WebSocket error')));
      ws.addEventListener('close', (ev) =>
        finish(
          joinEnd
            ? undefined
            : new Error(`closed before JOIN_END (frames=${frames.length}, bytes=${dataBytes}, code=${ev.code})`),
        ),
      );
      ws.addEventListener('message', (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const u8 = new Uint8Array(ev.data);
        frames.push(u8);
        const head = new TextDecoder().decode(u8.subarray(0, Math.min(8, u8.length)));
        if (head !== 'fig-wire') dataBytes += u8.length;
        // JOIN_END is the bare 12-byte Kiwi frame.
        if (u8.length === 12 && head !== 'fig-wire') {
          joinEnd = true;
          emit({ event: 'progress', frames: frames.length, dataBytes, joinEnd: true, phase: 'join_end' });
          setTimeout(() => finish(), 1500);
          return;
        }
        if (frames.length === 1 || frames.length % 4 === 0) {
          emit({ event: 'progress', frames: frames.length, dataBytes, joinEnd, phase: 'recv' });
        }
      });
    });

    emit({
      event: 'done',
      frames: frames.map(u8ToB64),
      dataBytes,
      joinEnd,
    });
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.source !== 'figma-sites-exporter' || d.type !== 'START_PAGE_SYNC') return;
    emit({ event: 'start' });
    fullSync(d.multiplayerUrl, d.timeoutMs).catch((e) => {
      emit({ event: 'error', message: String(e && e.message ? e.message : e) });
    });
  });
})();
