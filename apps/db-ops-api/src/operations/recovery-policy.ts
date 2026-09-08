import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { evidenceId, EvidenceResourceSchema } from '../evidence/evidence-contract.js';
import type { ResourceRef } from '../resources/types.js';
const fields = { metricId: Type.String({ maxLength: 128 }), source: Type.String({ maxLength: 256 }), dimensions: Type.Optional(Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), Type.String({ maxLength: 256 }), { maxProperties: 16, additionalProperties: false })), min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()), windowSeconds: Type.Integer({ minimum: 30, maximum: 3600 }), maxSampleGapSeconds: Type.Integer({ minimum: 1, maximum: 3600 }) };
const policyFields = { enabled: Type.Boolean(), commandTypes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 16, uniqueItems: true }), ...fields };
export const RecoveryPolicySchema = Type.Object({ schemaVersion: Type.Literal(1), version: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), ...policyFields }, { additionalProperties: false });
export const RecoveryPolicyUpdateSchema = Type.Object({ expectedVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }), ...policyFields }, { additionalProperties: false });
const bindingSchema = Type.Object({ schemaVersion: Type.Literal(1), policyVersion: Type.Integer({ minimum: 1 }), actorId: Type.Integer({ minimum: 1 }), resource: EvidenceResourceSchema, commandType: Type.String({ minLength: 1, maxLength: 128 }), ...fields, digest: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false });
export type RecoveryPolicy = Static<typeof RecoveryPolicySchema>;
export type RecoveryBinding = Static<typeof bindingSchema>;
export const recoveryPolicyKey = (ref: ResourceRef) => `evidence_recovery:${ref.type}:${ref.id}`;
export function parseRecoveryPolicy(raw: unknown): RecoveryPolicy {
  let value: unknown;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('RECOVERY_POLICY_INVALID'); }
  if (!Value.Check(RecoveryPolicySchema, value) || value.maxSampleGapSeconds > value.windowSeconds
    || (value.min !== undefined && value.max !== undefined && value.min > value.max)
    || (value.enabled && (!value.version || !value.metricId || !value.source || !value.commandTypes.length || (value.min === undefined && value.max === undefined)))) throw new Error('RECOVERY_POLICY_INVALID');
  return value;
}
export function createRecoveryBinding(raw: unknown, actorId: number, resource: ResourceRef, commandType: string): RecoveryBinding | null {
  const policy = parseRecoveryPolicy(raw);
  if (!policy.enabled || !policy.commandTypes.includes(commandType)) return null;
  const { enabled, commandTypes, version, ...plan } = policy;
  const content = { ...plan, policyVersion: version, actorId, resource, commandType };
  const binding = { ...content, digest: evidenceId(content) };
  if (!validateRecoveryBinding(binding)) throw new Error('RECOVERY_POLICY_INVALID');
  return binding;
}
export function validateRecoveryBinding(value: unknown): value is RecoveryBinding {
  if (!Value.Check(bindingSchema, value)) return false;
  const { digest, ...content } = value;
  try { parseRecoveryPolicy({ schemaVersion: 1, version: value.policyVersion, enabled: true, commandTypes: [value.commandType], metricId: value.metricId, source: value.source, windowSeconds: value.windowSeconds, maxSampleGapSeconds: value.maxSampleGapSeconds, ...(value.dimensions ? { dimensions: value.dimensions } : {}), ...(value.min !== undefined ? { min: value.min } : {}), ...(value.max !== undefined ? { max: value.max } : {}) }); }
  catch { return false; }
  return digest === evidenceId(content);
}
