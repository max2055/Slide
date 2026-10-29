/**
 * MAX-238 / B2E — unmounted MySQL host for the accepted atomic binding adapter.
 *
 * The host owns exactly one narrow lease per application: `beginTransaction` →
 * `metric_policy_lock id=1 FOR UPDATE` → every read on that same connection →
 * the accepted B2D adapter (B1 → B2A → B2C → receipt → final capability time) →
 * one `stageApplication` (operation/receipt uniqueness, binding CAS, audit) →
 * one `settleApplication` → release, or destroy the connection when any part of
 * that lifecycle is unconfirmed. It never opens a default connection, reads env,
 * registers a service, issues a receipt or performs collection I/O.
 *
 * Trusted authorization, the B2C context, the mandatory list and the template
 * reader come from an injected factory that receives **the current connection**;
 * they are only called inside the transaction. The connection's own reads supply
 * the stored binding, its application state, the receipt row and the operation
 * journal. Nothing here is a real MySQL proof: the focused tests use a fault
 * injecting SQL fixture. See `docs/slide/development/MAX-238/b2e-mysql-host-codec.md`
 * and the candidate DDL in `b2e-candidate-schema.sql`.
 */
import { z } from 'zod';
import { ResourceTypeSchema } from '../../contracts/metrics/index.js';
import { TimestampSchema } from '../../contracts/metrics/definitions.js';
import {
  HashIdSchema, ResourceBindingCandidateSchema,
  type HashId, type ResourceBindingCandidate,
} from '../../contracts/metrics/templates.js';
import type { PackageRegistry } from '../packages/model.js';
import type { TemplateVersionReadPort } from './preflight.js';
import {
  applyTemplateBindingMutation,
  type BindingApplicationHost, type BindingApplicationIntent, type BindingApplicationOutcome,
  type BindingStageRejectionCode,
} from './transaction-adapter.js';
import type { ResourceRef } from './transaction-guard.js';
import {
  BindingPersistenceError, decodeBindingPayload, encodeTemplatePendingPayload,
  type DecodedBindingPayload, type EffectiveSnapshot,
} from './persistence-codec.js';
import type { TemplateCollectionPlan } from './plan.js';

/** Every statement this host issues. The SQL fixture dispatches on these values. */
export const MYSQL_BINDING_HOST_SQL = {
  lock: 'SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE',
  bindingRead: 'SELECT payload FROM metric_policy_bindings WHERE resource_key = ?',
  bindingLock: 'SELECT payload FROM metric_policy_bindings WHERE resource_key = ? FOR UPDATE',
  receiptRead: 'SELECT payload FROM metric_policy_trial_receipts WHERE receipt_id = ? LIMIT 2',
  operationRead: 'SELECT caller_key, receipt_id, resource_type, resource_id, target_revision, '
    + 'candidate_digest, resolution_identity, dependency_digest, status '
    + 'FROM metric_policy_operations WHERE caller_key = ? LIMIT 2',
  consumptionRead: 'SELECT caller_key FROM metric_policy_operations WHERE receipt_id = ? LIMIT 2',
  operationInsert: 'INSERT INTO metric_policy_operations (caller_key, receipt_id, resource_type, resource_id, '
    + 'resource_key, target_revision, candidate_digest, resolution_identity, dependency_digest, status) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  bindingUpdate: 'UPDATE metric_policy_bindings SET payload = ?, group_id = ? WHERE resource_key = ? '
    + "AND JSON_EXTRACT(payload, '$.binding.revision') = ?",
  // Only an unbound resource reaches this statement; the primary key is the CAS:
  // two concurrent first bindings cannot both create the row.
  bindingInsert: 'INSERT INTO metric_policy_bindings (resource_key, payload, group_id, capabilities) VALUES (?, ?, ?, ?)',
  auditInsert: 'INSERT INTO metric_policy_audit (target, payload) VALUES (?, ?)',
} as const;

export type BindingHostErrorCode =
  | 'HOST_UNAVAILABLE'
  | 'HOST_BEGIN_UNKNOWN'
  | 'HOST_LOCK_UNAVAILABLE'
  | 'HOST_INPUTS_UNAVAILABLE'
  | 'HOST_QUERY_UNAVAILABLE'
  | 'HOST_PAYLOAD_INVALID'
  | 'HOST_INTENT_INVALID'
  | 'HOST_CLEANUP_UNCONFIRMED';

