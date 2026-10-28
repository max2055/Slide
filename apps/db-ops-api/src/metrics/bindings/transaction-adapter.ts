/**
 * MAX-238 / B2D — internal atomic transaction adapter.
 *
 * This is the adapter core that sits between the accepted v2 transaction guard
 * and a future storage host. It runs entirely inside the caller-supplied
 * transaction context: it re-walks B1 → B2A → B2C, verifies the trusted v2
 * receipt against the candidate, the resolution and the dependency digest, and
 * then asks the host for **one** atomic staging of binding + operation + receipt
 * consumption + audit. It is not a production store: nothing here commits,
 * issues a receipt, applies a binding, touches a connection or performs
 * collection I/O. See `docs/slide/development/MAX-238/b2d-atomic-adapter.md` and
 * `b2d-production-wiring.md`.
 *
 * The host reports the final commit result. A staging acknowledgement is never
 * treated as committed, and an unknown/ unavailable settlement is returned as
 * "look up the original operation", never as success and never as a resend.
 */
import { z } from 'zod';
import type { PackageRegistry } from '../packages/model.js';
import type { ResourceBindingCandidate, HashId } from '../../contracts/metrics/templates.js';
import { refKey } from '../policy/model.js';
import type { TemplateVersionReadPort } from './preflight.js';
import type { TemplateCollectionPlan } from './plan.js';
import {
  prepareTemplateBindingMutationV2,
  type BindingOperationLookup, type BindingTransactionPortV2,
  type LegacyBindingDelegate, type PreparedTemplateBindingMutation, type ReplayedBindingMutation,
  type ResourceRef,
} from './transaction-guard.js';

export type BindingApplicationErrorCode =
  | 'APPLICATION_HOST_UNAVAILABLE'
  | 'APPLICATION_TEMPLATE_READER_UNAVAILABLE'
  | 'APPLICATION_INTENT_INVALID';

/** A defect in the host contract or in the guard→adapter hand-off; not a policy rejection. */
export class BindingApplicationError extends Error {
  constructor(public readonly code: BindingApplicationErrorCode) {
    super(code);
    this.name = 'BindingApplicationError';
  }
}

/** Stable codes a host may use for an atomic staging rejection. */
export const BINDING_STAGE_REJECTION_CODES = [
  'OPERATION_CONFLICT',
  'RECEIPT_CONSUMED',
  'REVISION_CONFLICT',
  'DEPENDENCY_CHANGED',
  'UNAVAILABLE',
] as const;
export type BindingStageRejectionCode = (typeof BINDING_STAGE_REJECTION_CODES)[number];

/**
 * The single atomic staging intent. It is one object so the host can write all
 * four records (binding, operation, receipt consumption, audit) in one
 * transaction, all-or-nothing. The binding is the **raw** candidate with
 * `revision = target`; the resolved plan is an attached pending snapshot, never
 * a replacement for the effective plan of the previous applied revision.
 */
export interface BindingApplicationIntent {
  kind: 'template_binding_application';
  internal: true;
  protocol: 'max238.binding-application.v1';
  resource_key: string;
  base_revision: number;
  target_revision: number;
  /** Raw candidate (`package: null`, fixed pins, overrides) with the target revision. */
  binding: ResourceBindingCandidate;
  pending: {
    resolution_identity: HashId;
    plan: TemplateCollectionPlan;
    decided_at: string;
  };
  application: {
    status: 'pending';
    /** Preserved from the previous application; a pending revision never becomes applied. */
    applied_revision: number | null;
    previous_resolution_identity: HashId | null;
  };
  operation: {
    key: string;
    caller_key: string;
    resource: ResourceRef;
    target_revision: number;
    candidate_digest: HashId;
    resolution_identity: HashId;
    dependency_digest: HashId;
    receipt_id: string;
    /** The row written by the transaction that commits; the adapter never reports it committed itself. */
    status: 'committed';
  };
  receipt: { receipt_id: string; operation_key: string; expires_at: string };
  audit: {
    action: 'template_binding.apply';
    target: string;
    revision: number;
    /** Trusted actor from the transaction view; never request-supplied. */
    actor_id: number;
    idempotency_key: string;
    candidate_digest: HashId;
    resolution_identity: HashId;
    dependency_digest: HashId;
    receipt_id: string;
    at: string;
  };
}

/**
 * The transaction host. Reads plus one atomic staging call plus the host-owned
 * settlement report — nothing else. `templateVersions` must be bound to the same
 * transaction view; the adapter never accepts a caller-supplied template reader.
 */
