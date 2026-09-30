import { RapidRefill } from './rapid-refill.js';
import { validateSummaryRecord } from './auto-compact.js';
import { validateRecoverySnapshot } from "./recovery-policy.js";
import type { AgentRunSpec } from "../types.js";
import { createHash } from 'node:crypto';
import type { SessionEntry } from '../session.js';
import { compatibleMessageParts } from '../message-parts.js';

/** IDs include run and iteration, so identical replies in different turns differ. */
export function checkpointFacts(payload: Record<string, unknown>, scope: string): SessionEntry[] {
  const runId = typeof payload.canonical_run_id === 'string' ? payload.canonical_run_id : scope;
  const turnId = typeof payload.canonical_turn_id === 'string' ? payload.canonical_turn_id : runId;
  const assistant = (payload.assistantMessage ?? payload.assistant_message) as SessionEntry | undefined;
  const results = (payload.completedToolResults ?? payload.completed_tool_results ?? []) as SessionEntry[];
  return [assistant, ...results].filter((m): m is SessionEntry => !!m && (!m.source || m.source === 'fact')).map(m => ({
    ...m, source: 'fact' as const, runId: m.runId ?? runId, turnId: m.turnId ?? turnId,
    id: m.id ?? `cp_${createHash('sha256').update(JSON.stringify([runId, payload.iteration ?? 0,
      m.role, m.role === 'tool' ? m.tool_call_id : m.tool_calls?.map(c => c.id) ?? m.content])).digest('hex')}`,
  })).map(m => compatibleMessageParts(m, { status: 'partial',
    attempt: (payload.stream_state_v1 as { attempt?: number } | undefined)?.attempt,
    sourceRequestId: (payload.stream_state_v1 as { sourceRequestId?: string } | undefined)?.sourceRequestId }));
}

export class LegacyCheckpoint {
  private static readonly _RUNTIME_CHECKPOINT_KEY = 'runtime_checkpoint';

  /**
   * Persist the latest in-flight turn state into session metadata.
   */
  _setRuntimeCheckpoint(session: { metadata: Record<string, unknown> }, payload: Record<string, unknown>): void {
    session.metadata[LegacyCheckpoint._RUNTIME_CHECKPOINT_KEY] = payload;
    // Caller (SessionManager) is responsible for save
  }

  /**
   * Remove the checkpoint after a turn completes or is abandoned.
   */
  _clearRuntimeCheckpoint(session: { metadata: Record<string, unknown> }): void {
    if (LegacyCheckpoint._RUNTIME_CHECKPOINT_KEY in session.metadata) {
      delete session.metadata[LegacyCheckpoint._RUNTIME_CHECKPOINT_KEY];
    }
  }

  /**
   * Build a stable deduplication key for checkpoint messages.
   */
  static _checkpointMessageKey(message: Record<string, unknown>): unknown[] {
    if (message.id) return ['id', message.id];
    return [
      message['role'],
      message['content'],
      message['tool_call_id'],
      message['name'],
      message['tool_calls'],
      message['reasoning_content'],
      message['thinking_blocks'],
    ];
  }

  /**
   * Materialize an unfinished turn into session history before a new request.
   */
  _restoreRuntimeCheckpoint(session: {
    metadata: Record<string, unknown>;
    messages: Record<string, unknown>[];
    sessionKey?: string;
    appendFacts?: (entries: SessionEntry[]) => void;
  }): boolean {
    const checkpoint = session.metadata[LegacyCheckpoint._RUNTIME_CHECKPOINT_KEY];
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
      return false;
    }

    const cp = checkpoint as Record<string, unknown>;
    if (cp.context_state_v1 !== undefined) new RapidRefill(cp.context_state_v1);
    if (cp.context_summary_v1 !== undefined) validateSummaryRecord(cp.context_summary_v1);
    if (cp.runtime_state_v1 !== undefined) validateRecoverySnapshot(cp.runtime_state_v1);
    if (cp.messages_restored === true) return false;
    // A response_ready checkpoint is a candidate; completion transaction/file
    // finalization alone may promote it to canonical assistant history.
    if (cp.stream_state_v1 && cp.phase === 'final_response') { cp.messages_restored = true; return false; }
    const assistantMessage = (cp['assistant_message'] ?? cp['assistantMessage']) as Record<string, unknown> | undefined;
    const completedToolResults = ((cp['completed_tool_results'] ?? cp['completedToolResults']) as Record<string, unknown>[]) || [];
    const pendingToolCalls = ((cp['pending_tool_calls'] ?? cp['pendingToolCalls']) as Record<string, unknown>[]) || [];

