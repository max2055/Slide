import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { OutboxService, type TransactionPool } from '../workflows/outbox-service.js';
import type { TypedJobHandler } from '../workflows/job-registry.js';
import { InvestigationAuthorization, freezeInvestigationCaller } from './authorization.js';
import { InvestigationStoreError } from './store.js';
import { MysqlOperationalEventIngest, type EventReceipt } from './event-ingest.js';
import { EventIngestError, normalizeEvent, freezeTriggerBinding, stableHash, type EventInput, type TriggerBinding } from './trigger-policy.js';
import { redactSensitiveData } from '../security/sensitive-data.js';

export const SYSTEM_EVENT_JOB = 'system.event.ingest';
export type SystemComponent = 'api' | 'collector' | 'queue' | 'agent';
export interface SystemFailure {
  component: SystemComponent; sourceEventId: string; occurredAt: string;
  correlationId: string; stableErrorCode: string; callsite: string;
  origin: EventInput['origin']; httpStatus?: number;
  releaseId?: string; commitSha?: string;
  /** Body-free original error facts. Never request/job/model payloads. */
  facts?: { jobId?: string; jobType?: string; attempt?: number; fencingToken?: number; outcome?: string };
}
export interface SystemErrorFact {
  schemaVersion: 1; source: string; event: EventInput; raw: SystemFailure['facts']; contentHash: string;
}
const components: readonly string[] = ['api', 'collector', 'queue', 'agent'];
const label = (v: unknown, max = 128): v is string => typeof v === 'string' && new RegExp(`^[A-Za-z0-9_.:/-]{1,${max}}$`).test(v);
const decode = <T>(v: T | string): T => typeof v === 'string' ? JSON.parse(v) : v;
export function prepareSystemFailure(input: SystemFailure): Omit<SystemErrorFact, 'contentHash'> {
  if (!input || !components.includes(input.component) || !label(input.sourceEventId) || !label(input.correlationId)
    || !label(input.stableErrorCode) || !label(input.callsite, 512)
    || !Number.isFinite(Date.parse(input.occurredAt))
    || !['collector', 'workflow', 'user_operation', 'investigation_engine'].includes(input.origin)
    || input.httpStatus !== undefined && (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)
    || input.releaseId !== undefined && !label(input.releaseId, 100)
    || input.commitSha !== undefined && !/^[a-f0-9]{40}$/.test(input.commitSha)) throw new EventIngestError('EVENT_INPUT_INVALID');
  const facts = input.facts ?? {};
  if (Object.keys(facts).some(k => !['jobId', 'jobType', 'attempt', 'fencingToken', 'outcome'].includes(k))
    || [facts.jobId, facts.jobType, facts.outcome].some(v => v !== undefined && !label(v))
    || [facts.attempt, facts.fencingToken].some(v => v !== undefined && (!Number.isSafeInteger(v) || v < 1)))
    throw new EventIngestError('EVENT_INPUT_INVALID');
  const source = `slide.system.${input.component}`;
  // Agent outcomes and every investigation job/request are unconditionally
  // engine-origin, regardless of a producer attempting to classify otherwise.
  const origin = input.component === 'agent' || input.facts?.jobType?.startsWith('investigation.')
    || input.facts?.jobType === SYSTEM_EVENT_JOB ? 'investigation_engine' : input.origin;
  const event: EventInput = { schemaVersion: 1, sourceEventId: input.sourceEventId, kind: 'system.failure',
    subject: { kind: 'platform', component: input.component }, occurredAt: new Date(input.occurredAt).toISOString(),
    severity: 'error', summary: `${input.component}: ${input.stableErrorCode}`, correlationId: input.correlationId,
    stableErrorCode: input.stableErrorCode, callsite: input.callsite, origin,
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
    ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }) };
  return { schemaVersion: 1, source, event, raw: redactSensitiveData(facts) as SystemFailure['facts'] };
}

/** Original facts are durable before any automatic admission. Reuses the
 * existing queue, transaction owner and event/admission port; no new schema,
 * model, timer, external dispatch or alternate Run/result owner. */
