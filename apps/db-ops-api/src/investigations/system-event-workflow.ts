import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import type { TransactionConnection } from '../workflows/outbox-service.js';
import { platformLogs, type StructuredLogEvidenceAdapter } from '../platform/structured-log-evidence-adapter.js';
import { InvestigationAuthorization, freezeInvestigationCaller } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { InvestigationStoreError, type AdmissionInvestigation } from './store.js';
import { appendObservation, decode, isId, observationRows, invalidObservation, absentObservation, InvestigationObservationDatabase } from './observation-db.js';
import { SYSTEM_EVENT_JOB, type SystemErrorFact } from './system-event-bridge.js';
import { stableHash } from './trigger-policy.js';

/** Live System authority does not grant membership of service-owned investigations. */
export async function systemEventOn(c: TransactionConnection, actor: ActorContext, id: string, authorization: InvestigationAuthorization) {
  if (!isId(id)) throw invalidObservation();
  const subject: AdmissionInvestigation = { id: 'system-event-read', sessionId: 'system-event-read', profileId: 'system',
    profileVersion: 1, scopeVersion: 'system-event-read', version: 1, lifecycle: 'open',
    owner: { kind: actor.principalKind ?? 'user', id: actor.userId }, resources: [] };
  await authorization.authorize(c, actor, subject, 'create');
  const [row] = await observationRows(c as never, `SELECT e.*, j.payload AS fact FROM operational_events e
    JOIN workflow_jobs j ON JSON_UNQUOTE(JSON_EXTRACT(e.envelope,'$.rawRef'))=CONCAT('workflow-job:',j.id)
    WHERE e.id=? AND j.job_type=? FOR SHARE`, [id, SYSTEM_EVENT_JOB]);
  if (!row) throw absentObservation();
  const fact = decode(row.fact) as SystemErrorFact, { contentHash, ...prepared } = fact;
  if (fact.schemaVersion !== 1 || !['slide.system.api','slide.system.collector','slide.system.queue','slide.system.agent'].includes(fact.source)
    || fact.source !== String(row.source) || fact.event.subject.kind !== 'platform' || fact.event.sourceEventId !== String(row.source_event_id)
    || stableHash(prepared) !== contentHash) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
  return { row, fact, subject };
}

