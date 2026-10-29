/**
 * MAX-238 / B2B — pre-application transaction decision and trusted trial-receipt
 * guard on top of the accepted B1 preflight and B2A candidate compilation.
 *
 * This is still an **unmounted internal** step. It consumes a trusted transaction
 * view plus a request and returns either a rejection, an exact replay of an
 * already committed operation, a "look up the original operation" status or a
 * *prepared* pending write. It persists nothing, issues no receipt, applies no
 * binding and performs no collection I/O. No real MySQL lock/CAS, authorization
 * atomicity, trial execution or application acceptance is proven here (see
 * `docs/slide/development/MAX-238/b2b-transaction-guard.md` and
 * `b2b-transaction-wiring.md`).
 *
 * The entry is `prepareTemplateBindingMutation(request, transaction, templates,
 * registry)`. It always re-runs B2A `compileBindingCandidate`, so neither a
 * caller-supplied "compiled/validated" object nor an old candidate snapshot can
 * replace the current candidate identity. Current state comes only from the
 * trusted view: `payload.binding` is the configuration fact and its `revision` is
 * the only CAS authority.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  HashIdSchema, ItemIdSchema, ResourceBindingCandidateSchema, ResourceRefSchema, TemplateIdSchema,
  VersionNumberSchema,
  type HashId, type PackagePin, type ResourceBindingCandidate,
} from '../../contracts/metrics/templates.js';
import { TimestampSchema } from '../../contracts/metrics/definitions.js';
import { stable, type PackageRegistry } from '../packages/model.js';
import {
  compileBindingCandidate, type BindingTemplateCandidate,
} from './compile.js';
import { resolveTemplateBinding, templateResolutionIdentity, type ResolvedTemplateBinding } from './resolve.js';
import { buildTemplateCollectionPlan, type TemplateCollectionPlan } from './plan.js';
import type { TemplateVersionReadPort } from './preflight.js';

export type ResourceRef = z.infer<typeof ResourceRefSchema>;

/** Stable machine code for every guard rejection; `message` equals the code. */
export type BindingTransactionErrorCode =
  | 'TRANSACTION_INPUT_INVALID'
  | 'TRANSACTION_BINDING_UNAVAILABLE'
  | 'TRANSACTION_BINDING_INVALID'
  | 'TRANSACTION_BINDING_MISSING'
  | 'TRANSACTION_BINDING_IDENTITY'
  | 'TRANSACTION_REVISION_CONFLICT'
  | 'TRANSACTION_AUTH_UNAVAILABLE'
  | 'TRANSACTION_FORBIDDEN'
  | 'TRANSACTION_CANCELLED'
  | 'TRANSACTION_DEPENDENCY_CHANGED'
  | 'TRANSACTION_OPERATION_UNAVAILABLE'
  | 'TRANSACTION_OPERATION_INVALID'
  | 'TRANSACTION_OPERATION_CONFLICT'
  | 'TRANSACTION_RECEIPT_UNAVAILABLE'
  | 'TRANSACTION_RECEIPT_NOT_FOUND'
  | 'TRANSACTION_RECEIPT_INVALID'
  | 'TRANSACTION_RECEIPT_MISMATCH'
  | 'TRANSACTION_RECEIPT_ITEMS_INVALID'
  | 'TRANSACTION_RECEIPT_TIME_INVALID'
  | 'TRANSACTION_RECEIPT_EXPIRED'
  | 'TRANSACTION_TIME_UNAVAILABLE'
  | 'TRANSACTION_MANDATORY_UNAVAILABLE'
  | 'TRANSACTION_MANDATORY_INVALID'
  // Explicit v2 (template resolution) entry only; the v1 entry never returns these.
  | 'TRANSACTION_CONTEXT_UNAVAILABLE'
  | 'TRANSACTION_CONTEXT_INVALID'
  | 'TRANSACTION_CONTEXT_TIME_INVALID'
  | 'TRANSACTION_RECEIPT_CONSUMED'
  | 'TRANSACTION_RESOLUTION_INVALID'
  | 'TRANSACTION_RESOLUTION_DISABLED'
  | 'TRANSACTION_RESOLUTION_BLOCKED'
  | 'TRANSACTION_RESOLUTION_EMPTY'
  | 'TRANSACTION_CAPABILITY_TIME_INVALID';

/** A selected/qualified template item, identified the way the template contract identifies it. */
export interface BindingItemRef {
  template_id: string;
  item_id: string;
  item_version: number;
}

/**
 * Only structured item identities travel with an item-coverage rejection; a
 * port/driver message, receipt body or credential never does.
 */
export class BindingTransactionError extends Error {
  constructor(
    public readonly code: BindingTransactionErrorCode,
    public readonly items: readonly BindingItemRef[] = [],
  ) {
    super(code);
    this.name = 'BindingTransactionError';
  }
}

/** Trusted authorization state, re-read before reads and again before a decision. */
export interface TrustedAuthorization {
  /** Manage permission for this exact resource in the trusted view. */
  allowed: boolean;
  /** Cancellation of this attempt in the trusted view. */
  cancelled: boolean;
  /**
   * Server-computed identity of every configuration dependency the test relied
   * on (group/policy revisions, inventory compatibility, credential-reference
   * version). The guard treats it as opaque; it must never contain secrets.
   */
  dependency_digest: HashId;
}

/** One caller-key operation already recorded in the trusted view. */
export interface TrustedBindingOperation {
  caller_key: string;
  resource: ResourceRef;
  target_revision: number;
  candidate_digest: HashId;
  /** `committed` has a receipt to replay; `unknown` must be looked up, never resent. */
  status: 'committed' | 'unknown';
  receipt_id: string | null;
}

/**
 * The trusted reads shared by both protocols. Every method reads server-side
 * state; none writes. `mandatoryItems` may be absent, which means "every
 * selected item is mandatory" until mandatory semantics are resolved.
 */
export interface BindingTransactionReads {
  authorize(resource: ResourceRef): Promise<unknown>;
  currentBinding(resource: ResourceRef): Promise<unknown>;
  getTrialReceipt(receiptId: string): Promise<unknown>;
  mandatoryItems?(resource: ResourceRef): Promise<unknown>;
  /**
   * Trusted current server time, read **synchronously** after the last
   * asynchronous authorization read. Returning a promise/thenable would
   * reintroduce the async window the expiry check must not have; the future
   * trusted adapter has to satisfy this contract (it still does not make DB
   * commit-time atomicity true).
   */
  serverNow(): unknown;
}

