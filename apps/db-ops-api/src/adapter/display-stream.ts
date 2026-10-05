import { randomUUID } from 'node:crypto';
import { createMessageProjection, reduceMessageProjection, type MessageProjection, type ProjectionFrame } from '@slide/agent-core/message-projection';
import type { DisplayCursor, DisplayRecovery, DisplayStreamEvent } from '@slide/agent-core/display-stream';

export interface DisplayStreamLimits {
  maxRunOps: number; maxRunBytes: number; maxRuns: number;
  maxGlobalOps: number; maxGlobalBytes: number;
  maxSnapshotParts: number; maxSnapshotBytes: number;
  maxSubscriptionsPerPeer: number; terminalTtlMs: number;
  textWindowMs: number; textBatchBytes: number; progressWindowMs: number;
}
const defaults: DisplayStreamLimits = {
  maxRunOps: 2000, maxRunBytes: 1024 * 1024, maxRuns: 64,
  maxGlobalOps: 16_000, maxGlobalBytes: 16 * 1024 * 1024,
  maxSnapshotParts: 256, maxSnapshotBytes: 256 * 1024,
  maxSubscriptionsPerPeer: 8, terminalTtlMs: 600_000,
  textWindowMs: 40, textBatchBytes: 8192, progressWindowMs: 200,
};
export function loadDisplayStreamLimits(overrides: Partial<DisplayStreamLimits> = {}): DisplayStreamLimits {
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof DisplayStreamLimits)[]) {
    const env = process.env[`SLIDE_STREAM_${key.replace(/[A-Z]/g, s => `_${s}`).toUpperCase()}`];
    limits[key] = overrides[key] ?? (env === undefined ? defaults[key] : Number(env));
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new Error(`INVALID_DISPLAY_STREAM_LIMIT:${key}`);
  }
  if (limits.maxSnapshotBytes < 8192 || limits.maxRunBytes < limits.maxSnapshotBytes * 2
    || limits.maxGlobalBytes < limits.maxRunBytes || limits.maxGlobalOps < limits.maxRunOps
    || limits.textBatchBytes > limits.maxSnapshotBytes / 2) throw new Error('INCONSISTENT_DISPLAY_STREAM_LIMITS');
  return limits;
}
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
function tail(text: string, maxBytes: number): string {
  // Preserve UTF-8 code points. This is only the bounded display tail, never a fact.
  const data = Buffer.from(text);
  if (data.length <= maxBytes) return text;
  let offset = data.length - maxBytes;
  while (offset < data.length && (data[offset] & 0xc0) === 0x80) offset++;
  return data.subarray(offset).toString('utf8');
}
function boundedSnapshot(source: MessageProjection, limits: DisplayStreamLimits): { state: MessageProjection; omitted: number; truncated: boolean } {
  const state = structuredClone(source);
  const original = state.parts.length;
  let truncated = false;
  state.error = state.error?.slice(0, 1024);
  const partLimit = Math.min(limits.maxSnapshotParts, limits.maxRunOps);
  const stateBudget = limits.maxSnapshotBytes - 4096; // reserve full envelope/identity/ref bytes
  if (state.parts.length > partLimit) { state.parts = state.parts.slice(-partLimit); truncated = true; }
  const textLimit = Math.floor(stateBudget * 3 / 4);
  for (const row of state.parts) {
    if ('text' in row.part && typeof row.part.text === 'string') {
      const text = tail(row.part.text, textLimit);
      if (text !== row.part.text) truncated = true;
      row.part.text = text;
    }
  }
  while (bytes(state) > stateBudget && state.parts.length > 1) { state.parts.shift(); truncated = true; }
  if (bytes(state) > stateBudget) { state.parts = []; truncated = true; }
  return { state, omitted: original - state.parts.length, truncated };
}
interface Batch { frame: ProjectionFrame; kind: 'text' | 'progress'; key: string; bytes: number; ops: number; timer: ReturnType<typeof setTimeout>; }
interface Run {
  sessionKey: string; runId: string; turnId: string; epoch: string; seq: number;
  state: MessageProjection; snapshotBytes: number; truncated: boolean; omitted: number;
  log: { seq: number; frame: ProjectionFrame; bytes: number; ops: number }[];
  logBytes: number; logOps: number; pending?: Batch;
  firstText: boolean; touched: number; terminalAt?: number;
}
interface Source { runId: string; turnId: string; get: () => MessageProjection; }
interface Subscription { id: string; send: (event: DisplayStreamEvent) => boolean; }