export class BindingHostError extends Error {
  constructor(public readonly code: BindingHostErrorCode) {
    super(code);
    this.name = 'BindingHostError';
  }
}

const fail = (code: BindingHostErrorCode): never => {
  throw new BindingHostError(code);
};

/** Column widths of the candidate DDL, checked in UTF-8 bytes before any write. */
const LIMITS = {
  caller_key: 255,
  receipt_id: 255,
  /** Matches the existing `metric_policy_bindings.resource_key` column width. */
  resource_key: 255,
  operation_key: 1024,
  resource_type: 32,
  digest: 71,
  status: 16,
  payload_bytes: 1024 * 1024,
} as const;

/**
 * The structural subset of `mysql2/promise` this host needs; no default pool is
 * created. `values` is `unknown` because mysql2 accepts arrays and option
 * objects; every call site here passes a positional array.
 */
export interface BindingSqlConnection {
  beginTransaction(): Promise<void>;
  execute(sql: string, values?: unknown): Promise<[unknown, unknown]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  destroy(): void;
}
export interface BindingSqlPool {
  getConnection(): Promise<BindingSqlConnection>;
}

/** Same-transaction trusted reads; the factory receives the live connection. */
export interface TrustedBindingInputs {
  authorize(resource: ResourceRef): Promise<unknown>;
  /** Returns `{resource, group, capabilities, at, actor_id}`; the host adds `application`. */
  applicationContext(resource: ResourceRef): Promise<unknown>;
  mandatoryItems(resource: ResourceRef): Promise<unknown>;
  templateVersions(): TemplateVersionReadPort;
}
export type TrustedBindingInputsFactory = (connection: BindingSqlConnection) => TrustedBindingInputs;

export interface MysqlBindingHostOptions {
  /** A pool or `null`; a missing pool is a stable "host unavailable", never a fallback. */
  readonly pool: () => BindingSqlPool | null;
  readonly trustedInputs: TrustedBindingInputsFactory;
  /** Trusted server clock, read synchronously by the guard. Never `Date.now()` here. */
  readonly trustedNow: () => unknown;
}

export interface BindingOperationLookupResult {
  /** `true` only when a complete exact query answered; `false` is "no guarantee". */
  complete: boolean;
  operation: Record<string, unknown> | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return fail('HOST_QUERY_UNAVAILABLE');
  return (result[0] as unknown[]).map(row => {
    if (!isPlainObject(row)) return fail('HOST_QUERY_UNAVAILABLE');
    return row;
  });
}

function affectedRowsOf(result: unknown): number | null {
  if (!Array.isArray(result) || !isPlainObject(result[0])) return null;
  const affected = result[0].affectedRows;
  return typeof affected === 'number' && Number.isSafeInteger(affected) && affected >= 0 ? affected : null;
}

/** VARBINARY values are compared byte for byte; never a case/space-folding collation. */
const bytes = (value: string): Buffer => Buffer.from(value, 'utf8');

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8');
    // A stored value that is not exactly the UTF-8 encoding is corruption, not a key.
    return Buffer.from(text, 'utf8').equals(value) ? text : null;
  }
  return null;
}

function uintOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** A stored id/revision that must be a positive safe integer, never 0 or a fraction. */
function positiveOf(value: unknown): number | null {
  const parsed = uintOf(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** The exact key space the host writes: a text of that pattern inside the column width. */
function keyOf(value: unknown, pattern: RegExp, limit: number): string | null {
  const text = textOf(value);
  if (text === null || text.length === 0 || text.length > limit || Buffer.byteLength(text, 'utf8') > limit) {
    return null;
  }
  return pattern.test(text) ? text : null;
}

function requireText(value: string, limit: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit
    || Buffer.byteLength(value, 'utf8') > limit) {
    return fail('HOST_INTENT_INVALID');
  }
  return value;
}

function payloadOf(row: Record<string, unknown>): unknown {
  const payload = row.payload;
  if (typeof payload === 'string' || isPlainObject(payload)) return payload;
  return fail('HOST_QUERY_UNAVAILABLE');
}

const isDuplicateEntry = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

const applicationStateOf = (decoded: DecodedBindingPayload) => ({
  status: decoded.application.status,
  applied_revision: decoded.application.applied_revision,
  resolution_identity: decoded.kind === 'template_pending' ? decoded.application.resolution_identity : null,
});

// The exact key space of the two columns this host writes and queries.
const CALLER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECEIPT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

/**
 * Validate one stored operation row against everything this host wrote for it:
 * both byte-exact keys, the resource type/identity, a positive target revision,
 * the three digests and one of the two mutually exclusive statuses. A row that
 * fails any of these is corrupt storage — never a completed operation, never a
 * "missing" one, and never a trusted receipt consumption.
 *
 * `expectedCaller` is the key that was queried, so a row returned under another
 * key (a collation or trailing-space artefact) is corruption, not a match.
 */
function operationRowOf(row: Record<string, unknown>, expectedCaller: string): Record<string, unknown> | null {
  const callerKey = keyOf(row.caller_key, CALLER_KEY_PATTERN, LIMITS.caller_key);
  if (callerKey === null || callerKey !== expectedCaller) return null;
  // Every operation row is written together with the receipt it consumes.
  const receiptId = keyOf(row.receipt_id, RECEIPT_KEY_PATTERN, LIMITS.receipt_id);
  if (receiptId === null) return null;
  const resourceType = textOf(row.resource_type);
  if (resourceType === null || !ResourceTypeSchema.safeParse(resourceType).success) return null;
  const resourceId = positiveOf(row.resource_id);
  const targetRevision = positiveOf(row.target_revision);
  const candidateDigest = HashIdSchema.safeParse(textOf(row.candidate_digest) ?? undefined);
  const resolutionIdentity = HashIdSchema.safeParse(textOf(row.resolution_identity) ?? undefined);
  const dependencyDigest = HashIdSchema.safeParse(textOf(row.dependency_digest) ?? undefined);
  const status = textOf(row.status);
  if (resourceId === null || targetRevision === null
    || !candidateDigest.success || !resolutionIdentity.success || !dependencyDigest.success
    || (status !== 'committed' && status !== 'unknown')) {
    return null;
  }
  return {
    caller_key: callerKey,
    resource: { type: resourceType, id: resourceId },
    target_revision: targetRevision,
    candidate_digest: candidateDigest.data,
    resolution_identity: resolutionIdentity.data,
    dependency_digest: dependencyDigest.data,
    receipt_id: receiptId,
    status,
  };
}

/** A consumption row names the caller that used the receipt; a damaged key proves nothing. */
function consumptionRowOf(row: Record<string, unknown>): string | null {
  return keyOf(row.caller_key, CALLER_KEY_PATTERN, LIMITS.caller_key);
}

// --- intent validation ------------------------------------------------------

const IdTextSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const OperationKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:#@-]{0,1023}$/);
const RevisionSchema = z.number().int().nonnegative().max(MAX_REVISION);
const TargetRevisionSchema = z.number().int().positive().max(MAX_REVISION);

const IntentSchema = z.strictObject({
  kind: z.literal('template_binding_application'),
  internal: z.literal(true),
  protocol: z.literal('max238.binding-application.v1'),
  resource_key: z.string().min(1),
  base_revision: RevisionSchema,
  target_revision: TargetRevisionSchema,
  binding: z.unknown(),
  pending: z.strictObject({
    resolution_identity: HashIdSchema,
    plan: z.unknown(),
    decided_at: TimestampSchema,
  }),
  application: z.strictObject({
    status: z.literal('pending'),
    applied_revision: TargetRevisionSchema.nullable(),
    previous_resolution_identity: HashIdSchema.nullable(),
  }),
  operation: z.strictObject({
    key: OperationKeySchema,
    caller_key: IdTextSchema,
    resource: z.strictObject({
      type: ResourceTypeSchema,
      id: z.number().int().positive().max(MAX_REVISION),
    }),
    target_revision: TargetRevisionSchema,
    candidate_digest: HashIdSchema,
    resolution_identity: HashIdSchema,
    dependency_digest: HashIdSchema,
    receipt_id: IdTextSchema,
    status: z.literal('committed'),
  }),
  receipt: z.strictObject({
    receipt_id: IdTextSchema,
    operation_key: OperationKeySchema,
    expires_at: TimestampSchema,
  }),
  audit: z.strictObject({
    action: z.literal('template_binding.apply'),
    target: z.string().min(1),
    revision: TargetRevisionSchema,
    actor_id: z.number().int().positive().max(MAX_REVISION),
    idempotency_key: IdTextSchema,
    candidate_digest: HashIdSchema,
    resolution_identity: HashIdSchema,
    dependency_digest: HashIdSchema,
    receipt_id: IdTextSchema,
    at: TimestampSchema,
  }),
});

interface ValidatedIntent {
  resource_key: string;
  base_revision: number;
  target_revision: number;
  binding: ResourceBindingCandidate;
  resolution_identity: HashId;
  plan: TemplateCollectionPlan;
  decided_at: string;
  applied_revision: number | null;
  previous_resolution_identity: HashId | null;
  operation: BindingApplicationIntent['operation'];
  audit: BindingApplicationIntent['audit'];
}

/**
 * Validate the whole intent and every SQL-representable boundary **before** the
 * first write. The plan keeps the base revision's identity; the target binding
 * revision is a separate field, never a rewritten plan revision.
 */
function validateIntent(intent: unknown): ValidatedIntent {
  const parsed = IntentSchema.safeParse(intent);
  if (!parsed.success) return fail('HOST_INTENT_INVALID');
  const value = parsed.data;
  const binding = ResourceBindingCandidateSchema.safeParse(value.binding);
  if (!binding.success) return fail('HOST_INTENT_INVALID');
  if (binding.data.package !== null || binding.data.template_pins.length === 0) {
    return fail('HOST_INTENT_INVALID');
  }
  if (value.base_revision + 1 !== value.target_revision
    || binding.data.revision !== value.target_revision
    || value.operation.target_revision !== value.target_revision
    || value.audit.revision !== value.target_revision) {
    return fail('HOST_INTENT_INVALID');
  }
  const resourceKey = `${value.operation.resource.type}:${value.operation.resource.id}`;
  if (value.resource_key !== resourceKey || value.audit.target !== resourceKey) {
    return fail('HOST_INTENT_INVALID');
  }
  if (value.operation.caller_key !== value.audit.idempotency_key
    || value.receipt.receipt_id !== value.operation.receipt_id
    || value.receipt.receipt_id !== value.audit.receipt_id
    || value.receipt.operation_key !== value.operation.key
    || value.audit.at !== value.pending.decided_at
    || value.operation.candidate_digest !== value.audit.candidate_digest
    || value.operation.resolution_identity !== value.audit.resolution_identity
    || value.operation.resolution_identity !== value.pending.resolution_identity
    || value.operation.dependency_digest !== value.audit.dependency_digest) {
    return fail('HOST_INTENT_INVALID');
  }
  const plan = value.pending.plan;
  if (!isPlainObject(plan) || plan.kind !== 'template_collection_plan'
    || plan.identity !== value.pending.resolution_identity
    || plan.revision !== value.base_revision
    || !isPlainObject(plan.resource)
    || plan.resource.type !== binding.data.resource.type
    || plan.resource.id !== String(binding.data.resource.id)) {
    return fail('HOST_INTENT_INVALID');
  }
  requireText(value.resource_key, LIMITS.resource_key);
  requireText(value.operation.caller_key, LIMITS.caller_key);
  requireText(value.operation.receipt_id, LIMITS.receipt_id);
  requireText(value.operation.key, LIMITS.operation_key);
  requireText(value.operation.resource.type, LIMITS.resource_type);
  return {
    resource_key: value.resource_key,
    base_revision: value.base_revision,
    target_revision: value.target_revision,
    binding: binding.data,
    resolution_identity: value.pending.resolution_identity,
    plan: plan as unknown as TemplateCollectionPlan,
    decided_at: value.pending.decided_at,
    applied_revision: value.application.applied_revision,
    previous_resolution_identity: value.application.previous_resolution_identity,
    operation: value.operation as unknown as BindingApplicationIntent['operation'],
    audit: value.audit as unknown as BindingApplicationIntent['audit'],
  };
}

/** The template audit shape; deliberately not the legacy `Audit` union. */
function auditPayloadOf(intent: ValidatedIntent, operationKey: string): string {
  return JSON.stringify({
    actor_id: intent.audit.actor_id,
    request_id: intent.audit.idempotency_key,
    action: intent.audit.action,
    target: intent.audit.target,
    revision: intent.audit.revision,
    at: intent.audit.at,
    candidate_digest: intent.audit.candidate_digest,
    resolution_identity: intent.audit.resolution_identity,
    dependency_digest: intent.audit.dependency_digest,
    receipt_id: intent.audit.receipt_id,
    operation_key: operationKey,
    configuration: {
      base_revision: intent.base_revision,
      target_revision: intent.target_revision,
      group_id: intent.binding.group_id,
      template_pins: intent.binding.template_pins,
      overrides: intent.binding.overrides,
    },
  });
}

// --- transaction lifecycle --------------------------------------------------

type LifecycleState = 'active' | 'committed' | 'rolled_back' | 'destroyed';

/**
 * Exactly one cleanup per lease. A rollback is attempted at most once; if it is
 * not confirmed the connection is destroyed and never returned to the pool, so a
 * later `START TRANSACTION` cannot implicitly commit leftovers.
 */
class TransactionLifecycle {
  state: LifecycleState = 'active';
  private rollbackAttempted = false;
  constructor(private readonly connection: BindingSqlConnection) {}

  async rollbackOnce(): Promise<boolean> {
    if (this.state === 'rolled_back') return true;
    if (this.state !== 'active' || this.rollbackAttempted) return false;
    this.rollbackAttempted = true;
    try {
      await this.connection.rollback();
      this.state = 'rolled_back';
      return true;
    } catch {
      return false;
    }
  }

  destroy(): void {
    if (this.state === 'destroyed') return;
    this.state = 'destroyed';
    try { this.connection.destroy(); } catch { /* the connection is already unusable */ }
  }

  release(): void {
    try { this.connection.release(); } catch { /* released exactly once */ }
  }

  async withdraw(): Promise<void> {
    if (this.state === 'destroyed') return;
    if (this.state === 'active') {
      // Nothing is committed without an explicit settle; withdraw discards reads.
      if (await this.rollbackOnce()) this.release(); else this.destroy();
      return;
    }
    this.release();
  }
}

interface StagedToken {
  /** The exact handle the adapter receives and passes back to settle. */
  handle: { status: 'staged' };
  target_revision: number;
  redeemed: boolean;
}

class MysqlTransactionHost implements BindingApplicationHost {
  private staged: StagedToken | null = null;

  constructor(
    private readonly connection: BindingSqlConnection,
    private readonly inputs: TrustedBindingInputs,
    private readonly lifecycle: TransactionLifecycle,
    private readonly trustedNow: () => unknown,
  ) {}

  // --- trusted reads -------------------------------------------------------

  authorize(resource: ResourceRef): Promise<unknown> {
    return this.inputs.authorize(resource);
  }

  mandatoryItems(resource: ResourceRef): Promise<unknown> {
    return this.inputs.mandatoryItems(resource);
  }

  templateVersions(): TemplateVersionReadPort {
    return this.inputs.templateVersions();
  }

  serverNow(): unknown {
    // Synchronous by contract; the guard rejects a thenable as unavailable time.
    return this.trustedNow();
  }

  async currentBinding(resource: ResourceRef): Promise<unknown> {
    const decoded = await this.readDecoded(resourceKeyOf(resource), false);
    return decoded === null ? null : decoded.binding;
  }

  async getTrialReceipt(receiptId: string): Promise<unknown> {
    const rows = await this.select(MYSQL_BINDING_HOST_SQL.receiptRead, receiptId);
    if (rows.length > 1) return fail('HOST_QUERY_UNAVAILABLE');
    if (rows.length === 0) return null;
    const payload = payloadOf(rows[0]);
    if (typeof payload !== 'string') return payload;
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return fail('HOST_QUERY_UNAVAILABLE');
    }
  }

  async applicationContext(resource: ResourceRef): Promise<unknown> {
    const raw = await this.inputs.applicationContext(resource);
    if (!isPlainObject(raw)) return fail('HOST_INPUTS_UNAVAILABLE');
    const decoded = await this.readDecoded(resourceKeyOf(resource), false);
    // Exactly the six fields the guard's strict schema accepts; the stored
    // application state is read here, not supplied by the factory or the request.
    // An unbound resource has no row and therefore no application state — null,
    // never a fabricated pending revision.
    return {
      resource: raw.resource,
      group: raw.group,
      capabilities: raw.capabilities,
      at: raw.at,
      actor_id: raw.actor_id,
      application: decoded === null ? null : applicationStateOf(decoded),
    };
  }

  async findOperationExact(callerKey: string): Promise<unknown> {
    const rows = await this.select(MYSQL_BINDING_HOST_SQL.operationRead, callerKey);
    if (rows.length > 1) return { complete: false, operation: null };
    if (rows.length === 0) return { complete: true, operation: null };
    const operation = operationRowOf(rows[0], callerKey);
    return operation === null ? { complete: false, operation: null } : { complete: true, operation };
  }

  async findReceiptConsumption(receiptId: string): Promise<unknown> {
    const rows = await this.select(MYSQL_BINDING_HOST_SQL.consumptionRead, receiptId);
    // Two rows prove the global uniqueness invariant is broken; never "consumed".
    // A row whose caller key is damaged proves nothing either.
    if (rows.length > 1 || rows.some(row => consumptionRowOf(row) === null)) return { complete: false };
    return { complete: true, consumed: rows.length === 1 };
  }

  // --- atomic staging ------------------------------------------------------

  async stageApplication(intent: unknown): Promise<unknown> {
    // One staged intent per lease; a second call cannot reuse this transaction.
    if (this.staged !== null) return this.reject('UNAVAILABLE');
    let valid: ValidatedIntent;
    try { valid = validateIntent(intent); } catch { return this.reject('UNAVAILABLE'); }

    let decoded: DecodedBindingPayload | null;
    try { decoded = await this.readDecoded(valid.resource_key, true); } catch { return this.reject('UNAVAILABLE'); }
    if (decoded === null) {
      // The first binding of an unbound resource: base 0 creates revision 1.
      // Anything else claims a history this storage does not have.
      if (valid.base_revision !== 0 || valid.applied_revision !== null
        || valid.previous_resolution_identity !== null) {
        return this.reject('REVISION_CONFLICT');
      }
    } else {
      // The row lock above is the CAS read; the SQL condition below is the authority.
      if (decoded.binding.revision !== valid.base_revision) return this.reject('REVISION_CONFLICT');
      // A previous applied revision with no provable effective plan is an existing
      // storage gap; refuse instead of inventing history or promoting the pending plan.
      if (decoded.effective_missing) return this.reject('UNAVAILABLE');
      if (decoded.application.applied_revision !== valid.applied_revision
        || (decoded.effective?.resolution_identity ?? null) !== valid.previous_resolution_identity) {
        return this.reject('DEPENDENCY_CHANGED');
      }
    }

    let payloadText: string;
    let auditText: string;
    try {
      payloadText = encodeTemplatePendingPayload({
        binding: valid.binding,
        base_revision: valid.base_revision,
        target_revision: valid.target_revision,
        resolution_identity: valid.resolution_identity,
        plan: valid.plan,
        decided_at: valid.decided_at,
        operation_key: valid.operation.key,
        applied_revision: decoded?.application.applied_revision ?? null,
        previous_resolution_identity: valid.previous_resolution_identity,
        previous_effective: (decoded?.effective as EffectiveSnapshot | null | undefined) ?? null,
        published_at: valid.decided_at,
      });
      auditText = auditPayloadOf(valid, valid.operation.key);
    } catch { return this.reject('UNAVAILABLE'); }
    if (Buffer.byteLength(payloadText, 'utf8') > LIMITS.payload_bytes
      || Buffer.byteLength(auditText, 'utf8') > LIMITS.payload_bytes) {
      return this.reject('UNAVAILABLE');
    }

    // Three physical writes: the operation row also *is* the receipt consumption
    // (global UNIQUE receipt_id); no separate consumption ledger is written.
    try {
      await this.connection.execute(MYSQL_BINDING_HOST_SQL.operationInsert, [
        bytes(valid.operation.caller_key), bytes(valid.operation.receipt_id),
        bytes(valid.operation.resource.type), valid.operation.resource.id,
        bytes(valid.resource_key), valid.operation.target_revision,
        bytes(valid.operation.candidate_digest), bytes(valid.operation.resolution_identity),
        bytes(valid.operation.dependency_digest), bytes('committed'),
      ]);
    } catch (error) {
      return this.rejectedWrite(error, valid);
    }

    let casResult: unknown;
    try {
      casResult = decoded === null
        // The primary key is the CAS: a concurrent first binding conflicts here,
        // exactly like a revision mismatch would on an existing row.
        ? await this.connection.execute(MYSQL_BINDING_HOST_SQL.bindingInsert, [
          bytes(valid.resource_key), payloadText, valid.binding.group_id, '[]',
        ])
        : await this.connection.execute(MYSQL_BINDING_HOST_SQL.bindingUpdate, [
          payloadText, valid.binding.group_id, bytes(valid.resource_key), valid.base_revision,
        ]);
    } catch (error) {
      // Another client created this resource's row between the lock read and the
      // insert: that is a revision conflict, not an unknown write failure.
      if (decoded === null && isDuplicateEntry(error)) return this.reject('REVISION_CONFLICT');
      return this.rejectedWrite(error, valid);
    }
    const affected = affectedRowsOf(casResult);
    if (affected !== 1) {
      // Zero means the CAS revision no longer matches (or the row vanished); a
      // non-numeric report is unknown. Either way nothing may stay staged.
      return this.reject(affected === 0 ? 'REVISION_CONFLICT' : 'UNAVAILABLE');
    }

    try {
      await this.connection.execute(MYSQL_BINDING_HOST_SQL.auditInsert, [bytes(valid.resource_key), auditText]);
    } catch (error) {
      return this.rejectedWrite(error, valid);
    }

    const handle: { status: 'staged' } = { status: 'staged' };
    this.staged = { handle, target_revision: valid.target_revision, redeemed: false };
    return handle;
  }

  async settleApplication(staged: unknown): Promise<unknown> {
    const token = this.staged;
    // Only the exact handle this host staged may be settled, exactly once.
    if (token === null || staged !== token.handle || token.redeemed) return { status: 'unknown' };
    token.redeemed = true;
    try {
      await this.connection.commit();
    } catch {
      // A commit whose acknowledgement was lost may have committed: never call it
      // rolled back and never return this connection to the pool.
      this.lifecycle.destroy();
      return { status: 'unknown' };
    }
    this.lifecycle.state = 'committed';
    return { status: 'committed', revision: token.target_revision };
  }

  // --- helpers -------------------------------------------------------------

  private async rejectedWrite(error: unknown, valid: ValidatedIntent): Promise<unknown> {
    // Roll the whole staging back before reporting a rejection.
    const restored = await this.lifecycle.rollbackOnce();
    if (!restored) return fail('HOST_CLEANUP_UNCONFIRMED');
    return { status: 'rejected', code: await this.classifyWriteFailure(error, valid) };
  }

  private async reject(code: BindingStageRejectionCode): Promise<unknown> {
    const restored = await this.lifecycle.rollbackOnce();
    if (!restored) return fail('HOST_CLEANUP_UNCONFIRMED');
    return { status: 'rejected', code };
  }

  /**
   * Distinguish the two known unique constraints without parsing a driver
   * message: after the rollback, look up the surviving rows by each key. An
   * unrecognized unique violation stays `UNAVAILABLE`.
   */
  private async classifyWriteFailure(error: unknown, valid: ValidatedIntent): Promise<BindingStageRejectionCode> {
    if (!isDuplicateEntry(error)) return 'UNAVAILABLE';
    try {
      const byCaller = await this.select(MYSQL_BINDING_HOST_SQL.operationRead, valid.operation.caller_key);
      if (byCaller.some(row => operationRowOf(row, valid.operation.caller_key) !== null)) return 'OPERATION_CONFLICT';
    } catch { return 'UNAVAILABLE'; }
    try {
      const byReceipt = await this.select(MYSQL_BINDING_HOST_SQL.consumptionRead, valid.operation.receipt_id);
      // A surviving row that cannot be read as a consumption is not a known conflict.
      if (byReceipt.length > 0 && byReceipt.every(row => consumptionRowOf(row) !== null)) return 'RECEIPT_CONSUMED';
    } catch { return 'UNAVAILABLE'; }
    return 'UNAVAILABLE';
  }

  private async readDecoded(resourceKey: string, forUpdate: boolean): Promise<DecodedBindingPayload | null> {
    const rows = await this.select(
      forUpdate ? MYSQL_BINDING_HOST_SQL.bindingLock : MYSQL_BINDING_HOST_SQL.bindingRead,
      resourceKey,
    );
    if (rows.length > 1) return fail('HOST_QUERY_UNAVAILABLE');
    if (rows.length === 0) return null;
    try {
      return decodeBindingPayload(payloadOf(rows[0]));
    } catch (error) {
      if (error instanceof BindingPersistenceError) return fail('HOST_PAYLOAD_INVALID');
      return fail('HOST_QUERY_UNAVAILABLE');
    }
  }

  private async select(sql: string, value: string): Promise<Record<string, unknown>[]> {
    if (typeof value !== 'string' || value.length === 0) return fail('HOST_QUERY_UNAVAILABLE');
    return rowsOf(await this.connection.execute(sql, [bytes(value)]));
  }
}