/** Explicit read-only draft and no-action verification on the existing owner. */
export class SystemEventWorkflow extends InvestigationObservationDatabase {
  private readonly bridge: InvestigationSessionBridge;
  constructor(pool: () => Pool | null, authorization = new InvestigationAuthorization(), bridge?: InvestigationSessionBridge,
    private readonly logs: StructuredLogEvidenceAdapter = platformLogs, private readonly collectionActive: () => boolean = () => false) {
    super(pool, authorization);
    this.bridge = bridge ?? new InvestigationSessionBridge(pool, authorization);
  }
  async draft(caller: ActorContext, eventId: string) {
    const actor = freezeInvestigationCaller(caller);
    if ((actor.principalKind ?? 'user') !== 'user') throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
    return this.bridge.storeFor(actor).transaction(async (c, append) => {
      const { fact, row, subject } = await systemEventOn(c, actor, eventId, this.authorization);
      const [link] = await observationRows(c as never, 'SELECT investigation_id FROM investigation_event_links WHERE event_id=? FOR SHARE', [eventId]);
      const existing = link?.investigation_id ?? row.investigation_id;
      if (existing) {
        const inv = await this.authorization.load(c, existing);
        await this.authorization.authorize(c, actor, inv, 'read');
        return { id: inv.id, eventId, modelInvoked: false as const };
      }
      const created = await this.bridge.createOnConnection(actor, c, append, {
        idempotencyKey: `platform-event:${eventId}`, title: 'Slide 平台诊断', goal: '核对原平台异常、故障部署版本与后续观测，保留证据不足；分析完成不代表恢复。',
        profileId: 'system', profileVersion: 1, resources: [],
        context: { subject: fact.event.subject, from: fact.event.occurredAt, to: new Date(row.received_at).toISOString() },
      });
      await c.execute('INSERT INTO investigation_event_links (investigation_id,event_id) VALUES (?,?) ON DUPLICATE KEY UPDATE event_id=event_id', [created.investigation.id, eventId]);
      const [final] = await observationRows(c as never, 'SELECT investigation_id FROM investigation_event_links WHERE event_id=? FOR SHARE', [eventId]);
      if (final?.investigation_id !== created.investigation.id) throw new InvestigationStoreError('VERSION_CONFLICT');
      await this.authorization.authorize(c, actor, subject, 'create');
      return { id: created.investigation.id, eventId, modelInvoked: false as const };
    });
  }
  async detail(caller: ActorContext, investigationId: string) {
    const actor = freezeInvestigationCaller(caller);
    return this.transaction(actor, investigationId, async (c, inv) => {
      if (inv.profileId !== 'system' || inv.resources.length) throw absentObservation();
      const links = await observationRows(c, 'SELECT event_id FROM investigation_event_links WHERE investigation_id=? ORDER BY linked_at,event_id LIMIT 101', [inv.id]);
      const events = [];
      for (const link of links.slice(0, 100)) {
        const { fact } = await systemEventOn(c as never, actor, link.event_id, this.authorization);
        const receipts = await observationRows(c, 'SELECT payload FROM platform_event_verifications WHERE event_id=? AND investigation_id=? ORDER BY created_at DESC,id DESC LIMIT 20', [link.event_id, inv.id]);
        events.push({ eventId: link.event_id, fact, returnTo: `/events?view=system&event=${link.event_id}`, verifications: receipts.map(r => decode(r.payload)) });
      }
      await this.authorization.authorize(c as never, actor, inv, 'content');
      return { events, truncated: links.length > 100, modelInvoked: false as const };
    });
  }
  async verify(caller: ActorContext, eventId: string, investigationId: string, expectedVersion: number, key: string) {
    const actor = freezeInvestigationCaller(caller);
    if (!isId(eventId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !key?.trim() || Buffer.byteLength(key) > 255) throw invalidObservation();
    return this.transaction(actor, investigationId, async (c, inv) => {
      await this.authorization.authorize(c as never, actor, inv, 'patch');
      if ((actor.principalKind ?? 'user') !== 'user' || inv.profileId !== 'system' || inv.resources.length) throw absentObservation();
      const [link] = await observationRows(c, 'SELECT event_id FROM investigation_event_links WHERE investigation_id=? AND event_id=? FOR SHARE', [inv.id, eventId]);
      if (!link) throw absentObservation();
      const { fact } = await systemEventOn(c as never, actor, eventId, this.authorization);
      const commandHash = stableHash([eventId, inv.id, expectedVersion]);
      const [prior] = await observationRows(c, 'SELECT command_hash,payload FROM platform_event_verifications WHERE investigation_id=? AND actor_id=? AND idempotency_key=? FOR UPDATE', [inv.id, actor.userId, Buffer.from(key)]);
      if (prior) {
        if (prior.command_hash !== commandHash) throw new InvestigationStoreError('IDEMPOTENCY_PAYLOAD_MISMATCH');
        return decode(prior.payload);
      }
      if (!Number.isSafeInteger(inv.version + 1) || inv.version !== expectedVersion) throw new InvestigationStoreError('VERSION_CONFLICT');
      const [state] = await observationRows(c, 'SELECT active_request_id FROM investigations WHERE id=?', [inv.id]);
      if (state.active_request_id) throw new InvestigationStoreError('INVESTIGATION_ACTIVE_REQUEST');
      if (inv.lifecycle === 'archived' || inv.lifecycle === 'closed') throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
      let evidence: ReturnType<StructuredLogEvidenceAdapter['verifyFailure']>;
      try { evidence = this.logs.verifyFailure(fact.event, this.collectionActive()); }
      catch { evidence = { from: fact.event.occurredAt, to: new Date().toISOString(), conclusion: 'insufficient_evidence', gaps: ['LOG_EVIDENCE_UNAVAILABLE'], observation: null, persistence: 'process-local' }; }
      const [clock] = await observationRows(c, 'SELECT CURRENT_TIMESTAMP(3) AS now');
      const occurredAt = new Date(clock.now).toISOString(), version = inv.version + 1;
      const receipt = { id: randomUUID(), eventId, investigationId: inv.id, actorId: actor.userId, version,
        originalHash: fact.contentHash, releaseId: fact.event.releaseId ?? null, commitSha: fact.event.commitSha ?? null,
        ...evidence, verifiedAt: occurredAt, modelInvoked: false as const };
      await c.execute('INSERT INTO platform_event_verifications (id,event_id,investigation_id,actor_id,idempotency_key,command_hash,payload) VALUES (?,?,?,?,?,?,?)',
        [receipt.id,eventId,inv.id,actor.userId,Buffer.from(key),commandHash,JSON.stringify(receipt)]);
      const problemStatus = evidence.conclusion === 'recovered' ? 'resolved' : evidence.conclusion === 'not_improved' ? 'in_progress' : 'unconfirmed';
      await c.execute('UPDATE investigations SET problem_status=?,version=? WHERE id=?', [problemStatus,version,inv.id]);
      await appendObservation(c, inv.id, `platform-verification:${receipt.id}`, { type: 'investigation.changed', occurredAt, payload: { version, lifecycle: inv.lifecycle, problemStatus } });
      await this.authorization.authorize(c as never, actor, inv, 'patch');
      return receipt;
    });
  }
}
