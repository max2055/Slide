import type { PoolConnection } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import { evidenceHash, redactEvidence } from '../analysis/analysis-evidence.js';
import { CanonicalStore } from '../adapter/canonical-store.js';
import { projectionDocuments, createMessageProjection, hydrateMessageProjection, reduceMessageProjection, type MessageProjection, type ProjectionDocument } from '@slide/agent-core/message-projection';
import type { MessageParts } from '@slide/agent-core';
import { InvestigationObservationDatabase, captureObservation, observationRows, decode, invalidObservation } from './observation-db.js';
import { validateInvestigationStreamEvent, type InvestigationStreamEvent } from './contracts.js';
import { InvestigationStoreError } from './store.js';
import { freezeInvestigationCaller } from './authorization.js';

export function publicDocument(document: MessageParts): MessageParts {
  const safe = redactEvidence(structuredClone(document)) as MessageParts;
  safe.parts = safe.parts.filter(part => part.type !== 'reasoning');
  for (const part of safe.parts) {
    if (part.type === 'tool_call') {
      try { part.call.function.arguments = JSON.stringify(redactEvidence(JSON.parse(part.call.function.arguments))); }
      catch { part.call.function.arguments = '{}'; }
    } else if (part.type === 'tool_result' && typeof part.content === 'string') {
      try { part.content = JSON.stringify(redactEvidence(JSON.parse(part.content))); } catch { part.content = redactEvidence(part.content) as string; }
    }
    if ('text' in part && typeof part.text === 'string') part.text = part.text.slice(-8192);
  }
  safe.parts = projectionDocuments([safe]).flatMap(d => d.parts);
  // Only the canonical storage reader retains exact legacy rollback payloads.
  safe.legacy = { id: safe.id, role: safe.role, content: safe.parts.map(p => p.type === 'text' || p.type === 'runtime_notice' ? p.text : '').join('') };
  return safe;
}
export interface InvestigationProjection {
  investigationId: string; sequence: number; runs: Record<string, MessageProjection>;
  documents: ProjectionDocument[];
  evidenceIds: string[]; results: Array<{ resultId: string; resultVersion: number; schemaVersion: 2 }>;
  metadata?: { version: number; lifecycle: string; problemStatus: string };
}
export function emptyInvestigationProjection(id: string): InvestigationProjection {
  return { investigationId: id, sequence: 0, runs: {}, documents: [], evidenceIds: [], results: [] };
}
/** Ordered batch reducer: duplicates are no-ops, missing durable ordinals ask
 * for replay instead of silently advancing past an unseen operation. */