/** The accepted v1 transaction view: the shared reads plus the v1 caller-key lookup. */
export interface BindingTransactionPort extends BindingTransactionReads {
  findOperation(callerKey: string): Promise<unknown>;
}

/**
 * One caller-key operation already recorded by the explicit v2 protocol. It
 * carries the three identities a receipt binds — candidate, resolution and
 * dependency — plus the receipt it consumed. A record without a resolution
 * identity is a v1 record and can never be an exact v2 replay.
 */
export interface TrustedBindingOperationV2 {
  caller_key: string;
  resource: ResourceRef;
  target_revision: number;
  candidate_digest: HashId;
  resolution_identity: HashId;
  dependency_digest: HashId;
  receipt_id: string | null;
  status: 'committed' | 'unknown';
}

/** The trusted previous application state; a pending revision must preserve it. */
export interface TrustedApplicationState {
  status: 'pending' | 'applied' | 'failed';
  applied_revision: number | null;
  resolution_identity: HashId | null;
}

/**
 * Trusted inputs the v2 entry needs on top of {@link BindingTransactionPort}.
 * `applicationContext` is one same-view read of the B2C inputs, the previous
 * application state and the audit actor. `findOperationExact` and
 * `findReceiptConsumption` must assert completeness: they may only answer
 * `null`/`consumed: false` when a complete exact query proved absence, never
 * from a truncated audit window.
 */
export interface BindingTransactionPortV2 extends BindingTransactionReads {
  findOperationExact(callerKey: string): Promise<unknown>;
  findReceiptConsumption(receiptId: string): Promise<unknown>;
  applicationContext(resource: ResourceRef): Promise<unknown>;
}

/** The explicit single-package branch; the existing flow owns it, this guard does not rewrite it. */
export interface LegacyBindingDelegate {
  kind: 'legacy_delegate';
  binding: ResourceBindingCandidate;
  package: PackagePin;
}

/** The exact operation is already committed; replay its receipt, write nothing. */
export interface ReplayedBindingMutation {
  kind: 'replay';
  persisted: false;
  resource: ResourceRef;
  base_revision: number;
  target_revision: number;
  candidate_digest: HashId;
  operation: { key: string; caller_key: string; receipt_id: string; status: 'committed' };
}

/** A prior attempt has an unknown outcome; query the original operation, never resend. */
export interface BindingOperationLookup {
  kind: 'operation_lookup_required';
  persisted: false;
  resource: ResourceRef;
  candidate_digest: HashId;
  operation: { key: string; caller_key: string; status: 'unknown' };
}

/** A decision the caller may write only inside the same transaction as its receipt and audit. */
export interface PreparedBindingMutation {
  kind: 'prepared';
  /** Prepared only: no commit, receipt issuance or acceptance happened here. */
  prepared: true;
  persisted: false;
  applied: false;
  resource: ResourceRef;
  base_revision: number;
  target_revision: number;
  candidate_digest: HashId;
  operation: { key: string; caller_key: string; receipt_id: string; status: 'pending' };
  /** Exact trusted base read inside the view; null only for an unbound resource's first binding. */
  current: ResourceBindingCandidate | null;
  /** Exact binding to save in the same transaction; unresolved, not an execution plan. */
  next: ResourceBindingCandidate;
}

/**
 * The explicit v2 prepared decision: the same pending write as v1 plus the
 * re-derived B2C view whose identity the receipt binds. It is still only
 * prepared — no commit, receipt issuance or application happened here.
 */
export interface PreparedTemplateBindingMutation extends PreparedBindingMutation {
  protocol: 'max238.template-binding.v2';
  receipt_version: 2;
  dependency_digest: HashId;
  resolution_identity: HashId;
  resolution: ResolvedTemplateBinding;
  plan: TemplateCollectionPlan;
  /** Preserved as-is; a new pending revision never replaces the effective plan. */
  previous_application: TrustedApplicationState | null;
  /** Trusted audit actor; the request never supplies it. */
  actor_id: number;
  decided_at: string;
  receipt_expires_at: string;
}

export type BindingMutationOutcome =
  | LegacyBindingDelegate | ReplayedBindingMutation | BindingOperationLookup | PreparedBindingMutation;

export type TemplateBindingMutationOutcome =
  | LegacyBindingDelegate | ReplayedBindingMutation | BindingOperationLookup | PreparedTemplateBindingMutation;

const IdTextSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const ItemRefSchema = z.strictObject({
  template_id: TemplateIdSchema,
  item_id: ItemIdSchema,
  item_version: VersionNumberSchema,
});
const ReceiptItemSchema = z.strictObject({
  ...ItemRefSchema.shape,
  phases: z.strictObject({ read: z.boolean(), transform: z.boolean(), unit: z.boolean() }),
});
const TargetRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const BaseRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** The request may name a receipt id and nothing else about the receipt. */
const PrepareMutationRequestSchema = z.strictObject({
  resource: ResourceRefSchema,
  candidate: z.unknown(),
  receipt_id: IdTextSchema,
  caller_key: IdTextSchema,
});
const TrustedAuthorizationSchema = z.strictObject({
  allowed: z.boolean(),
  cancelled: z.boolean(),
  dependency_digest: HashIdSchema,
});
const TrustedOperationSchema = z.strictObject({
  caller_key: IdTextSchema,
  resource: ResourceRefSchema,
  target_revision: TargetRevisionSchema,
  candidate_digest: HashIdSchema,
  status: z.enum(['committed', 'unknown']),
  receipt_id: IdTextSchema.nullable(),
}).superRefine((operation, ctx) => {
  if (operation.status === 'committed' && operation.receipt_id === null) {
    ctx.addIssue({ code: 'custom', path: ['receipt_id'], message: 'OPERATION_RECEIPT_REQUIRED' });
  }
});
const TrialReceiptSchema = z.strictObject({
  receipt_id: IdTextSchema,
  resource: ResourceRefSchema,
  base_revision: BaseRevisionSchema,
  target_revision: TargetRevisionSchema,
  candidate_digest: HashIdSchema,
  dependency_digest: HashIdSchema,
  issued_at: TimestampSchema,
  expires_at: TimestampSchema,
  items: z.array(ReceiptItemSchema),
  optional_exclusions: z.array(ItemRefSchema),
});
const MandatoryItemsSchema = z.array(ItemRefSchema);

