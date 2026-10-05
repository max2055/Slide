/** Browser-safe derived display state. No IO, clock, tool execution or storage writes. */
import { readMessageParts, type MessagePart, type MessageParts, type PartBoundary } from './message-parts.js';
import type { NormalizedToolEvent, ToolPhase } from './tool-stream.js';
import { boundedToolValue, buildToolPreview } from './tool-stream.js';

export type RunPhase = 'preparing' | 'generating' | 'tools' | 'retrying' | 'saving';
export type RunTerminal = 'completed' | 'partial' | 'cancelled' | 'timed_out' | 'failed';
export interface ProjectedPart { messageId: string; part: MessagePart; factMessageId?: string; }
export interface ProjectionAnchor { id: string; parts: ProjectedPart[]; }
export interface MessageProjection {
  version: 1;
  runId: string;
  attempt: number;
  sequence: number;
  phase: RunPhase;
  runState?: 'running' | 'saving' | RunTerminal;
  parts: ProjectedPart[];
  anchorId?: string;
  terminal?: RunTerminal;
  error?: string;
  durable?: PartBoundary['durable'];
}
export type ProjectionOperation =
  | { type: 'run.status'; phase: RunPhase }
  | { type: 'part.start'; messageId: string; part: MessagePart }
  | { type: 'part.append' | 'part.replace'; partId: string; text: string }
  | { type: 'part.end'; partId: string }
  | { type: 'tool.state' | 'tool.progress'; messageId: string; partId: string; event: NormalizedToolEvent; durable?: PartBoundary['durable'] }
  | { type: 'stream.reset'; anchor: ProjectionAnchor }
  | { type: 'parts.persisted'; documents: ProjectionDocument[] }
  | { type: 'stream.snapshot'; snapshot: MessageProjection }
  | { type: 'run.terminal'; outcome: RunTerminal; durable?: PartBoundary['durable']; error?: string };
export interface ProjectionFrame {
  version: 1;
  runId: string;
  attempt: number;
  sequence: number;
  operations: ProjectionOperation[];
}
/** Display facts deliberately exclude the exact legacy rollback payload. */
export type ProjectionDocument = Omit<MessageParts, 'legacy'>;
export function projectionDocuments(documents: MessageParts[]): ProjectionDocument[] {
  return documents.map(value => {
    const { legacy: _legacy, ...doc } = readMessageParts(value);
    return { ...structuredClone(doc), parts: doc.parts.map(displayPart) };
  });
}
function displayPart(value: MessagePart): MessagePart {
  const part = structuredClone(value);
  if (part.type === 'tool_result') {
    let content = part.content;
    if (typeof content === 'string') { try { content = JSON.parse(content); } catch { /* plain text */ } }
    part.content = buildToolPreview(content, part.toolCallId).text;
  }
  if (part.type === 'tool_call') {
    let args: unknown = part.call.function.arguments;
    try { args = JSON.parse(part.call.function.arguments); } catch { /* legacy display */ }
    const safe = boundedToolValue(args);
    part.call.function.arguments = typeof safe === 'string' ? safe : JSON.stringify(safe);
  }
  return part;
}
const phases: RunPhase[] = ['preparing', 'generating', 'tools', 'retrying', 'saving'];
const terminal: RunTerminal[] = ['completed', 'partial', 'cancelled', 'timed_out', 'failed'];
const ranks: ToolPhase[] = ['planned', 'queued', 'running', 'settled', 'persisted'];
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const ordinal = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const evidence = (v: PartBoundary['durable']) => !!v && ['jsonl', 'mysql', 'checkpoint'].includes(v.kind) && identity(v.reference);
const confirmed = (p: MessagePart) => !!p.durable || p.tool?.phase === 'settled' || p.tool?.phase === 'persisted';

