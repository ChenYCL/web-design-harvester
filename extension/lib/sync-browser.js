/**
 * Browser multiplayer full-sync.
 * Fresh WS (rotated tracking_session_id, no reconnect-*) → schema → JOIN_START → NODE_CHANGES → JOIN_END.
 * Cookies are sent automatically when the extension has host_permissions for figma.com.
 */
import { isFigWireFrame } from './wire.js';

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

/**
 * @param {object} opts
 * @param {string} opts.multiplayerUrl
 * @param {number} [opts.timeoutMs]
 * @param {(p:{frames:number,dataBytes:number,joinEnd:boolean})=>void} [opts.onProgress]
 * @returns {Promise<{frames:Uint8Array[], joinEnd:boolean, schemaFrame:Uint8Array|null, dataBytes:number}>}
 */
export function fullSyncBrowser({ multiplayerUrl, timeoutMs = 120_000, onProgress }) {
  const wsUrl = rotateTrackingSessionId(multiplayerUrl);
  const frames = [];
  let joinEnd = false;
  let schemaFrame = null;
  let dataBytes = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      err ? reject(err) : resolve({ frames, joinEnd, schemaFrame, dataBytes });
    };
    const timer = setTimeout(
      () => finish(new Error(`fullSync timeout after ${timeoutMs}ms (joinEnd=${joinEnd}, frames=${frames.length})`)),
      timeoutMs,
    );

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      finish(e);
      return;
    }
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('error', () => finish(new Error('multiplayer WebSocket error')));
    ws.addEventListener('close', () => {
      finish(joinEnd ? undefined : new Error(`connection closed before JOIN_END (frames=${frames.length})`));
    });
    ws.addEventListener('message', (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const u8 = new Uint8Array(ev.data);
      frames.push(u8);
      if (isFigWireFrame(u8)) {
        schemaFrame = u8;
        onProgress?.({ frames: frames.length, dataBytes, joinEnd });
        return;
      }
      dataBytes += u8.length;
      // JOIN_END is the bare 12-byte Kiwi frame.
      if (u8.length === 12) {
        joinEnd = true;
        onProgress?.({ frames: frames.length, dataBytes, joinEnd });
        setTimeout(() => finish(undefined), 1500);
        return;
      }
      if (frames.length % 5 === 0) onProgress?.({ frames: frames.length, dataBytes, joinEnd });
    });
  });
}