/** All mutations/capture/registration are synchronous in one JS authority.
 * Timers may flush batches, but no await separates W from installing its suffix. */
export class DisplayStreamAuthority<Peer extends object> {
  readonly limits: DisplayStreamLimits;
  private runs = new Map<string, Run>();
  private sources = new Map<string, Source>();
  private subscriptions = new Map<string, Map<Peer, Subscription>>();
  private expiry?: ReturnType<typeof setInterval>;
  constructor(limits: Partial<DisplayStreamLimits> = {}) {
    this.limits = loadDisplayStreamLimits(limits);
  }
  start(sessionKey: string, runId: string, turnId: string, get: () => MessageProjection): void {
    this.sources.set(sessionKey, { runId, turnId, get });
    // Admission concurrency already bounds sources; an explicit cap also applies here.
    while (this.sources.size > this.limits.maxRuns) this.sources.delete(this.sources.keys().next().value!);
  }
  end(sessionKey: string, runId: string): void {
    if (this.sources.get(sessionKey)?.runId === runId) this.sources.delete(sessionKey);
  }
  private recovery(run: Run): DisplayRecovery {
    return { truncated: run.truncated, omittedParts: run.omitted,
      detailRef: { kind: 'authorized-history', sessionKey: run.sessionKey, runId: run.runId } };
  }
  private snapshot(run: Run, id: string): DisplayStreamEvent {
    return { type: 'stream.snapshot', sessionKey: run.sessionKey,
      stream: { version: 1, streamEpoch: run.epoch, runId: run.runId, turnId: run.turnId, subscriptionId: id, fromSeq: run.seq, toSeq: run.seq },
      snapshot: run.state, recovery: this.recovery(run) };
  }
  private delta(run: Run, id: string, entry: Run['log'][number]): DisplayStreamEvent {
    return { type: 'stream.delta', sessionKey: run.sessionKey,
      stream: { version: 1, streamEpoch: run.epoch, runId: run.runId, turnId: run.turnId, subscriptionId: id, fromSeq: entry.seq, toSeq: entry.seq }, projection: entry.frame };
  }
  private sendSnapshot(run: Run): void {
    for (const sub of this.subscriptions.get(run.sessionKey)?.values() ?? []) sub.send(this.snapshot(run, sub.id));
  }
  private create(sessionKey: string, frame?: ProjectionFrame): Run | undefined {
    const source = this.sources.get(sessionKey);
    const runId = frame?.runId ?? source?.runId;
    if (!runId) return;
    const base = source?.runId === runId ? source.get() : createMessageProjection(runId);
    const full = frame && base.sequence < frame.sequence ? reduceMessageProjection(base, frame) : base;
    const bounded = boundedSnapshot(full, this.limits);
    const run: Run = { sessionKey, runId, turnId: source?.turnId ?? runId, epoch: randomUUID(), seq: 0,
      state: bounded.state, snapshotBytes: bytes(bounded.state), truncated: bounded.truncated, omitted: bounded.omitted,
      log: [], logBytes: 0, logOps: 0, firstText: false, touched: Date.now(), terminalAt: full.terminal ? Date.now() : undefined };
    this.runs.set(sessionKey, run);
    if (!this.expiry) {
      this.expiry = setInterval(() => this.prune(), Math.min(this.limits.terminalTtlMs, 30_000));
      this.expiry.unref();
    }
    this.prune(sessionKey);
    return run;
  }
  publish(sessionKey: string, frame: ProjectionFrame): void {
    this.prune(sessionKey);
    let run = this.runs.get(sessionKey);
    if (!run || run.runId !== frame.runId) {
      if (run) this.evict(sessionKey);
      run = this.create(sessionKey, frame);
      if (run) this.sendSnapshot(run);
      return;
    }
    if (run.state.terminal || frame.sequence <= run.state.sequence) return;
    const bounded = boundedSnapshot(reduceMessageProjection(run.state, frame), this.limits);
    run.state = bounded.state; run.snapshotBytes = bytes(run.state);
    run.omitted += bounded.omitted; run.truncated ||= bounded.truncated; run.touched = Date.now();
    if (run.state.terminal) run.terminalAt = Date.now();
    const op = frame.operations.length === 1 ? frame.operations[0] : undefined;
    const kind = op?.type === 'part.append' ? 'text' : op?.type === 'tool.progress' ? 'progress' : undefined;
    const key = op?.type === 'part.append' ? `${frame.attempt}:${op.partId}` : op?.type === 'tool.progress' ? `${frame.attempt}:${op.partId}` : '';
    const size = bytes(frame);
    // Oversized ops are represented by the bounded authoritative snapshot.
    if (size > this.limits.maxSnapshotBytes / 2 || frame.operations.length > this.limits.maxRunOps) {
      this.flush(run); run.seq++; run.log = []; run.logBytes = 0; run.logOps = 0; this.sendSnapshot(run); this.prune(sessionKey); return;
    }
    if (kind && (kind !== 'text' || run.firstText)) {
      if (run.pending && (run.pending.kind !== kind || run.pending.key !== key)) this.flush(run);
      const pending = run.pending;
      if (pending) {
        if (kind === 'text') {
          const last = pending.frame.operations[0];
          if (last.type === 'part.append' && op?.type === 'part.append') last.text += op.text;
        } else pending.frame.operations = structuredClone(frame.operations);
        pending.frame.sequence = frame.sequence; pending.ops++;
        pending.bytes = bytes(pending.frame);
      } else {
        const timer = setTimeout(() => { this.flush(run!); this.prune(sessionKey); }, kind === 'text' ? this.limits.textWindowMs : this.limits.progressWindowMs);
        timer.unref();
        run.pending = { kind, key, frame: structuredClone(frame), bytes: size, ops: 1, timer };
      }
      if (run.pending!.bytes >= this.limits.textBatchBytes || run.pending!.ops >= this.limits.maxRunOps
        || run.state.parts.length + run.pending!.frame.operations.length > this.limits.maxRunOps) this.flush(run);
    } else {
      this.flush(run);
      // part.start includes the first nonempty text. No merge-window delay.
      if (frame.operations.some(o => o.type === 'part.start' && 'text' in o.part && !!o.part.text) || kind === 'text') run.firstText = true;
      this.emit(run, frame);
    }
    this.prune(sessionKey);
  }
  private flush(run: Run): void {
    const pending = run.pending;
    if (!pending) return;
    clearTimeout(pending.timer); run.pending = undefined; this.emit(run, pending.frame);
  }
  private emit(run: Run, frame: ProjectionFrame): void {
    const entry = { seq: ++run.seq, frame: structuredClone(frame), bytes: bytes(frame), ops: frame.operations.length };
    run.log.push(entry); run.logBytes += entry.bytes; run.logOps += entry.ops;
    while (run.log.length && (run.logOps + run.state.parts.length > this.limits.maxRunOps || run.logBytes + run.snapshotBytes > this.limits.maxRunBytes)) {
      const first = run.log.shift()!; run.logBytes -= first.bytes; run.logOps -= first.ops;
    }
    for (const sub of this.subscriptions.get(run.sessionKey)?.values() ?? []) sub.send(this.delta(run, sub.id, entry));
  }
  watch(peer: Peer, sessionKey: string, id: string, send: Subscription['send'], cursor?: DisplayCursor): boolean {
    if (typeof id !== 'string' || !id || id.length > 512) return false;
    let count = 0;
    for (const subs of this.subscriptions.values()) if (subs.has(peer)) count++;
    if (!this.subscriptions.get(sessionKey)?.has(peer) && count >= this.limits.maxSubscriptionsPerPeer) return false;
    this.prune(sessionKey);
    let run = this.runs.get(sessionKey);
    if (!run) run = this.create(sessionKey);
    if (run) this.flush(run);
    const subs = this.subscriptions.get(sessionKey) ?? new Map<Peer, Subscription>();
    this.subscriptions.set(sessionKey, subs);
    // Capture W and register suffix before delivering (including reentrant test hooks).
    const suffix = run && cursor && cursor.streamEpoch === run.epoch && cursor.runId === run.runId && cursor.turnId === run.turnId
      && Number.isSafeInteger(cursor.toSeq) && cursor.toSeq >= 0 && cursor.toSeq <= run.seq
      && cursor.toSeq >= (run.log[0]?.seq ?? run.seq + 1) - 1
      ? run.log.filter(e => e.seq > cursor.toSeq) : undefined;
    const baseline = run ? this.snapshot(run, id) : undefined;
    // Delivery order must survive a synchronous reentrant publication.
    const queued: DisplayStreamEvent[] = [];
    let capturing = true;
    let queuedBytes = 0, overflow = false;
    const sub: Subscription = { id, send: e => {
      if (!capturing) return send(e);
      if (overflow) return true;
      queuedBytes += bytes(e);
      if (queued.length >= this.limits.maxRunOps || queuedBytes > this.limits.maxSnapshotBytes) { queued.length = 0; queuedBytes = 0; overflow = true; }
      else queued.push(e);
      return true;
    } };
    subs.set(peer, sub);
    if (suffix) for (const entry of suffix) send(this.delta(run!, id, entry));
    else if (baseline) send(baseline);
    else send({ type: 'stream.snapshot', sessionKey, stream: { version: 1, streamEpoch: randomUUID(), runId: 'cold', turnId: 'cold', subscriptionId: id, fromSeq: 0, toSeq: 0 },
      snapshot: createMessageProjection('cold'), recovery: { truncated: true, cold: true, omittedParts: 0, detailRef: { sessionKey, runId: 'cold', kind: 'authorized-history' } } });
    capturing = false;
    if (overflow) { const latest = this.runs.get(sessionKey); if (latest) send(this.snapshot(latest, id)); }
    else for (const e of queued) send(e);
    this.prune(sessionKey);
    return true;
  }
  legacySnapshot(sessionKey: string): Record<string, unknown> | undefined {
    this.prune();
    const run = this.runs.get(sessionKey);
    if (!run || run.state.terminal) return;
    return { type: 'text_delta', runId: run.runId, sessionKey, delta: run.state.parts.map(p => p.part.type === 'text' ? p.part.text : '').join(''),
      thinkingContent: run.state.parts.map(p => p.part.type === 'reasoning' ? p.part.text : '').join(''), reset: true,
      sequence: run.state.sequence, attempt: run.state.attempt, projection: { version: 1, runId: run.runId, sequence: run.state.sequence, attempt: run.state.attempt,
        operations: [{ type: 'stream.snapshot', snapshot: run.state }] }, recovery: this.recovery(run) };
  }
  unwatch(peer: Peer, sessionKey?: string): void {
    for (const [key, subs] of this.subscriptions) {
      if (sessionKey !== undefined && key !== sessionKey) continue;
      subs.delete(peer); if (!subs.size) this.subscriptions.delete(key);
    }
  }
  stats() {
    let totalBytes = 0, totalOps = 0, pendingBytes = 0, subscriptions = 0;
    for (const run of this.runs.values()) { totalBytes += run.snapshotBytes + run.logBytes + (run.pending?.bytes ?? 0); totalOps += run.state.parts.length + run.logOps + (run.pending?.frame.operations.length ?? 0); pendingBytes += run.pending?.bytes ?? 0; }
    for (const subs of this.subscriptions.values()) subscriptions += subs.size;
    return { runs: this.runs.size, sources: this.sources.size, bytes: totalBytes, ops: totalOps, pendingBytes, subscriptions };
  }
  private evict(key: string): void { const run = this.runs.get(key); if (run?.pending) clearTimeout(run.pending.timer); this.runs.delete(key); }
  private prune(protect?: string): void {
    const now = Date.now();
    for (const [key, run] of this.runs) if (run.terminalAt !== undefined && now - run.terminalAt >= this.limits.terminalTtlMs) this.evict(key);
    // Per-run pending is included in capacity, not an unaccounted timer queue.
    for (const run of this.runs.values()) while (run.log.length && (run.snapshotBytes + run.logBytes + (run.pending?.bytes ?? 0) > this.limits.maxRunBytes
      || run.logOps + run.state.parts.length + (run.pending?.frame.operations.length ?? 0) > this.limits.maxRunOps)) {
      const first = run.log.shift()!; run.logBytes -= first.bytes; run.logOps -= first.ops;
    }
    while (this.runs.size > this.limits.maxRuns || this.stats().bytes > this.limits.maxGlobalBytes || this.stats().ops > this.limits.maxGlobalOps) {
      const victim = [...this.runs.values()].filter(r => r.sessionKey !== protect).sort((a, b) => a.touched - b.touched)[0];
      if (!victim) break;
      this.evict(victim.sessionKey);
    }
    if (!this.runs.size && this.expiry) { clearInterval(this.expiry); this.expiry = undefined; }
  }
  dispose(): void { clearInterval(this.expiry); for (const key of this.runs.keys()) this.evict(key); this.sources.clear(); this.subscriptions.clear(); }
}