export function reduceInvestigationEvents(state: InvestigationProjection, batch: readonly InvestigationStreamEvent[]): InvestigationProjection {
  let next = structuredClone(state);
  for (const event of [...batch].sort((a, b) => a.sequence - b.sequence)) {
    if (event.investigationId !== state.investigationId || !validateInvestigationStreamEvent(event).ok) throw new Error('INVALID_INVESTIGATION_EVENT');
    if (event.sequence <= next.sequence) continue;
    if (event.sequence !== next.sequence + 1) throw new Error('REPLAY_REQUIRED');
    if (event.type === 'parts.operation') {
      const operations = event.payload.operations.map(op => {
        if (op.type !== 'parts.persisted') return op;
        for (const doc of op.documents) {
          const index = next.documents.findIndex(d => d.id === doc.id);
          if (index < 0) next.documents.push(doc); else next.documents[index] = doc;
        }
        return { ...op, documents: op.documents.filter(d => d.role !== 'user' && d.role !== 'system') };
      });
      next.runs[event.runId] = reduceMessageProjection(next.runs[event.runId] ?? createMessageProjection(event.runId), { ...event.payload, operations });
    }
    else if (event.type === 'evidence.added' && !next.evidenceIds.includes(event.payload.evidenceId)) next.evidenceIds.push(event.payload.evidenceId);
    else if (event.type === 'result.persisted' && !next.results.some(r => r.resultId === event.payload.resultId)) next.results.push(event.payload);
    else if (event.type === 'investigation.changed') next.metadata = event.payload;
    else if (event.type === 'run.terminal') {
      const state = next.runs[event.runId] ?? createMessageProjection(event.runId);
      state.runState = event.payload.state; state.terminal = event.payload.state;
      state.durable = { kind: 'mysql', reference: event.runId };
      next.runs[event.runId] = state;
    }
    next.sequence = event.sequence;
  }
  return next;
}
const at = (value: any) => new Date(value).toISOString();
export async function captureCanonicalDocument(c: PoolConnection, id: string, requestId: string, document: MessageParts, occurredAt: string): Promise<void> {
  const doc = publicDocument(document);
  if (!doc.runId) throw invalidObservation();
  await captureObservation(c, id, `parts:${evidenceHash(doc.id)}`, { type: 'parts.operation', requestId, runId: doc.runId,
    occurredAt, payload: { version: 1, runId: doc.runId, sequence: 0, attempt: 0,
      operations: [{ type: 'parts.persisted', documents: projectionDocuments([doc]) }] } });
}
export interface InvestigationSnapshot {
  investigationId: string; watermark: number; projectionHash: string;
  documents: MessageParts[]; metadata: { version: number; lifecycle: string; problemStatus: string };
  runs: Array<{ requestId: string; runId: string; state: string; resolution: 'known' | 'outcome_unknown' }>;
  projection: InvestigationProjection;
  evidenceIds: string[]; results: Array<{ resultId: string; resultVersion: number; schemaVersion: 2 }>;
  truncated: boolean; nextBefore: string | null;
}
export interface InvestigationReplay {
  events: InvestigationStreamEvent[]; nextCursor: number; hasMore: boolean;
  replayRequired: boolean; watermark: number;
}
export class InvestigationStreamStore extends InvestigationObservationDatabase {
  private canonical = new CanonicalStore(this.poolProvider as never, this.authorization);
  private async capture(c: PoolConnection, investigation: any, actor: ActorContext): Promise<Omit<InvestigationSnapshot, 'watermark' | 'projectionHash'>> {
    const id = investigation.id;
    const [record] = await observationRows(c, 'SELECT * FROM investigations WHERE id = ?', [id]);
    const requests = await observationRows(c, 'SELECT * FROM investigation_requests WHERE investigation_id = ? ORDER BY created_at, id', [id]);
    for (const request of requests) await captureObservation(c, id, `request:${request.id}`, { type: 'request.accepted', requestId: request.id,
      occurredAt: at(request.created_at), payload: { jobId: request.job_id, version: Number(request.accepted_version) } });
    // Keep large runtime checkpoints out of the filesort tuple. Only terminal
    // classification needs resolution; SQL order and live ACL stay unchanged.
    const rows = await observationRows(c, `SELECT ar.id, ar.state, ar.created_at, ar.finished_at,
      JSON_EXTRACT(ar.result_json, '$.resolution') AS resolution_json, ir.id AS request_id FROM agent_runs ar JOIN investigation_requests ir
      ON ir.investigation_id = ? AND ar.session_id = ? AND ar.message_id = ir.message_id
      AND ar.actor_id = ir.actor_id AND ar.idempotency_key = CONCAT('investigation:', ir.id) ORDER BY ir.accepted_version, ar.created_at, ar.id`, [id, investigation.sessionId]);
    const runs: InvestigationSnapshot['runs'] = [];
    for (const run of rows) {
      await captureObservation(c, id, `run:${run.id}:started`, { type: 'run.started', requestId: run.request_id, runId: run.id, occurredAt: at(run.created_at), payload: {} });
      const unknown = run.state === 'partial' && (/UNKNOWN/.test(decode(run.resolution_json)?.reasonCode ?? '')
        || decode(run.resolution_json)?.kind === 'outcome_unknown');
      const state = unknown ? 'partial' : run.state;
      const resolution = unknown ? 'outcome_unknown' as const : 'known' as const;
      runs.push({ requestId: run.request_id, runId: run.id, state, resolution });
    }
    const page = await this.canonical.getObservationPage(c as never, actor, id, 200);
    const documents = page.messages.flatMap(m => m.messageParts ? [publicDocument(m.messageParts)] : []);
    for (const doc of documents) {
      const request = requests.find(r => r.message_id === doc.turnId || r.message_id === doc.id);
      if (request) await captureCanonicalDocument(c, id, request.id, doc, at(request.created_at));
    }
    let omitted = false;
    while (documents.length > 1 && Buffer.byteLength(JSON.stringify(documents)) > 48 * 1024) { documents.shift(); omitted = true; }
    // Tool Parts were committed before terminal facts. Never feed late frames
    // after a terminal reducer, even when capture begins after worker exit.
    for (const run of rows) if (run.state !== 'running') {
      const publicRun = runs.find(r => r.runId === run.id)!;
      await captureObservation(c, id, `run:${run.id}:terminal`, { type: 'run.terminal', requestId: run.request_id, runId: run.id,
        occurredAt: at(run.finished_at ?? run.created_at), payload: { state: publicRun.state, resolution: publicRun.resolution } as any });
    }
    const metadata = { version: Number(record.version), lifecycle: record.lifecycle, problemStatus: record.problem_status };
    await captureObservation(c, id, 'metadata', { type: 'investigation.changed', occurredAt: at(record.updated_at), payload: metadata });
    // Read references independently of event retention. Full values are served
    // only through their content APIs with per-reference live authorization.
    const evidenceRows = await observationRows(c, 'SELECT id, metadata_json FROM investigation_evidence WHERE investigation_id = ? ORDER BY id', [id]);
    for (const row of evidenceRows) await this.authorization.authorize(c as never, actor, investigation, 'content', decode(row.metadata_json).resources);
    const results = await observationRows(c, 'SELECT id, version FROM investigation_results WHERE investigation_id = ? ORDER BY version', [id]);
    const projection = emptyInvestigationProjection(id);
    projection.documents = projectionDocuments(documents);
    projection.metadata = metadata;
    projection.evidenceIds = evidenceRows.map(e => e.id);
    projection.results = results.map(r => ({ resultId: r.id, resultVersion: Number(r.version), schemaVersion: 2 }));
    for (const runId of new Set(documents.flatMap(d => d.runId ? [d.runId] : []))) projection.runs[runId] = hydrateMessageProjection(runId, documents);
    for (const run of runs) if (run.state !== 'running') {
      const state = projection.runs[run.runId] ?? createMessageProjection(run.runId);
      state.runState = run.state as any; state.terminal = run.state as any; state.durable = { kind: 'mysql', reference: run.runId };
      projection.runs[run.runId] = state;
    }
    return { investigationId: id, documents, metadata, runs, projection, evidenceIds: projection.evidenceIds,
      results: projection.results, truncated: omitted || page.nextBefore !== null, nextBefore: page.nextBefore };
  }
  async snapshot(caller: ActorContext, id: string): Promise<InvestigationSnapshot> {
    return this.transaction(caller, id, async (c, investigation, actor) => {
      const content = await this.capture(c, investigation, actor);
      const [head] = await observationRows(c, 'SELECT sequence FROM investigation_stream_heads WHERE investigation_id = ?', [id]);
      const watermark = Number(head?.sequence ?? 0);
      content.projection.sequence = watermark;
      return { ...content, watermark, projectionHash: investigationProjectionHash(content.projection) };
    });
  }
  async replay(caller: ActorContext, id: string, after = 0, limit = 200): Promise<InvestigationReplay> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalidObservation();
    return this.transaction(caller, id, async (c, investigation, actor) => {
      await this.capture(c, investigation, actor);
      const [head] = await observationRows(c, 'SELECT * FROM investigation_stream_heads WHERE investigation_id = ?', [id]);
      const watermark = Number(head?.sequence ?? 0);
      if (after < Number(head?.retained_after ?? 0) || after > watermark) return { events: [], nextCursor: after, hasMore: false, replayRequired: true, watermark };
      const rows = await observationRows(c, 'SELECT event_json FROM investigation_stream_events WHERE investigation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?', [id, after, limit + 1]);
      const events = rows.slice(0, limit).map(r => decode(r.event_json) as InvestigationStreamEvent);
      return { events, nextCursor: events.at(-1)?.sequence ?? after, hasMore: rows.length > limit, replayRequired: false, watermark };
    });
  }
  async prune(caller: ActorContext, id: string, before: string): Promise<void> {
    if (!instantRetention(before)) throw invalidObservation();
    await this.transaction(caller, id, async (c, investigation, actor) => {
      await this.authorization.authorize(c as never, actor, investigation, 'continue');
      // Only an expired PREFIX may be deleted; late source occurredAt values
      // cannot introduce holes in a valid cursor window.
      const rows = await observationRows(c, 'SELECT sequence, occurred_at FROM investigation_stream_events WHERE investigation_id = ? ORDER BY sequence', [id]);
      let floor = 0;
      for (const row of rows) { if (new Date(row.occurred_at).getTime() >= Date.parse(before)) break; floor = Number(row.sequence); }
      if (!floor) return;
      await c.execute('DELETE FROM investigation_stream_events WHERE investigation_id = ? AND sequence <= ?', [id, floor]);
      await c.execute('UPDATE investigation_stream_heads SET retained_after = GREATEST(retained_after, ?) WHERE investigation_id = ?', [floor, id]);
    });
  }
}
export function investigationProjectionHash(projection: InvestigationProjection): string {
  return evidenceHash([...projection.documents].sort((a, b) => a.id.localeCompare(b.id)));
}
const instantRetention = (value: string) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() - 90 * 86_400_000;

