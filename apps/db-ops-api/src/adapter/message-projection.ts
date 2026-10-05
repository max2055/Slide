import { createMessageProjection, projectionDocuments, projectionMessageParts, reduceMessageProjection, restoreMessageProjection,
  type MessageProjection, type ProjectionAnchor, type ProjectionFrame, type ProjectionOperation } from '@slide/agent-core/message-projection';
import { boundedToolValue, normalizeToolEvent, TOOL_PREVIEW_LIMIT } from '@slide/agent-core/tool-stream';
import type { MessageParts } from '@slide/agent-core';
import type { ChatEvent } from './types.js';

/** Normalization only. The shared reducer alone decides legal state transitions. */
export class AdapterMessageProjection {
  state: MessageProjection;
  anchor: ProjectionAnchor = { id: 'initial', parts: [] };
  private messageId: string;
  private reasoningPart = 0;
  private inputs = new Map<string, { raw: string | null; characters: number }>();
  constructor(readonly runId: string, snapshot?: unknown) {
    this.state = snapshot ? restoreMessageProjection(snapshot) : createMessageProjection(runId);
    if (this.state.runId !== runId) throw new Error('PROJECTION_RUN_MISMATCH');
    this.messageId = `run_${runId}_assistant`;
    if (snapshot) this.anchor = { id: this.state.anchorId ?? 'recovered', parts: structuredClone(this.state.parts) };
  }
  begin(messageId: string): void { this.messageId = messageId; this.reasoningPart = 0; this.inputs.clear(); }
  get currentMessageId(): string { return this.messageId; }
  private startText(partId: string, type: 'text' | 'reasoning' | 'tool_input', text: string, toolCallId?: string, name?: string): ProjectionOperation[] {
    const existing = this.state.parts.some(p => p.part.id === partId);
    if (existing) {
      const prior = this.state.parts.find(p => p.part.id === partId)?.part;
      const previous = prior && 'text' in prior ? prior.text ?? '' : '';
      if (type === 'text' && text.startsWith(previous)) return [{ type: 'part.append', partId, text: text.slice(previous.length) }];
      return [{ type: type === 'text' ? 'part.replace' : 'part.append', partId, text }];
    }
    const base = { id: partId, source: 'fact' as const, status: 'partial' as const };
    const part = type === 'reasoning' ? { ...base, type, text, format: 'reasoning_content' as const }
      : type === 'tool_input' ? { ...base, type, text, toolCallId: toolCallId!, name } : { ...base, type, text };
    return [{ type: 'part.start', messageId: this.messageId, part }];
  }
  end(): ProjectionOperation[] {
    return this.state.parts.filter(p => p.messageId === this.messageId && p.part.generation === 'open').map(p => ({ type: 'part.end', partId: p.part.id }));
  }
  input(delta: Record<string, unknown>): ProjectionOperation[] {
    const id = typeof delta.id === 'string' ? delta.id : undefined;
    const fn = delta.function as { name?: string; arguments?: string } | undefined;
    if (!id || typeof fn?.arguments !== 'string') return [];
    const input = this.inputs.get(id) ?? { raw: '', characters: 0 };
    input.characters += fn.arguments.length;
    input.raw = input.raw !== null && input.characters <= TOOL_PREVIEW_LIMIT ? input.raw + fn.arguments : null;
    this.inputs.set(id, input);
    // Incomplete JSON cannot be safely redacted by field. Show progress until
    // a full value can use S1's bounded sanitizer; parsing never executes it.
    let text = `参数生成中（${input.characters} 字符）`;
    if (input.raw !== null) { try { text = JSON.stringify(boundedToolValue(JSON.parse(input.raw))); } catch { /* incomplete */ } }
    const partId = `${this.messageId}/input/${id}`;
    if (this.state.parts.some(p => p.part.id === partId)) return [{ type: 'part.replace', partId, text }];
    return this.startText(partId, 'tool_input', text, id, fn.name);
  }
  observe(event: ChatEvent, attempt: number, sequence: number): ProjectionFrame {
    const operations: ProjectionOperation[] = [];
    if (event.type === 'message_parts') operations.push(...event.operations);
    else if (event.type === 'text_delta') {
      if (event.reset) { this.inputs.clear(); operations.push({ type: 'stream.reset', anchor: this.anchor }); }
      else operations.push(...this.startText(event.partId ?? `${this.messageId}/text`, 'text', event.partText ?? event.delta));
    } else if (event.type === 'thinking_delta') {
      const last = this.state.parts.at(-1);
      const id = last?.messageId === this.messageId && last.part.type === 'reasoning' && last.part.generation === 'open'
        ? last.part.id : `${this.messageId}/reasoning/${++this.reasoningPart}`;
      operations.push(...this.startText(id, 'reasoning', event.delta));
    } else if (event.type === 'thinking_end') {
      operations.push(...this.state.parts.filter(p => p.part.type === 'reasoning' && p.part.generation === 'open').map(p => ({ type: 'part.end' as const, partId: p.part.id })));
    } else if (event.type.startsWith('tool_')) {
      const tool = normalizeToolEvent(event);
      if (tool) {
        const prior = this.state.parts.find(p => p.part.type === 'tool_call' && p.part.call.id === tool.toolCallId);
        if (!prior) operations.push(...this.end());
        operations.push({ type: event.type === 'tool_progress' ? 'tool.progress' : 'tool.state', messageId: prior?.messageId ?? this.messageId,
          partId: prior?.part.id ?? `${this.messageId}/tool/${tool.toolCallId}`, event: tool,
          ...(tool.phase === 'persisted' ? { durable: prior?.part.durable } : {}) });
      }
    } else if (event.type === 'complete' || event.type === 'cancelled' || event.type === 'error') {
      if (event.type !== 'complete') operations.push({ type: 'stream.reset', anchor: this.anchor });
      operations.push(...this.end(), { type: 'run.status', phase: 'saving' });
      if (event.type === 'complete' && event.messageParts?.durable) operations.push(
        { type: 'parts.persisted', documents: projectionDocuments([event.messageParts]) },
        { type: 'run.terminal', outcome: 'completed', durable: event.messageParts.durable });
      // Completion stays a candidate until the admission owner's transaction acknowledges it.
      if (event.type !== 'complete') operations.push({ type: 'run.terminal', outcome: event.type === 'cancelled' ? 'cancelled' : event.stopReason === 'timed_out' ? 'timed_out'
        : event.stopReason === 'max_iterations' || event.resolution?.kind === 'partial' ? 'partial' : 'failed',
        ...(event.type === 'error' ? { error: event.error } : {}) });
    }
    const frame: ProjectionFrame = { version: 1, runId: this.runId, attempt, sequence, operations };
    this.state = reduceMessageProjection(this.state, frame);
    return frame;
  }
  document(messageId: string, legacy: MessageParts['legacy']): MessageParts {
    const doc = projectionMessageParts(this.state, messageId, legacy);
    doc.parts = doc.parts.filter(p => p.type !== 'tool_input');
    return doc;
  }
  finalDocument(legacy: MessageParts['legacy'], retract = false): MessageParts {
    const state = retract ? reduceMessageProjection(this.state, { version: 1, runId: this.runId, attempt: this.state.attempt,
      sequence: this.state.sequence + 1, operations: [{ type: 'stream.reset', anchor: this.anchor }] }) : this.state;
    const doc = projectionMessageParts(state, this.messageId, legacy);
    // Prior continuations have no separate canonical assistant fact. Retain
    // their generating identities in the final storage container, in order.
    doc.parts = structuredClone(state.parts.filter(p => !p.factMessageId && p.part.type !== 'tool_input').map(p => ({ ...p.part, sourceMessageId: p.messageId })));
    return doc;
  }
}
