import { compatibleMessageParts, acknowledgeMessageParts, statusForStopReason, type SessionEntry, type PartBoundary, type PartStatus } from '@slide/agent-core';
import { buildToolPreview, boundedToolValue } from '@slide/agent-core/tool-stream';

export function persistedMessageParts(entry: SessionEntry, kind: 'mysql' | 'checkpoint' | 'jsonl' = 'mysql', requestedStatus?: PartStatus): SessionEntry {
  entry = { ...entry, runId: entry.runId ?? `legacy_run_${entry.id}`, turnId: entry.turnId ?? `legacy_turn_${entry.id}` };
  const stop = entry.metadata?.stopReason ?? (entry.messageParts?.status === 'failed' || entry.messageParts?.status === 'discarded' ? entry.messageParts.status : undefined);
  const status = requestedStatus ?? statusForStopReason(stop);
  const boundary: PartBoundary = { status, durable: { kind, reference: entry.id! } };
  try {
    const result = acknowledgeMessageParts(entry, boundary);
    // checkpointFacts creates legacy tool Parts before DirectAdapter binds the
    // persisted user turn. Its next projection.document adds these same default
    // display identities. Serialize that fallback once, before the first commit,
    // so a later acknowledgement never rewrites an already-committed legacy ID.
    const doc = result.messageParts;
    if (kind === 'checkpoint' && doc.projectionMessageId === undefined
      && doc.runId === entry.runId && (doc.turnId === entry.turnId && doc.legacy.turnId === entry.turnId
        || entry.role === 'tool' && doc.turnId === entry.runId && doc.legacy.turnId === entry.runId)
      && doc.parts.every((part, index) => part.id === `${entry.id}/part/${index}` && part.sourceMessageId === undefined)) {
      doc.turnId = entry.turnId;
      doc.legacy.turnId = entry.turnId;
      doc.projectionMessageId = entry.id;
      doc.parts = doc.parts.map(part => ({ ...part, sourceMessageId: entry.id, generation: part.generation ?? 'ended' }));
    }
    // projectionMessageParts reconstructs the document from acknowledged parts
    // but omits its generating boundary. Preserve the identity already present
    // on every part; explicit document values are never overwritten.
    if (kind === 'checkpoint' && doc.parts.length) {
      for (const key of ['attempt', 'sourceRequestId'] as const) {
        const value = doc.parts[0][key];
        if (doc[key] === undefined && value !== undefined && doc.parts.every(part => part[key] === value)) Object.assign(doc, { [key]: value });
      }
    }
    // ProjectionDocument stores a bounded display preview, not the original
    // tool result. Reconstruct the exact canonical Part only when this is the
    // known display transform of the same raw/legacy fact. Any other content
    // stays intact for canonical-store's full-payload conflict check.
    if (kind === 'checkpoint' && entry.role === 'tool' && doc.legacy.content === entry.content) {
      let content: unknown = entry.content;
      if (typeof content === 'string') { try { content = JSON.parse(content); } catch { /* plain result */ } }
      const preview = buildToolPreview(content, entry.tool_call_id ?? '').text;
      doc.parts = doc.parts.map(part => part.type === 'tool_result' && part.toolCallId === entry.tool_call_id && part.content === preview
        ? { ...part, content: entry.content } : part);
    }
    if (kind === 'checkpoint' && entry.role === 'assistant') {
      doc.parts = doc.parts.map(part => {
        if (part.type !== 'tool_call') return part;
        const call = entry.tool_calls?.find(call => call.id === part.call.id);
        const legacy = doc.legacy.tool_calls?.find(call => call.id === part.call.id);
        if (!call || legacy?.function.arguments !== call.function.arguments || legacy.function.name !== call.function.name || legacy.type !== call.type) return part;
        let args: unknown = call.function.arguments;
        try { args = JSON.parse(call.function.arguments); } catch { /* legacy display */ }
        const safe = boundedToolValue(args);
        const preview = typeof safe === 'string' ? safe : JSON.stringify(safe);
        return part.call.function.arguments === preview
          ? { ...part, call: { ...part.call, function: { ...part.call.function, arguments: call.function.arguments } } } : part;
      });
    }
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
