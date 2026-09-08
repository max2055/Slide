import { randomUUID } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ActorContext } from '../auth/actor-context.js';
import type { ResourceRef } from '../resources/types.js';
import { dbConnection } from '../db-connection.js';
import { PersistentOperationService } from '../operations/operation-service.js';
import { evidenceService, type EvidenceService } from './evidence-service.js';
import { authorizeEvidence, validateEvidenceQuery } from './evidence-store.js';
import { dimensionsKey, evaluateInvariants } from './invariant-engine.js';
import { evaluateExpectation } from './expectation-engine.js';
import { EvidenceResourceSchema, validateEvidenceItem } from './evidence-contract.js';

const rule = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), metricId: Type.String({ minLength: 1, maxLength: 128 }), min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()), dimensions: Type.Optional(Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), Type.String({ maxLength: 256 }), { maxProperties: 16, additionalProperties: false })) }, { additionalProperties: false });
const rulesSchema = Type.Object({ schemaVersion: Type.Literal(1), version: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), rules: Type.Array(rule, { maxItems: 100 }) }, { additionalProperties: false });
const updateSchema = Type.Object({ expectedVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }), rules: Type.Array(rule, { maxItems: 100 }) }, { additionalProperties: false });
const decisionInput = Type.Object({ statement: Type.String({ minLength: 1, maxLength: 2000 }), status: Type.Union([Type.Literal('inference'), Type.Literal('hypothesis')]), evidenceRefs: Type.Array(Type.String({ pattern: '^[a-f0-9]{64}$' }), { minItems: 1, maxItems: 100, uniqueItems: true }), from: Type.String({ maxLength: 64 }), to: Type.String({ maxLength: 64 }) }, { additionalProperties: false });
const decisionSchema = Type.Composite([decisionInput, Type.Object({ id: Type.String({ pattern: '^[a-f0-9-]{36}$' }), schemaVersion: Type.Literal(1), resource: EvidenceResourceSchema, createdAt: Type.String({ maxLength: 64 }) })], { additionalProperties: false });
export type EvidenceDecision = Static<typeof decisionSchema>;
export type InvariantConfiguration = Static<typeof rulesSchema>;
interface Executor { execute(sql: string, values?: any[]): Promise<any>; }
interface OperationReader { getForActor(id: string, actorId: number): Promise<{ id: string; actorId: number; resource: { type: string; id: string }; state: string } | null>; }
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
  constructor(private readonly pool: () => Executor | null = () => dbConnection.getPool(), private readonly evidence: Pick<EvidenceService, 'getBundle' | 'getItem'> = evidenceService, private readonly operations: OperationReader = new PersistentOperationService(() => dbConnection.getPool() as any), private readonly clock: () => Date = () => new Date()) {}
  private executor(): Executor { const pool = this.pool(); if (!pool) throw new Error('EVIDENCE_STORAGE_UNAVAILABLE'); return pool; }
  async rules(actor: ActorContext, ref: ResourceRef): Promise<InvariantConfiguration> {
    authorizeEvidence(actor, ref);
    const [rows] = await this.executor().execute('SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1', [configKey(ref)]);
    return rows[0] ? parseRules(rows[0].config_value) : { schemaVersion: 1, version: 0, rules: [] };
  }
  async updateRules(actor: ActorContext, ref: ResourceRef, input: unknown): Promise<InvariantConfiguration> {
    authorizeEvidence(actor, ref);
    if (!actor.permissions.includes('*') && !actor.roles.includes('admin')) throw new Error('RULES_FORBIDDEN');
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
    return { schemaVersion: 1, resource: ref, generatedAt: now.toISOString(), rulesVersion: config.version,
      invariants: evaluateInvariants(facts, config.rules, now.getTime()), expectations: [...latest.values()].map(current => evaluateExpectation(current, facts, now.getTime())),
      evidenceRefs: facts.map(item => item.id), gaps: [...bundle.gaps, ...(!config.rules.length ? ['INVARIANTS_NOT_CONFIGURED'] : []), ...(bundle.truncated ? ['EVIDENCE_TRUNCATED'] : [])] };
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
    let result: unknown;
    try { result = typeof rows[0].record_json === 'string' ? JSON.parse(rows[0].record_json) : rows[0].record_json; } catch { throw new Error('DECISION_INVALID'); }
    if (!Value.Check(decisionSchema, result) || result.id !== id || result.resource.type !== ref.type || result.resource.id !== ref.id) throw new Error('DECISION_INVALID');
    return result;
  }
  async recovery(actor: ActorContext, ref: ResourceRef, operationId: string) {
    authorizeEvidence(actor, ref);
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(operationId)) throw new Error('OPERATION_INVALID');
    const operation = await this.operations.getForActor(operationId, actor.userId);
    if (!operation || operation.actorId !== actor.userId || operation.resource.type !== ref.type || String(operation.resource.id) !== String(ref.id)) throw new Error('OPERATION_NOT_FOUND');
    return { schemaVersion: 1, resource: ref, operationId, operationState: operation.state, status: 'unknown' as const, reason: 'RECOVERY_PLAN_NOT_BOUND', evidenceRefs: [], verifiedBy: 'operation-metadata-v1' };
  }
}
export const evidenceEvaluationService = new EvidenceEvaluationService();
