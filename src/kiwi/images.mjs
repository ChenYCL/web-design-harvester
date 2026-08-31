// Collect image-fill hashes from decoded nodeChanges and resolve them to
// downloadable URLs via the REST /v1/files/{key}/images endpoint — which,
// unlike the node endpoints, works for Figma Sites files (verified 200).
import { createHash } from 'crypto';

const SHA1_RE = /\b[0-9a-f]{40}\b/;

function paintHash(p) {
  // Wire 真值：fillPaints[].image.hash 是 20 字节原始 sha1，hex 编码后即
  // REST /v1/files/{key}/images 映射的键（91/91 实测命中）。
  const h = p?.image?.hash ?? p?.imageHash;
  if (h instanceof Uint8Array || h instanceof Buffer) {
    return h.length === 20 ? Buffer.from(h).toString('hex') : null;
  }
  if (typeof h === 'string' && /^[0-9a-f]{40}$/.test(h)) return h;
  return null;
}

export function collectImageHashes(nodeChanges) {
  const hashes = new Set();
  const byNode = new Map();
  const add = (h, id) => {
    if (!h) return;
    hashes.add(h);
    if (!byNode.has(h)) byNode.set(h, new Set());
    byNode.get(h).add(id);
  };
  const scanPaints = (paints, id) => {
    for (const p of paints || []) add(paintHash(p), id);
  };
  for (const nc of nodeChanges) {
    const id = `${nc.guid?.sessionID ?? 0}:${nc.guid?.localID ?? 0}`;
    scanPaints(nc.fillPaints, id);
    scanPaints(nc.strokePaints, id);
  }
  return { hashes: [...hashes], byNode };
}

export async function fetchImageMap(fileKey, token = process.env.FIGMA_TOKEN) {
  if (!token) throw new Error('FIGMA_TOKEN not set');
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/images`, {
    headers: { 'X-FIGMA-TOKEN': token },
  });
  if (!res.ok) throw new Error(`REST /images failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  const body = await res.json();
  if (body.error || body.status !== 200) throw new Error(`REST /images error: ${JSON.stringify(body).slice(0, 200)}`);
  return body.meta.images; // { sha1: signedUrl }
}

export async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, sha1: createHash('sha1').update(buf).digest('hex') };
}
