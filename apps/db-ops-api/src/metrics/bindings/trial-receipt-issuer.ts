/**
 * MAX-238 / B2G — offline v2 trial-receipt compiler.
 *
 * It turns one raw binding candidate plus injected trusted inputs into the exact
 * private `TrialReceiptV2` shape the accepted B2E host reads back by
 * `SELECT payload FROM metric_policy_trial_receipts WHERE receipt_id = ? LIMIT 2`
 * and the B2D guard accepts. It compiles only: no connection, no insert, no
 * policy lock, no application and no collection I/O (see
 * `docs/slide/development/MAX-238/b2g-trial-receipt-issuer.md`).
 *
 * The three identities are never invented here: `candidate_digest` is
 * {@link bindingCandidateDigest}, `resolution_identity` is
 * {@link templateResolutionIdentity}, and `dependency_digest` is a trusted input.
 * The request may name only a receipt id; any receipt body, item list, digest or
 * resolution identity in the request is a strict-schema rejection with zero write.
 */
import { z } from 'zod';
import {
  HashIdSchema, ItemIdSchema, ResourceRefSchema, TemplateIdSchema, VersionNumberSchema,
  type HashId,
} from '../../contracts/metrics/templates.js';
import { TimestampSchema } from '../../contracts/metrics/definitions.js';
import { stable, type PackageRegistry } from '../packages/model.js';
import { compileBindingCandidate, type BindingTemplateCandidate } from './compile.js';
import {
  resolveTemplateBinding, templateResolutionIdentity, type TemplateResolutionContext,
} from './resolve.js';
import type { TemplateVersionReadPort } from './preflight.js';
import { bindingCandidateDigest } from './transaction-guard.js';

export type ResourceRef = z.infer<typeof ResourceRefSchema>;

/** Stable machine code for every issuer rejection; `message` equals the code. */
export type TrialReceiptIssueErrorCode =
  | 'TRIAL_RECEIPT_INPUT_INVALID'
  | 'TRIAL_TRUSTED_INPUT_INVALID'
  | 'TRIAL_BINDING_IDENTITY'
  | 'TRIAL_RECEIPT_TEMPLATE_REQUIRED'
  | 'TRIAL_RESOLUTION_INVALID'
  | 'TRIAL_REVISION_INVALID'
  | 'TRIAL_EVIDENCE_UNAVAILABLE'
  | 'TRIAL_EVIDENCE_INVALID'
  | 'TRIAL_EVIDENCE_INCOMPLETE'
  | 'TRIAL_EVIDENCE_WITHDRAWN'
  | 'TRIAL_ITEM_UNQUALIFIED'
  | 'TRIAL_TIME_UNAVAILABLE';

/** Only structured item identities travel with an item rejection; never evidence or a message. */
export interface TrialItemRef {
  template_id: string;
  item_id: string;
  item_version: number;
}

export class TrialReceiptIssueError extends Error {
  constructor(
    public readonly code: TrialReceiptIssueErrorCode,
    public readonly items: readonly TrialItemRef[] = [],
  ) {
    super(code);
    this.name = 'TrialReceiptIssueError';
  }
}

/** One selected item with its explicit per-phase trial evidence. */
export interface TrialReceiptItem extends TrialItemRef {
  phases: { read: boolean; transform: boolean; unit: boolean };
}

/**
 * The private v2 receipt body. Field-for-field the guard's `TrialReceiptV2Schema`;
 * the fixture proves that by reading the stored row through the guard, never by
 * re-declaring the schema here.
 */
export interface TrialReceiptV2Payload {
  receipt_version: 2;
  receipt_id: string;
  resource: ResourceRef;
  base_revision: number;
  target_revision: number;
  candidate_digest: HashId;
  resolution_identity: HashId;
  dependency_digest: HashId;
  issued_at: string;
  expires_at: string;
  items: TrialReceiptItem[];
  optional_exclusions: TrialItemRef[];
}

/** What the writer accepts: the two columns the host reads, and nothing else. */
export interface IssuedTrialReceipt {
  readonly receipt_id: string;
  readonly payload: TrialReceiptV2Payload;
}

/**
 * The injected offline evidence port. It answers per selected item server-side;
 * the request body never supplies a phase. A missing port is a stable
 * `TRIAL_EVIDENCE_UNAVAILABLE`, never a default or an empty pass.
 */
export interface TrialEvidenceReadPort {
  read(resource: ResourceRef): Promise<unknown>;
}

export interface TrialReceiptIssuerOptions {
  /** Trusted B2C inputs (resource/group/capabilities/at); never the request body. */
  readonly context: TemplateResolutionContext;
  /** Trusted server-side dependency identity; the request never supplies it. */
  readonly dependencyDigest: HashId;
  readonly templates: TemplateVersionReadPort;
  readonly registry: PackageRegistry;
  /** Offline trial evidence; absent means the issuer cannot issue. */
  readonly evidence?: TrialEvidenceReadPort | null;
  /** Trusted clock, read synchronously; a promise/thenable is unavailable time. */
  readonly now: () => unknown;
  /** Trusted receipt lifetime; never taken from the request. */
  readonly ttlMs: number;
}

const IdTextSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
/** The request may name a receipt id and nothing else about the receipt. */
const IssueRequestSchema = z.strictObject({
  resource: ResourceRefSchema,
  candidate: z.unknown().refine(value => value !== undefined),
  receipt_id: IdTextSchema,
});
const EvidenceEntrySchema = z.strictObject({
  template_id: TemplateIdSchema,
  item_id: ItemIdSchema,
  item_version: VersionNumberSchema,
  status: z.enum(['qualified', 'withdrawn', 'failed']),
  optional: z.boolean(),
  phases: z.strictObject({ read: z.boolean(), transform: z.boolean(), unit: z.boolean() }),
});
const EvidenceSchema = z.array(EvidenceEntrySchema);

type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const itemKey = (item: TrialItemRef): string =>
  `${item.template_id}\u0000${item.item_id}\u0000${item.item_version}`;
const compareItem = (left: TrialItemRef, right: TrialItemRef): number =>
  compare(left.template_id, right.template_id)
  || compare(left.item_id, right.item_id)
  || left.item_version - right.item_version;
const refOf = (item: TrialItemRef): TrialItemRef => ({
  template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
});
const sameResource = (left: ResourceRef, right: ResourceRef): boolean =>
  left.type === right.type && left.id === right.id;

const isThenable = (value: unknown): boolean =>
  (typeof value === 'object' || typeof value === 'function') && value !== null
  && typeof (value as { then?: unknown }).then === 'function';

/** Every selected item of the compiled candidate, keyed exactly like the guard keys them. */
function selectedItems(candidate: BindingTemplateCandidate): Map<string, TrialItemRef> {
  const selected = new Map<string, TrialItemRef>();
  for (const collector of candidate.collectors) {
    for (const item of collector.items) {
      const ref: TrialItemRef = {
        template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
      };
      selected.set(itemKey(ref), ref);
    }
  }
  return selected;
}

/** The synchronous trusted clock; `Date.now()` and a client value are never substitutes. */
function readTrustedNow(now: (() => unknown) | undefined): { text: string; ms: number } {
  if (typeof now !== 'function') throw new TrialReceiptIssueError('TRIAL_TIME_UNAVAILABLE');
  let raw: unknown;
  try {
    raw = now();
  } catch {
    throw new TrialReceiptIssueError('TRIAL_TIME_UNAVAILABLE');
  }
  if (isThenable(raw)) throw new TrialReceiptIssueError('TRIAL_TIME_UNAVAILABLE');
  const parsed = TimestampSchema.safeParse(raw);
  if (!parsed.success) throw new TrialReceiptIssueError('TRIAL_TIME_UNAVAILABLE');
  const ms = Date.parse(parsed.data);
  if (!Number.isFinite(ms)) throw new TrialReceiptIssueError('TRIAL_TIME_UNAVAILABLE');
  return { text: parsed.data, ms };
}

/** A missing/failed auth-free evidence read is unavailable, not "no phases". */
async function readEvidence(port: TrialEvidenceReadPort | null | undefined, resource: ResourceRef): Promise<unknown> {
  if (port === null || port === undefined || typeof port.read !== 'function') {
    throw new TrialReceiptIssueError('TRIAL_EVIDENCE_UNAVAILABLE');
  }
  try {
    return await port.read(resource);
  } catch {
    throw new TrialReceiptIssueError('TRIAL_EVIDENCE_UNAVAILABLE');
  }
}

/**
 * Turn per-item evidence into the receipt's qualified items and explicit
 * non-mandatory exclusions. One qualified item never stands in for another: an
 * unqualified mandatory item, an item with no evidence, or a withdrawn/failed
 * evidence row rejects the whole issuance before anything is written.
 */
function buildItemEvidence(
  selected: ReadonlyMap<string, TrialItemRef>,
  raw: unknown,
): { items: TrialReceiptItem[]; exclusions: TrialItemRef[] } {
  const parsed = EvidenceSchema.safeParse(raw);
  if (!parsed.success) throw new TrialReceiptIssueError('TRIAL_EVIDENCE_INVALID');
  const evidence = new Map<string, EvidenceEntry>();
  for (const entry of parsed.data) {
    const key = itemKey(entry);
    // A foreign item or a duplicate answer is not evidence about this candidate.
    if (!selected.has(key) || evidence.has(key)) throw new TrialReceiptIssueError('TRIAL_EVIDENCE_INVALID');
    evidence.set(key, entry);
  }

  const items: TrialReceiptItem[] = [];
  const exclusions: TrialItemRef[] = [];
  for (const [key, ref] of selected) {
    const entry = evidence.get(key);
    if (entry === undefined) throw new TrialReceiptIssueError('TRIAL_EVIDENCE_INCOMPLETE', [ref]);
    if (entry.status !== 'qualified') throw new TrialReceiptIssueError('TRIAL_EVIDENCE_WITHDRAWN', [ref]);
    const { read, transform, unit } = entry.phases;
    if (read && transform && unit) {
      items.push({ ...refOf(ref), phases: { read, transform, unit } });
      continue;
    }
    // Partial evidence is only acceptable as an explicitly excluded non-mandatory item.
    if (entry.optional) { exclusions.push(refOf(ref)); continue; }
    throw new TrialReceiptIssueError('TRIAL_ITEM_UNQUALIFIED', [ref]);
  }
  return { items: items.sort(compareItem), exclusions: exclusions.sort(compareItem) };
}

