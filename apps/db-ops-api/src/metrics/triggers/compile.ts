/**
 * MAX-239 — immutable resource rule snapshot compilation and the pre-consumer fence.
 *
 * The input is the accepted {@link TriggerRuleCandidateSet} from `resolve.ts`.
 * Compilation is a pure projection: it adds a canonical hash to every rule and to
 * the resource snapshot, freezes the value and re-validates it through the
 * contract. It does not persist, apply, promote, emit or notify anything, and it
 * cannot turn a candidate into evidence that a rule is in effect.
 *
 * Two different claims stay separate:
 *
 * - `applied` / `effective` are literally false in the snapshot and there is no
 *   setter. A later mount package may store the snapshot, but only the binding
 *   row's own application state can say it is applied.
 * - {@link checkTriggerSnapshotFence} is the only way to compare the snapshot
 *   against trusted applied evidence (resource, applied revision, plan identity).
 *   Until that evidence matches and says `applied`, a consumer must not report an
 *   executable/effective conclusion.
 */
import {
  TriggerAppliedEvidenceSchema, TriggerResourceSnapshotSchema, TriggerRuleCandidateSetSchema,
  TriggerRuleSnapshotSchema,
  type TriggerAppliedEvidence, type TriggerResourceSnapshot, type TriggerRuleCandidateSet,
  type TriggerRuleSnapshot,
} from '../../contracts/metrics/triggers.js';
import { frozenCopy, triggerRuleSnapshotHash, triggerSnapshotHash } from './model.js';

export type TriggerCompileErrorCode =
  | 'TRIGGER_CANDIDATE_INVALID'
  | 'TRIGGER_SNAPSHOT_INVALID'
  | 'TRIGGER_SNAPSHOT_HASH_MISMATCH';

export class TriggerCompileError extends Error {
  constructor(public readonly code: TriggerCompileErrorCode) {
    super(code);
    this.name = 'TriggerCompileError';
  }
}

/**
 * Compile one candidate into a frozen snapshot. Every rule hash and the aggregate
 * hash are computed here; the result is re-parsed so a snapshot this module would
 * later reject can never be returned.
 */
export function compileTriggerSnapshot(candidateInput: unknown): TriggerResourceSnapshot {
  const parsed = TriggerRuleCandidateSetSchema.safeParse(candidateInput);
  if (!parsed.success) throw new TriggerCompileError('TRIGGER_CANDIDATE_INVALID');
  const candidate: TriggerRuleCandidateSet = parsed.data;

  const rules: TriggerRuleSnapshot[] = candidate.rules.map(rule => {
    const withHash = { ...rule, snapshot_hash: triggerRuleSnapshotHash(rule) };
    if (!TriggerRuleSnapshotSchema.safeParse(withHash).success) {
      throw new TriggerCompileError('TRIGGER_SNAPSHOT_INVALID');
    }
    return withHash;
  });

  const draft = {
    kind: 'template_trigger_snapshot' as const,
    internal: candidate.internal,
    persisted: candidate.persisted,
    applied: candidate.applied,
    effective: candidate.effective,
    status: candidate.status,
    resource: candidate.resource,
    config_revision: candidate.config_revision,
    plan_identity: candidate.plan_identity,
    templates: candidate.templates,
    rules,
  };
  const snapshot = { ...draft, snapshot_hash: triggerSnapshotHash(draft) };
  const checked = TriggerResourceSnapshotSchema.safeParse(snapshot);
  if (!checked.success) throw new TriggerCompileError('TRIGGER_SNAPSHOT_INVALID');
  return frozenCopy(checked.data);
}

/**
 * Re-verify an untrusted snapshot before use (round-trip, storage read or an
 * in-memory handoff): every rule body hash and the aggregate hash must recompute,
 * and the value must still satisfy the contract. Returns a frozen independent copy.
 */
export function verifyTriggerSnapshot(snapshotInput: unknown): TriggerResourceSnapshot {
  const parsed = TriggerResourceSnapshotSchema.safeParse(snapshotInput);
  if (!parsed.success) throw new TriggerCompileError('TRIGGER_SNAPSHOT_INVALID');
  const snapshot = parsed.data;
  for (const rule of snapshot.rules) {
    const { snapshot_hash: declared, ...body } = rule;
    if (declared !== triggerRuleSnapshotHash(body)) {
      throw new TriggerCompileError('TRIGGER_SNAPSHOT_HASH_MISMATCH');
    }
  }
  const { snapshot_hash: declared, ...rest } = snapshot;
  if (declared !== triggerSnapshotHash(rest)) {
    throw new TriggerCompileError('TRIGGER_SNAPSHOT_HASH_MISMATCH');
  }
  return frozenCopy(snapshot);
}

export type TriggerFenceCode =
  | 'TRIGGER_FENCE_EVIDENCE_INVALID'
  | 'TRIGGER_FENCE_NOT_APPLIED'
  | 'TRIGGER_FENCE_RESOURCE_MISMATCH'
  | 'TRIGGER_FENCE_REVISION_MISMATCH'
  | 'TRIGGER_FENCE_PLAN_MISMATCH';

export interface TriggerFenceResult {
  ok: boolean;
  code: TriggerFenceCode | null;
}

const FX = (code: TriggerFenceCode): TriggerFenceResult => ({ ok: false, code });
const OK: TriggerFenceResult = Object.freeze({ ok: true, code: null }) as TriggerFenceResult;

/**
 * The pre-consumer fence. Trusted applied evidence must name the snapshot's own
 * resource, applied revision and plan identity, and must say `applied`. A pending
 * or failed application, or one naming another revision/plan/resource, yields a
 * stable refusal — never "assume the latest snapshot is live".
 */
export function checkTriggerSnapshotFence(
  snapshot: TriggerResourceSnapshot,
  evidenceInput: unknown,
): TriggerFenceResult {
  const evidence = TriggerAppliedEvidenceSchema.safeParse(evidenceInput);
  if (!evidence.success) return FX('TRIGGER_FENCE_EVIDENCE_INVALID');
  const trusted: TriggerAppliedEvidence = evidence.data;
  if (trusted.application_status !== 'applied') return FX('TRIGGER_FENCE_NOT_APPLIED');
  if (trusted.resource.type !== snapshot.resource.type
    || String(trusted.resource.id) !== snapshot.resource.id) {
    return FX('TRIGGER_FENCE_RESOURCE_MISMATCH');
  }
  if (trusted.applied_revision !== snapshot.config_revision) return FX('TRIGGER_FENCE_REVISION_MISMATCH');
  if (trusted.plan_identity !== snapshot.plan_identity) return FX('TRIGGER_FENCE_PLAN_MISMATCH');
  return OK;
}
