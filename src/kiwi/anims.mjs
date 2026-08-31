// Distill animation nodes (KEYFRAME / KEYFRAME_TRACK / ANIMATION_PRESET_INSTANCE)
// from decoded nodeChanges into portable descriptors.

export const ANIM_NODE_TYPES = new Set([
  'KEYFRAME', 'KEYFRAME_TRACK', 'ANIMATION_PRESET_INSTANCE',
]);

function timingValue(v) {
  if (!v) return null;
  const { value, dataType, resolvedDataType } = v;
  const inner = value ?? {};
  return {
    type: resolvedDataType || dataType || null,
    // float / structured values are preserved as-is; only Uint8Array is opaque
    value: typeof inner === 'object' && inner !== null && 'floatValue' in inner
      ? inner.floatValue
      : inner,
  };
}

export function distillKeyframe(nc) {
  if (nc.type !== 'KEYFRAME') return null;
  return {
    id: `${nc.guid.sessionID}:${nc.guid.localID}`,
    type: 'KEYFRAME',
    name: nc.name,
    parent: nc.parentIndex?.guid ? `${nc.parentIndex.guid.sessionID}:${nc.parentIndex.guid.localID}` : null,
    property: nc.overrideKey ? `${nc.overrideKey.sessionID}:${nc.overrideKey.localID}` : null,
    value: nc.keyframeValue ? {
      valueType: nc.keyframeValue.valueType ?? null,
      value: nc.keyframeValue.value?.floatValue ?? nc.keyframeValue.value ?? null,
    } : null,
    easing: nc.easingData?.easingType ?? null,
  };
}

export function distillPresetInstance(nc) {
  if (nc.type !== 'ANIMATION_PRESET_INSTANCE') return null;
  return {
    id: `${nc.guid.sessionID}:${nc.guid.localID}`,
    type: 'ANIMATION_PRESET_INSTANCE',
    name: nc.name,
    presetVersion: nc.version ?? null,
    parent: nc.parentIndex?.guid ? `${nc.parentIndex.guid.sessionID}:${nc.parentIndex.guid.localID}` : null,
    timelineOffset: nc.timelineOffset ?? null,
    // componentPropAssignments carry the timing parameters (duration, delay, …)
    props: (nc.componentPropAssignments || []).map(a => ({
      defID: a.defID ? `${a.defID.sessionID}:${a.defID.localID}` : null,
      ...timingValue(a.varValue),
    })),
    backingCodeComponentId: nc.backingCodeComponentId?.assetRef?.key ?? null,
  };
}

export function distillTrack(nc) {
  if (nc.type !== 'KEYFRAME_TRACK') return null;
  return {
    id: `${nc.guid.sessionID}:${nc.guid.localID}`,
    type: 'KEYFRAME_TRACK',
    name: nc.name,
    parent: nc.parentIndex?.guid ? `${nc.parentIndex.guid.sessionID}:${nc.parentIndex.guid.localID}` : null,
    property: nc.overrideKey ? `${nc.overrideKey.sessionID}:${nc.overrideKey.localID}` : null,
    operation: nc.keyframeOperation ?? null,
  };
}

export function distillAnimations(nodeChanges) {
  const keyframes = [], tracks = [], presets = [];
  for (const nc of nodeChanges) {
    if (nc.type === 'KEYFRAME') { const d = distillKeyframe(nc); if (d) keyframes.push(d); }
    else if (nc.type === 'KEYFRAME_TRACK') { const d = distillTrack(nc); if (d) tracks.push(d); }
    else if (nc.type === 'ANIMATION_PRESET_INSTANCE') { const d = distillPresetInstance(nc); if (d) presets.push(d); }
  }
  return { keyframes, tracks, presets, counts: { keyframes: keyframes.length, tracks: tracks.length, presets: presets.length } };
}
