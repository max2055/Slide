import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import { Value } from '@sinclair/typebox/value';
import { evidenceHash, redactEvidence } from '../analysis/analysis-evidence.js';
import { InvestigationResultSchema, validateInvestigationResult, readInvestigationResult, type InvestigationResult } from './contracts.js';
import { InvestigationStoreError, type AdmissionInvestigation } from './store.js';
import { InvestigationObservationDatabase, appendObservation, observationRows, decode,
  invalidObservation, absentObservation, type ResultBinding } from './observation-db.js';

export function resultEvidenceIds(result: InvestigationResult): string[] {
  return [...new Set([...result.facts.flatMap(f => f.evidenceIds),
    ...result.claims.flatMap(c => [...c.supportingEvidenceIds, ...c.contradictingEvidenceIds]),
    ...result.hypotheses.flatMap(h => [...h.supportingEvidenceIds, ...h.contradictingEvidenceIds]),
    ...(result.rootCauseVerification.status === 'unverified' ? [] : result.rootCauseVerification.evidenceIds),
    ...(result.recoveryVerification?.evidenceIds ?? [])])].sort();
}
export function validateMachineResult(value: unknown, bindings: ReadonlySet<string>) {
  const result = validateInvestigationResult(value, bindings);
  if (!result.ok) return result;
  if (['human_confirmed', 'experimentally_verified'].includes(result.value.rootCauseVerification.status)
    || result.value.recoveryVerification || result.value.problemStatus === 'resolved') return { ok: false as const, error: 'INVESTIGATION_INPUT_INVALID' };
  return result;
}
export function resultView(value: unknown, bindings: ReadonlySet<string>, legacyMarkdown = '') {
  const view = readInvestigationResult(value, legacyMarkdown, bindings);
  if (view.kind === 'v2') return { kind: 'v2' as const, readOnly: true, summary: view.value.summary,
    rootCauseVerification: view.value.rootCauseVerification, value: view.value };
  if (view.kind === 'v1') return { kind: 'v1' as const, readOnly: true, summary: view.value.conclusions.join('\n'),
    rootCauseVerification: { status: 'unverified' as const }, value: view.value };
  return { kind: 'legacy' as const, readOnly: true, summary: view.displayMarkdown, rootCauseVerification: { status: 'unverified' as const }, value: null };
}
export interface VersionedInvestigationResult extends ResultBinding {
  id: string; version: number; result: InvestigationResult;
}

export class InvestigationResultStore extends InvestigationObservationDatabase {
  async put(caller: ActorContext, binding: ResultBinding, key: string, expectedVersion: number, value: unknown): Promise<VersionedInvestigationResult> {
    binding = { ...binding }; value = structuredClone(value);
    if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > 255 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw invalidObservation();
    return this.transaction(caller, binding.investigationId, async (c, investigation, actor) => {
      const access = await this.assertBinding(c, actor, investigation, binding);
      const subject = access.snapshot.context?.subject;
      const candidate = value as InvestigationResult;
      if (!subject || evidenceHash(candidate?.subject) !== evidenceHash(subject) || candidate?.provenance?.runtimeRunId !== binding.runId) throw invalidObservation();
      return this.putOnConnection(c, actor, investigation, binding, key, expectedVersion, value);
    });
  }
  async putOnConnection(c: PoolConnection, actor: ActorContext, investigation: Readonly<AdmissionInvestigation>,
    binding: ResultBinding, key: string, expectedVersion: number, value: unknown): Promise<VersionedInvestigationResult> {
    // Shape first, then bind every reference to its exact original execution.
    if (!Value.Check(InvestigationResultSchema, value)) throw invalidObservation();
    const shape = validateMachineResult(value, new Set(resultEvidenceIds(value)));
    if (!shape.ok) throw invalidObservation();
    const refs = resultEvidenceIds(shape.value);
    const bound = await this.authorizedBindings(c, actor, investigation, binding, refs, true);
    const validated = validateMachineResult(value, bound);
    if (!validated.ok) throw invalidObservation();
    const result = redactEvidence(validated.value) as InvestigationResult;
    const payloadHash = evidenceHash({ binding, expectedVersion, result });
    const [existing] = await observationRows(c, 'SELECT * FROM investigation_results WHERE investigation_id = ? AND source_key = ? FOR UPDATE', [investigation.id, Buffer.from(key)]);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new InvestigationStoreError('IDEMPOTENCY_PAYLOAD_MISMATCH');
      return this.view(existing);
    }
    const [latest] = await observationRows(c, 'SELECT COALESCE(MAX(version), 0) AS version FROM investigation_results WHERE investigation_id = ?', [investigation.id]);
    if (Number(latest.version) !== expectedVersion || !Number.isSafeInteger(expectedVersion + 1)) throw new InvestigationStoreError('VERSION_CONFLICT');
    const id = randomUUID(), version = expectedVersion + 1;
    await c.execute(`INSERT INTO investigation_results
      (id, investigation_id, request_id, run_id, version, source_key, payload_hash, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, investigation.id, binding.requestId, binding.runId, version, Buffer.from(key), payloadHash, JSON.stringify(result)]);
    await appendObservation(c, investigation.id, `result:${id}`, { type: 'result.persisted', requestId: binding.requestId,
      runId: binding.runId, occurredAt: result.createdAt, payload: { resultId: id, resultVersion: version, schemaVersion: 2 } });
    return { ...binding, id, version, result };
  }
  private view(row: any): VersionedInvestigationResult {
    return { id: row.id, investigationId: row.investigation_id, requestId: row.request_id, runId: row.run_id,
      version: Number(row.version), result: decode(row.result_json) };
  }
  async authorizedBindings(c: PoolConnection, actor: ActorContext, investigation: Readonly<AdmissionInvestigation>,
    binding: ResultBinding, refs: readonly string[], requireAvailable = false): Promise<Set<string>> {
    const bound = new Set<string>();
    for (const ref of refs) {
      const [row] = await observationRows(c, 'SELECT * FROM investigation_evidence WHERE id = ? AND investigation_id = ? AND request_id = ? AND run_id = ? FOR SHARE',
        [ref, investigation.id, binding.requestId, binding.runId]);
      if (!row) throw absentObservation();
      await this.authorization.authorize(c as never, actor, investigation, 'content', decode(row.metadata_json).resources);
      if (requireAvailable && (row.expired_at || new Date(row.expires_at).getTime() <= Date.now())) throw new InvestigationStoreError('EVIDENCE_EXPIRED');
      bound.add(ref);
    }
    return bound;
  }
  async list(caller: ActorContext, id: string, before?: number, limit = 20): Promise<{ items: VersionedInvestigationResult[]; nextBefore: number | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw invalidObservation();
    return this.transaction(caller, id, async (c, investigation, actor) => {
      const rows = await observationRows(c, `SELECT * FROM investigation_results WHERE investigation_id = ? ${before === undefined ? '' : 'AND version < ?'} ORDER BY version DESC LIMIT ?`, [id, ...(before === undefined ? [] : [before]), limit + 1]);
      const items = [];
      for (const row of rows.slice(0, limit)) {
        const view = this.view(row);
        // Expired references remain historical tombstones, never new proof.
        await this.authorizedBindings(c, actor, investigation, view, resultEvidenceIds(view.result));
        items.push(view);
      }
      return { items, nextBefore: rows.length > limit ? items.at(-1)!.version : null };
    });
  }
}
