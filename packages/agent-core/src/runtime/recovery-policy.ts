import type { LLMResponse } from '../types.js';

export type RecoveryKind = 'empty' | 'continuation' | 'stream' | 'repetition' | 'context';
export interface RecoverySnapshot {
  schemaVersion: 1;
  modelSteps: number;
  providerAttempts: number;
  toolCalls: number;
  total: number;
  counts: Record<RecoveryKind, number>;
  unknownRequests: number;
  reservedTokens: number;
  usage: Record<string, number>;
}
export interface RecoveryLimits { total?: number; empty?: number; continuation?: number; stream?: number; repetition?: number; context?: number }
const defaults = { total: 8, empty: 2, continuation: 3, stream: 2, repetition: 2, context: 4 };
export class RuntimeError extends Error {
  constructor(readonly code: string, message: string, readonly source: 'provider' | 'runtime' | 'tool' = 'runtime',
    readonly retryable = false, readonly recoverable = false, readonly causeCode?: string,
    readonly providerStatus?: number, readonly attemptId?: number) { super(message); this.name = 'RuntimeError'; }
}
export function runtimeError(error: unknown, attemptId?: number): RuntimeError {
  if (error instanceof RuntimeError) return new RuntimeError(error.code, error.message, error.source, error.retryable, error.recoverable, error.causeCode, error.providerStatus, attemptId ?? error.attemptId);
  const e = error as Partial<LLMResponse> & { message?: string; code?: string; status?: number; name?: string };
  const status = e?.providerStatus ?? e?.status;
  const cause = e?.errorCode ?? e?.code;
  const message = e?.error ?? e?.message ?? String(error);
  if (status === 401 || status === 403) return new RuntimeError('PROVIDER_AUTH', message, 'provider', false, false, cause, status, attemptId);
  if (/context_length_exceeded|context window|prompt is too long|maximum context/i.test((cause ?? '') + message)) return new RuntimeError('CONTEXT_OVERFLOW', message, 'provider', false, false, cause, status, attemptId);
  const network = /INCOMPLETE_STREAM|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|UND_ERR|APIConnectionError/.test(cause ?? e?.name ?? '') || /connection error|fetch failed/i.test(message);
  const retryable = status === 429 || (status !== undefined && status >= 500 && status <= 599) || network;
  return new RuntimeError(e?.errorKind === 'timeout' ? 'MODEL_REQUEST_TIMEOUT' : retryable ? 'PROVIDER_TRANSIENT' : 'PROVIDER_ERROR', message,
    'provider', retryable, retryable, cause, status, attemptId);
}
export function cancellationError(signal?: AbortSignal): RuntimeError {
  const reason = signal?.reason;
  if (reason instanceof RuntimeError) return reason;
  const deadline = /TIMED_OUT|TIMEOUT|deadline|超时/i.test(String(reason?.code ?? reason?.message ?? ''));
  return new RuntimeError(deadline ? 'RUN_DEADLINE' : 'USER_CANCELLED', deadline ? 'Run deadline exceeded' : 'Cancelled');
}
export class RecoveryPolicy {
  readonly state: RecoverySnapshot;
  readonly limits: typeof defaults;
  constructor(snapshot?: unknown, limits: RecoveryLimits = {}) {
    this.limits = { ...defaults, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > defaults[key as keyof typeof defaults]) throw new Error('Invalid recovery limit');
    }
    this.state = snapshot === undefined ? { schemaVersion: 1, modelSteps: 0, providerAttempts: 0, toolCalls: 0, total: 0,
      counts: { empty: 0, continuation: 0, stream: 0, repetition: 0, context: 0 }, unknownRequests: 0, reservedTokens: 0, usage: {} } : validateRecoverySnapshot(snapshot);
  }
  consume(kind: RecoveryKind): boolean {
    if (this.state.total >= this.limits.total || this.state.counts[kind] >= this.limits[kind]) return false;
    this.state.total++; this.state.counts[kind]++; return true;
  }
  snapshot(): RecoverySnapshot { return validateRecoverySnapshot(this.state); }
}
export function validateRecoverySnapshot(value: unknown): RecoverySnapshot {
  const s = value as RecoverySnapshot;
  const number = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!s || s.schemaVersion !== 1 || !s.counts || !s.usage ||
    ![s.modelSteps, s.providerAttempts, s.toolCalls, s.total, s.unknownRequests, s.reservedTokens].every(number) ||
    !(['empty', 'continuation', 'stream', 'repetition', 'context'] as const).every(k => number(s.counts[k])) ||
    s.total !== Object.values(s.counts).reduce((a, b) => a + b, 0) || s.providerAttempts < s.modelSteps ||
    !Object.values(s.usage).every(number)) throw new RuntimeError('INVALID_CHECKPOINT', 'Invalid runtime recovery checkpoint');
  return { schemaVersion: 1, modelSteps: s.modelSteps, providerAttempts: s.providerAttempts, toolCalls: s.toolCalls,
    total: s.total, counts: { empty: s.counts.empty, continuation: s.counts.continuation, stream: s.counts.stream, repetition: s.counts.repetition, context: s.counts.context },
    unknownRequests: s.unknownRequests, reservedTokens: s.reservedTokens,
    usage: Object.fromEntries(Object.entries(s.usage).filter(([k]) => ['prompt_tokens', 'completion_tokens', 'cached_tokens'].includes(k))) };
}
export function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(cancellationError(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