/**
 * The explicit v2 receipt protocol. `receipt_version` is a discriminant, so a
 * v1 receipt is not a v2 receipt with optional fields: the old strict schema
 * rejects v2 rows for the v1 entry and this strict schema rejects v1 rows here.
 * The three identities are independent: the candidate digest covers the raw
 * candidate and dependency digest, the resolution identity covers the resolved
 * parameters/settings/capability semantics, and the dependency digest is also
 * compared on its own.
 */
const TrialReceiptV2Schema = z.strictObject({
  receipt_version: z.literal(2),
  receipt_id: IdTextSchema,
  resource: ResourceRefSchema,
  base_revision: BaseRevisionSchema,
  target_revision: TargetRevisionSchema,
  candidate_digest: HashIdSchema,
  resolution_identity: HashIdSchema,
  dependency_digest: HashIdSchema,
  issued_at: TimestampSchema,
  expires_at: TimestampSchema,
  items: z.array(ReceiptItemSchema),
  optional_exclusions: z.array(ItemRefSchema),
});
const TrustedOperationV2Schema = z.strictObject({
  caller_key: IdTextSchema,
  resource: ResourceRefSchema,
  target_revision: TargetRevisionSchema,
  candidate_digest: HashIdSchema,
  resolution_identity: HashIdSchema,
  dependency_digest: HashIdSchema,
  receipt_id: IdTextSchema.nullable(),
  status: z.enum(['committed', 'unknown']),
}).superRefine((operation, ctx) => {
  if (operation.status === 'committed' && operation.receipt_id === null) {
    ctx.addIssue({ code: 'custom', path: ['receipt_id'], message: 'OPERATION_RECEIPT_REQUIRED' });
  }
});
/** A lookup only counts when the port asserts it was complete and exact. */
const OperationLookupV2Schema = z.strictObject({
  complete: z.literal(true),
  operation: z.unknown().refine(value => value !== undefined),
});
const ReceiptConsumptionSchema = z.strictObject({
  complete: z.literal(true),
  consumed: z.boolean(),
});
const TrustedApplicationStateSchema = z.strictObject({
  status: z.enum(['pending', 'applied', 'failed']),
  applied_revision: BaseRevisionSchema.nullable(),
  resolution_identity: HashIdSchema.nullable(),
});
/** One same-view read: B2C inputs plus the previous application and the audit actor. */
const ApplicationContextSchema = z.strictObject({
  resource: z.unknown().refine(value => value !== undefined),
  group: z.unknown().refine(value => value !== undefined),
  capabilities: z.unknown().refine(value => value !== undefined),
  at: z.unknown().refine(value => value !== undefined),
  actor_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  application: TrustedApplicationStateSchema.nullable(),
});

type TrialReceipt = z.infer<typeof TrialReceiptSchema>;
type TrialReceiptV2 = z.infer<typeof TrialReceiptV2Schema>;
/** Normalized explicitly: nullable schema fields stay `null`, never `undefined`. */
interface TrustedApplicationContext {
  resource: unknown;
  group: unknown;
  capabilities: unknown;
  at: unknown;
  actor_id: number;
  application: TrustedApplicationState | null;
}

/** The candidate-identity format version; changing the covered fields requires a new value. */
export const BINDING_CANDIDATE_DIGEST_FORMAT = 'max238.binding-candidate.v1';

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sameResource = (left: ResourceRef, right: ResourceRef): boolean =>
  left.type === right.type && left.id === right.id;
const itemKey = (item: BindingItemRef): string =>
  `${item.template_id}\u0000${item.item_id}\u0000${item.item_version}`;
const compareItem = (left: BindingItemRef, right: BindingItemRef): number =>
  compare(left.template_id, right.template_id)
  || compare(left.item_id, right.item_id)
  || left.item_version - right.item_version;
const copyResource = (resource: ResourceRef): ResourceRef => ({ type: resource.type, id: resource.id });

/**
 * The exact candidate identity a trial receipt is bound to. It covers the
 * resource, base/target revision, fixed pins and hashes, selected items,
 * collector/mapping, the complete binding (`package`/`group_id`/`overrides`) and
 * the B2A unresolved sources, plus the trusted server-side dependency digest.
 *
 * Only true sets (object keys, and the arrays B2A/the schemas already order
 * canonically) are sorted by `stable`; ordered arrays such as mapping steps keep
 * their order. The digest identifies a candidate; it is not a resolved plan.
 */
export function bindingCandidateDigest(
  candidate: BindingTemplateCandidate,
  targetRevision: number,
  dependencyDigest: HashId,
): HashId {
  const identity = {
    format: BINDING_CANDIDATE_DIGEST_FORMAT,
    resource: copyResource(candidate.binding.resource),
    base_revision: candidate.binding.revision,
    target_revision: targetRevision,
    package: candidate.binding.package,
    group_id: candidate.binding.group_id,
    overrides: candidate.binding.overrides,
    template_pins: candidate.binding.template_pins,
    pin_sources: candidate.pins.map(entry => ({
      pin: entry.pin,
      parameters: entry.unresolved.parameters,
      trigger_refs: entry.unresolved.trigger_refs,
      source_chain: entry.unresolved.source_chain,
    })),
    collectors: candidate.collectors.map(entry => ({
      release: entry.release,
      collector_id: entry.collector_id,
      implementation_id: entry.implementation_id,
      method: entry.method,
      mappings: entry.mappings,
      items: entry.items.map(item => ({
        pin: item.pin,
        template_id: item.template_id,
        item_id: item.item_id,
        item_version: item.item_version,
        canonical_metric: item.canonical_metric,
        unit: item.unit,
        dimensions: item.dimensions,
        release: item.release,
        collector_id: item.collector_id,
        implementation_id: item.implementation_id,
        method: item.method,
      })),
    })),
    dependency_digest: dependencyDigest,
  };
  return `sha256:${createHash('sha256').update(stable(identity)).digest('hex')}`;
}

