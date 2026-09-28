import type { AgentRunSpec } from "../types.js";

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
  }): boolean {
    const checkpoint = session.metadata[LegacyCheckpoint._RUNTIME_CHECKPOINT_KEY];
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
      return false;
    }

    const cp = checkpoint as Record<string, unknown>;
    const assistantMessage = cp['assistant_message'] as Record<string, unknown> | undefined;
    const completedToolResults = (cp['completed_tool_results'] as Record<string, unknown>[]) || [];
    const pendingToolCalls = (cp['pending_tool_calls'] as Record<string, unknown>[]) || [];

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

    // Backfill interrupted tool calls
    for (const toolCall of pendingToolCalls) {
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
        const leftKey = LegacyCheckpoint._checkpointMessageKey(existing[i]);
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
    session.messages.push(...restoredMessages.slice(overlap));

    // Clear checkpoint after restoring
    this._clearRuntimeCheckpoint(session);

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
    await spec.checkpointCallback(payload);
  }
}

