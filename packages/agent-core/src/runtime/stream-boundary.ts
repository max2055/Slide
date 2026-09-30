import { randomUUID } from 'node:crypto';
import type { AgentHookContext } from '../types.js';
import { RuntimeError } from './recovery-policy.js';

export interface StreamAnchor {
  checkpointId: string;
  sourceRequestId?: string;
  source: 'checkpoint';
  text: string;
  reasoning: string;
  messageIds: string[];
}
export interface StreamSnapshot {
  schemaVersion: 1;
  attempt: number;
  sequence: number;
  discardedBytes: number;
  /** A crashed active attempt may have emitted bytes after its last checkpoint. */
  discardedBytesIncomplete?: boolean;
  sourceRequestId?: string;
  anchor: StreamAnchor | null;
}
export interface StreamReset extends StreamSnapshot { reasonCode: string }

/** A callback return is evidence only when a persistence callback actually exists.
 * final_response is response_ready, never a committed assistant transaction. */
export class StreamBoundary {
  state: StreamSnapshot;
  reasoning: string;
  constructor(value?: unknown) {
    if (value === undefined) this.state = { schemaVersion: 1, attempt: 0, sequence: 0, discardedBytes: 0, anchor: null };
    else {
      const s = value as StreamSnapshot;
      if (!s || s.schemaVersion !== 1 || ![s.attempt, s.sequence, s.discardedBytes].every(n => Number.isSafeInteger(n) && n >= 0)
        || (s.discardedBytesIncomplete !== undefined && typeof s.discardedBytesIncomplete !== 'boolean')
        || (s.sourceRequestId !== undefined && typeof s.sourceRequestId !== 'string')
        || (s.anchor !== null && (!s.anchor || s.anchor.source !== 'checkpoint' || typeof s.anchor.checkpointId !== 'string'
          || typeof s.anchor.text !== 'string' || typeof s.anchor.reasoning !== 'string'
          || !Array.isArray(s.anchor.messageIds) || !s.anchor.messageIds.every(id => typeof id === 'string')))) {
        throw new RuntimeError('INVALID_CHECKPOINT', 'Invalid stream boundary checkpoint');
      }
      this.state = structuredClone(s);
    }
    this.reasoning = this.state.anchor?.reasoning ?? '';
  }
  begin(ctx: AgentHookContext): void {
    this.state.attempt++;
    this.state.sourceRequestId = randomUUID();
    ctx.streamAttempt = this.state.attempt;
    ctx.sourceRequestId = this.state.sourceRequestId;
    ctx.provisionalBytes = { text: 0, reasoning: 0, tool: 0 };
  }
  snapshot(anchor = this.state.anchor): StreamSnapshot { return structuredClone({ ...this.state, anchor }); }
  proposedAnchor(checkpointId: string, text: string, messageIds: string[] = []): StreamAnchor {
    return { checkpointId, sourceRequestId: this.state.sourceRequestId, source: 'checkpoint', text,
      reasoning: this.reasoning, messageIds: [...new Set([...(this.state.anchor?.messageIds ?? []), ...messageIds])] };
  }
  reset(ctx: AgentHookContext, reasonCode: string): StreamReset {
    this.state.sequence++;
    if (!ctx.streamReset && ctx.provisionalBytes && !ctx.streamedContent && ctx.response?.content) ctx.provisionalBytes.text += Buffer.byteLength(ctx.response.content);
    this.state.discardedBytes += Object.values(ctx.provisionalBytes ?? {}).reduce((sum, n) => sum + n, 0);
    ctx.provisionalBytes = { text: 0, reasoning: 0, tool: 0 };
    this.reasoning = this.state.anchor?.reasoning ?? '';
    return ctx.streamReset = { ...this.snapshot(), reasonCode };
  }
}