/** The internal operation key: resource + target revision + candidate digest. */
export const bindingOperationKey = (
  resource: ResourceRef,
  targetRevision: number,
  candidateDigest: HashId,
): string => `${resource.type}:${resource.id}#${targetRevision}@${candidateDigest}`;

async function readAuthorization(
  port: BindingTransactionReads,
  resource: ResourceRef,
): Promise<TrustedAuthorization> {
  if (typeof port?.authorize !== 'function') throw new BindingTransactionError('TRANSACTION_AUTH_UNAVAILABLE');
  let raw: unknown;
  try {
    raw = await port.authorize(resource);
  } catch {
    // A revoked/throwing grant port must never default to success.
    throw new BindingTransactionError('TRANSACTION_AUTH_UNAVAILABLE');
  }
  const parsed = TrustedAuthorizationSchema.safeParse(raw);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_AUTH_UNAVAILABLE');
  return parsed.data;
}

async function readCurrentBinding(port: BindingTransactionReads, resource: ResourceRef): Promise<unknown> {
  if (typeof port?.currentBinding !== 'function') throw new BindingTransactionError('TRANSACTION_BINDING_UNAVAILABLE');
  try {
    return await port.currentBinding(resource);
  } catch {
    throw new BindingTransactionError('TRANSACTION_BINDING_UNAVAILABLE');
  }
}

function parseCurrentBinding(raw: unknown, resource: ResourceRef): ResourceBindingCandidate {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BindingTransactionError('TRANSACTION_BINDING_INVALID');
  }
  const source = raw as Record<string, unknown>;
  // Old payloads may omit `template_pins`; an explicit empty array means the same
  // legacy single-package branch. Everything else is passed through untouched.
  const parsed = ResourceBindingCandidateSchema.safeParse({ ...source, template_pins: source.template_pins ?? [] });
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_BINDING_INVALID');
  if (!sameResource(parsed.data.resource, resource)) throw new BindingTransactionError('TRANSACTION_BINDING_IDENTITY');
  return parsed.data;
}

async function readOperation(
  port: BindingTransactionPort,
  callerKey: string,
): Promise<TrustedBindingOperation | null> {
  if (typeof port?.findOperation !== 'function') throw new BindingTransactionError('TRANSACTION_OPERATION_UNAVAILABLE');
  let raw: unknown;
  try {
    raw = await port.findOperation(callerKey);
  } catch {
    throw new BindingTransactionError('TRANSACTION_OPERATION_UNAVAILABLE');
  }
  if (raw === null || raw === undefined) return null;
  const parsed = TrustedOperationSchema.safeParse(raw);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_OPERATION_INVALID');
  return {
    caller_key: parsed.data.caller_key,
    resource: parsed.data.resource,
    target_revision: parsed.data.target_revision,
    candidate_digest: parsed.data.candidate_digest,
    status: parsed.data.status,
    receipt_id: parsed.data.receipt_id ?? null,
  };
}

async function readReceiptRaw(port: BindingTransactionReads, receiptId: string): Promise<unknown> {
  if (typeof port?.getTrialReceipt !== 'function') throw new BindingTransactionError('TRANSACTION_RECEIPT_UNAVAILABLE');
  let raw: unknown;
  try {
    raw = await port.getTrialReceipt(receiptId);
  } catch {
    throw new BindingTransactionError('TRANSACTION_RECEIPT_UNAVAILABLE');
  }
  if (raw === null || raw === undefined) throw new BindingTransactionError('TRANSACTION_RECEIPT_NOT_FOUND');
  return raw;
}

async function readReceipt(port: BindingTransactionReads, receiptId: string): Promise<TrialReceipt> {
  const raw = await readReceiptRaw(port, receiptId);
  const parsed = TrialReceiptSchema.safeParse(raw);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_RECEIPT_INVALID');
  return parsed.data;
}

async function readReceiptV2(port: BindingTransactionReads, receiptId: string): Promise<TrialReceiptV2> {
  const raw = await readReceiptRaw(port, receiptId);
  const parsed = TrialReceiptV2Schema.safeParse(raw);
  // A v1 receipt (no `receipt_version`) is invalid here, never silently upgraded.
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_RECEIPT_INVALID');
  return parsed.data;
}

/**
 * The trusted mandatory list. Its absence means every selected item is
 * mandatory; a request can never supply or relax it. Each entry must name a
 * selected item, so a mandatory list cannot cover items this candidate dropped.
 */
async function readMandatory(
  port: BindingTransactionReads,
  resource: ResourceRef,
  selected: Map<string, BindingItemRef>,
): Promise<Set<string>> {
  if (typeof port?.mandatoryItems !== 'function') return new Set(selected.keys());
  let raw: unknown;
  try {
    raw = await port.mandatoryItems(resource);
  } catch {
    throw new BindingTransactionError('TRANSACTION_MANDATORY_UNAVAILABLE');
  }
  const parsed = MandatoryItemsSchema.safeParse(raw);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_MANDATORY_INVALID');
  const mandatory = new Set<string>();
  for (const item of parsed.data) {
    const key = itemKey(item);
    if (!selected.has(key) || mandatory.has(key)) {
      throw new BindingTransactionError('TRANSACTION_MANDATORY_INVALID', [item]);
    }
    mandatory.add(key);
  }
  return mandatory;
}

const isThenable = (value: unknown): boolean =>
  (typeof value === 'object' || typeof value === 'function') && value !== null
  && typeof (value as { then?: unknown }).then === 'function';

/**
 * Trusted current time. The read is synchronous on purpose: the receipt expiry
 * check runs after the last asynchronous authorization with no further await, so
 * no clock movement can slip into the decision. A missing/throwing port, a
 * promise/thenable or an unparseable timestamp is unavailable time — never
 * `Date.now()` and never a client-supplied value.
 */
function readServerNow(port: BindingTransactionReads): { at: string; ms: number } {
  if (typeof port?.serverNow !== 'function') throw new BindingTransactionError('TRANSACTION_TIME_UNAVAILABLE');
  let raw: unknown;
  try {
    raw = port.serverNow();
  } catch {
    throw new BindingTransactionError('TRANSACTION_TIME_UNAVAILABLE');
  }
  if (isThenable(raw)) throw new BindingTransactionError('TRANSACTION_TIME_UNAVAILABLE');
  const parsed = TimestampSchema.safeParse(raw);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_TIME_UNAVAILABLE');
  const ms = Date.parse(parsed.data);
  if (!Number.isFinite(ms)) throw new BindingTransactionError('TRANSACTION_TIME_UNAVAILABLE');
  // Keep the trusted instance text for audit; the millisecond value drives expiry.
  return { at: parsed.data, ms };
}