    const restoredMessages: Record<string, unknown>[] = [];

    // Restore assistant message
    if (assistantMessage && typeof assistantMessage === 'object') {
      const restored: Record<string, unknown> = { ...assistantMessage };
      if (!restored['timestamp']) {
        restored['timestamp'] = new Date().toISOString();
      }
      restoredMessages.push(restored);
    }

    // Restore completed tool results
    for (const msg of completedToolResults) {
      if (msg && typeof msg === 'object') {
        const restored: Record<string, unknown> = { ...msg };
        if (!restored['timestamp']) {
          restored['timestamp'] = new Date().toISOString();
        }
        restoredMessages.push(restored);
      }
    }

    // Legacy plain-object consumers retain their projection-only compatibility.
    // Canonical Session stores only returned facts; normalize generates placeholders.
    for (const toolCall of pendingToolCalls) {
      if (session.appendFacts) continue;
      if (!toolCall || typeof toolCall !== 'object') continue;
      const toolId = toolCall['id'] as string | undefined;
      const func = toolCall['function'] as Record<string, unknown> | undefined;
      const name = (func?.['name'] as string) || 'tool';
      restoredMessages.push({
        role: 'tool',
        tool_call_id: toolId,
        name,
        content: '[Task interrupted before this tool finished.]',
        timestamp: new Date().toISOString(),
      });
    }

    // Deduplicate: find overlap between existing messages suffix and restored prefix
    let overlap = 0;
    const maxOverlap = Math.min(session.messages.length, restoredMessages.length);
    for (let size = maxOverlap; size > 0; size--) {
      const existing = session.messages.slice(-size);
      const restored = restoredMessages.slice(0, size);
      let allMatch = true;
      for (let i = 0; i < size; i++) {
        const leftKey = LegacyCheckpoint._checkpointMessageKey(restored[i].id ? existing[i] : { ...existing[i], id: undefined });
        const rightKey = LegacyCheckpoint._checkpointMessageKey(restored[i]);
        if (JSON.stringify(leftKey) !== JSON.stringify(rightKey)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        overlap = size;
        break;
      }
    }

    // Append only non-overlapping messages
    if (session.appendFacts) {
      const facts = checkpointFacts(cp, `legacy_checkpoint_${session.sessionKey ?? ''}_${JSON.stringify(LegacyCheckpoint._checkpointMessageKey(assistantMessage ?? {}))}`);
      // ID-less legacy checkpoints may overlap the end of pre-migration history.
      session.appendFacts(facts.slice(assistantMessage?.id ? 0 : overlap));
    } else session.messages.push(...restoredMessages.slice(overlap));

    // Legacy callers retain their clear-on-restore contract. New ledgers survive;
    // materialized evidence must not be appended again after another user message.
    if (cp.runtime_state_v1 === undefined) this._clearRuntimeCheckpoint(session);
    else cp.messages_restored = true;

    return restoredMessages.length > 0;
  }

  /**
   * Convenience: restore checkpoint and return messages.
   * Callers feed this into LegacyCheckpoint.run() as initialMessages.
   */
  _restoreRuntimeCheckpointForMessages(session: {
    metadata: Record<string, unknown>;
    messages: Record<string, unknown>[];
  }): Array<{ role: string; content: string | null }> {
    this._restoreRuntimeCheckpoint(session);
    // Cast SessionEntry[] to Message[]
    return session.messages.map(m => ({
      role: (m['role'] as string) || 'user',
      content: (m['content'] as string | null) || null,
    }));
  }
}

export async function emitCheckpoint(
  spec: AgentRunSpec,
  payload: Record<string, unknown>
): Promise<void> {
  if (spec.checkpointCallback) {
    const scope = spec.runtimeRunId ?? spec.idempotencyKey ?? spec.sessionKey ?? 'legacy';
    const facts = checkpointFacts(payload, scope);
    const next: Record<string, unknown> = { ...payload, canonical_run_id: scope };
    if (payload.assistantMessage) next.assistantMessage = facts.find(m => m.role === 'assistant');
    if (payload.completedToolResults) next.completedToolResults = facts.filter(m => m.role === 'tool');
    await spec.checkpointCallback(next);
  }
}
