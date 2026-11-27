/** Full maintenance scope belongs to the authorized history API/internal audit only.
 * Apply on reads too: alerts written before this fix may contain full revisions. */
export function publicMaintenanceTags(raw: any) {
  let tags: any;
  try { tags = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
  if (!tags || typeof tags !== 'object') return tags;
  const { manual_silence_suppressed: _internalSilence, ...publicTags } = tags;
  return { ...publicTags, ...(tags.maintenance ? { maintenance: {
    state: tags.maintenance.state, at: tags.maintenance.at,
  } } : {}) };
}