function assertAuthorized(auth: TrustedAuthorization): void {
  if (!auth.allowed) throw new BindingTransactionError('TRANSACTION_FORBIDDEN');
  if (auth.cancelled) throw new BindingTransactionError('TRANSACTION_CANCELLED');
}

/**
 * The final trusted boundary every successful outcome shares (legacy, replay,
 * lookup and prepared): still allowed, not cancelled and no configuration
 * dependency changed during this call. Keeping it in one helper prevents a
 * branch from checking only part of the rule.
 */
function assertFinalAuthorization(before: TrustedAuthorization, after: TrustedAuthorization): void {
  assertAuthorized(after);
  if (after.dependency_digest !== before.dependency_digest) {
    throw new BindingTransactionError('TRANSACTION_DEPENDENCY_CHANGED');
  }
}

function selectedItems(candidate: BindingTemplateCandidate): Map<string, BindingItemRef> {
  const selected = new Map<string, BindingItemRef>();
  for (const collector of candidate.collectors) {
    for (const item of collector.items) {
      const ref: BindingItemRef = {
        template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
      };
      selected.set(itemKey(ref), ref);
    }
  }
  return selected;
}

function verifyReceiptIdentity(
  receipt: TrialReceipt | TrialReceiptV2,
  expected: {
    receiptId: string; resource: ResourceRef; base: number; target: number;
    digest: HashId; dependencyDigest: HashId;
    /** Present only on the v2 entry; the resolution identity is compared as its own fact. */
    resolutionIdentity?: HashId;
  },
): void {
  if (receipt.receipt_id !== expected.receiptId
    || !sameResource(receipt.resource, expected.resource)
    || receipt.base_revision !== expected.base
    || receipt.target_revision !== expected.target
    || receipt.candidate_digest !== expected.digest
    || receipt.dependency_digest !== expected.dependencyDigest) {
    throw new BindingTransactionError('TRANSACTION_RECEIPT_MISMATCH');
  }
  if (expected.resolutionIdentity !== undefined
    && (!('resolution_identity' in receipt) || receipt.resolution_identity !== expected.resolutionIdentity)) {
    throw new BindingTransactionError('TRANSACTION_RECEIPT_MISMATCH');
  }
}

function verifyReceiptTime(receipt: TrialReceipt | TrialReceiptV2, now: number): void {
  const issued = Date.parse(receipt.issued_at);
  const expires = Date.parse(receipt.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || issued > now) {
    throw new BindingTransactionError('TRANSACTION_RECEIPT_TIME_INVALID');
  }
  if (now >= expires) throw new BindingTransactionError('TRANSACTION_RECEIPT_EXPIRED');
}

/**
 * Exact per-item coverage of this candidate. Every selected item must either be
 * qualified with every read/transform/unit phase, or be an explicitly excluded
 * non-mandatory item; the receipt cannot add foreign items, repeat an item or
 * drop a mandatory one. "Some other item had a good value" never qualifies.
 */
function verifyReceiptItems(
  receipt: TrialReceipt | TrialReceiptV2,
  selected: Map<string, BindingItemRef>,
  mandatory: Set<string>,
): void {
  const problems = new Map<string, BindingItemRef>();
  const flag = (item: BindingItemRef): void => { problems.set(itemKey(item), item); };

  const qualified = new Set<string>();
  for (const item of receipt.items) {
    const key = itemKey(item);
    const known = selected.get(key);
    if (known === undefined) {
      flag({ template_id: item.template_id, item_id: item.item_id, item_version: item.item_version });
      continue;
    }
    if (qualified.has(key) || !item.phases.read || !item.phases.transform || !item.phases.unit) {
      flag(known);
      continue;
    }
    qualified.add(key);
  }

  const excluded = new Set<string>();
  for (const item of receipt.optional_exclusions) {
    const key = itemKey(item);
    const known = selected.get(key);
    if (known === undefined || excluded.has(key) || mandatory.has(key) || qualified.has(key)) {
      flag(known ?? item);
      continue;
    }
    excluded.add(key);
  }

  for (const [key, item] of selected) {
    if (!qualified.has(key) && (mandatory.has(key) || !excluded.has(key))) flag(item);
  }

  if (problems.size > 0) {
    throw new BindingTransactionError(
      'TRANSACTION_RECEIPT_ITEMS_INVALID',
      [...problems.values()].sort(compareItem),
    );
  }
}

const itemRefOf = (item: { template_id: string; item_id: string; item_version: number }): BindingItemRef => ({
  template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
});

/**
 * The trusted enable-time gate, run inside the synchronous decision segment after
 * {@link readServerNow}. B2C resolves capabilities at `applicationContext.at`, so a
 * receipt that was valid then says nothing about the providers at the decision
 * time: a capability can expire between the context read and the final clock, and
 * a future `at` can admit evidence that does not exist yet (including inventory
 * observed after the trusted now). `at` must therefore not be ahead of the trusted
 * clock, and every capability the enable plan actually uses must satisfy
 * `evaluated_at <= now < valid_until`. Disabled/excluded items never enter a plan
 * step, so they add no new permission conclusion here.
 */
function assertEnableTime(
  application: TrustedApplicationContext,
  plan: TemplateCollectionPlan,
  now: number,
): void {
  const at = TimestampSchema.safeParse(application.at);
  if (!at.success || Date.parse(at.data) > now) {
    throw new BindingTransactionError('TRANSACTION_CONTEXT_TIME_INVALID');
  }
  const invalid: BindingItemRef[] = [];
  for (const release of plan.releases) {
    for (const step of release.steps) {
      for (const item of step.items) {
        const evaluated = Date.parse(item.capability.evaluated_at);
        const validUntil = Date.parse(item.capability.valid_until);
        // A validity window ending exactly at `now` is already closed.
        if (!(evaluated <= now) || !(now < validUntil)) invalid.push(itemRefOf(item));
      }
    }
  }
  if (invalid.length > 0) {
    throw new BindingTransactionError('TRANSACTION_CAPABILITY_TIME_INVALID', invalid.sort(compareItem));
  }
}