const resourceKeyOf = (resource: ResourceRef): string => `${resource.type}:${resource.id}`;

function assertInputs(inputs: unknown): asserts inputs is TrustedBindingInputs {
  if (!isPlainObject(inputs)
    || typeof inputs.authorize !== 'function'
    || typeof inputs.applicationContext !== 'function'
    || typeof inputs.mandatoryItems !== 'function'
    || typeof inputs.templateVersions !== 'function') {
    return fail('HOST_INPUTS_UNAVAILABLE');
  }
}

/**
 * The host: one connection, one global policy lock, one adapter call, one
 * cleanup. `apply` returns the adapter's outcome unchanged; guard/host contract
 * errors propagate after the connection has been withdrawn.
 */
export class MysqlBindingHost {
  constructor(private readonly options: MysqlBindingHostOptions) {}

  async apply(request: unknown, registry: PackageRegistry): Promise<BindingApplicationOutcome> {
    const pool = this.options?.pool?.();
    if (pool === null || pool === undefined || typeof pool.getConnection !== 'function') {
      return fail('HOST_UNAVAILABLE');
    }
    let connection: BindingSqlConnection;
    try {
      connection = await pool.getConnection();
    } catch {
      return fail('HOST_UNAVAILABLE');
    }
    const lifecycle = new TransactionLifecycle(connection);

    try {
      await connection.beginTransaction();
    } catch {
      // Begin state is unknown: never reuse this connection for a later statement.
      lifecycle.destroy();
      return fail('HOST_BEGIN_UNKNOWN');
    }

    let lockRows: Record<string, unknown>[];
    try {
      lockRows = rowsOf(await connection.execute(MYSQL_BINDING_HOST_SQL.lock));
    } catch {
      await lifecycle.withdraw();
      return fail('HOST_LOCK_UNAVAILABLE');
    }
    if (lockRows.length !== 1) {
      await lifecycle.withdraw();
      return fail('HOST_LOCK_UNAVAILABLE');
    }

    let inputs: TrustedBindingInputs;
    try {
      const created = this.options.trustedInputs(connection);
      assertInputs(created);
      inputs = created;
    } catch {
      await lifecycle.withdraw();
      return fail('HOST_INPUTS_UNAVAILABLE');
    }

    const transaction = new MysqlTransactionHost(connection, inputs, lifecycle, this.options.trustedNow);
    let outcome: BindingApplicationOutcome;
    try {
      outcome = await applyTemplateBindingMutation(request, transaction, registry);
    } catch (error) {
      await lifecycle.withdraw();
      throw error;
    }
    await lifecycle.withdraw();
    return outcome;
  }

