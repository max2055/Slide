import { randomUUID } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ActorContext } from '../auth/actor-context.js';
import type { ResourceRef } from '../resources/types.js';
import { dbConnection } from '../db-connection.js';
import { PersistentOperationService } from '../operations/operation-service.js';
import { evidenceService, type EvidenceService } from './evidence-service.js';
import { authorizeEvidence, EvidenceStore, validateEvidenceQuery } from './evidence-store.js';
import { auditLogManager } from '../audit/audit-log.js';
import { dimensionsKey, evaluateInvariants } from './invariant-engine.js';
import { evaluateExpectation } from './expectation-engine.js';
import { EvidenceResourceSchema, validateEvidenceItem } from './evidence-contract.js';
import { parseRecoveryPolicy, RecoveryPolicyUpdateSchema, recoveryPolicyKey, validateRecoveryBinding, type RecoveryPolicy } from '../operations/recovery-policy.js';
import { verifyRecoveryWindow } from '../operations/operation-verifier.js';

const rule = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), metricId: Type.String({ minLength: 1, maxLength: 128 }), min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()), dimensions: Type.Optional(Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), Type.String({ maxLength: 256 }), { maxProperties: 16, additionalProperties: false })) }, { additionalProperties: false });
const rulesSchema = Type.Object({ schemaVersion: Type.Literal(1), version: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), rules: Type.Array(rule, { maxItems: 100 }) }, { additionalProperties: false });
const updateSchema = Type.Object({ expectedVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }), rules: Type.Array(rule, { maxItems: 100 }) }, { additionalProperties: false });
const decisionInput = Type.Object({ statement: Type.String({ minLength: 1, maxLength: 2000 }), status: Type.Union([Type.Literal('inference'), Type.Literal('hypothesis')]), evidenceRefs: Type.Array(Type.String({ pattern: '^[a-f0-9]{64}$' }), { minItems: 1, maxItems: 100, uniqueItems: true }), from: Type.String({ maxLength: 64 }), to: Type.String({ maxLength: 64 }) }, { additionalProperties: false });
const decisionSchema = Type.Composite([decisionInput, Type.Object({ id: Type.String({ pattern: '^[a-f0-9-]{36}$' }), schemaVersion: Type.Literal(1), resource: EvidenceResourceSchema, createdAt: Type.String({ maxLength: 64 }) })], { additionalProperties: false });
export type EvidenceDecision = Static<typeof decisionSchema>;
export type InvariantConfiguration = Static<typeof rulesSchema>;
interface Executor { execute(sql: string, values?: any[]): Promise<any>; }
interface OperationReader { getForActor(id: string, actorId: number): Promise<{ id: string; actorId: number; resource: { type: string; id: string }; state: string; commandType?: string; finishedAt?: Date } | null>; recoveryBindingForActor?(id: string, actorId: number): Promise<unknown>; }
function configKey(ref: ResourceRef): string { return `evidence_invariants:${ref.type}:${ref.id}`; }
function parseRules(raw: unknown): InvariantConfiguration {
  let value: unknown;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('RULES_INVALID'); }
  if (!Value.Check(rulesSchema, value)) throw new Error('RULES_INVALID');
  evaluateInvariants([], value.rules);
  if (new Set(value.rules.map(rule => rule.id)).size !== value.rules.length) throw new Error('RULES_INVALID');
  return value;
}
export class EvidenceEvaluationService {
  constructor(private readonly pool: () => Executor | null = () => dbConnection.getPool(), private readonly evidence: Pick<EvidenceService, 'getBundle' | 'getItem'> = evidenceService, private readonly operations: OperationReader = new PersistentOperationService(() => dbConnection.getPool() as any), private readonly clock: () => Date = () => new Date(), private readonly historyStore: Pick<EvidenceStore, 'history' | 'recoveryWindow'> = new EvidenceStore(pool)) {}
  private executor(): Executor { const pool = this.pool(); if (!pool) throw new Error('EVIDENCE_STORAGE_UNAVAILABLE'); return pool; }
  async rules(actor: ActorContext, ref: ResourceRef): Promise<InvariantConfiguration> {
    authorizeEvidence(actor, ref);
    const [rows] = await this.executor().execute('SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1', [configKey(ref)]);
    return rows[0] ? parseRules(rows[0].config_value) : { schemaVersion: 1, version: 0, rules: [] };
  }
  async updateRules(actor: ActorContext, ref: ResourceRef, input: unknown): Promise<InvariantConfiguration> {
    authorizeEvidence(actor, ref);
    if (!actor.permissions.some(value => value === '*' || value === 'admin:*')) throw new Error('RULES_FORBIDDEN');
    if (!Value.Check(updateSchema, input)) throw new Error('RULES_INVALID');
    const next = parseRules({ schemaVersion: 1, version: input.expectedVersion + 1, rules: input.rules });
    const executor = this.executor();
    const [rows] = await executor.execute('SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1', [configKey(ref)]);
    const current = rows[0] ? parseRules(rows[0].config_value) : { version: 0 };
    if (current.version !== input.expectedVersion) throw new Error('RULES_VERSION_CONFLICT');
    if (!rows[0]) {
      try { await executor.execute("INSERT INTO system_config (config_key, config_value, value_type) VALUES (?, ?, 'json')", [configKey(ref), JSON.stringify(next)]); }
      catch (error) { if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new Error('RULES_VERSION_CONFLICT'); throw error; }
    } else {
      const raw = typeof rows[0].config_value === 'string' ? rows[0].config_value : JSON.stringify(rows[0].config_value);
      const [result] = await executor.execute('UPDATE system_config SET config_value = ? WHERE config_key = ? AND BINARY config_value = BINARY ?', [JSON.stringify(next), configKey(ref), raw]);
      if (result.affectedRows !== 1) throw new Error('RULES_VERSION_CONFLICT');
    }
    await auditLogManager.logConfigChange({ userId: String(actor.userId), username: actor.username, configKey: configKey(ref), oldValue: current, newValue: next });
    return next;
  }
  async evaluate(actor: ActorContext, ref: ResourceRef) {
    authorizeEvidence(actor, ref);
    const config = await this.rules(actor, ref);
    const bundle = await this.evidence.getBundle(actor, ref);
    const now = this.clock();
    const facts = bundle.facts;
    const latest = new Map<string, typeof facts[number]>();
    for (const item of facts) {
      const key = `${item.payload.metricId}:${item.source}:${dimensionsKey(item.dimensions)}`;
      if (!latest.has(key) || latest.get(key)!.observedAt < item.observedAt) latest.set(key, item);
    }
    const gaps = new Set([...bundle.gaps, ...(!config.rules.length ? ['INVARIANTS_NOT_CONFIGURED'] : []), ...(bundle.truncated ? ['EVIDENCE_TRUNCATED'] : [])]);
    if (latest.size > 32) gaps.add('EXPECTATION_IDENTITIES_TRUNCATED');
    const expectations: ReturnType<typeof evaluateExpectation>[] = [];
    const refs = new Set(facts.map(item => item.id));
    for (const current of [...latest.values()].slice(0, 32)) {
      const history = await this.historyStore.history(actor, ref, current, now);
      if (history.truncated) gaps.add('EXPECTATION_HISTORY_TRUNCATED');
      const result = evaluateExpectation(current, history.items, now.getTime());
      expectations.push(result);
      result.evidenceRefs.forEach(id => refs.add(id));
    }
    return { schemaVersion: 1, resource: ref, generatedAt: now.toISOString(), rulesVersion: config.version,
      invariants: evaluateInvariants(facts, config.rules, now.getTime()), expectations,
      evidenceRefs: [...refs], gaps: [...gaps] };
  }
  async recordDecision(actor: ActorContext, ref: ResourceRef, input: unknown): Promise<EvidenceDecision> {
    authorizeEvidence(actor, ref);
    if (!Value.Check(decisionInput, input)) throw new Error('DECISION_INVALID');
    validateEvidenceQuery({ from: input.from, to: input.to, limit: 100 });
    const from = new Date(input.from).toISOString(), to = new Date(input.to).toISOString();
    for (const id of input.evidenceRefs) {
      const item = await this.evidence.getItem(actor, ref, id);
      if (!validateEvidenceItem(item) || item.subject.resource.type !== ref.type || item.subject.resource.id !== ref.id || item.observedAt < from || item.observedAt > to) throw new Error('DECISION_EVIDENCE_INVALID');
    }
    const decision: EvidenceDecision = { ...input, from, to, id: randomUUID(), schemaVersion: 1, resource: ref, createdAt: this.clock().toISOString() };
    await this.executor().execute('INSERT INTO agent_evidence_decisions (id, owner_user_id, resource_type, resource_id, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [decision.id, actor.userId, ref.type, ref.id, JSON.stringify(decision), new Date(decision.createdAt)]);
    return decision;
  }
  async decision(actor: ActorContext, ref: ResourceRef, id: string): Promise<EvidenceDecision | null> {
    authorizeEvidence(actor, ref);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('DECISION_INVALID');
    const [rows] = await this.executor().execute('SELECT record_json FROM agent_evidence_decisions WHERE owner_user_id = ? AND resource_type = ? AND resource_id = ? AND id = ? LIMIT 1', [actor.userId, ref.type, ref.id, id]);
    if (!rows[0]) return null;
    const result = await this.readDecision(actor, ref, rows[0].record_json);
    if (result.id !== id) throw new Error('DECISION_INVALID');
    return result;
  }
  private async readDecision(actor: ActorContext, ref: ResourceRef, raw: unknown): Promise<EvidenceDecision> {
    let result: unknown;
    try { result = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('DECISION_INVALID'); }
    if (!Value.Check(decisionSchema, result) || result.resource.type !== ref.type || result.resource.id !== ref.id) throw new Error('DECISION_INVALID');
    validateEvidenceQuery({ from: result.from, to: result.to, limit: 100 });
    for (const id of result.evidenceRefs) {
      const item = await this.evidence.getItem(actor, ref, id);
      if (!validateEvidenceItem(item) || item.id !== id || item.subject.resource.type !== ref.type || item.subject.resource.id !== ref.id || Date.parse(item.observedAt) < Date.parse(result.from) || Date.parse(item.observedAt) > Date.parse(result.to)) throw new Error('DECISION_EVIDENCE_INVALID');
    }
    return result;
  }
  async decisions(actor: ActorContext, ref: ResourceRef, limit = 20) {
    authorizeEvidence(actor, ref);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('DECISION_INVALID');
    const [rows] = await this.executor().execute(`SELECT record_json FROM agent_evidence_decisions WHERE owner_user_id = ? AND resource_type = ? AND resource_id = ? ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`, [actor.userId, ref.type, ref.id]);
    const items: EvidenceDecision[] = []; const gaps = new Set<string>();
    for (const row of rows.slice(0, limit)) {
      try { items.push(await this.readDecision(actor, ref, row.record_json)); }
      catch (error) {
        if (error instanceof Error && ['DECISION_INVALID', 'DECISION_EVIDENCE_INVALID', 'EVIDENCE_QUERY_INVALID'].includes(error.message)) gaps.add('DECISION_EVIDENCE_UNAVAILABLE');
        else throw error;
      }
    }
    return { schemaVersion: 1, resource: ref, items, truncated: rows.length > limit, gaps: [...gaps] };
  }
  async recovery(actor: ActorContext, ref: ResourceRef, operationId: string) {
    authorizeEvidence(actor, ref);
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(operationId)) throw new Error('OPERATION_INVALID');
    const operation = await this.operations.getForActor(operationId, actor.userId);
    if (!operation || operation.actorId !== actor.userId || operation.resource.type !== ref.type || String(operation.resource.id) !== String(ref.id)) throw new Error('OPERATION_NOT_FOUND');
    const base = { schemaVersion: 1, resource: ref, operationId, operationState: operation.state, status: 'unknown' as const, reason: 'RECOVERY_PLAN_NOT_BOUND', evidenceRefs: [] as string[], verifiedBy: 'operation-metadata-v1' };
    const binding = await this.operations.recoveryBindingForActor?.(operationId, actor.userId);
    if (!validateRecoveryBinding(binding) || binding.actorId !== actor.userId || binding.resource.type !== ref.type || binding.resource.id !== ref.id || binding.commandType !== operation.commandType) return base;
    const finished = operation.finishedAt;
    if (!(finished instanceof Date) || !Number.isFinite(finished.getTime()) || !['succeeded', 'failed', 'unknown'].includes(operation.state)) return { ...base, reason: 'RECOVERY_OPERATION_INCOMPLETE', policyVersion: binding.policyVersion };
    const plan = { ...binding, startedAt: finished.toISOString() };
    const now = this.clock();
    if (finished > now) return { ...base, reason: 'RECOVERY_OPERATION_INCOMPLETE', policyVersion: binding.policyVersion };
    await this.evidence.getBundle(actor, ref);
    const history = await this.historyStore.recoveryWindow(actor, ref, plan);
    if (history.truncated) return { ...base, reason: 'RECOVERY_EVIDENCE_TRUNCATED', policyVersion: binding.policyVersion };
    return { ...base, ...verifyRecoveryWindow(plan, history.items, now.getTime()), policyVersion: binding.policyVersion, source: binding.source, metricId: binding.metricId };
  }
  async recoveryPolicy(actor: ActorContext, ref: ResourceRef): Promise<RecoveryPolicy> {
    authorizeEvidence(actor, ref);
    const [rows] = await this.executor().execute('SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1', [recoveryPolicyKey(ref)]);
    return rows[0] ? parseRecoveryPolicy(rows[0].config_value) : { schemaVersion: 1, version: 0, enabled: false, commandTypes: [], metricId: '', source: '', windowSeconds: 60, maxSampleGapSeconds: 30 };
  }
  async updateRecoveryPolicy(actor: ActorContext, ref: ResourceRef, input: unknown): Promise<RecoveryPolicy> {
    authorizeEvidence(actor, ref);
    if (!actor.permissions.some(value => value === '*' || value === 'admin:*')) throw new Error('RECOVERY_POLICY_FORBIDDEN');
    if (!Value.Check(RecoveryPolicyUpdateSchema, input)) throw new Error('RECOVERY_POLICY_INVALID');
    const { expectedVersion, ...fields } = input;
    const next = parseRecoveryPolicy({ ...fields, schemaVersion: 1, version: expectedVersion + 1 });
    const executor = this.executor(); const key = recoveryPolicyKey(ref);
    const [rows] = await executor.execute('SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1', [key]);
    const current = rows[0] ? parseRecoveryPolicy(rows[0].config_value) : { version: 0 };
    if (current.version !== expectedVersion) throw new Error('RECOVERY_POLICY_VERSION_CONFLICT');
    if (!rows[0]) {
      try { await executor.execute("INSERT INTO system_config (config_key, config_value, value_type) VALUES (?, ?, 'json')", [key, JSON.stringify(next)]); }
      catch (error) { if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new Error('RECOVERY_POLICY_VERSION_CONFLICT'); throw error; }
    } else {
      const raw = typeof rows[0].config_value === 'string' ? rows[0].config_value : JSON.stringify(rows[0].config_value);
      const [result] = await executor.execute('UPDATE system_config SET config_value = ? WHERE config_key = ? AND BINARY config_value = BINARY ?', [JSON.stringify(next), key, raw]);
      if (result.affectedRows !== 1) throw new Error('RECOVERY_POLICY_VERSION_CONFLICT');
    }
    await auditLogManager.logConfigChange({ userId: String(actor.userId), username: actor.username, configKey: key, oldValue: current, newValue: next });
    return next;
  }
}
export const evidenceEvaluationService = new EvidenceEvaluationService();
