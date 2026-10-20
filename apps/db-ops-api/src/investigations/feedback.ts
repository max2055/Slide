import { ActionVerificationStore } from '../operations/actions/verification-store.js';
import { PlanStore } from '../operations/actions/plan-store.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { evidenceHash, redactEvidence } from '../analysis/analysis-evidence.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationStoreError, type AdmissionInvestigation } from './store.js';
import { InvestigationObservationDatabase, observationRows, appendObservation, decode, invalidObservation, absentObservation } from './observation-db.js';
import { InvestigationResultStore, resultEvidenceIds, type VersionedInvestigationResult } from './result-schema.js';
import { validateFeedback, feedbackEvidenceIds, coversRecoveryWindow, type InvestigationFeedbackRequest, type InvestigationFeedbackRecord } from './feedback-contracts.js';

export class InvestigationFeedbackStore extends InvestigationObservationDatabase {
  private readonly results: InvestigationResultStore;
  private readonly actionReports: ActionVerificationStore;
  constructor(poolProvider: () => Pool | null = () => dbConnection.getPool(), authorization = new InvestigationAuthorization()) {
    super(poolProvider, authorization);
    this.results = new InvestigationResultStore(poolProvider, authorization);
    this.actionReports = new ActionVerificationStore(new PlanStore(poolProvider() as never));
  }
  private async result(c: PoolConnection, investigation: Readonly<AdmissionInvestigation>, id: string, version: number): Promise<VersionedInvestigationResult> {
    const [row] = await observationRows(c, 'SELECT * FROM investigation_results WHERE id = ? AND investigation_id = ? AND version = ? FOR SHARE', [id, investigation.id, version]);
    if (!row) throw absentObservation();
    return { id: row.id, version: Number(row.version), investigationId: investigation.id,
      requestId: row.request_id, runId: row.run_id, result: decode(row.result_json) };
  }
  private async references(c: PoolConnection, actor: ActorContext, investigation: Readonly<AdmissionInvestigation>,
    result: VersionedInvestigationResult, command: InvestigationFeedbackRequest, available: boolean) {
    const ids = feedbackEvidenceIds(command);
    if ('verification' in command && command.verification?.actionReport) {
      try { await this.actionReports.reference(c as never, actor, investigation.id, command.verification.actionReport); }
      catch (error) {
        if (error instanceof Error && ['OPERATIONS_NOT_FOUND', 'OPERATIONS_FORBIDDEN'].includes(error.message)) throw absentObservation();
        if (error instanceof Error && error.message === 'OPERATIONS_PRECONDITION_FAILED') throw invalidObservation();
        throw error;
      }
    }
    // Reading feedback also rechecks every scope of the result it refers to.
    await this.results.authorizedBindings(c, actor, investigation, result, [...new Set([...resultEvidenceIds(result.result), ...ids])]);
    await this.results.authorizedBindings(c, actor, investigation, result, ids, available);
    const references: InvestigationFeedbackRecord['references'] = [], metadata = [];
    for (const id of ids) {
      const [row] = await observationRows(c, 'SELECT content_hash, metadata_json, expires_at, expired_at FROM investigation_evidence WHERE id = ? FOR SHARE', [id]);
      references.push({ id, contentHash: row.content_hash,
        status: row.expired_at || new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'available' });
      metadata.push(decode(row.metadata_json));
    }
    return { references, metadata };
  }
  private record(row: any, references: InvestigationFeedbackRecord['references'], latest: number): InvestigationFeedbackRecord {
    return { id: row.id, investigationId: row.investigation_id, actorId: Number(row.actor_id),
      version: Number(row.accepted_version), command: decode(row.command_json), createdAt: new Date(row.created_at).toISOString(),
      staleResult: Number(row.result_version) !== latest, references,
      ...(row.verification_json ? { verification: decode(row.verification_json) } : {}) };
  }
  async add(caller: ActorContext, investigationId: string, key: string, value: unknown): Promise<InvestigationFeedbackRecord> {
    const command = structuredClone(validateFeedback(value));
    if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > 255) throw invalidObservation();
    return this.transaction(caller, investigationId, async (c, investigation, actor) => {
      if ((actor.principalKind ?? 'user') !== 'user') throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
      await this.authorization.authorize(c as never, actor, investigation, 'patch');
      const result = await this.result(c, investigation, command.resultId, command.resultVersion);
      const { references, metadata } = await this.references(c, actor, investigation, result, command, true);
      const hash = evidenceHash(command);
      const [latestRow] = await observationRows(c, 'SELECT COALESCE(MAX(version), 0) AS version FROM investigation_results WHERE investigation_id = ?', [investigationId]);
      const latest = Number(latestRow.version);
      const [existing] = await observationRows(c, 'SELECT * FROM investigation_feedback WHERE investigation_id = ? AND actor_id = ? AND idempotency_key = ? FOR UPDATE', [investigationId, actor.userId, Buffer.from(key)]);
      if (existing) {
        if (existing.payload_hash !== hash) throw new InvestigationStoreError('IDEMPOTENCY_PAYLOAD_MISMATCH');
        return this.record(existing, references, latest);
      }
      if (latest !== result.version || investigation.version !== command.expectedVersion || !Number.isSafeInteger(investigation.version + 1)) throw new InvestigationStoreError('VERSION_CONFLICT');
      if (investigation.lifecycle === 'archived') throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
      if (command.kind === 'close') {
        const [row] = await observationRows(c, 'SELECT active_request_id FROM investigations WHERE id = ?', [investigationId]);
        if (row.active_request_id) throw new InvestigationStoreError('INVESTIGATION_ACTIVE_REQUEST');
      }
      const actionProof = 'verification' in command && command.verification?.actionReport
        ? await this.actionReports.forFeedback(c as never, actor, investigationId, result.id, result.version,
          investigation.version, command.verification.actionReport, command.verification.from, command.verification.to).catch(error => {
            if (error instanceof Error && error.message === 'OPERATIONS_NOT_FOUND') throw absentObservation();
            if (error instanceof Error && error.message === 'OPERATIONS_FORBIDDEN') throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
            if (error instanceof Error && ['OPERATIONS_PRECONDITION_FAILED', 'OPERATIONS_VERSION_CONFLICT', 'OPERATIONS_EXPIRED'].includes(error.message)) throw invalidObservation();
            throw error;
          }) : null;
      if ((command.kind === 'recovery' || command.kind === 'close') && 'verification' in command && command.verification
        && (!actionProof && !coversRecoveryWindow(command.verification, metadata) || investigation.resources.some(resource =>
          !(actionProof && actionProof.resource.type === resource.type && actionProof.resource.id === resource.id) && !coversRecoveryWindow(command.verification, metadata.filter(row => row.resources.some((ref: { type: string; id: number }) =>
            ref.type === resource.type && ref.id === resource.id)))))) throw invalidObservation();
      const [clock] = await observationRows(c, 'SELECT CURRENT_TIMESTAMP(3) AS now');
      const createdAt = new Date(clock.now).toISOString();
      const safe = redactEvidence(command) as InvestigationFeedbackRequest;
      const verification = 'verification' in safe && safe.verification
        ? { ...safe.verification, verifiedAt: createdAt, verifiedBy: actor.userId, status: 'human_confirmed' as const } : undefined;
      const id = randomUUID(), version = investigation.version + 1;
      await c.execute(`INSERT INTO investigation_feedback
        (id, investigation_id, result_id, result_version, actor_id, idempotency_key, payload_hash, accepted_version, command_json, verification_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, investigationId, result.id, result.version, actor.userId,
        Buffer.from(key), hash, version, JSON.stringify(safe), verification ? JSON.stringify(verification) : null, new Date(createdAt)]);
      if (command.kind === 'close') {
        await c.execute('UPDATE investigations SET lifecycle = ?, problem_status = ?, version = ? WHERE id = ?', [command.lifecycle, command.problemStatus, version, investigationId]);
      } else await c.execute('UPDATE investigations SET version = ? WHERE id = ?', [version, investigationId]);
      const [state] = await observationRows(c, 'SELECT lifecycle, problem_status FROM investigations WHERE id = ?', [investigationId]);
      await appendObservation(c, investigationId, `feedback:${id}`, { type: 'investigation.changed', occurredAt: createdAt,
        payload: { version, lifecycle: state.lifecycle, problemStatus: state.problem_status } });
      return { id, investigationId, actorId: actor.userId, version, command: safe, createdAt, staleResult: false, references, ...(verification ? { verification } : {}) };
    });
  }
  async list(caller: ActorContext, investigationId: string, before?: number, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw invalidObservation();
    return this.transaction(caller, investigationId, async (c, investigation, actor) => {
      const [latest] = await observationRows(c, 'SELECT COALESCE(MAX(version), 0) AS version FROM investigation_results WHERE investigation_id = ?', [investigationId]);
      const rows = await observationRows(c, `SELECT * FROM investigation_feedback WHERE investigation_id = ? ${before === undefined ? '' : 'AND accepted_version < ?'} ORDER BY accepted_version DESC LIMIT ?`, [investigationId, ...(before === undefined ? [] : [before]), limit + 1]);
      const items: InvestigationFeedbackRecord[] = [];
      for (const row of rows.slice(0, limit)) {
        const result = await this.result(c, investigation, row.result_id, Number(row.result_version));
        const { references } = await this.references(c, actor, investigation, result, decode(row.command_json), false);
        const record = this.record(row, references, Number(latest.version));
        if (record.verification?.actionReport) {
          record.staleVerification = record.staleResult || investigation.version !== record.version;
          if (!record.staleVerification) {
            try {
              await this.actionReports.forFeedback(c as never, actor, investigationId, result.id, result.version,
                Number(row.accepted_version) - 1, record.verification.actionReport, record.verification.from, record.verification.to);
            } catch (error) {
              // Revoked callers must still fail the entire content read; expired/old proof is retained as stale history.
              if (error instanceof Error && ['OPERATIONS_PRECONDITION_FAILED', 'OPERATIONS_VERSION_CONFLICT', 'OPERATIONS_EXPIRED'].includes(error.message)) record.staleVerification = true;
              else if (error instanceof Error && ['OPERATIONS_NOT_FOUND', 'OPERATIONS_FORBIDDEN'].includes(error.message)) throw absentObservation();
              else throw error;
            }
          }
        }
        items.push(record);
      }
      return { items, nextBefore: rows.length > limit ? items.at(-1)!.version : null };
    });
  }
}
