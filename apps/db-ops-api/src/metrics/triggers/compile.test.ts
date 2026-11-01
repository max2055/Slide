import { describe, expect, it } from 'vitest';
import type { TriggerResourceSnapshot } from '../../contracts/metrics/triggers.js';
import { baseline, portOf } from './test-support.js';
import { resolveTriggerRules } from './resolve.js';
import {
  checkTriggerSnapshotFence, compileTriggerSnapshot, verifyTriggerSnapshot, TriggerCompileError,
} from './compile.js';

const evidenceFor = (snapshot: TriggerResourceSnapshot, overrides: Record<string, unknown> = {}) => ({
  resource: { type: snapshot.resource.type, id: Number(snapshot.resource.id) },
  applied_revision: snapshot.config_revision,
  plan_identity: snapshot.plan_identity,
  application_status: 'applied',
  ...overrides,
});

async function compiled(options: Parameters<typeof resolveTriggerRules>[3] = {}) {
  const base = await baseline();
  const candidate = await resolveTriggerRules(base.resolution, base.catalog, portOf([base.version]).port, options);
  const snapshot = compileTriggerSnapshot(candidate);
  return { base, candidate, snapshot };
}

function failureOf(run: () => unknown): TriggerCompileError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TriggerCompileError);
    return error as TriggerCompileError;
  }
  throw new Error('expected the compilation to reject');
}