export type InvestigationWatchFailure = 'authority_revoked' | 'observation_unavailable';
export function investigationWatchFailure(error: unknown): InvestigationWatchFailure {
  return error instanceof InvestigationStoreError
    && ['INVESTIGATION_NOT_FOUND', 'INVESTIGATION_OPERATION_FORBIDDEN'].includes(error.code)
    ? 'authority_revoked' : 'observation_unavailable';
}
interface WatchPeer { send(value: Record<string, unknown>): boolean; close(reason: InvestigationWatchFailure): void; }
interface Watch { generation: number; cursor: number; actor: ActorContext; ready: boolean; }
/** Durable polling observes commits from every worker. No ephemeral subscribe
 * gap, no execution ownership and no cancellation on transport disconnect. */
export class InvestigationWatchService {
  private peers = new Map<WatchPeer, Map<string, Watch>>();
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = new Set<WatchPeer>();
  constructor(private readonly store = new InvestigationStreamStore(), private readonly intervalMs = 1000) {}
  async watch(peer: WatchPeer, caller: ActorContext, id: string, afterSequence?: number): Promise<void> {
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) throw invalidObservation();
    let watches = this.peers.get(peer);
    if (!watches) { watches = new Map(); this.peers.set(peer, watches); }
    if (!watches.has(id) && watches.size >= 8) throw invalidObservation();
    caller = freezeInvestigationCaller(caller);
    const watch: Watch = { generation: (watches.get(id)?.generation ?? 0) + 1, cursor: 0, actor: caller, ready: false };
    watches.set(id, watch);
    try {
      const snapshot = await this.store.snapshot(caller, id);
      if (this.peers.get(peer)?.get(id) !== watch) return;
      // Reauthorize AFTER snapshot construction before delivery. Any unwatch,
      // newer watch, close or revoked scope invalidates this awaited result.
      const check = await this.store.replay(caller, id, snapshot.watermark, 1);
      if (this.peers.get(peer)?.get(id) !== watch) return;
      if (afterSequence !== undefined) {
        const previous = await this.store.replay(caller, id, afterSequence, 1);
        if (this.peers.get(peer)?.get(id) !== watch) return;
        if (previous.replayRequired) peer.send({ type: 'investigation.replay_required', investigationId: id });
      }
      await this.store.transaction(caller, id, async () => {
        if (this.peers.get(peer)?.get(id) !== watch) return;
        if (!peer.send({ type: 'investigation.snapshot', ...snapshot })) { this.unwatch(peer, id); return; }
        watch.cursor = snapshot.watermark; watch.ready = !check.replayRequired;
      });
      this.start();
    } catch (error) { if (this.peers.get(peer)?.get(id) === watch) this.unwatch(peer, id); throw error; }
  }
  private start(): void {
    if (this.timer || !this.peers.size) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs); this.timer.unref();
  }
  async tick(): Promise<void> {
    await Promise.all([...this.peers].map(async ([peer, watches]) => {
      if (this.inFlight.has(peer)) return;
      this.inFlight.add(peer);
      try {
        for (const [id, watch] of watches) {
          if (!watch.ready) continue;
          try {
            const replay = await this.store.replay(watch.actor, id, watch.cursor);
            if (this.peers.get(peer)?.get(id) !== watch) continue;
            if (replay.replayRequired) {
              peer.send({ type: 'investigation.replay_required', investigationId: id }); this.unwatch(peer, id); continue;
            }
            // Recheck the full live boundary just before the send, not merely
            // JWT identity at connect or a cached content permission receipt.
            await this.store.transaction(watch.actor, id, async () => {
              if (this.peers.get(peer)?.get(id) !== watch) return;
              for (const event of replay.events) {
                if (!peer.send({ type: 'investigation.event', event })) { this.unwatch(peer, id); break; }
                watch.cursor = event.sequence;
              }
            });
          } catch (error) {
            if (this.peers.get(peer)?.get(id) !== watch) continue;
            this.unwatch(peer); peer.close(investigationWatchFailure(error)); break;
          }
        }
      } finally { this.inFlight.delete(peer); }
    }));
  }
  unwatch(peer: WatchPeer, id?: string): void {
    if (id === undefined) this.peers.delete(peer);
    else { const watches = this.peers.get(peer); watches?.delete(id); if (!watches?.size) this.peers.delete(peer); }
    if (!this.peers.size) { clearInterval(this.timer); this.timer = undefined; }
  }
  dispose(): void { clearInterval(this.timer); this.timer = undefined; this.peers.clear(); }
}