/**
 * Decide whether the current candidate may enter a pending application
 * transaction. Contract and behavior:
 *
 * - B1/B2A always run first through {@link compileBindingCandidate}; their
 *   stable rejections propagate and no partial decision exists.
 * - A legacy candidate is still checked for resource identity and for the final
 *   authorization/dependency boundary after all asynchronous work, then returned
 *   as `legacy_delegate` untouched: no digest, current, operation, receipt or
 *   write — the existing single-package flow keeps owning it.
 * - The trusted view is the only source of the current revision and of every
 *   receipt fact; the request may name a receipt id but never its contents.
 * - Authorization is read before candidate/receipt reads and again after all
 *   asynchronous work for every outcome; a revoked grant, cancellation or
 *   changed dependency identity rejects before any decision is formed.
 * - The trusted clock is read synchronously after that last authorization, so
 *   the receipt is checked against current trusted time with no further await.
 * - An already committed exact operation replays its receipt without a new
 *   revision, even when the trusted current revision already equals the target;
 *   an unknown outcome only asks the caller to query the original operation.
 * - Failure leaves every input and the trusted view unchanged; the guard has no
 *   write path at all.
 */
export async function prepareTemplateBindingMutation(
  request: unknown,
  transaction: BindingTransactionPort,
  templates: TemplateVersionReadPort,
  registry: PackageRegistry,
): Promise<BindingMutationOutcome> {
  const parsedRequest = PrepareMutationRequestSchema.safeParse(request);
  if (!parsedRequest.success) throw new BindingTransactionError('TRANSACTION_INPUT_INVALID');
  const { resource, candidate, receipt_id: receiptId, caller_key: callerKey } = parsedRequest.data;

  const before = await readAuthorization(transaction, resource);
  assertAuthorized(before);

  const compiled = await compileBindingCandidate(candidate, templates, registry);
  // Resource identity covers both compiled results; a legacy delegate is a
  // binding for this exact resource and never bypasses the boundary.
  if (!sameResource(compiled.binding.resource, resource)) {
    throw new BindingTransactionError('TRANSACTION_BINDING_IDENTITY');
  }
  if (compiled.kind === 'legacy') {
    // Same final boundary as every other outcome, after the last asynchronous
    // work; still no digest, current, operation, receipt or decision.
    const after = await readAuthorization(transaction, resource);
    assertFinalAuthorization(before, after);
    return { kind: 'legacy_delegate', binding: compiled.binding, package: compiled.package };
  }

  const rawCurrent = await readCurrentBinding(transaction, resource);
  if (rawCurrent === null || rawCurrent === undefined) {
    throw new BindingTransactionError('TRANSACTION_BINDING_MISSING');
  }
  const current = parseCurrentBinding(rawCurrent, resource);

  const baseRevision = compiled.binding.revision;
  const targetRevision = baseRevision + 1;
  if (!Number.isSafeInteger(targetRevision)) throw new BindingTransactionError('TRANSACTION_REVISION_CONFLICT');
  const digest = bindingCandidateDigest(compiled, targetRevision, before.dependency_digest);
  const key = bindingOperationKey(resource, targetRevision, digest);

  const operation = await readOperation(transaction, callerKey);
  if (operation !== null) {
    const exact = operation.caller_key === callerKey
      && sameResource(operation.resource, resource)
      && operation.target_revision === targetRevision
      && operation.candidate_digest === digest;
    // Wrong resource/target/digest under the same caller key is a collision, not a replay.
    if (!exact) throw new BindingTransactionError('TRANSACTION_OPERATION_CONFLICT');

    const after = await readAuthorization(transaction, resource);
    assertFinalAuthorization(before, after);

    if (operation.status === 'unknown') {
      return {
        kind: 'operation_lookup_required', persisted: false, resource: copyResource(resource),
        candidate_digest: digest, operation: { key, caller_key: callerKey, status: 'unknown' },
      };
    }
    if (operation.receipt_id === null) throw new BindingTransactionError('TRANSACTION_OPERATION_INVALID');
    return {
      kind: 'replay', persisted: false, resource: copyResource(resource),
      base_revision: targetRevision - 1, target_revision: targetRevision, candidate_digest: digest,
      operation: { key, caller_key: callerKey, receipt_id: operation.receipt_id, status: 'committed' },
    };
  }

  // The trusted revision is the only CAS authority; an outside snapshot cannot prove it.
  if (current.revision !== baseRevision) throw new BindingTransactionError('TRANSACTION_REVISION_CONFLICT');

  const receipt = await readReceipt(transaction, receiptId);
  const selected = selectedItems(compiled);
  const mandatory = await readMandatory(transaction, resource, selected);

  // Last asynchronous read. Everything below is synchronous: trusted now,
  // receipt identity/time/items and the prepared decision.
  const after = await readAuthorization(transaction, resource);
  assertFinalAuthorization(before, after);
  const now = readServerNow(transaction);

  verifyReceiptIdentity(receipt, {
    receiptId, resource, base: baseRevision, target: targetRevision,
    digest, dependencyDigest: before.dependency_digest,
  });
  verifyReceiptTime(receipt, now.ms);
  verifyReceiptItems(receipt, selected, mandatory);

  return {
    kind: 'prepared', prepared: true, persisted: false, applied: false,
    resource: copyResource(resource), base_revision: baseRevision, target_revision: targetRevision,
    candidate_digest: digest,
    operation: { key, caller_key: callerKey, receipt_id: receiptId, status: 'pending' },
    current,
    next: { ...compiled.binding, revision: targetRevision },
  };
}

/** The trusted same-transaction inputs the explicit v2 entry needs; never request-supplied. */
interface VerifiedResolution {
  application: TrustedApplicationContext;
  resolution: ResolvedTemplateBinding;
  plan: TemplateCollectionPlan;
  identity: HashId;
}