describe('immutable trigger snapshot', () => {
  it('compiles a candidate into a hashed snapshot that never claims to be applied', async () => {
    const { snapshot } = await compiled();
    expect(snapshot.kind).toBe('template_trigger_snapshot');
    expect(snapshot.internal).toBe(true);
    expect(snapshot.persisted).toBe(false);
    expect(snapshot.applied).toBe(false);
    expect(snapshot.effective).toBe(false);
    expect(snapshot.status).toBe('candidate');
    expect(snapshot.resource).toEqual({ type: 'instance', id: '7' });
    expect(snapshot.config_revision).toBe(4);
    expect(snapshot.templates).toHaveLength(1);
    expect(snapshot.rules).toHaveLength(2);
    expect(snapshot.snapshot_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const rule of snapshot.rules) {
      expect(rule.snapshot_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(rule.body_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rules[0].problem)).toBe(true);
  });

  it('is deterministic and survives a JSON round-trip', async () => {
    const first = await compiled();
    const second = compileTriggerSnapshot(first.candidate);
    expect(second).toEqual(first.snapshot);
    // A snapshot is not a candidate: compiling it again is rejected, not re-hashed.
    expect(failureOf(() => compileTriggerSnapshot(second)).code).toBe('TRIGGER_CANDIDATE_INVALID');

    const roundTripped = JSON.parse(JSON.stringify(first.snapshot));
    expect(roundTripped).not.toBe(first.snapshot);
    expect(verifyTriggerSnapshot(roundTripped)).toEqual(first.snapshot);
  });

  it('rejects a tampered rule hash, a tampered aggregate hash and a tampered body', async () => {
    const { snapshot } = await compiled();

    const ruleHash = structuredClone(snapshot);
    ruleHash.rules[0].snapshot_hash = `sha256:${'c'.repeat(64)}`;
    expect(failureOf(() => verifyTriggerSnapshot(ruleHash)).code).toBe('TRIGGER_SNAPSHOT_HASH_MISMATCH');

    const aggregate = structuredClone(snapshot);
    aggregate.snapshot_hash = `sha256:${'d'.repeat(64)}`;
    expect(failureOf(() => verifyTriggerSnapshot(aggregate)).code).toBe('TRIGGER_SNAPSHOT_HASH_MISMATCH');

    const body = structuredClone(snapshot);
    const problem = body.rules.find(rule => rule.rule_id === 'alpha-threshold')!.problem;
    expect(problem.node).toBe('compare');
    if (problem.node === 'compare') problem.threshold = { kind: 'constant', value: 60 };
    expect(failureOf(() => verifyTriggerSnapshot(body)).code).toBe('TRIGGER_SNAPSHOT_HASH_MISMATCH');

    expect(failureOf(() => verifyTriggerSnapshot({ kind: 'template_trigger_snapshot' })).code)
      .toBe('TRIGGER_SNAPSHOT_INVALID');
    expect(failureOf(() => compileTriggerSnapshot({})).code).toBe('TRIGGER_CANDIDATE_INVALID');
  });

  it('keeps the previous 90 snapshot unchanged when the rule is re-authored to 95', async () => {
    const before = await compiled();
    const previous = before.snapshot;
    const previousHash = previous.snapshot_hash;
    const thresholdBefore = previous.rules.find(rule => rule.rule_id === 'alpha-threshold')!;
    expect(thresholdBefore.problem).toMatchObject({ threshold: { kind: 'constant', value: 90 } });

    const after = await compiled({ parameter_overrides: { 'alpha-threshold': { problem_threshold: 95 } } });
    const thresholdAfter = after.snapshot.rules.find(rule => rule.rule_id === 'alpha-threshold')!;
    expect(thresholdAfter.problem).toMatchObject({ threshold: { kind: 'constant', value: 95 } });
    expect(after.snapshot.snapshot_hash).not.toBe(previousHash);

    // The old snapshot is an independent copy: same hash, same 90, still verifies.
    expect(previous.snapshot_hash).toBe(previousHash);
    expect(previous.rules.find(rule => rule.rule_id === 'alpha-threshold')!.problem)
      .toMatchObject({ threshold: { kind: 'constant', value: 90 } });
    expect(verifyTriggerSnapshot(structuredClone(previous))).toEqual(previous);
  });

  it('does not follow a later mutation of the input the snapshot was built from', async () => {
    const base = await baseline();
    const candidate = await resolveTriggerRules(base.resolution, base.catalog, portOf([base.version]).port);
    const snapshot = compileTriggerSnapshot(candidate);
    const before = structuredClone(snapshot);

    // The frozen candidate cannot be edited in place; a detached copy can, and the
    // compiled snapshot must not share structure with it.
    const detached = JSON.parse(JSON.stringify(candidate));
    detached.rules.find((rule: { rule_id: string }) => rule.rule_id === 'alpha-threshold').problem.threshold.value = 10;
    expect(snapshot).toEqual(before);
    expect(() => { (candidate.rules[0] as unknown as { rule_id: string }).rule_id = 'x'; }).toThrow();
  });
});

describe('pre-consumer fence', () => {
  it('accepts matching applied evidence only', async () => {
    const { snapshot } = await compiled();
    expect(checkTriggerSnapshotFence(snapshot, evidenceFor(snapshot))).toEqual({ ok: true, code: null });

    for (const status of ['pending', 'failed']) {
      expect(checkTriggerSnapshotFence(snapshot, evidenceFor(snapshot, { application_status: status })))
        .toEqual({ ok: false, code: 'TRIGGER_FENCE_NOT_APPLIED' });
    }
  });

  it('refuses another resource, revision, plan or malformed evidence', async () => {
    const { snapshot } = await compiled();
    expect(checkTriggerSnapshotFence(snapshot, evidenceFor(snapshot, { resource: { type: 'instance', id: 8 } })))
      .toEqual({ ok: false, code: 'TRIGGER_FENCE_RESOURCE_MISMATCH' });
    expect(checkTriggerSnapshotFence(snapshot, evidenceFor(snapshot, { resource: { type: 'server', id: 7 } })))
      .toEqual({ ok: false, code: 'TRIGGER_FENCE_RESOURCE_MISMATCH' });
    expect(checkTriggerSnapshotFence(snapshot, evidenceFor(snapshot, { applied_revision: 3 })))
      .toEqual({ ok: false, code: 'TRIGGER_FENCE_REVISION_MISMATCH' });
    expect(checkTriggerSnapshotFence(snapshot, evidenceFor(snapshot, { plan_identity: `sha256:${'e'.repeat(64)}` })))
      .toEqual({ ok: false, code: 'TRIGGER_FENCE_PLAN_MISMATCH' });
    expect(checkTriggerSnapshotFence(snapshot, { application_status: 'applied' }))
      .toEqual({ ok: false, code: 'TRIGGER_FENCE_EVIDENCE_INVALID' });
    expect(checkTriggerSnapshotFence(snapshot, null))
      .toEqual({ ok: false, code: 'TRIGGER_FENCE_EVIDENCE_INVALID' });
  });
});
