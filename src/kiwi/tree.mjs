// Build and query a node tree from raw Figma nodeChanges (Kiwi decode output).
import { nid } from './wire.mjs';

export function collectNodes(nodeChanges) {
  const byId = new Map();
  const children = new Map();
  for (const nc of nodeChanges) {
    const id = nid(nc.guid);
    const existing = byId.get(id);
    // Prefer nodes that are actually loaded (have parentIndex) when duplicated.
    if (!existing || (nc.parentIndex && !existing.parentIndex)) byId.set(id, nc);
  }
  for (const nc of byId.values()) {
    const pi = nc.parentIndex;
    if (!pi?.guid) continue;
    const pid = nid(pi.guid);
    if (pid === nid(nc.guid)) continue;
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(nc);
  }
  // Wire order: parentIndex.position is a lexicographic ordering key.
  for (const [, arr] of children) {
    arr.sort((a, b) => {
      const pa = a.parentIndex?.position ?? '';
      const pb = b.parentIndex?.position ?? '';
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }
  return { byId, children };
}

export function childIds({ byId, children }, id) {
  return (children.get(id) || []).map(nc => nid(nc.guid));
}

export function buildTree({ byId, children }) {
  const out = new Map();
  for (const [id, nc] of byId) {
    out.set(id, {
      id,
      name: nc.name ?? '',
      type: nc.type ?? 'UNSET',
      visible: nc.visible !== false,
      children: childIds({ children }, id),
    });
  }
  return out;
}

export function flattenTree(tree, rootId) {
  const seen = [];
  const walk = (id) => {
    const n = tree.get(id);
    if (!n) return;
    seen.push(id);
    for (const c of n.children) walk(c);
  };
  walk(rootId);
  return seen;
}

/** Absolute transform of a node relative to its parent (m02=x, m12=y). */
export function nodeBox(nc) {
  const t = nc.transform || {};
  return {
    x: t.m02 ?? 0,
    y: t.m12 ?? 0,
    w: nc.size?.x ?? 0,
    h: nc.size?.y ?? 0,
  };
}