async function readApplicationContext(
  port: BindingTransactionPortV2,
  resource: ResourceRef,
): Promise<TrustedApplicationContext> {
  if (typeof port?.applicationContext !== 'function') {
    throw new BindingTransactionError('TRANSACTION_CONTEXT_UNAVAILABLE');
  }
  let raw: unknown;
  try {
    raw = await port.applicationContext(resource);
  } catch {
    throw new BindingTransactionError('TRANSACTION_CONTEXT_UNAVAILABLE');
  }
  const parsed = ApplicationContextSchema.safeParse(raw);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_CONTEXT_INVALID');
  const application = parsed.data.application;
  return {
    resource: parsed.data.resource,
    group: parsed.data.group,
    capabilities: parsed.data.capabilities,
    at: parsed.data.at,
    actor_id: parsed.data.actor_id,
    application: application === null ? null : {
      status: application.status,
      applied_revision: application.applied_revision ?? null,
      resolution_identity: application.resolution_identity ?? null,
    },
  };
}

/**
 * The complete exact operation lookup. A bare `null`, a missing `complete`
 * assertion or a non-object envelope is "no guarantee", not "no operation";
 * the v2 entry rejects instead of inventing a fresh operation.
 */
async function readOperationV2(
  port: BindingTransactionPortV2,
  callerKey: string,
): Promise<TrustedBindingOperationV2 | null> {
  if (typeof port?.findOperationExact !== 'function') {
    throw new BindingTransactionError('TRANSACTION_OPERATION_UNAVAILABLE');
  }
  let raw: unknown;
  try {
    raw = await port.findOperationExact(callerKey);
  } catch {
    throw new BindingTransactionError('TRANSACTION_OPERATION_UNAVAILABLE');
  }
  const envelope = OperationLookupV2Schema.safeParse(raw);
  if (!envelope.success) throw new BindingTransactionError('TRANSACTION_OPERATION_UNAVAILABLE');
  if (envelope.data.operation === null) return null;
  const parsed = TrustedOperationV2Schema.safeParse(envelope.data.operation);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_OPERATION_INVALID');
  return {
    caller_key: parsed.data.caller_key,
    resource: parsed.data.resource,
    target_revision: parsed.data.target_revision,
    candidate_digest: parsed.data.candidate_digest,
    resolution_identity: parsed.data.resolution_identity,
    dependency_digest: parsed.data.dependency_digest,
    receipt_id: parsed.data.receipt_id ?? null,
    status: parsed.data.status,
  };
}

/** Receipt single-use, proven by a complete exact lookup rather than an audit window. */
async function readReceiptConsumption(
  port: BindingTransactionPortV2,
  receiptId: string,
): Promise<boolean> {
  if (typeof port?.findReceiptConsumption !== 'function') {
    throw new BindingTransactionError('TRANSACTION_RECEIPT_UNAVAILABLE');
  }
  let raw: unknown;
  try {
    raw = await port.findReceiptConsumption(receiptId);
  } catch {
    throw new BindingTransactionError('TRANSACTION_RECEIPT_UNAVAILABLE');
  }
  const parsed = ReceiptConsumptionSchema.safeParse(raw);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_RECEIPT_UNAVAILABLE');
  return parsed.data.consumed;
}

/**
 * Re-walk the accepted B2C resolution and plan from the raw candidate inside the
 * same transaction, and enforce that an enable can only be staged for an
 * executable, unblocked plan. B2C/B1/B2A rejections propagate unchanged: they
 * already carry a stable code and a structured location, never a driver text.
 */
async function verifyTemplateResolution(
  compiled: BindingTemplateCandidate,
  baseRevision: number,
  resource: ResourceRef,
  transaction: BindingTransactionPortV2,
  templates: TemplateVersionReadPort,
  registry: PackageRegistry,
): Promise<VerifiedResolution> {
  const application = await readApplicationContext(transaction, resource);
  const resolution = await resolveTemplateBinding(compiled.binding, {
    resource: application.resource,
    group: application.group,
    capabilities: application.capabilities,
    at: application.at,
  }, templates, registry);
  if (resolution.kind !== 'template_resolution') {
    throw new BindingTransactionError('TRANSACTION_RESOLUTION_INVALID');
  }
  if (resolution.revision !== baseRevision
    || resolution.resource.type !== resource.type
    || resolution.resource.id !== String(resource.id)
    || stable(resolution.binding) !== stable(compiled.binding)) {
    throw new BindingTransactionError('TRANSACTION_RESOLUTION_INVALID');
  }

  const plan = buildTemplateCollectionPlan(resolution);
  const identity = templateResolutionIdentity(resolution);
  // The plan's own identity must be the resolution identity; a drift is a defect.
  if (plan.identity !== identity) throw new BindingTransactionError('TRANSACTION_RESOLUTION_INVALID');

  if (!resolution.settings.enabled) throw new BindingTransactionError('TRANSACTION_RESOLUTION_DISABLED');
  const blocking = resolution.excluded
    .filter(entry => entry.blocking)
    .map(entry => ({ template_id: entry.template_id, item_id: entry.item_id, item_version: entry.item_version }))
    .sort(compareItem);
  if (blocking.length > 0) throw new BindingTransactionError('TRANSACTION_RESOLUTION_BLOCKED', blocking);
  if (!plan.executable || !plan.releases.some(entry => entry.steps.length > 0)) {
    throw new BindingTransactionError('TRANSACTION_RESOLUTION_EMPTY');
  }

  return { application, resolution, plan, identity };
}

/**
 * Decide whether a template binding may enter an enable transaction, binding a
 * **v2** receipt to the candidate, the resolved plan identity and the trusted
 * dependency digest. This is the explicit protocol the atomic adapter uses; the
 * v1 entry above keeps its own contract.
 *
 * Contract and behavior:
 * - The request carries only the raw candidate, resource, caller key and receipt
 *   id; every trusted fact (current binding, application context, authorization,
 *   operation, receipt, mandatory items, clock) comes from the transaction view.
 * - B1/B2A run first; a legacy candidate is delegated untouched with the shared
 *   final boundary and no receipt/resolution/write decision.
 * - Every template path re-runs `resolveTemplateBinding` and
 *   `buildTemplateCollectionPlan`; the receipt must bind all three identities.
 * - An existing operation is an exact replay only when caller key, resource,
 *   target, candidate digest, resolution identity, dependency digest and receipt
 *   all agree; otherwise it is a collision. Unknown operations are only looked up.
 *   A committed operation still needs a reproducible resolution identity: if the
 *   current B2C blocks or drifts, it is a stable rejection, never a synthetic replay.
 * - A non-executable resolution (disabled, blocking unsupported/unknown item or
 *   empty plan) is never staged for enable, and receipt single use is proven by a
 *   complete exact lookup.
 * - A new prepared decision also needs the trusted context time not to be in the
 *   future and every capability the plan actually uses to satisfy
 *   `evaluated_at <= trusted now < valid_until`; a valid receipt never substitutes
 *   for that.
 * - The v1 final boundary — last async authorization, then synchronous trusted
 *   clock, then the decision with no further await — is preserved here.
 */
