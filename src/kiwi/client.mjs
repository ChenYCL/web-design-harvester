// Standalone multiplayer full-sync client.
// Opens our own WebSocket to Figma's multiplayer endpoint with cookies stolen
// from a logged-in Chrome (CDP). A fresh connection (rotated tracking_session_id,
// no reconnect params) makes the server stream the FULL scenegraph:
//   schema frame → JOIN_START → NODE_CHANGES flood → JOIN_END
import { writeFileSync } from 'fs';
import { createRequire } from 'module';
import { randomBytes } from 'node:crypto';
import { isFigWireFrame, isZstd, nid } from './wire.mjs';

const require = createRequire(import.meta.url);

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function loadWs() {
  for (const base of [process.cwd(), `${process.env.HOME}/.cache/figma-kiwi`]) {
    try { return require(require.resolve('ws', { paths: [base] })); } catch { /* try next */ }
  }
  throw new Error('ws package not found — run: npm i ws (or npm run kiwi:setup)');
}

/**
 * Capture a full sync from the multiplayer endpoint.
 * @param {object} opts
 * @param {string} opts.fileKey        Figma file key
 * @param {string} opts.multiplayerUrl The exact WS URL observed from a real
 *                                     editor session (server verifies query
 *                                     params strictly). reconnect-* params are
 *                                     stripped and tracking_session_id rotated.
 * @param {Array}  opts.cookies        figma.com cookies (from cdp.stealCookies)
 * @param {string} opts.outDir        Where to write raw frames
 * @param {number} [opts.timeoutMs]   Default 90s
 * @returns {Promise<{frames:number, dataBytes:number, joinEnd:boolean, schemaFrame:Buffer|null}>}
 */
export function fullSync({ fileKey, multiplayerUrl, cookies, outDir, timeoutMs = 90000 }) {
  const WebSocket = loadWs();
  const newTSID = randomBytes(8).toString('base64url').slice(0, 16);
  const wsUrl = multiplayerUrl
    .replace(/tracking_session_id=[^&]+/, `tracking_session_id=${newTSID}`)
    .replace(/&reconnect-key=[^&]+/, '')
    .replace(/&reconnect-sequence-number=\d+/, '');

  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const ws = new WebSocket(wsUrl, {
    headers: {
      Origin: 'https://www.figma.com',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      Cookie: cookieHeader,
    },
    perMessageDeflate: false,
  });

  return new Promise((resolve, reject) => {
    let frameCount = 0, dataBytes = 0, joinEnd = false, schemaFrame = null;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      err ? reject(err) : resolve({ frames: frameCount, dataBytes, joinEnd, schemaFrame });
    };
    const timer = setTimeout(() => finish(new Error(`fullSync timeout after ${timeoutMs}ms (joinEnd=${joinEnd})`)), timeoutMs);

    ws.on('open', () => { /* streaming begins */ });
    ws.on('error', (e) => finish(e));
    ws.on('close', () => finish(joinEnd ? undefined : new Error('connection closed before JOIN_END')));

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const u8 = new Uint8Array(data);
      const idx = String(frameCount).padStart(4, '0');
      if (outDir) writeFileSync(`${outDir}/fs_${idx}_${u8.length}b.bin`, Buffer.from(data));
      frameCount++;
      if (isFigWireFrame(u8)) { schemaFrame = Buffer.from(data); return; }
      dataBytes += u8.length;
      // JOIN_END 是 12B 裸 Kiwi 帧（无 zstd）——全量 sync 完成标记。
      // 收到即视为完成：稍等让尾部 SIGNAL 帧落盘，然后收尾。
      if (u8.length === 12) {
        joinEnd = true;
        setTimeout(() => finish(undefined), 1500);
      }
    });
  });
}

/** Decode captured frames into raw nodeChanges using a Kiwi decoder. */
export function decodeFrames(frames, decoder, { zstd } = {}) {
  const decompress = zstd || ((u8) => isZstd(u8) ? new Uint8Array(require(require.resolve('fzstd', { paths: [process.env.HOME + '/.cache/figma-kiwi', process.cwd()] })).decompress(u8)) : u8);
  const nodeChanges = [];
  let joinEnd = false;
  for (const frame of frames) {
    const u8 = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (isFigWireFrame(u8)) continue;
    const m = decoder.decodeMessage(decompress(u8));
    if (m.type === 'JOIN_END') joinEnd = true;
    if (m.type === 'NODE_CHANGES') nodeChanges.push(...m.nodeChanges);
  }
  return { nodeChanges, joinEnd };
}

export { nid };