export class MysqlSystemEventBridge {
  private readonly bindings: ReadonlyMap<string, TriggerBinding>;
  constructor(private readonly poolProvider: () => Pool | null, bindings: readonly TriggerBinding[],
    private readonly ingestFor: (binding: TriggerBinding) => MysqlOperationalEventIngest,
    private readonly authorization = new InvestigationAuthorization()) {
    const frozen = bindings.map(freezeTriggerBinding);
    // Empty bindings permit read-only tools while collection is disabled.
    // record/deliver still reject every unbound source.
    if (new Set(frozen.map(b => b.source)).size !== frozen.length
      || frozen.some(b => b.policy.profileId !== 'system' || b.source !== `slide.system.${b.policy.component}`
        || !components.includes(b.policy.component!))) throw new EventIngestError('EVENT_INPUT_INVALID');
    this.bindings = new Map(frozen.map(b => [b.source, b]));
  }
  private pool(): Pool {
    const pool = this.poolProvider(); if (!pool) throw new EventIngestError('EVENT_STORE_UNAVAILABLE'); return pool;
  }
  async record(input: SystemFailure): Promise<{ jobId: string; duplicate: boolean }> {
    const prepared = prepareSystemFailure(input), binding = this.bindings.get(prepared.source);
    if (!binding) throw new EventIngestError('EVENT_INPUT_INVALID');
    normalizeEvent(prepared.event, binding, randomUUID(), new Date().toISOString());
    const contentHash = stableHash(prepared), payload: SystemErrorFact = { ...prepared, contentHash };
    const key = `system-event:${stableHash([prepared.source, prepared.event.sourceEventId])}`;
    const id = randomUUID();
    return new OutboxService(this.pool() as unknown as TransactionPool).transaction(async c => {
      await c.execute(`INSERT INTO workflow_jobs (id, job_type, schema_version, payload, idempotency_key)
        VALUES (?, ?, 1, ?, ?) ON DUPLICATE KEY UPDATE id = id`, [id, SYSTEM_EVENT_JOB, JSON.stringify(payload), key]);
      const [rows] = await c.execute('SELECT id, job_type, payload FROM workflow_jobs WHERE idempotency_key = ? FOR UPDATE', [key]) as [RowDataPacket[], unknown];
      const stored = decode<SystemErrorFact>(rows[0].payload);
      if (rows[0].job_type !== SYSTEM_EVENT_JOB || stored.contentHash !== contentHash || stableHash({ schemaVersion: stored.schemaVersion,
        source: stored.source, event: stored.event, raw: stored.raw }) !== contentHash) throw new EventIngestError('EVENT_DELIVERY_CONFLICT');
      return { jobId: rows[0].id, duplicate: rows[0].id !== id };
    });
  }
  /** Read the durable original, never trust claim payload to grant authority. */
  async deliver(jobId: string): Promise<EventReceipt> {
    if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new EventIngestError('EVENT_INPUT_INVALID');
    const [rows] = await this.pool().execute<RowDataPacket[]>('SELECT payload FROM workflow_jobs WHERE id = ? AND job_type = ?', [jobId, SYSTEM_EVENT_JOB]);
    if (!rows[0]) throw new EventIngestError('EVENT_INPUT_INVALID');
    const stored = decode<SystemErrorFact>(rows[0].payload), binding = this.bindings.get(stored.source);
    const { contentHash, ...prepared } = stored;
    if (!binding || stored.schemaVersion !== 1 || stableHash(prepared) !== contentHash) throw new EventIngestError('EVENT_DELIVERY_CONFLICT');
    return this.ingestFor(binding).ingest({ ...stored.event, rawRef: `workflow-job:${jobId}` });
  }
  handler(): TypedJobHandler {
    return async (_payload, job, context) => {
      if (job.type !== SYSTEM_EVENT_JOB) throw new EventIngestError('EVENT_INPUT_INVALID');
      context.signal.throwIfAborted();
      return this.deliver(job.id); // admission is idempotent even after lost ack/lease.
    };
  }
  /** For System tools only. Exact investigation/event links plus live whole
   * scope authorization; no arbitrary rawRef traversal or job payload reads. */
  async readFacts(caller: import('../auth/actor-context.js').ActorContext, investigationId: string,
    window: { from: string; to: string; component: string }): Promise<SystemErrorFact[]> {
    caller = freezeInvestigationCaller(caller);
    return new OutboxService(this.pool() as unknown as TransactionPool).transaction(async c => {
      const inv = await this.authorization.load(c, investigationId);
      await this.authorization.authorize(c, caller, inv, 'content');
      if (inv.profileId !== 'system') throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
      if (!components.includes(window.component) || !Number.isFinite(Date.parse(window.from)) || !Number.isFinite(Date.parse(window.to))
        || Date.parse(window.from) > Date.parse(window.to) || Date.parse(window.to) - Date.parse(window.from) > 3_600_000)
        throw new EventIngestError('EVENT_INPUT_INVALID');
      const [rows] = await c.execute(`SELECT j.payload FROM investigation_event_links l
        JOIN operational_events e ON e.id = l.event_id
        JOIN workflow_jobs j ON JSON_UNQUOTE(JSON_EXTRACT(e.envelope, '$.rawRef')) = CONCAT('workflow-job:', j.id)
        WHERE l.investigation_id = ? AND e.source = ? AND j.job_type = ?
        AND e.occurred_at BETWEEN ? AND ? ORDER BY e.occurred_at, e.id LIMIT 101`,
      [investigationId, `slide.system.${window.component}`, SYSTEM_EVENT_JOB,
        new Date(window.from), new Date(window.to)]) as [RowDataPacket[], unknown];
      return rows.map(row => {
        const stored = decode<SystemErrorFact>(row.payload), { contentHash, ...prepared } = stored;
        if (stored.schemaVersion !== 1 || stored.source !== `slide.system.${window.component}` || stableHash(prepared) !== contentHash)
          throw new EventIngestError('EVENT_DELIVERY_CONFLICT');
        return stored;
      });
    });
  }
}
