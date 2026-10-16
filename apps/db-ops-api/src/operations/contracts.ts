/** Internal V23 contracts. Public HTTP/generated types are assembled by P10.
 * These facts do not grant execution authority and do not alter V1 Operation. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResourceRef } from '../resources/types.js';

export const OPERATIONS_SCHEMA_VERSION = 1 as const;
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const key = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const utc = z.iso.datetime({ precision: 3 });
export const resourceRefSchema = z.strictObject({ type: z.enum(['instance', 'server', 'network_device']), id: positive });
export const principalSchema = z.strictObject({ kind: z.enum(['user', 'service']), id: positive });
export type OperationsPrincipal = z.infer<typeof principalSchema>;
export const versionReferenceSchema = z.strictObject({ id: key, version: positive, hash,
  validUntil: utc });
export type VersionReference = z.infer<typeof versionReferenceSchema>;
export const caseStateSchema = z.enum(['draft', 'pending_review', 'published', 'expired', 'withdrawn']);
export const relationStateSchema = z.enum(['suggested', 'confirmed', 'expired', 'withdrawn', 'conflicted']);
export const baselineStateSchema = z.enum(['not_qualified', 'qualified', 'invalidated']);
export const planStateSchema = z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'expired', 'superseded']);
export const executionStateSchema = z.enum(['queued', 'prechecking', 'dispatching', 'succeeded', 'failed', 'outcome_unknown', 'cancelled']);
export const verificationStateSchema = z.enum(['pending', 'observing', 'passed', 'failed', 'inconclusive']);

export interface VersionedRecord { id: string; version: number; schemaVersion: 1; contentHash: string }
export interface TrustedCaseVersion extends VersionedRecord {
  source: { investigationId: string; resultVersion: number; evidence: readonly VersionReference[] };
  resources: readonly ResourceRef[];
  state: z.infer<typeof caseStateSchema>;
  author: OperationsPrincipal;
  redactionPolicyVersion: string;
  applicability: Readonly<Record<string, string>>;
  validUntil: string;
}
export interface RelationRevision extends VersionedRecord {
  relationId: string; source: ResourceRef; target: ResourceRef;
  relationType: 'runs_on' | 'replicates_to' | 'depends_on' | 'connected_to' | 'serves';
  state: z.infer<typeof relationStateSchema>;
  evidence: readonly VersionReference[]; observedAt: string; validFrom: string; validUntil: string | null;
  /** Old provenance is retained as unverified; hosts remains a reverse view. */
  legacyProvenance: string | null;
}
export interface BaselineSeriesIdentity {
  resource: ResourceRef; metric: string; unit: string; dimensions: Readonly<Record<string, string>>;
  source: { id: string; bindingId: string; version: string }; configurationVersion: string;
  transformVersion: string; counterEpoch: string | null;
}
export interface BaselineVersion extends VersionedRecord {
  series: BaselineSeriesIdentity; seriesHash: string; methodVersion: string;
  state: z.infer<typeof baselineStateSchema>; reason: string | null;
  training: { from: string; until: string }; validation: { from: string; until: string };
  quality: { validDays: number; coverage: number; samples: number; missing: number };
}
export interface CorrelationSnapshot extends VersionedRecord {
  eventIds: readonly string[]; investigationIds: readonly string[]; ruleVersion: string;
  relations: readonly VersionReference[]; baselines: readonly VersionReference[];
  partial: boolean; severity: string;
  score: { lower: number; upper: number; coverage: number; components: Readonly<Record<string, number | null>> };
  overrideOf: VersionReference | null;
}

/** First pilot only. No arbitrary tool, shell, target URL, unit or verifier code.
 * Target eligibility, tool/config hashes and freshness are checked live by P06/07. */
