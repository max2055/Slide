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
  | 'TRANSACTION_MANDATORY_INVALID';

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
 * The trusted transaction view. Every method reads server-side state; none
 * writes. `mandatoryItems` may be absent, which means "every selected item is
 * mandatory" until mandatory semantics are resolved (a later package).
 */
export interface BindingTransactionPort {
  authorize(resource: ResourceRef): Promise<unknown>;
  currentBinding(resource: ResourceRef): Promise<unknown>;
  findOperation(callerKey: string): Promise<unknown>;
  getTrialReceipt(receiptId: string): Promise<unknown>;
  mandatoryItems?(resource: ResourceRef): Promise<unknown>;
  serverNow(): Promise<unknown>;
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
  /** Exact trusted base read inside the view; never a caller snapshot. */
  current: ResourceBindingCandidate;
  /** Exact binding to save in the same transaction; unresolved, not an execution plan. */
  next: ResourceBindingCandidate;
}

export type BindingMutationOutcome =
  | LegacyBindingDelegate | ReplayedBindingMutation | BindingOperationLookup | PreparedBindingMutation;

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

type TrialReceipt = z.infer<typeof TrialReceiptSchema>;

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
  port: BindingTransactionPort,
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

async function readCurrentBinding(port: BindingTransactionPort, resource: ResourceRef): Promise<unknown> {
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

async function readReceipt(port: BindingTransactionPort, receiptId: string): Promise<TrialReceipt> {
  if (typeof port?.getTrialReceipt !== 'function') throw new BindingTransactionError('TRANSACTION_RECEIPT_UNAVAILABLE');
  let raw: unknown;
  try {
    raw = await port.getTrialReceipt(receiptId);
  } catch {
    throw new BindingTransactionError('TRANSACTION_RECEIPT_UNAVAILABLE');
  }
  if (raw === null || raw === undefined) throw new BindingTransactionError('TRANSACTION_RECEIPT_NOT_FOUND');
  const parsed = TrialReceiptSchema.safeParse(raw);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_RECEIPT_INVALID');
  return parsed.data;
}

/**
 * The trusted mandatory list. Its absence means every selected item is
 * mandatory; a request can never supply or relax it. Each entry must name a
 * selected item, so a mandatory list cannot cover items this candidate dropped.
 */
async function readMandatory(
  port: BindingTransactionPort,
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

async function readServerNow(port: BindingTransactionPort): Promise<number> {
  if (typeof port?.serverNow !== 'function') throw new BindingTransactionError('TRANSACTION_TIME_UNAVAILABLE');
  let raw: unknown;
  try {
    raw = await port.serverNow();
  } catch {
    throw new BindingTransactionError('TRANSACTION_TIME_UNAVAILABLE');
  }
  const parsed = TimestampSchema.safeParse(raw);
  if (!parsed.success) throw new BindingTransactionError('TRANSACTION_TIME_UNAVAILABLE');
  const now = Date.parse(parsed.data);
  if (!Number.isFinite(now)) throw new BindingTransactionError('TRANSACTION_TIME_UNAVAILABLE');
  return now;
}

function assertAuthorized(auth: TrustedAuthorization): void {
  if (!auth.allowed) throw new BindingTransactionError('TRANSACTION_FORBIDDEN');
  if (auth.cancelled) throw new BindingTransactionError('TRANSACTION_CANCELLED');
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
  receipt: TrialReceipt,
  expected: {
    receiptId: string; resource: ResourceRef; base: number; target: number;
    digest: HashId; dependencyDigest: HashId;
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
}

function verifyReceiptTime(receipt: TrialReceipt, now: number): void {
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
  receipt: TrialReceipt,
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

/**
 * Decide whether the current candidate may enter a pending application
 * transaction. Contract and behavior:
 *
 * - B1/B2A always run first through {@link compileBindingCandidate}; their
 *   stable rejections propagate and no partial decision exists.
 * - A legacy candidate returns `legacy_delegate` untouched: no digest, receipt,
 *   operation lookup or write — the existing single-package flow keeps owning it.
 * - The trusted view is the only source of the current revision and of every
 *   receipt fact; the request may name a receipt id but never its contents.
 * - Authorization is read before candidate/receipt reads and again after all
 *   asynchronous work; a revoked grant, cancellation or changed dependency
 *   identity rejects before any decision is formed.
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
  if (compiled.kind === 'legacy') {
    return { kind: 'legacy_delegate', binding: compiled.binding, package: compiled.package };
  }
  if (!sameResource(compiled.binding.resource, resource)) {
    throw new BindingTransactionError('TRANSACTION_BINDING_IDENTITY');
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
    assertAuthorized(after);

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
  const now = await readServerNow(transaction);

  const after = await readAuthorization(transaction, resource);
  assertAuthorized(after);
  if (after.dependency_digest !== before.dependency_digest) {
    throw new BindingTransactionError('TRANSACTION_DEPENDENCY_CHANGED');
  }

  verifyReceiptIdentity(receipt, {
    receiptId, resource, base: baseRevision, target: targetRevision,
    digest, dependencyDigest: before.dependency_digest,
  });
  verifyReceiptTime(receipt, now);
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