/**
 * Compile one v2 trial receipt. Contract and behavior:
 *
 * - The request is a strict object: `resource`, the raw `candidate` and
 *   `receipt_id`. A receipt body, `items`, `issued_at`/`expires_at`, a digest or a
 *   resolution identity in the request is `TRIAL_RECEIPT_INPUT_INVALID`.
 * - B1/B2A run first through {@link compileBindingCandidate}; a legacy
 *   single-package candidate is not a template trial and is rejected.
 * - B2C re-runs from the raw candidate with the trusted context; the receipt's
 *   resolution identity is exactly `templateResolutionIdentity` of that outcome.
 * - `target_revision` is always the current `binding.revision + 1`; the request
 *   cannot choose it, and `dependency_digest` comes only from the injected input.
 * - Every selected item needs explicit evidence. Partial phases are either an
 *   explicit optional exclusion or a rejection; withdrawn/failed evidence and a
 *   missing evidence item reject with zero write.
 * - Time comes from the synchronous trusted clock plus the injected lifetime; the
 *   result satisfies the guard's `issued_at <= now < expires_at`.
 */
export async function issueTrialReceipt(
  request: unknown,
  options: TrialReceiptIssuerOptions,
): Promise<IssuedTrialReceipt> {
  const parsedRequest = IssueRequestSchema.safeParse(request);
  if (!parsedRequest.success) throw new TrialReceiptIssueError('TRIAL_RECEIPT_INPUT_INVALID');
  const { resource, candidate, receipt_id: receiptId } = parsedRequest.data;

  const dependencyDigest = HashIdSchema.safeParse(options?.dependencyDigest);
  if (!dependencyDigest.success) throw new TrialReceiptIssueError('TRIAL_TRUSTED_INPUT_INVALID');
  if (!Number.isSafeInteger(options?.ttlMs) || options.ttlMs <= 0) {
    throw new TrialReceiptIssueError('TRIAL_TRUSTED_INPUT_INVALID');
  }
  // A missing evidence port is unavailable before any template/registry read.
  if (options.evidence === null || options.evidence === undefined || typeof options.evidence.read !== 'function') {
    throw new TrialReceiptIssueError('TRIAL_EVIDENCE_UNAVAILABLE');
  }

  const compiled = await compileBindingCandidate(candidate, options.templates, options.registry);
  if (compiled.kind === 'legacy') throw new TrialReceiptIssueError('TRIAL_RECEIPT_TEMPLATE_REQUIRED');
  if (!sameResource(compiled.binding.resource, resource)) {
    throw new TrialReceiptIssueError('TRIAL_BINDING_IDENTITY');
  }

  const baseRevision = compiled.binding.revision;
  const targetRevision = baseRevision + 1;
  if (!Number.isSafeInteger(targetRevision)) throw new TrialReceiptIssueError('TRIAL_REVISION_INVALID');

  const resolution = await resolveTemplateBinding(
    compiled.binding, options.context, options.templates, options.registry,
  );
  if (resolution.kind !== 'template_resolution'
    || resolution.revision !== baseRevision
    || resolution.resource.type !== resource.type
    || resolution.resource.id !== String(resource.id)
    || stable(resolution.binding) !== stable(compiled.binding)) {
    throw new TrialReceiptIssueError('TRIAL_RESOLUTION_INVALID');
  }

  const selected = selectedItems(compiled);
  const { items, exclusions } = buildItemEvidence(
    selected, await readEvidence(options.evidence, resource),
  );

  const digest = bindingCandidateDigest(compiled, targetRevision, dependencyDigest.data);
  const identity = templateResolutionIdentity(resolution);

  const now = readTrustedNow(options.now);
  let expires: string;
  try {
    expires = new Date(now.ms + options.ttlMs).toISOString();
  } catch {
    throw new TrialReceiptIssueError('TRIAL_TRUSTED_INPUT_INVALID');
  }
  if (Date.parse(expires) <= now.ms) throw new TrialReceiptIssueError('TRIAL_TRUSTED_INPUT_INVALID');

  return {
    receipt_id: receiptId,
    payload: {
      receipt_version: 2,
      receipt_id: receiptId,
      resource: { type: resource.type, id: resource.id },
      base_revision: baseRevision,
      target_revision: targetRevision,
      candidate_digest: digest,
      resolution_identity: identity,
      dependency_digest: dependencyDigest.data,
      issued_at: now.text,
      expires_at: expires,
      items,
      optional_exclusions: exclusions,
    },
  };
}
