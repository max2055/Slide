/** Synthetic SQL adapter: calls complete production transactions, never a live source. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertKnownPartial } from '../../investigations/continuation.js';
import { SourceControl } from './control.js';
import { sourceIntentHash } from './audit.js';
import { sourceTestConfig } from './config.fixture.js';

const zero = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
function partial(investigationId: string, version: number) {
  const requestId = randomUUID(), jobId = randomUUID(), runId = randomUUID(), reservationId = randomUUID();
  const actor = { kind: 'user', id: 100 + version }, sessionId = randomUUID();
  const operationId = `request:${requestId}`;
  const receipt = { schemaVersion: 1, requestId, reservationId, operationId, domain: 'synthetic', mode: 'manual', commandHash: 'a'.repeat(64) };
  return {
    request: { id: requestId, investigation_id: investigationId, actor_kind: actor.kind, actor_id: actor.id,
      message_id: randomUUID(), job_id: jobId, cancel_requested_at: null, request_snapshot: {
        id: investigationId, actor, sessionId, authority: { actor, sessionId, investigationId }, budgetReceipt: receipt,
      } as any },
    job: { id: jobId, job_type: 'investigation.execute', state: 'dead_letter', fencing_token: 1,
      payload: { investigationId, requestId }, lease_owner: null, lease_expires_at: null },
    run: { id: runId, idempotency_key: `investigation:${requestId}`, actor_id: actor.id, session_id: sessionId,
      message_id: '', state: 'partial', result_json: { investigationExecution: { schemaVersion: 1, requestId,
        jobId, fencingToken: 1, provider: null, tools: {}, usageUnknown: false, usage: zero(), reservationId, reservedTokens: 32000 } } as any },
    result: { investigation_id: investigationId, version, request_id: requestId, run_id: runId },
    allocation: { id: reservationId, request_id: requestId, operation_id: operationId, domain_key: 'synthetic', mode: 'manual',
      command_hash: receipt.commandHash, reserved_tokens: 32000, reserved_cost_micros: 1000,
      reservation_snapshot: { requestId, operationId, domain: 'synthetic', mode: 'manual', reserveTokens: 32000, reserveCostMicros: 1000 },
      state: 'cancelled', sent_at: null, settled_at: new Date(), charged_tokens: 0, charged_cost_micros: 0,
      cost_status: 'known', usage_snapshot: null as any, settlement_hash: null as any }, evidence: [],
  };
}
function fixture(depth = 1) {
  const investigationId = randomUUID(), config = { ...sourceTestConfig(), investigationId, phase: 'collect' as const };
  const parts = Array.from({ length: depth }, (_, n) => partial(investigationId, n + 1));
  const tail = partial(investigationId, depth + 1).request;
  parts.forEach((p, i) => {
    p.run.message_id = p.request.message_id;
    (parts[i + 1]?.request ?? tail).request_snapshot.continuationOf = {
      requestId: p.request.id, runId: p.run.id, resultVersion: p.result.version,
    };
  });
  const jobs: any[] = parts.map(p => p.job);
  for (const p of parts) {
    const predecessor = { id: randomUUID(), job_type: 'qualification.source', state: 'dead_letter', attempts: 1,
      max_attempts: 1, lease_owner: null, lease_expires_at: null, last_error: 'V23_SOURCE_REQUIRES_AUDIT',
      payload: { phase: 'investigate', operationId: randomUUID() }, idempotency_key: '' };
    predecessor.idempotency_key = `v23-source:${predecessor.payload.operationId}`;
    const intent = { ...predecessor, id: randomUUID(), state: 'completed', last_error: null as any,
      payload: { phase: 'continue', operationId: randomUUID() }, idempotency_key: '' };
    intent.idempotency_key = `v23-source:${intent.payload.operationId}`;
    const reviewId = randomUUID();
    jobs.push(predecessor, intent, { id: reviewId, job_type: 'qualification.source.audit', state: 'completed',
      idempotency_key: `v23-source-audit:${predecessor.id}`, lease_owner: null, lease_expires_at: null,
      payload: { predecessorId: predecessor.id, predecessorHash: sourceIntentHash(predecessor), successorIntentId: intent.id,
        receipt: { reviewId, decision: 'known_partial_explicit_continuation', predecessor: { intentId: predecessor.id,
          operationId: predecessor.payload.operationId, jobHash: sourceIntentHash(predecessor) },
          successor: { operationId: intent.payload.operationId, database: config.database }, partial: {
            investigationId, requestId: p.request.id, runId: p.run.id, resultVersion: p.result.version,
            executionJobId: p.job.id, executionJobHash: sourceIntentHash(p.job), recordsHash: sourceIntentHash(p),
          } } } });
  }
  const requests = [...parts.map(p => p.request), tail];
  const counters = { writes: 0, commits: 0, rollbacks: 0 };
  let control: SourceControl;
  const select = async (sql: string, args: any[] = []): Promise<any> => {
    if (sql.startsWith('INSERT')) { counters.writes++; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('SELECT * FROM workflow_jobs ORDER')) return [jobs];
    if (sql.includes('FROM investigation_requests')) {
      if (sql.includes('JSON_EXTRACT')) return [requests.filter(r => r.investigation_id === args[0]
        && r.request_snapshot.continuationOf?.requestId === args[1]).map(r => ({ id: r.id }))];
      return [requests.filter(r => r.id === args[0] && (args.length < 2 || r.investigation_id === args[1]))];
    }
    if (sql.includes('FROM workflow_jobs')) return [jobs.filter(j => j.id === args[0])];
    if (sql.includes('FROM agent_runs')) return [parts.filter(p => p.run.id === args[0]).map(p => p.run)];
    if (sql.includes('FROM investigation_results')) return [parts.filter(p => p.result.investigation_id === args[0]
      && (args.length < 2 || p.result.version === args[1])).map(p => p.result).sort((a, b) => b.version - a.version)];
    if (sql.includes('FROM investigation_budget_ledger')) return [parts.filter(p => p.request.id === args[0]).map(p => p.allocation)];
    if (sql.includes('FROM investigation_evidence')) return [[]];
    if (sql.includes('FROM worker_leases')) return [[{ db: config.database, utc: new Date(), zone: '+00:00', held: 1,
      owner_id: (control as any).lease.ownerId, expires_at: new Date(Date.now() + 30000) }]];
    throw Error(`UNEXPECTED_SQL:${sql}`);
  };
  const connection = { threadId: 42, execute: select, query: select, beginTransaction: async () => {},
    commit: async () => { counters.commits++; }, rollback: async () => { counters.rollbacks++; } };
  control = new SourceControl({} as any, { ...config, requestId: tail.id });
  (control as any).lock = connection;
  return { parts, tail, jobs, requests, investigationId, counters, connection, control,
    record: () => (control as any).recordIntent(),
    check: (successor = tail.id) => assertKnownPartial(connection as any, investigationId, {
      requestId: parts[0].request.id, runId: parts[0].run.id, resultVersion: parts[0].result.version,
    }, successor),
    rehash: () => { for (const p of parts) for (const j of jobs) if (j.payload?.receipt?.partial?.requestId === p.request.id)
      j.payload.receipt.partial.recordsHash = sourceIntentHash(p); },
  };
}

describe('known terminal partial and complete inherited source chain', () => {
  it('accepts a precisely bound cancelled zero-send allocation without changing it', async () => {
    const f = fixture(), before = structuredClone(f.parts);
    await expect(f.check()).resolves.toEqual(f.parts[0]);
    expect(f.parts).toEqual(before); expect(f.counters.writes).toBe(0);
  });
  it('retains exact settled usage matching', async () => {
    const f = fixture(), p = f.parts[0];
    Object.assign(p.allocation, { state: 'settled', sent_at: new Date(), usage_snapshot: zero(), settlement_hash: 'b'.repeat(64) });
    await expect(f.check()).resolves.toEqual(p);
    p.allocation.usage_snapshot.inputTokens = 1;
    await expect(f.check()).rejects.toThrow('VERSION_CONFLICT');
  });
  const mutations: Record<string, (p: ReturnType<typeof partial>) => void> = {
    sent: p => { p.allocation.sent_at = new Date() as any; },
    charged: p => { p.allocation.charged_tokens = 1; }, cost: p => { p.allocation.charged_cost_micros = 1; },
    unknownCost: p => { p.allocation.cost_status = 'unknown'; }, unknownUsage: p => { p.run.result_json.investigationExecution.usageUnknown = true; },
    usage: p => { p.run.result_json.investigationExecution.usage.inputTokens = 1; },
    cache: p => { p.run.result_json.investigationExecution.usage.cachedInputTokens = 1; },
    output: p => { p.run.result_json.investigationExecution.usage.outputTokens = 1; },
    missingUsage: p => { delete p.run.result_json.investigationExecution.usage; },
    missingTerminal: p => { p.allocation.settled_at = null as any; },
    usageSnapshot: p => { p.allocation.usage_snapshot = zero(); }, hash: p => { p.allocation.settlement_hash = 'x'; },
    reserved: p => { p.allocation.state = 'reserved'; }, unknown: p => { p.allocation.state = 'unknown'; },
    provider: p => { p.run.result_json.investigationExecution.provider = { status: 'sent' }; },
    tool: p => { p.run.result_json.investigationExecution.tools = { call: { status: 'running' } }; },
    returnedTool: p => { p.run.result_json.investigationExecution.tools = { call: { status: 'returned' } }; },
    pending: p => { p.run.result_json.completionPending = true; }, lease: p => { p.job.lease_owner = 'other' as any; },
    reservation: p => { p.run.result_json.investigationExecution.reservationId = randomUUID(); },
    receipt: p => { p.request.request_snapshot.budgetReceipt.reservationId = randomUUID(); },
    request: p => { p.allocation.request_id = randomUUID(); }, operation: p => { p.allocation.operation_id = 'other'; },
    domain: p => { p.allocation.domain_key = 'other'; }, mode: p => { p.allocation.mode = 'automatic'; },
    command: p => { p.allocation.command_hash = 'b'.repeat(64); },
    snapshot: p => { p.allocation.reservation_snapshot.requestId = randomUUID(); },
    actor: p => { p.run.actor_id++; }, session: p => { p.run.session_id = randomUUID(); },
    cancellation: p => { p.request.cancel_requested_at = 'now' as any; },
  };
  it.each(Object.keys(mutations))('rejects cancelled inconsistency: %s', async name => {
    const f = fixture(); mutations[name](f.parts[0]);
    await expect(f.check()).rejects.toThrow('VERSION_CONFLICT'); expect(f.counters.writes).toBe(0);
  });
  it.each([1, 2, 4, 8])('commits complete recordIntent for %i inherited edges with distinct node actors/sessions', async depth => {
    const f = fixture(depth); await expect(f.record()).resolves.toBeTypeOf('string');
    expect(f.counters).toEqual({ writes: 1, commits: 1, rollbacks: 0 });
  });
  const corruptions: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    records: f => { f.parts[0].request.message_id = randomUUID(); },
    hash: f => { f.jobs.find(j => j.payload?.receipt).payload.receipt.partial.recordsHash = '0'.repeat(64); },
    jobHash: f => { f.jobs.find(j => j.payload?.receipt).payload.receipt.partial.executionJobHash = '0'.repeat(64); },
    version: f => { f.parts[1].request.request_snapshot.continuationOf.resultVersion++; },
    run: f => { f.parts[1].request.request_snapshot.continuationOf.runId = randomUUID(); },
    investigation: f => { f.parts[1].request.investigation_id = randomUUID(); },
    actor: f => { f.parts[1].run.actor_id++; }, session: f => { f.parts[1].run.session_id = randomUUID(); },
    missingEdge: f => { delete f.parts[1].request.request_snapshot.continuationOf; f.rehash(); },
    branch: f => { f.requests.push({ ...structuredClone(f.tail), id: randomUUID() }); },
    missingAudit: f => { f.jobs.splice(f.jobs.findIndex(j => j.payload?.receipt), 1); },
    predecessor: f => { f.jobs.find(j => j.payload?.receipt).payload.predecessorId = randomUUID(); },
    successor: f => { f.jobs.find(j => j.payload?.receipt).payload.successorIntentId = randomUUID(); },
    operation: f => { f.jobs.find(j => j.payload?.receipt).payload.receipt.successor.operationId = randomUUID(); },
    review: f => { f.jobs.find(j => j.payload?.receipt).payload.receipt.reviewId = randomUUID(); },
    tailActor: f => { f.tail.request_snapshot.actor.id++; },
    tailSession: f => { f.tail.request_snapshot.authority.sessionId = randomUUID(); },
    unrelated: f => { delete f.tail.request_snapshot.continuationOf; },
    notTail: f => { const r = structuredClone(f.tail); r.id = randomUUID(); r.request_snapshot.continuationOf.requestId = f.tail.id; f.requests.push(r); },
    cycle: f => { f.parts[0].request.request_snapshot.continuationOf = {
      requestId: f.parts[1].request.id, runId: f.parts[1].run.id, resultVersion: f.parts[1].result.version }; f.rehash(); },
  };
  it.each(Object.keys(corruptions))('rolls back with zero writes for complete-chain corruption: %s', async name => {
    const f = fixture(3); corruptions[name](f);
    await expect(f.record()).rejects.toThrow();
    expect(f.counters).toEqual({ writes: 0, commits: 0, rollbacks: 1 });
  });
});
