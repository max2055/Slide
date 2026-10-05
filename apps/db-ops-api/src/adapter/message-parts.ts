import { compatibleMessageParts, acknowledgeMessageParts, statusForStopReason, type SessionEntry, type PartBoundary, type PartStatus } from '@slide/agent-core';

export function persistedMessageParts(entry: SessionEntry, kind: 'mysql' | 'checkpoint' | 'jsonl' = 'mysql', requestedStatus?: PartStatus): SessionEntry {
  entry = { ...entry, runId: entry.runId ?? `legacy_run_${entry.id}`, turnId: entry.turnId ?? `legacy_turn_${entry.id}` };
  const stop = entry.metadata?.stopReason ?? (entry.messageParts?.status === 'failed' || entry.messageParts?.status === 'discarded' ? entry.messageParts.status : undefined);
  const status = requestedStatus ?? statusForStopReason(stop);
  const boundary: PartBoundary = { status, durable: { kind, reference: entry.id! } };
  try {
    const result = acknowledgeMessageParts(entry, boundary);
    const stopReason = entry.metadata?.stopReason;
    if (stopReason) result.messageParts.runTerminal = stopReason === 'completed' ? 'completed' : stopReason === 'cancelled' ? 'cancelled'
      : stopReason === 'timed_out' ? 'timed_out' : stopReason === 'max_iterations' ? 'partial' : 'failed';
    return result;
  }
  catch { return compatibleMessageParts(entry, boundary); }
}

/** DB text is the old-reader projection. Metadata parts are optional, never authority for IDs. */
export function recordMessageParts(row: { message_id: string; role: SessionEntry['role']; content: string; metadata?: unknown; created_at?: unknown }, fallback?: { runId: string; turnId: string }): SessionEntry {
  let metadata: Record<string, unknown> = {};
  try { metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown>) ?? {}; } catch { /* legacy text remains readable */ }
  const candidate = metadata.messageParts as SessionEntry['messageParts'];
  const doc = candidate?.version === 1 && candidate.id === row.message_id && candidate.role === row.role && candidate.legacy?.content === row.content ? candidate : undefined;
  const prior = doc?.legacy ?? {};
  return persistedMessageParts({ ...prior, id: row.message_id, role: row.role, content: row.content, source: 'fact',
    runId: typeof metadata.canonicalRunId === 'string' ? metadata.canonicalRunId : doc?.runId ?? fallback?.runId ?? `legacy_run_${row.message_id}`,
    turnId: typeof metadata.canonicalTurnId === 'string' ? metadata.canonicalTurnId : doc?.turnId ?? fallback?.turnId ?? `legacy_turn_${row.message_id}`,
    ...(row.created_at ? { timestamp: new Date(row.created_at as string).toISOString() } : {}),
    ...(metadata.stopReason ? { metadata: { stopReason: metadata.stopReason } } : {}),
    ...(doc ? { messageParts: doc } : {}),
  } as SessionEntry);
}