export function createMessageProjection(runId: string): MessageProjection {
  if (!identity(runId)) throw new Error('INVALID_PROJECTION_RUN');
  return { version: 1, runId, attempt: 0, sequence: 0, phase: 'preparing', runState: 'running', parts: [] };
}
function validatePart(entry: ProjectedPart): void {
  if (!identity(entry?.messageId)) throw new Error('INVALID_PROJECTION_PART');
  readMessageParts({ version: 1, id: entry.messageId, role: 'assistant', source: 'fact', status: 'partial', parts: [entry.part], legacy: {} });
  const tool = entry.part.tool;
  if (tool && (!identity(tool.toolCallId) || !identity(tool.name) || !ranks.includes(tool.phase)
    || !Number.isFinite(tool.occurredAt) || tool.occurredAt < 0
    || tool.outcome !== undefined && !['ok', 'error', 'cancelled', 'unknown'].includes(tool.outcome)
    || tool.phase === 'persisted' && !evidence(entry.part.durable))) throw new Error('INVALID_PROJECTION_TOOL');
}
function validateParts(parts: ProjectedPart[]): void {
  if (!Array.isArray(parts)) throw new Error('INVALID_PROJECTION_PARTS');
  const ids = new Set<string>();
  for (const entry of parts) { validatePart(entry); if (ids.has(entry.part.id)) throw new Error('DUPLICATE_PROJECTION_PART'); ids.add(entry.part.id); }
}
export function restoreMessageProjection(value: unknown): MessageProjection {
  const state = value as MessageProjection;
  if (!state || state.version !== 1 || !identity(state.runId) || !ordinal(state.attempt) || !ordinal(state.sequence)
    || !phases.includes(state.phase) || state.runState !== undefined && !['running', 'saving', ...terminal].includes(state.runState)
    || state.terminal !== undefined && !terminal.includes(state.terminal)
    || state.terminal === 'completed' && !evidence(state.durable)) throw new Error('INVALID_PROJECTION_SNAPSHOT');
  validateParts(state.parts);
  return structuredClone(state);
}
function validateOperation(op: ProjectionOperation, runId: string): void {
  if (!op || typeof op !== 'object') throw new Error('INVALID_PROJECTION_OP');
  switch (op.type) {
    case 'run.status': if (!phases.includes(op.phase)) throw new Error('INVALID_PROJECTION_PHASE'); break;
    case 'part.start': validatePart(op); if (op.part.status !== 'partial' || op.part.durable || op.part.generation === 'ended') throw new Error('INVALID_PROJECTION_START'); break;
    case 'part.append': case 'part.replace': if (!identity(op.partId) || typeof op.text !== 'string') throw new Error('INVALID_PROJECTION_TEXT'); break;
    case 'part.end': if (!identity(op.partId)) throw new Error('INVALID_PROJECTION_END'); break;
    case 'tool.state': case 'tool.progress': {
      const e = op.event;
      if (!identity(op.partId) || !identity(op.messageId) || !e || !identity(e.toolCallId) || !identity(e.name)
        || !ranks.includes(e.phase) || !Number.isFinite(e.occurredAt) || e.occurredAt < 0
        || e.outcome !== undefined && !['ok', 'error', 'cancelled', 'unknown'].includes(e.outcome)
        || e.phase === 'persisted' && !evidence(op.durable)) throw new Error('INVALID_PROJECTION_TOOL');
      break;
    }
    case 'stream.reset': if (!identity(op.anchor?.id)) throw new Error('INVALID_PROJECTION_ANCHOR'); validateParts(op.anchor.parts); break;
    case 'parts.persisted':
      if (!Array.isArray(op.documents)) throw new Error('INVALID_PROJECTION_FACTS');
      for (const doc of op.documents) { readMessageParts({ ...doc, legacy: {} }); if (doc.runId !== runId || !evidence(doc.durable)) throw new Error('INVALID_PROJECTION_FACTS'); }
      break;
    case 'stream.snapshot': if (restoreMessageProjection(op.snapshot).runId !== runId) throw new Error('INVALID_PROJECTION_RUN'); break;
    case 'run.terminal': if (!terminal.includes(op.outcome) || op.outcome === 'completed' && !evidence(op.durable)) throw new Error('INVALID_PROJECTION_TERMINAL'); break;
    default: throw new Error('INVALID_PROJECTION_OP');
  }
}