export async function prepareTemplateBindingMutationV2(
  request: unknown,
  transaction: BindingTransactionPortV2,
  templates: TemplateVersionReadPort,
  registry: PackageRegistry,
): Promise<TemplateBindingMutationOutcome> {
  const parsedRequest = PrepareMutationRequestSchema.safeParse(request);
  if (!parsedRequest.success) throw new BindingTransactionError('TRANSACTION_INPUT_INVALID');
  const { resource, candidate, receipt_id: receiptId, caller_key: callerKey } = parsedRequest.data;

  const before = await readAuthorization(transaction, resource);
  assertAuthorized(before);

  const compiled = await compileBindingCandidate(candidate, templates, registry);
  if (!sameResource(compiled.binding.resource, resource)) {
    throw new BindingTransactionError('TRANSACTION_BINDING_IDENTITY');
  }
  if (compiled.kind === 'legacy') {
    const after = await readAuthorization(transaction, resource);
    assertFinalAuthorization(before, after);
    return { kind: 'legacy_delegate', binding: compiled.binding, package: compiled.package };
  }

  // The base revision comes from the candidate, so an absent row can be read as
  // "unbound": only a candidate that names base 0 may create the first binding.
  // Any other base with no stored row is a stale or wrong resource, not a create.
  const baseRevision = compiled.binding.revision;
  const rawCurrent = await readCurrentBinding(transaction, resource);
  let current: ResourceBindingCandidate | null;
  if (rawCurrent === null || rawCurrent === undefined) {
    if (baseRevision !== 0) throw new BindingTransactionError('TRANSACTION_BINDING_MISSING');
    current = null;
  } else {
    current = parseCurrentBinding(rawCurrent, resource);
  }

  const targetRevision = baseRevision + 1;
  if (!Number.isSafeInteger(targetRevision)) throw new BindingTransactionError('TRANSACTION_REVISION_CONFLICT');
  const digest = bindingCandidateDigest(compiled, targetRevision, before.dependency_digest);
  const key = bindingOperationKey(resource, targetRevision, digest);

  const operation = await readOperationV2(transaction, callerKey);
  if (operation !== null) {
    // Everything except the resolution identity is comparable before the B2C
    // re-run; a mismatch there is a collision and never a resend.
    const identityFree = operation.caller_key === callerKey
      && sameResource(operation.resource, resource)
      && operation.target_revision === targetRevision
      && operation.candidate_digest === digest
      && operation.dependency_digest === before.dependency_digest
      && (operation.receipt_id === null || operation.receipt_id === receiptId);
    if (!identityFree) throw new BindingTransactionError('TRANSACTION_OPERATION_CONFLICT');

    const verified = await verifyTemplateResolution(
      compiled, baseRevision, resource, transaction, templates, registry,
    );
    if (operation.resolution_identity !== verified.identity) {
      throw new BindingTransactionError('TRANSACTION_OPERATION_CONFLICT');
    }

    const after = await readAuthorization(transaction, resource);
    assertFinalAuthorization(before, after);

    if (operation.status === 'unknown') {
      return {
        kind: 'operation_lookup_required', persisted: false, resource: copyResource(resource),
        candidate_digest: digest, operation: { key, caller_key: callerKey, status: 'unknown' },
      };
    }
    if (operation.receipt_id === null) throw new BindingTransactionError('TRANSACTION_OPERATION_INVALID');
    return {
      kind: 'replay', persisted: false, resource: copyResource(resource),
      base_revision: targetRevision - 1, target_revision: targetRevision, candidate_digest: digest,
      operation: { key, caller_key: callerKey, receipt_id: operation.receipt_id, status: 'committed' },
    };
  }

  // The trusted revision is the only CAS authority; an outside snapshot cannot
  // prove it. A missing row proves base 0 (checked above) and nothing else.
  if ((current?.revision ?? 0) !== baseRevision) throw new BindingTransactionError('TRANSACTION_REVISION_CONFLICT');

  const verified = await verifyTemplateResolution(
    compiled, baseRevision, resource, transaction, templates, registry,
  );
  const receipt = await readReceiptV2(transaction, receiptId);
  const selected = selectedItems(compiled);
  const mandatory = await readMandatory(transaction, resource, selected);
  if (await readReceiptConsumption(transaction, receiptId)) {
    throw new BindingTransactionError('TRANSACTION_RECEIPT_CONSUMED');
  }

  // Last asynchronous read. Everything below is synchronous: trusted now,
  // receipt identity/time/items and the prepared decision.
  const after = await readAuthorization(transaction, resource);
  assertFinalAuthorization(before, after);
  const now = readServerNow(transaction);

  verifyReceiptIdentity(receipt, {
    receiptId, resource, base: baseRevision, target: targetRevision,
    digest, dependencyDigest: before.dependency_digest,
    resolutionIdentity: verified.identity,
  });
  verifyReceiptTime(receipt, now.ms);
  verifyReceiptItems(receipt, selected, mandatory);
  // Still synchronous and still before a decision exists: a valid receipt proves
  // the trial happened, not that the capabilities it relied on still hold now.
  assertEnableTime(verified.application, verified.plan, now.ms);

  return {
    kind: 'prepared', prepared: true, persisted: false, applied: false,
    protocol: 'max238.template-binding.v2', receipt_version: 2,
    resource: copyResource(resource), base_revision: baseRevision, target_revision: targetRevision,
    candidate_digest: digest, dependency_digest: before.dependency_digest,
    resolution_identity: verified.identity, resolution: verified.resolution, plan: verified.plan,
    previous_application: verified.application.application, actor_id: verified.application.actor_id,
    decided_at: now.at, receipt_expires_at: receipt.expires_at,
    operation: { key, caller_key: callerKey, receipt_id: receiptId, status: 'pending' },
    current,
    next: { ...compiled.binding, revision: targetRevision },
  };
}
