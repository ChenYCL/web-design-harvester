// fig-wire frame detection and Kiwi schema extraction.
// Layout: "fig-wire" (8 bytes ASCII) + version (uint32 LE) + zstd-compressed schema.

export function isFigWireFrame(buf) {
  if (buf.length < 12) return false;
  return new TextDecoder().decode(buf.subarray(0, 8)) === 'fig-wire';
}

export function extractCompressedSchema(figWireBuf) {
  if (!isFigWireFrame(figWireBuf)) throw new Error('Not a fig-wire frame');
  return figWireBuf.subarray(12);
}

export function isZstd(buf) {
  return buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
}

export function nid(guid) {
  return `${guid?.sessionID ?? 0}:${guid?.localID ?? 0}`;
}