export interface BindingApplicationHost extends BindingTransactionPortV2 {
  templateVersions(): TemplateVersionReadPort;
  /** Stage every record of the intent atomically; the transaction is committed by the host. */
  stageApplication(intent: BindingApplicationIntent): Promise<unknown>;
  /** Host-reported final result of committing (or rolling back) the staged intent. */
  settleApplication(staged: unknown): Promise<unknown>;
}

export interface RejectedBindingApplication {
  kind: 'rejected';
  status: 'rejected';
  persisted: false;
  committed: false;
  code: BindingStageRejectionCode;
}
export interface CommittedBindingApplication {
  kind: 'committed';
  status: 'committed';
  persisted: true;
  committed: true;
  revision: number;
  resolution_identity: HashId;
  operation: { key: string; caller_key: string; receipt_id: string; status: 'committed' };
}
export interface RolledBackBindingApplication {
  kind: 'rolled_back';
  status: 'rolled_back';
  persisted: false;
  committed: false;
  code: string;
}
export type BindingUnknownCommitCause =
  | 'host_reported_unknown'
  | 'stage_unavailable'
  | 'settle_unavailable'
  | 'settle_invalid';
export interface UnknownCommitBindingApplication {
  kind: 'commit_unknown';
  status: 'unknown';
  persisted: 'unknown';
  committed: 'unknown';
  cause: BindingUnknownCommitCause;
  /** Query the original operation by caller key; never resend this mutation. */
  lookup: true;
  operation: { key: string; caller_key: string; status: 'unknown' };
}

export type BindingApplicationOutcome =
  | LegacyBindingDelegate
  | ReplayedBindingMutation
  | BindingOperationLookup
  | RejectedBindingApplication
  | CommittedBindingApplication
  | RolledBackBindingApplication
  | UnknownCommitBindingApplication;

const StageStagedSchema = z.strictObject({ status: z.literal('staged') });
const StageRejectedSchema = z.strictObject({
  status: z.literal('rejected'),
  code: z.enum(BINDING_STAGE_REJECTION_CODES),
});
const StageResultSchema = z.union([StageStagedSchema, StageRejectedSchema]);
const SettlementSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('committed'), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ status: z.literal('rolled_back'), code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/) }),
  z.strictObject({ status: z.literal('unknown') }),
]);

const copyResource = (resource: ResourceRef): ResourceRef => ({ type: resource.type, id: resource.id });

function assertHost(host: BindingApplicationHost): void {
  if (host === null || typeof host !== 'object'
    || typeof host.templateVersions !== 'function'
    || typeof host.stageApplication !== 'function'
    || typeof host.settleApplication !== 'function') {
    throw new BindingApplicationError('APPLICATION_HOST_UNAVAILABLE');
  }
}

/**
 * The one same-connection template reader. A throwing factory or a reader
 * without `getVersion` is a contract defect: no caller-supplied fallback is used.
 */
function readTemplateReader(host: BindingApplicationHost): TemplateVersionReadPort {
  let reader: unknown;
  try {
    reader = host.templateVersions();
  } catch {
    throw new BindingApplicationError('APPLICATION_TEMPLATE_READER_UNAVAILABLE');
  }
  if (reader === null || typeof reader !== 'object'
    || typeof (reader as { getVersion?: unknown }).getVersion !== 'function') {
    throw new BindingApplicationError('APPLICATION_TEMPLATE_READER_UNAVAILABLE');
  }
  return reader as TemplateVersionReadPort;
}

function buildIntent(decision: PreparedTemplateBindingMutation): BindingApplicationIntent {
  if (decision.next.revision !== decision.target_revision
    || decision.base_revision + 1 !== decision.target_revision) {
    throw new BindingApplicationError('APPLICATION_INTENT_INVALID');
  }
  const resource = copyResource(decision.resource);
  const target = refKey(resource);
  const previous = decision.previous_application;
  return {
    kind: 'template_binding_application',
    internal: true,
    protocol: 'max238.binding-application.v1',
    resource_key: target,
    base_revision: decision.base_revision,
    target_revision: decision.target_revision,
    binding: structuredClone(decision.next),
    pending: {
      resolution_identity: decision.resolution_identity,
      plan: structuredClone(decision.plan),
      decided_at: decision.decided_at,
    },
    application: {
      status: 'pending',
      applied_revision: previous?.applied_revision ?? null,
      previous_resolution_identity: previous?.resolution_identity ?? null,
    },
    operation: {
      key: decision.operation.key,
      caller_key: decision.operation.caller_key,
      resource,
      target_revision: decision.target_revision,
      candidate_digest: decision.candidate_digest,
      resolution_identity: decision.resolution_identity,
      dependency_digest: decision.dependency_digest,
      receipt_id: decision.operation.receipt_id,
      status: 'committed',
    },
    receipt: {
      receipt_id: decision.operation.receipt_id,
      operation_key: decision.operation.key,
      expires_at: decision.receipt_expires_at,
    },
    audit: {
      action: 'template_binding.apply',
      target,
      revision: decision.target_revision,
      actor_id: decision.actor_id,
      idempotency_key: decision.operation.caller_key,
      candidate_digest: decision.candidate_digest,
      resolution_identity: decision.resolution_identity,
      dependency_digest: decision.dependency_digest,
      receipt_id: decision.operation.receipt_id,
      at: decision.decided_at,
    },
  };
}