/** One frame = one atomic operation; invalid frames never advance the watermark. */
export function validProjectionFrame(value: unknown, runId: string): value is ProjectionFrame {
  const frame = value as ProjectionFrame;
  if (!frame || frame.version !== 1 || frame.runId !== runId || !ordinal(frame.attempt) || !ordinal(frame.sequence) || !Array.isArray(frame.operations)) return false;
  try { frame.operations.forEach(op => validateOperation(op, runId)); } catch { return false; }
  return true;
}
export function reduceMessageProjection(state: MessageProjection, value: unknown): MessageProjection {
  const frame = value as ProjectionFrame;
  if (!frame || frame.version !== 1 || frame.runId !== state.runId || !ordinal(frame.attempt) || !ordinal(frame.sequence)
    || !Array.isArray(frame.operations) || state.terminal || frame.attempt < state.attempt || frame.sequence <= state.sequence) return state;
  try { frame.operations.forEach(op => validateOperation(op, state.runId)); } catch { return state; }
  const next = structuredClone(state);
  next.attempt = frame.attempt; next.sequence = frame.sequence;
  for (const op of frame.operations) {
    if (next.terminal) break;
    switch (op.type) {
      case 'run.status': next.phase = op.phase; next.runState = op.phase === 'saving' ? 'saving' : 'running'; break;
      case 'part.start':
        if (!next.parts.some(p => p.part.id === op.part.id)) next.parts.push({ messageId: op.messageId, part: { ...structuredClone(op.part), generation: 'open' } });
        break;
      case 'part.append': case 'part.replace': {
        const p = next.parts.find(p => p.part.id === op.partId)?.part;
        if (!p || p.generation !== 'open' || p.durable || p.status !== 'partial' || !['text', 'reasoning', 'tool_input', 'runtime_notice'].includes(p.type) || !('text' in p)) break;
        p.text = op.type === 'part.append' ? (p.text ?? '') + op.text : op.text;
        break;
      }
      case 'part.end': { const p = next.parts.find(p => p.part.id === op.partId)?.part; if (p?.generation === 'open') p.generation = 'ended'; break; }
      case 'tool.state': case 'tool.progress': {
        const e = op.event;
        let row = next.parts.find(p => p.part.id === op.partId);
        if (row && (row.messageId !== op.messageId || row.part.type !== 'tool_call' || row.part.call.id !== e.toolCallId)) break;
        const prior = row?.part.tool;
        if (prior && (prior.name !== e.name || prior.outcome !== undefined && e.outcome !== undefined && prior.outcome !== e.outcome)) break;
        if (prior?.phase === 'persisted') {
          if (e.phase === 'persisted' && prior.persistedAt === undefined) prior.persistedAt = e.occurredAt;
          break;
        }
        if (prior && (ranks.indexOf(e.phase) < ranks.indexOf(prior.phase)
          || ['settled', 'persisted'].includes(prior.phase) && e.phase !== 'persisted')) break;
        if (!row) {
          row = { messageId: op.messageId, part: { id: op.partId, type: 'tool_call', source: 'fact', status: 'partial', generation: 'ended',
            call: { id: e.toolCallId, type: 'function', function: { name: e.name, arguments: JSON.stringify(e.args ?? {}) } } } };
          next.parts.push(row);
        }
        // A complete provider call supersedes its display-only JSON fragments.
        next.parts = next.parts.filter(p => p.part.type !== 'tool_input' || p.part.toolCallId !== e.toolCallId);
        row.part.tool = { ...prior, ...structuredClone(e), outcome: e.outcome ?? prior?.outcome,
          args: e.args ?? prior?.args, preview: e.preview ?? prior?.preview, progress: e.progress ?? prior?.progress, startedAt: prior?.startedAt ?? e.startedAt,
          settledAt: prior?.settledAt ?? (e.phase === 'settled' ? e.occurredAt : undefined),
          persistedAt: prior?.persistedAt ?? (e.phase === 'persisted' ? e.occurredAt : undefined) };
        if (row.part.type === 'tool_call' && e.args) row.part.call.function.arguments = JSON.stringify(e.args);
        if (e.phase === 'persisted') { row.part.durable = structuredClone(op.durable); row.part.status = 'completed'; }
        break;
      }
      case 'stream.reset': {
        // Never remove an acknowledged fact or an already-settled side effect.
        const kept = next.parts.filter(p => confirmed(p.part));
        const anchor = structuredClone(op.anchor.parts);
        next.parts = anchor.map(p => kept.find(k => k.part.id === p.part.id) ?? p);
        // A concurrent settlement may not yet be in this anchor. Preserve its order.
        for (const p of kept) if (!next.parts.some(a => a.part.id === p.part.id)) {
          const original = state.parts.findIndex(a => a.part.id === p.part.id);
          const successor = state.parts.slice(original + 1).find(a => next.parts.some(n => n.part.id === a.part.id));
          const predecessor = state.parts.slice(0, original).reverse().find(a => next.parts.some(n => n.part.id === a.part.id));
          const index = predecessor ? next.parts.findIndex(a => a.part.id === predecessor.part.id) + 1
            : successor ? next.parts.findIndex(a => a.part.id === successor.part.id) : 0;
          next.parts.splice(index, 0, p);
        }
        next.anchorId = op.anchor.id; next.phase = 'retrying'; next.runState = 'running';
        break;
      }
      case 'parts.persisted': {
        for (const doc of op.documents) for (const part of doc.parts) {
          const row: ProjectedPart = { messageId: part.sourceMessageId ?? doc.projectionMessageId ?? doc.id, factMessageId: doc.id,
            part: { ...displayPart(part), generation: 'ended' as const } };
          const i = next.parts.findIndex(p => p.part.id === part.id);
          const priorTool = next.parts[i]?.part.tool;
          if (priorTool && (!row.part.tool || ranks.indexOf(priorTool.phase) >= ranks.indexOf(row.part.tool.phase))) row.part.tool = structuredClone(priorTool);
          if (row.part.tool?.phase === 'settled' && row.part.status === 'completed') row.part.tool.phase = 'persisted';
          if (i < 0) next.parts.push(row);
          else if (!next.parts[i].part.durable || next.parts[i].part.status !== 'completed') next.parts[i] = row;
        }
        break;
      }
      case 'stream.snapshot': {
        const restored = restoreMessageProjection(op.snapshot);
        if (restored.attempt < state.attempt || restored.sequence < state.sequence) break;
        const kept = next.parts.filter(p => confirmed(p.part));
        Object.assign(next, restored, { sequence: frame.sequence, attempt: frame.attempt });
        for (const p of kept) { const i = next.parts.findIndex(n => n.part.id === p.part.id); if (i < 0) next.parts.push(p); else next.parts[i] = p; }
        break;
      }
      case 'run.terminal':
        next.terminal = op.outcome; next.runState = op.outcome; next.error = op.error; next.durable = structuredClone(op.durable);
        for (const p of next.parts) p.part.generation = 'ended';
        break;
    }
  }
  return next;
}