export const actionPlanContentSchema = z.strictObject({
  schemaVersion: z.literal(1), investigationId: key, resultVersion: positive,
  target: z.strictObject({ type: z.literal('server'), id: positive }),
  tool: z.strictObject({ name: z.literal('restart_demo_service'), version: key, hash }),
  parameters: z.strictObject({ unit: z.literal('slide-action-demo.service') }),
  evidence: z.array(versionReferenceSchema).min(1).max(100),
  relations: z.array(versionReferenceSchema).max(100), baselines: z.array(versionReferenceSchema).max(100),
  preconditions: z.array(z.strictObject({ kind: key, expected: z.string().min(1).max(1000) })).max(100),
  risk: z.enum(['low', 'medium', 'high', 'critical']), impact: z.string().min(1).max(2000),
  policyVersion: key, validFrom: utc, validUntil: utc,
  verifier: z.strictObject({ id: key, version: key, definitionHash: hash,
    beforeSeconds: z.literal(120), readinessSeconds: z.literal(60), observationSeconds: z.literal(300),
    intervalSeconds: z.literal(10), maxExtraRestarts: z.literal(0), requireAllHealthy: z.literal(true) }),
  rollback: z.strictObject({ capability: z.literal('none'), description: z.string().min(1).max(2000) }),
  author: principalSchema, requester: principalSchema,
}).refine(value => {
  const lifetime = Date.parse(value.validUntil) - Date.parse(value.validFrom);
  return lifetime > 0 && lifetime <= 30 * 60_000;
}, { message: 'Plan validity must be positive and at most 30 minutes' });
export type ActionPlanContent = z.infer<typeof actionPlanContentSchema>;
export interface ActionPlanVersion extends VersionedRecord {
  state: z.infer<typeof planStateSchema>; content: Readonly<ActionPlanContent>;
}
export interface ActionExecution extends VersionedRecord {
  planId: string; planVersion: number; approvalId: string; operationId: string;
  state: z.infer<typeof executionStateSchema>; requestKey: string; payloadHash: string;
  leaseOwner: string | null; fence: number; sentAt: string | null; receiptHash: string | null;
  cancelRequestedAt: string | null;
}
export interface ActionVerificationReport extends VersionedRecord {
  executionId: string; planId: string; planVersion: number; investigationId: string; resultVersion: number;
  state: z.infer<typeof verificationStateSchema>; verifierHash: string;
  evidence: readonly VersionReference[]; missingSamples: number; reason: string | null;
}
export interface OperationsEvent {
  schemaVersion: 1; eventId: string; objectType: 'case' | 'relation' | 'baseline' | 'attention' | 'plan' | 'execution' | 'verification';
  objectId: string; version: number; occurredAt: string;
}
const statusCodes = {
  OPERATIONS_INPUT_INVALID: 422, OPERATIONS_FORBIDDEN: 403, OPERATIONS_NOT_FOUND: 404,
  OPERATIONS_VERSION_CONFLICT: 409, OPERATIONS_IDEMPOTENCY_CONFLICT: 409, OPERATIONS_EXPIRED: 410,
  OPERATIONS_PRECONDITION_FAILED: 422, OPERATIONS_FEATURE_DISABLED: 422, OPERATIONS_DEPENDENCY_UNAVAILABLE: 503,
} as const;
export class OperationsError extends Error {
  readonly statusCode: number;
  constructor(readonly code: keyof typeof statusCodes) { super(code); this.name = 'OperationsError'; this.statusCode = statusCodes[code]; }
}
export function assertExpectedVersion(expected: number, actual: number): void {
  if (!positive.safeParse(expected).success || !positive.safeParse(actual).success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  if (expected !== actual) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
}
/** Exact JSON only; never silently drop undefined/nonfinite values from a binding.
 * Services hash the server-validated content, not client-provided hashes. */
export function operationsContentHash(value: unknown): string {
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${Array.from(item, encode).join(',')}]`;
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
    }
    throw new OperationsError('OPERATIONS_INPUT_INVALID');
  };
  return createHash('sha256').update(encode(value)).digest('hex');
}