  /**
   * Read-only lookup of the original operation by caller key. It never writes an
   * unknown row, never retries a mutation and takes no lock: a missing or
   * unavailable answer is not proof that a replay is safe.
   */
  async lookupOperation(callerKey: string): Promise<BindingOperationLookupResult> {
    // Only a key this storage can represent is queryable; anything else is refused
    // before a connection is taken, never answered as "absent".
    if (typeof callerKey !== 'string' || !CALLER_KEY_PATTERN.test(callerKey)
      || Buffer.byteLength(callerKey, 'utf8') > LIMITS.caller_key) {
      return fail('HOST_INTENT_INVALID');
    }
    const pool = this.options?.pool?.();
    if (pool === null || pool === undefined || typeof pool.getConnection !== 'function') {
      return fail('HOST_UNAVAILABLE');
    }
    let connection: BindingSqlConnection;
    try {
      connection = await pool.getConnection();
    } catch {
      return fail('HOST_UNAVAILABLE');
    }
    try {
      const rows = rowsOf(await connection.execute(MYSQL_BINDING_HOST_SQL.operationRead, [bytes(callerKey)]));
      if (rows.length > 1) return { complete: false, operation: null };
      if (rows.length === 0) return { complete: true, operation: null };
      const operation = operationRowOf(rows[0], callerKey);
      return operation === null ? { complete: false, operation: null } : { complete: true, operation };
    } catch {
      return fail('HOST_QUERY_UNAVAILABLE');
    } finally {
      try { connection.release(); } catch { /* the pool may already have discarded it */ }
    }
  }
}