function unknownCommit(
  decision: PreparedTemplateBindingMutation,
  cause: BindingUnknownCommitCause,
): UnknownCommitBindingApplication {
  return {
    kind: 'commit_unknown',
    status: 'unknown',
    persisted: 'unknown',
    committed: 'unknown',
    cause,
    lookup: true,
    operation: {
      key: decision.operation.key,
      caller_key: decision.operation.caller_key,
      status: 'unknown',
    },
  };
}

/**
 * Apply one template binding enable inside the host's transaction.
 *
 * Contract and behavior:
 * - The v2 guard runs first and is the only decision point; a legacy delegate,
 *   an exact replay or an unknown-operation lookup returns untouched with **zero**
 *   staging calls.
 * - A prepared decision becomes exactly one {@link BindingApplicationIntent} and
 *   exactly one `stageApplication` call; the host must stage all four records
 *   atomically. Nothing is written when the guard rejects.
 * - An explicit staging rejection means the host rolled the whole intent back and
 *   is reported as `rejected`; any thrown/uncertain staging outcome is reported
 *   as `commit_unknown`, never retried here.
 * - Only an explicit host settlement `committed` with the exact target revision
 *   is reported as committed. `rolled_back`, `unknown`, a throwing/malformed
 *   settlement or a wrong revision are all reported as their own outcome; a
 *   staging acknowledgement alone never becomes success.
 * - No input, registry or previous application plan is mutated by this call.
 */
export async function applyTemplateBindingMutation(
  request: unknown,
  host: BindingApplicationHost,
  registry: PackageRegistry,
): Promise<BindingApplicationOutcome> {
  assertHost(host);
  const templates = readTemplateReader(host);

  const decision = await prepareTemplateBindingMutationV2(request, host, templates, registry);
  // Every non-prepared outcome already is the final answer; no staging exists.
  if (decision.kind !== 'prepared') return decision;

  const intent = buildIntent(decision);
  let staged: unknown;
  try {
    staged = await host.stageApplication(intent);
  } catch {
    // Without an explicit rejection we cannot claim "not persisted".
    return unknownCommit(decision, 'stage_unavailable');
  }
  const stage = StageResultSchema.safeParse(staged);
  if (!stage.success) return unknownCommit(decision, 'stage_unavailable');
  if (stage.data.status === 'rejected') {
    return {
      kind: 'rejected', status: 'rejected', persisted: false, committed: false, code: stage.data.code,
    };
  }

  let settled: unknown;
  try {
    settled = await host.settleApplication(staged);
  } catch {
    return unknownCommit(decision, 'settle_unavailable');
  }
  const settlement = SettlementSchema.safeParse(settled);
  if (!settlement.success) return unknownCommit(decision, 'settle_invalid');
  if (settlement.data.status === 'committed') {
    // A "committed" report for another revision is not this operation's success.
    if (settlement.data.revision !== decision.target_revision) return unknownCommit(decision, 'settle_invalid');
    return {
      kind: 'committed', status: 'committed', persisted: true, committed: true,
      revision: settlement.data.revision, resolution_identity: decision.resolution_identity,
      operation: {
        key: decision.operation.key, caller_key: decision.operation.caller_key,
        receipt_id: decision.operation.receipt_id, status: 'committed',
      },
    };
  }
  if (settlement.data.status === 'rolled_back') {
    return {
      kind: 'rolled_back', status: 'rolled_back', persisted: false, committed: false, code: settlement.data.code,
    };
  }
  return unknownCommit(decision, 'host_reported_unknown');
}
