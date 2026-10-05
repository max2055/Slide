/** Pure browser-safe display contract. Execution facts remain owned by checkpoints. */
export type ToolPhase = 'planned' | 'queued' | 'running' | 'settled' | 'persisted';
export type ToolOutcome = 'ok' | 'error' | 'cancelled' | 'unknown';
export interface ToolPreview {
  kind: 'text' | 'json';
  text: string;
  truncated: boolean;
  /** Resolve only through the actor-authorized session history; never a public URL. */
  detailsRef?: { kind: 'tool-call'; toolCallId: string };
}
export interface ToolLifecycleEvent {
  toolCallId: string;
  toolName: string;
  phase: ToolPhase;
  occurredAt: number;
  outcome?: ToolOutcome;
  args?: Record<string, unknown>;
  result?: unknown;
  progress?: Record<string, unknown>;
}
// Optional identity is solely the pre-S1 wire compatibility boundary. It is never
// synthesized by tool name: normalizeToolEvent rejects unidentified legacy frames.
type WireIdentity = { toolCallId?: string; toolName: string; occurredAt?: number; outcome?: ToolOutcome; preview?: ToolPreview };
export type ToolWireEvent = WireIdentity & (
  | { type: 'tool_start'; args: Record<string, unknown> }
  | { type: 'tool_progress'; progress: Record<string, unknown> }
  | { type: 'tool_result'; result: unknown }
  | { type: 'tool_error'; error: string }
  | { type: 'tool_state'; phase: ToolPhase; args?: Record<string, unknown> }
);
export interface NormalizedToolEvent {
  startedAt?: number;
  settledAt?: number;
  persistedAt?: number;
  toolCallId: string;
  name: string;
  phase: ToolPhase;
  occurredAt: number;
  outcome?: ToolOutcome;
  args?: Record<string, unknown>;
  preview?: ToolPreview;
  progress?: Record<string, unknown>;
}
export const TOOL_PREVIEW_LIMIT = 4096;
const phases: ToolPhase[] = ['planned', 'queued', 'running', 'settled', 'persisted'];
const outcomes: ToolOutcome[] = ['ok', 'error', 'cancelled', 'unknown'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 512;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function isToolWireEvent(value: unknown): value is ToolWireEvent {
  if (!record(value) || !identity(value.toolCallId) || !identity(value.toolName) || !time(value.occurredAt)) return false;
  if (value.runId !== undefined && !identity(value.runId)) return false;
  if (value.sessionKey !== undefined && !identity(value.sessionKey)) return false;
  if (value.outcome !== undefined && !outcomes.includes(value.outcome as ToolOutcome)) return false;
  if (value.sequence !== undefined && (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0)) return false;
  if (value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 0)) return false;
  if (value.preview !== undefined) {
    const p = value.preview;
    if (!record(p) || !['text', 'json'].includes(String(p.kind)) || typeof p.text !== 'string'
      || p.text.length > TOOL_PREVIEW_LIMIT || typeof p.truncated !== 'boolean') return false;
    if (p.detailsRef !== undefined && (!record(p.detailsRef) || p.detailsRef.kind !== 'tool-call' || p.detailsRef.toolCallId !== value.toolCallId)) return false;
  }
  switch (value.type) {
    case 'tool_start': return record(value.args);
    case 'tool_progress': return record(value.progress);
    case 'tool_result': return 'result' in value;
    case 'tool_error': return typeof value.error === 'string';
    case 'tool_state': return phases.includes(value.phase as ToolPhase) && (value.args === undefined || record(value.args));
    default: return false;
  }
}

/** The sole native Adapter → tool consumer conversion. Invalid frames are dropped. */
export function normalizeToolEvent(value: unknown): NormalizedToolEvent | null {
  if (!isToolWireEvent(value)) return null;
  return {
    startedAt: value.type === 'tool_start' || value.type === 'tool_state' && value.phase === 'running' ? value.occurredAt : undefined,
    toolCallId: value.toolCallId!, name: value.toolName, occurredAt: value.occurredAt!,
    phase: value.type === 'tool_state' ? value.phase : value.type === 'tool_start' || value.type === 'tool_progress' ? 'running' : 'settled',
    outcome: value.outcome ?? (value.type === 'tool_result' ? 'ok' : value.type === 'tool_error' ? 'error' : undefined),
    args: 'args' in value ? value.args : undefined,
    preview: value.preview ?? (value.type === 'tool_result' ? buildToolPreview(value.result, value.toolCallId!)
      : value.type === 'tool_error' ? buildToolPreview(value.error, value.toolCallId!) : undefined),
    progress: value.type === 'tool_progress' ? value.progress : undefined,
  };
}

const sensitiveKey = /password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|credential|connection[_-]?string|private[_-]?key/i;
function redactText(text: string): string {
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

/** Bounds depth, entries and characters before serializing; never forwards raw output. */
export function boundedToolValue(value: unknown, redact = redactText): unknown {
  let entries = 64;
  let chars = TOOL_PREVIEW_LIMIT;
  const seen = new WeakSet<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') { const text = redact(v); const out = text.slice(0, Math.max(0, chars)); chars -= out.length; return out.length < text.length ? out + '…' : out; }
    if (!v || typeof v !== 'object') return typeof v === 'bigint' ? String(v) : v;
    if (depth >= 4 || entries <= 0 || chars <= 0) return '[TRUNCATED]';
    if (seen.has(v)) return '[CIRCULAR]';
    seen.add(v);
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v) { if (--entries < 0) { out.push('[TRUNCATED]'); break; } out.push(visit(item, depth + 1)); }
      return out;
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const key in v) {
      if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
      if (--entries < 0) { out.__truncated = true; break; }
      out[key.slice(0, 128)] = sensitiveKey.test(key) ? '[REDACTED]' : visit((v as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  };
  return visit(value, 0);
}

export function buildToolPreview(value: unknown, toolCallId: string, redact = redactText): ToolPreview {
  const safe = boundedToolValue(value, redact);
  const serialized = typeof safe === 'string' ? safe : JSON.stringify(safe) ?? '(empty)';
  const truncated = serialized.length > TOOL_PREVIEW_LIMIT || serialized.includes('[TRUNCATED]') || serialized.includes('__truncated') || serialized.endsWith('…');
  return { kind: typeof value === 'object' && value !== null ? 'json' : 'text', text: serialized.slice(0, TOOL_PREVIEW_LIMIT), truncated,
    ...(truncated ? { detailsRef: { kind: 'tool-call' as const, toolCallId } } : {}) };
}