/** Only persisted facts hydrate durable state; malformed/future documents stay legacy-readable. */
export function hydrateMessageProjection(runId: string, documents: MessageParts[]): MessageProjection {
  const state = createMessageProjection(runId);
  let final: MessageParts | undefined;
  for (const value of documents) {
    try {
      const doc = readMessageParts(value);
      if (doc.runId !== runId || !doc.durable || doc.role === 'user' || doc.role === 'system') continue;
      const hydrated = reduceMessageProjection(state, { version: 1, runId, attempt: state.attempt, sequence: state.sequence + 1,
        operations: [{ type: 'parts.persisted', documents: projectionDocuments([doc]) }] });
      Object.assign(state, hydrated);
      if (doc.runTerminal) final = doc;
    } catch { /* original legacy fields remain the caller's fallback */ }
  }
  if (final) { state.terminal = final.runTerminal; state.runState = final.runTerminal; state.durable = structuredClone(final.durable); }
  return state;
}

/** Reuse source IDs/order for a persistence candidate; this function cannot acknowledge it. */
export function projectionMessageParts(state: MessageProjection, messageId: string, legacy: MessageParts['legacy']): MessageParts {
  return { version: 1, id: String(legacy.id ?? messageId), projectionMessageId: messageId, role: legacy.role,
    runId: state.runId, turnId: legacy.turnId, source: legacy.source ?? 'fact', status: 'partial',
    parts: structuredClone(state.parts.filter(p => p.messageId === messageId).map(p => ({ ...p.part, sourceMessageId: p.messageId }))), legacy: structuredClone(legacy) };
}
