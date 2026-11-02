/**
 * Pure rules for the MAX-236 P0-REAL-A executor: plan shape, code/schema
 * fingerprints, owned-endpoint guards, manifest and target guards, and
 * content-level preservation comparison.
 *
 * Apply/rollback replay is exercised against a real MySQL schema in
 * `real-migration-mysql.test.ts`; this file never opens a connection.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyRealMigration, applyRealRollback, assertOwnedEndpoint, assertPlanInvocation, assertTargetIdentity,
  assertWritableTarget, beginReadOnlySnapshot, disposeReal, evidenceJson, openRealSession, openVerifiedSession,
  parseHandle, parseManifest, parsePins, parseRealBinding, planRealMigration, planRealRollback, readConsistentSnapshot,
  readRealSnapshot, realPlanDigest, verifyPreservation,
  EXECUTOR_CODE_FINGERPRINT, EXECUTOR_VERSION, RealRefusal, realRollbackDigest,
  type EndpointInspection, type OwnedTargetHandle, type RealBinding, type RealSnapshot, type SqlSession,
} from './real-migration.js';
import type { IdentityInput } from './migration-drill.js';

const hashOf = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const pin = (id: string, version = 1) => ({ template_id: id, version, content_hash: hashOf(`${id}@${version}`) });
const packagePin = { id: 'mysql-basic', version: '1.0.0', digest: hashOf('mysql-basic@1.0.0') };
const PENDING = { applied_revision: null, reported_at: null, status: 'pending', error_code: null };

it('refuses native compiled envelopes before the legacy migration can erase their execution plan', () => {
  const payload = { envelope: 'templates-applied-v1', binding: { resource: { type: 'instance', id: 1 },
    revision: 1, package: null, template_pins: [pin('native')], overrides: {} }, pending: { plan: { compiled: true } } };
  expect(() => parseRealBinding(payload)).toThrow('REAL_NATIVE_BINDING_UNSUPPORTED');
  expect(() => parseRealBinding(null)).toThrow('REAL_RESOURCE_BINDING_INVALID');
});

const identity = (overrides: Partial<IdentityInput> = {}): IdentityInput => ({
  resource_type: 'instance', engine: 'mysql', old_id: 'cpu', unit: '%',
  target_metric_id: 'cpu_usage', target_unit: null, in_scope: true,
  has_custom_sql: false, custom_sql_reviewed: false, ...overrides,
});

const version = (id: string, overrides: Partial<{ content_hash: string; status: string; aggregate_ok: boolean; items_ok: boolean }> = {}) => ({
  content_hash: pin(id).content_hash,
  status: 'published',
  retired_at: null,
  aggregate_ok: true,
  items_ok: true,
  ...overrides,
});

const payload = (binding: Record<string, unknown>) => ({
  binding,
  resolved: null,
  published_at: '2026-10-27 09:00:00.000',
  application: PENDING,
});

const bindingPayloadDigest = (revision: number, pins: unknown[] = [], overrides: Record<string, unknown> = {}) =>
  hashOf(JSON.stringify(payload({
    resource: { type: 'instance', id: 9101 }, package: packagePin, group_id: null,
    overrides, revision, ...(pins.length > 0 ? { template_pins: pins } : {}),
  })));

const snapshot = (overrides: Partial<RealSnapshot> = {}): RealSnapshot => {
  const binding: RealBinding = {
    revision: 0, package: packagePin, template_pins: [], group_id: null, overrides: {}, resolved: null,
    application: PENDING,
  };
  return {
    resource: { type: 'instance', id: 9101 },
    resource_key: 'instance:9101',
    resource_type: 'instance',
    engine: 'mysql',
    resource_exists: true,
    binding,
    binding_payload_digest: bindingPayloadDigest(0),
    catalog: {
      'instance:cpu_usage': { unit: '%', is_collected: true },
      'instance:memory_usage': { unit: '%', is_collected: true },
      'instance:retired_metric': { unit: '%', is_collected: false },
    },
    catalog_supported: true,
    templates: {
      'tpl-a': { status: 'active', versions: { 1: version('tpl-a') } },
      'tpl-b': { status: 'active', versions: { 1: version('tpl-b') } },
    },
    template_catalog_supported: true,
    schema_fingerprint: hashOf('schema-v1'),
    revisions: [{
      revision: 0, audit_id: 1, request_id: 'max236-baseline:seed',
      package: packagePin, template_pins: [], group_id: null, overrides: {}, at: '2026-10-27 10:00:00.000',
      baseline: null,
    }],
    preservation: {
      history: [{ table: 'metrics_history', count: 3, digest: hashOf('history'), truncated: false }],
      credentials: [{ ref: 'credential:instance-9101:password', present: true, digest: hashOf('cipher') }],
      acl: { supported: true, count: 1, digest: hashOf('acl'), truncated: false, rows: ['acl:instance-9101:user-11'] },
      schedules: { count: 1, rows: [{ job_id: 'job-1', digest: hashOf('states') }], truncated: false },
      events: { supported: true, count: 1, digest: hashOf('events'), truncated: false },
      policy_audit: { count: 1, entries: [{ id: 1, request_id: 'max236-baseline:seed', digest: hashOf('audit-1') }], truncated: false },
      platform_audit: { count: 1, entries: [hashOf('platform-1')], truncated: false },
    },
    ...overrides,
  };
};

const request = (overrides: Record<string, unknown> = {}) => ({
  resource: { type: 'instance' as const, id: 9101 },
  identities: [
    identity(),
    identity({ old_id: 'legacy-cpu', target_metric_id: null }),
    identity({ old_id: 'retired', target_metric_id: 'retired_metric' }),
  ],
  template_pins: [pin('tpl-a'), pin('tpl-b')],
  ...overrides,
});

const refusal = (run: () => unknown): string => {
  try { run(); } catch (error) {
    if (error instanceof RealRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a RealRefusal');
};

describe('plan', () => {
  it('turns the real catalog into mapped / keep-legacy rows and binds a stable digest', () => {
    const before = snapshot();
    const plan = planRealMigration(before, request());
    expect(plan.cutover_allowed).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.base_revision).toBe(0);
    expect(plan.pins).toEqual([pin('tpl-a'), pin('tpl-b')]);
    expect(plan.rows.map(row => [row.identity, row.disposition])).toEqual([
      ['instance:mysql:cpu', 'mapped'],
      ['instance:mysql:legacy-cpu', 'keep-legacy'],
      ['instance:mysql:retired', 'keep-legacy'],
    ]);
    expect(plan.rows.find(row => row.identity.endsWith('retired'))?.reason).toContain('CANONICAL_NOT_COLLECTED');
    expect(plan).toEqual(planRealMigration(snapshot(), request()));
    expect(plan.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.digest).toBe(realPlanDigest(plan));
    expect(plan.executor_version).toBe(EXECUTOR_VERSION);
    expect(plan.code_fingerprint).toBe(EXECUTOR_CODE_FINGERPRINT);
    expect(plan.baseline?.payload_digest).toBe(before.binding_payload_digest);
    expect(plan.invocation.identities).toHaveLength(3);
  });

  it('binds a change to the complete baseline into the digest', () => {
    const base = planRealMigration(snapshot(), request());
    const changed = snapshot({ binding_payload_digest: hashOf('other-payload') });
    expect(planRealMigration(changed, request()).digest).not.toBe(base.digest);
  });

  it('uses the catalog unit, never the manifest unit', () => {
    const plan = planRealMigration(snapshot(), request({ identities: [identity({ unit: 'ops/s' })] }));
    expect(plan.rows[0]?.disposition).toBe('keep-legacy');
    expect(plan.rows[0]?.reason).toContain('UNIT_REVIEW_REQUIRED');
    expect(plan.cutover_allowed).toBe(false);
  });

  it('blocks a mapping target the real catalog lacks', () => {
    const plan = planRealMigration(snapshot(), request({ identities: [identity({ target_metric_id: 'missing_metric' })] }));
    expect(plan.rows[0]?.disposition).toBe('blocked');
    expect(plan.rows[0]?.reason).toContain('MAPPING_TARGET_MISSING');
    expect(plan.blockers).toContain('instance:mysql:cpu');
    expect(plan.cutover_allowed).toBe(false);
  });

  it('blocks when the candidate template catalog (140) is absent', () => {
    const plan = planRealMigration(snapshot({ templates: {}, template_catalog_supported: false }), request());
    expect(plan.blockers).toContain('TEMPLATE_CATALOG_MISSING');
    expect(plan.cutover_allowed).toBe(false);
  });

  it('blocks a pin whose immutable version hash differs', () => {
    const tampered = { ...pin('tpl-a'), content_hash: hashOf('other') };
    const plan = planRealMigration(snapshot(), request({ template_pins: [tampered] }));
    expect(plan.blockers).toContain('TEMPLATE_VERSION_HASH_MISMATCH:tpl-a@1');
    expect(plan.cutover_allowed).toBe(false);
  });

  it('blocks a retired version pin but keeps the historical snapshot readable', () => {
    const retired = snapshot({
      templates: { 'tpl-a': { status: 'active', versions: { 1: version('tpl-a', { status: 'retired' }) } } },
    });
    expect(retired.templates['tpl-a']?.versions[1]?.status).toBe('retired');
    const plan = planRealMigration(retired, request({ template_pins: [pin('tpl-a')] }));
    expect(plan.blockers).toContain('TEMPLATE_VERSION_NOT_PUBLISHED:tpl-a@1:retired');
    expect(plan.cutover_allowed).toBe(false);
  });

  it('does not treat an empty-metadata version as a compiled apply target', () => {
    const empty = snapshot({
      templates: { 'tpl-a': { status: 'active', versions: { 1: version('tpl-a', { aggregate_ok: false }) } } },
    });
    const plan = planRealMigration(empty, request({ template_pins: [pin('tpl-a')] }));
    expect(plan.blockers).toContain('TEMPLATE_VERSION_CONTENT_INVALID:tpl-a@1');
    expect(plan.cutover_allowed).toBe(false);
  });

  it('blocks an unknown template and a missing version', () => {
    const plan = planRealMigration(snapshot(), request({ template_pins: [pin('tpl-z'), { ...pin('tpl-b'), version: 9 }] }));
    expect(plan.blockers).toContain('TEMPLATE_PIN_MISSING:tpl-z');
    expect(plan.blockers).toContain('TEMPLATE_VERSION_MISSING:tpl-b@9');
  });

  it('does not plan an identity from another engine', () => {
    const plan = planRealMigration(snapshot(), request({
      identities: [identity({ engine: 'postgresql' }), identity({ old_id: 'ok' })],
    }));
    expect(plan.rows.map(row => row.identity)).toEqual(['instance:mysql:ok']);
  });

  it('refuses a binding that already carries a compiled resolved plan', () => {
    const binding = { ...snapshot().binding!, resolved: { plan: true } };
    expect(refusal(() => planRealMigration(snapshot({ binding }), request()))).toBe('REAL_RESOLVED_PLAN_UNSUPPORTED');
  });

  it('refuses a plan request for another resource', () => {
    expect(refusal(() => planRealMigration(snapshot(), request({ resource: { type: 'instance', id: 9999 } }))))
      .toBe('REAL_PLAN_RESOURCE_MISMATCH');
  });

  it('is blocked when the binding row does not exist', () => {
    const plan = planRealMigration(snapshot({ binding: null, binding_payload_digest: null }), request());
    expect(plan.blockers).toContain('RESOURCE_BINDING_MISSING:instance:9101');
    expect(plan.cutover_allowed).toBe(false);
  });

  it('keeps a device plan blocked: the real schema has no device metric catalog', () => {
    const device = snapshot({
      resource: { type: 'network_device', id: 9301 }, resource_key: 'network_device:9301',
      resource_type: 'network_device', engine: null, catalog: {}, catalog_supported: false,
    });
    const plan = planRealMigration(device, {
      resource: { type: 'network_device', id: 9301 },
      identities: [identity({ resource_type: 'network_device', engine: null })],
      template_pins: [pin('tpl-a')],
    });
    expect(plan.rows[0]?.disposition).toBe('blocked');
    expect(plan.cutover_allowed).toBe(false);
  });
});

describe('disposeReal', () => {
  const base = snapshot();
  it('maps an exact unit match', () => expect(disposeReal(identity(), base).disposition).toBe('mapped'));
  it('keeps the legacy path when the platform does not collect the target',
    () => expect(disposeReal(identity({ target_metric_id: 'retired_metric' }), base).disposition).toBe('keep-legacy'));
  it('blocks an unreviewed custom SQL identity',
    () => expect(disposeReal(identity({ has_custom_sql: true }), base).disposition).toBe('blocked'));
  it('keeps an out-of-scope identity on the legacy path',
    () => expect(disposeReal(identity({ in_scope: false }), base).disposition).toBe('keep-legacy'));
});

describe('apply guards', () => {
  const failing = (): SqlSession => ({
    query: async () => { throw new Error('no query expected'); },
    begin: async () => { throw new Error('no transaction expected'); },
    commit: async () => undefined,
    rollback: async () => undefined,
  });

  const replayed = (afterRevision: number, pins: ReturnType<typeof pin>[], digest: string, application = PENDING) =>
    snapshot({
      binding: { ...snapshot().binding!, revision: afterRevision, package: null, template_pins: pins, group_id: null, overrides: {}, resolved: null, application },
      revisions: [
        ...snapshot().revisions,
        { revision: afterRevision, audit_id: 2, request_id: digest, package: null, template_pins: pins, group_id: null, overrides: {}, at: 'later', baseline: null },
      ],
      preservation: {
        ...snapshot().preservation,
        policy_audit: { count: 2, truncated: false, entries: [...snapshot().preservation.policy_audit.entries, { id: 2, request_id: digest, digest: hashOf('audit-2') }] },
      },
    });

  it('refuses a forged plan digest before touching the session', async () => {
    const before = snapshot();
    const plan = { ...planRealMigration(before, request()), pins: [pin('tpl-b')] };
    await expect(applyRealMigration(failing(), plan, before, { actor_id: 9001, at: 'now' }))
      .rejects.toMatchObject({ code: 'REAL_PLAN_DIGEST_MISMATCH' });
  });

  it('refuses a plan bound to another schema fingerprint', async () => {
    const before = snapshot();
    const plan = planRealMigration(before, request());
    const drifted = snapshot({ schema_fingerprint: hashOf('schema-v2') });
    await expect(applyRealMigration(failing(), plan, drifted, { actor_id: 9001, at: 'now' }))
      .rejects.toMatchObject({ code: 'REAL_SCHEMA_FINGERPRINT_MISMATCH' });
  });

  it('refuses a blocked plan before writing', async () => {
    const before = snapshot();
    const plan = planRealMigration(before, request({ identities: [identity({ target_metric_id: 'missing' })] }));
    await expect(applyRealMigration(failing(), plan, before, { actor_id: 9001, at: 'now' }))
      .rejects.toMatchObject({ code: 'REAL_CUTOVER_BLOCKED' });
  });

  it('refuses a stale plan', async () => {
    const before = snapshot();
    const plan = planRealMigration(before, request());
    const moved = snapshot({ binding: { ...before.binding!, revision: 5 } });
    await expect(applyRealMigration(failing(), plan, moved, { actor_id: 9001, at: 'now' }))
      .rejects.toMatchObject({ code: 'REAL_PLAN_STALE' });
  });

  it('treats an exact replay with its own audit record as a no-op', async () => {
    const before = snapshot();
    const plan = planRealMigration(before, request());
    const requestId = `max236-migrate:${plan.digest}`;
    const result = await applyRealMigration(failing(), plan, replayed(1, plan.pins, requestId), { actor_id: 9001, at: 'later' });
    expect(result).toMatchObject({ outcome: 'noop', written: 0, revision: 1, request_id: requestId });
  });

  it('refuses a matching state without this plan audit record', async () => {
    const before = snapshot();
    const plan = planRealMigration(before, request());
    const drifted = snapshot({ binding: { ...before.binding!, revision: 1, package: null, template_pins: plan.pins } });
    await expect(applyRealMigration(failing(), plan, drifted, { actor_id: 9001, at: 'later' }))
      .rejects.toMatchObject({ code: 'REAL_REPLAY_CONFLICT' });
  });

  it('refuses a same-revision override drift as a replay', async () => {
    const before = snapshot();
    const plan = planRealMigration(before, request());
    const requestId = `max236-migrate:${plan.digest}`;
    const drifted = replayed(1, plan.pins, requestId);
    drifted.binding!.overrides = { chief_probe: 2 };
    drifted.binding_payload_digest = hashOf('drifted');
    await expect(applyRealMigration(failing(), plan, drifted, { actor_id: 9001, at: 'later' }))
      .rejects.toMatchObject({ code: 'REAL_REPLAY_CONFLICT' });
  });

  it('refuses a replay whose application state or resolved plan changed', async () => {
    const before = snapshot();
    const plan = planRealMigration(before, request());
    const requestId = `max236-migrate:${plan.digest}`;
    const changedApplication = replayed(1, plan.pins, requestId, { ...PENDING, status: 'applied' });
    await expect(applyRealMigration(failing(), plan, changedApplication, { actor_id: 9001, at: 'later' }))
      .rejects.toMatchObject({ code: 'REAL_REPLAY_CONFLICT' });
    const changedResolved = replayed(1, plan.pins, requestId);
    changedResolved.binding!.resolved = { compiled: true };
    await expect(applyRealMigration(failing(), plan, changedResolved, { actor_id: 9001, at: 'later' }))
      .rejects.toMatchObject({ code: 'REAL_REPLAY_CONFLICT' });
  });
});

describe('rollback plan', () => {
  const current = snapshot({
    binding: { ...snapshot().binding!, revision: 2, package: null, template_pins: [pin('tpl-a'), pin('tpl-b')] },
    revisions: [
      ...snapshot().revisions,
      { revision: 1, audit_id: 2, request_id: 'max236-migrate:one', package: null, template_pins: [pin('tpl-a')], group_id: null, overrides: {}, at: 'a', baseline: null },
      { revision: 2, audit_id: 3, request_id: 'max236-migrate:two', package: null, template_pins: [pin('tpl-a'), pin('tpl-b')], group_id: null, overrides: {}, at: 'b', baseline: null },
    ],
  });

  it('restores the target revision pins, package, group and overrides, appending a revision', () => {
    const target = current.revisions[0]!;
    const withConfig = { ...current, revisions: [{ ...target, group_id: 'g1', overrides: { window: 3 } }, ...current.revisions.slice(1)] };
    const plan = planRealRollback(withConfig, { target_revision: 0, expected_current_revision: 2 });
    expect(plan).toMatchObject({
      from_revision: 2, target_revision: 0, next_revision: 3, pins: [], package: packagePin,
      group_id: 'g1', overrides: { window: 3 },
    });
    expect(plan.digest).toBe(realRollbackDigest(plan));
    expect(plan.code_fingerprint).toBe(EXECUTOR_CODE_FINGERPRINT);
  });

  it('keeps a multi-template target multi-template', () => {
    const plan = planRealRollback(current, { target_revision: 1, expected_current_revision: 2 });
    expect(plan.pins).toEqual([pin('tpl-a')]);
  });

  it('returns the same plan after this rollback was applied (CLI repeat)', () => {
    const plan = planRealRollback(current, { target_revision: 0, expected_current_revision: 2 });
    // The rollback's own audit row records the exact baseline the plan bound.
    const applied = snapshot({
      binding: {
        ...snapshot().binding!, revision: 3, package: packagePin, template_pins: [],
        group_id: plan.group_id, overrides: plan.overrides, resolved: null, application: PENDING,
      },
      revisions: [...current.revisions, {
        revision: 3, audit_id: 4, request_id: `max236-rollback:${plan.digest}`,
        package: plan.package, template_pins: plan.pins, group_id: plan.group_id, overrides: plan.overrides,
        at: 'c', baseline: plan.baseline,
      }],
      binding_payload_digest: hashOf('applied'),
    });
    const replay = planRealRollback(applied, { target_revision: 0, expected_current_revision: 2 });
    expect(replay.digest).toBe(plan.digest);
  });

  it('refuses a replay whose rollback audit row has no bound baseline', () => {
    const plan = planRealRollback(current, { target_revision: 0, expected_current_revision: 2 });
    const applied = snapshot({
      binding: {
        ...snapshot().binding!, revision: 3, package: packagePin, template_pins: [],
        group_id: plan.group_id, overrides: plan.overrides, resolved: null, application: PENDING,
      },
      revisions: [...current.revisions, {
        revision: 3, audit_id: 4, request_id: `max236-rollback:${plan.digest}`,
        package: plan.package, template_pins: plan.pins, group_id: plan.group_id, overrides: plan.overrides,
        at: 'c', baseline: null,
      }],
      binding_payload_digest: hashOf('applied'),
    });
    expect(refusal(() => planRealRollback(applied, { target_revision: 0, expected_current_revision: 2 })))
      .toBe('REAL_ROLLBACK_BASELINE_MISSING');
  });

  it('binds the complete live baseline into the digest', () => {
    const plain = planRealRollback(current, { target_revision: 0, expected_current_revision: 2 });
    const drifted = snapshot({
      ...current,
      binding: { ...current.binding!, overrides: { window: 9 } },
      binding_payload_digest: hashOf('drifted-current'),
    });
    const driftedPlan = planRealRollback(drifted, { target_revision: 0, expected_current_revision: 2 });
    expect(driftedPlan.baseline.payload_digest).toBe(hashOf('drifted-current'));
    expect(driftedPlan.digest).not.toBe(plain.digest);
  });

  it('refuses a drifted state that merely has the next revision', () => {
    const applied = snapshot({
      binding: { ...snapshot().binding!, revision: 3, package: null, template_pins: [], overrides: { drift: 1 } },
    });
    expect(refusal(() => planRealRollback(applied, { target_revision: 0, expected_current_revision: 2 })))
      .toBe('REAL_ROLLBACK_CONFLICT');
  });

  it('refuses a stale observation of the current revision', () => {
    expect(refusal(() => planRealRollback(current, { target_revision: 0, expected_current_revision: 1 })))
      .toBe('REAL_ROLLBACK_CONFLICT');
  });

  it('refuses a target revision with no recorded configuration', () => {
    expect(refusal(() => planRealRollback(current, { target_revision: 7, expected_current_revision: 2 })))
      .toBe('REAL_ROLLBACK_TARGET_MISSING');
  });

  it('refuses rolling back to the current revision', () => {
    expect(refusal(() => planRealRollback(current, { target_revision: 2, expected_current_revision: 2 })))
      .toBe('REAL_ROLLBACK_TARGET_NOT_HISTORICAL');
  });

  it('treats an exact rollback replay with its audit record as a no-op', async () => {
    const plan = planRealRollback(current, { target_revision: 0, expected_current_revision: 2 });
    const requestId = `max236-rollback:${plan.digest}`;
    const applied = snapshot({
      binding: {
        ...snapshot().binding!, revision: plan.next_revision, package: plan.package, template_pins: plan.pins,
        group_id: plan.group_id, overrides: plan.overrides, resolved: null, application: PENDING,
      },
      revisions: [...current.revisions, {
        revision: plan.next_revision, audit_id: 4, request_id: requestId,
        package: plan.package, template_pins: plan.pins, group_id: plan.group_id, overrides: plan.overrides, at: 'c',
        baseline: plan.baseline,
      }],
    });
    const failing: SqlSession = {
      query: async () => { throw new Error('no query expected'); },
      begin: async () => { throw new Error('no transaction expected'); },
      commit: async () => undefined, rollback: async () => undefined,
    };
    const result = await applyRealRollback(failing, plan, applied, {
      target_revision: 0, expected_current_revision: 2, actor_id: 9001, at: 'now',
    });
    expect(result).toMatchObject({ outcome: 'noop', written: 0, revision: plan.next_revision });
  });
});

describe('preservation comparison', () => {
  const before = snapshot();
  const changed = (mutate: (value: RealSnapshot) => void): RealSnapshot => {
    const copy = JSON.parse(JSON.stringify(before)) as RealSnapshot;
    mutate(copy);
    return copy;
  };

  it('accepts an unchanged snapshot', () => expect(verifyPreservation(before, snapshot())).toMatchObject({ ok: true, complete: true }));

  it('detects a same-count history value change', () => {
    const after = changed(value => { value.preservation.history[0]!.digest = hashOf('rewritten'); });
    expect(verifyPreservation(before, after).checks.find(check => check.name === 'history-content')?.status).toBe('fail');
  });

  it('detects an ACL content change even when identities and count match', () => {
    const after = changed(value => { value.preservation.acl.digest = hashOf('grant-expiry-changed'); });
    const report = verifyPreservation(before, after);
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.name === 'acl')?.status).toBe('fail');
  });

  it('detects a changed credential digest even when presence matches', () => {
    const after = changed(value => { value.preservation.credentials[0]!.digest = hashOf('other-cipher'); });
    expect(verifyPreservation(before, after).checks.find(check => check.name === 'credentials')?.status).toBe('fail');
  });

  it('detects an audit prefix rewrite even when the count matches', () => {
    const after = changed(value => { value.preservation.policy_audit.entries[0]!.digest = hashOf('rewritten'); });
    expect(verifyPreservation(before, after).checks.find(check => check.name === 'audit-append-only')?.status).toBe('fail');
  });

  it('detects a replaced schedule job', () => {
    const after = changed(value => { value.preservation.schedules.rows[0]!.job_id = 'job-2'; });
    expect(verifyPreservation(before, after).checks.find(check => check.name === 'single-executor')?.status).toBe('fail');
  });

  it('detects an event state change', () => {
    const after = changed(value => { value.preservation.events.digest = hashOf('resolved'); });
    expect(verifyPreservation(before, after).checks.find(check => check.name === 'events-unchanged')?.status).toBe('fail');
  });

  it('never lets a truncated block pass', () => {
    const truncated = changed(value => { value.preservation.history[0]!.truncated = true; });
    const report = verifyPreservation(truncated, truncated);
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.checks.find(check => check.name === 'history-content')?.status).toBe('fail');
  });

  // Chief boundary B3: a segment that was truncated cannot prove preservation
  // even when its truncated slice compares equal to itself.
  it.each(['acl', 'events', 'schedules'] as const)('refuses a complete proof when %s was truncated', field => {
    const truncated = changed(value => { value.preservation[field].truncated = true; });
    const report = verifyPreservation(truncated, truncated);
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(false);
  });

  it('refuses a complete proof when the AFTER acl was truncated', () => {
    const after = changed(value => { value.preservation.acl.truncated = true; });
    const report = verifyPreservation(before, after);
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.name === 'acl')?.status).toBe('fail');
  });

  it('reports an unsupported scope as not complete instead of PASS', () => {
    const unsupported = snapshot({
      preservation: {
        ...snapshot().preservation,
        acl: { supported: false, count: 0, digest: hashOf('no-acl'), truncated: false, rows: [], reason: 'no ACL table' },
      },
    });
    const report = verifyPreservation(unsupported, unsupported);
    expect(report.ok).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.checks.find(check => check.name === 'acl')?.status).toBe('unsupported');
  });
});

describe('owned endpoint and target guards', () => {
  const OWNER = '15coder1-reala';
  const handle: OwnedTargetHandle = {
    owner: OWNER, phase: 'P0-REAL-A',
    container_id: 'a'.repeat(60) + '1234',
    container_name: 'max236-reala-15coder1',
    image: `sha256:${'b'.repeat(64)}`,
    network: 'max236-reala-15coder1-net',
    network_id: 'c'.repeat(64),
    volume: 'max236-reala-15coder1-data',
    volume_destination: '/var/lib/mysql',
    volume_labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' },
    port: 33440, database: 'max236_reala', user: 'root', password: 'empty',
    resources: ['instance:9101', 'server:9201'], created_at: '2026-10-27T00:00:00Z',
  };
  const dsn = 'mysql://root@127.0.0.1:33440/max236_reala';
  const inspection = (overrides: Partial<EndpointInspection['container']> = {}): EndpointInspection => ({
    container: {
      id: handle.container_id, name: '/max236-reala-15coder1', image: handle.image, running: true,
      labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' },
      mounts: [{ type: 'volume', name: handle.volume, destination: '/var/lib/mysql' }],
      networks: [handle.network],
      network_ids: [handle.network_id],
      published: [{ host_ip: '127.0.0.1', host_port: handle.port, container_port: 3306 }],
      ...overrides,
    },
    network: { id: handle.network_id, name: handle.network, labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' } },
    volume: { name: handle.volume, labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' } },
  });

  it('accepts only the exact recorded endpoint', () => {
    expect(() => assertOwnedEndpoint(dsn, handle, inspection())).not.toThrow();
  });

  it('refuses a remote or non-recorded DSN before connecting', async () => {
    expect(refusal(() => assertOwnedEndpoint('mysql://root@10.0.0.5:33440/max236_reala', handle, inspection())))
      .toBe('REAL_TARGET_DSN_REMOTE');
    expect(refusal(() => assertOwnedEndpoint('mysql://root@127.0.0.1:33441/max236_reala', handle, inspection())))
      .toBe('REAL_TARGET_PORT_MISMATCH');
    expect(refusal(() => assertOwnedEndpoint('mysql://root@127.0.0.1:33440/other_db', handle, inspection())))
      .toBe('REAL_TARGET_DATABASE_MISMATCH');
    expect(refusal(() => assertOwnedEndpoint('mysql://admin@127.0.0.1:33440/max236_reala', handle, inspection())))
      .toBe('REAL_TARGET_USER_MISMATCH');
    expect(refusal(() => assertOwnedEndpoint('mysql://root:secret@127.0.0.1:33440/max236_reala', handle, inspection())))
      .toBe('REAL_TARGET_CREDENTIAL_SOURCE_REFUSED');
    let connected = false;
    await expect(openRealSession(dsn, handle, {
      inspect: async () => inspection({ labels: { 'max236.owner': 'foreign-owner' } }),
      connect: async () => { connected = true; throw new Error('must not connect'); },
    })).rejects.toMatchObject({ code: 'REAL_TARGET_OWNER_REFUSED' });
    expect(connected).toBe(false);
  });

  it('refuses a changed ID, owner, phase, image, mount, network or port binding', () => {
    expect(refusal(() => assertOwnedEndpoint(dsn, handle, inspection({ id: 'f'.repeat(64) })))).toBe('REAL_TARGET_CONTAINER_ID_MISMATCH');
    expect(refusal(() => assertOwnedEndpoint(dsn, handle, inspection({ labels: { 'max236.owner': 'other', 'max236.phase': 'P0-REAL-A' } }))))
      .toBe('REAL_TARGET_OWNER_REFUSED');
    expect(refusal(() => assertOwnedEndpoint(dsn, handle, inspection({ labels: { 'max236.owner': OWNER, 'max236.phase': 'other' } }))))
      .toBe('REAL_TARGET_PHASE_REFUSED');
    expect(refusal(() => assertOwnedEndpoint(dsn, handle, inspection({ image: hashOf('other') })))).toBe('REAL_TARGET_IMAGE_MISMATCH');
    expect(refusal(() => assertOwnedEndpoint(dsn, handle, inspection({ mounts: [] })))).toBe('REAL_TARGET_MOUNT_MISMATCH');
    expect(refusal(() => assertOwnedEndpoint(dsn, handle, inspection({ networks: ['bridge'] })))).toBe('REAL_TARGET_NETWORK_MISMATCH');
    const foreignNetwork = inspection();
    (foreignNetwork.container as any).network_ids = ['foreign'];
    expect(refusal(() => assertOwnedEndpoint(dsn, handle, foreignNetwork))).toBe('REAL_TARGET_NETWORK_MISMATCH');
    expect(refusal(() => assertOwnedEndpoint(dsn, handle, inspection({ published: [{ host_ip: '127.0.0.1', host_port: 33441, container_port: 3306 }] }))))
      .toBe('REAL_TARGET_PORT_BINDING_MISMATCH');
    expect(refusal(() => assertOwnedEndpoint(dsn, handle, inspection({ running: false })))).toBe('REAL_TARGET_NOT_RUNNING');
  });

  const facts = {
    database: 'max236_reala', hostname: handle.container_id.slice(0, 12), version: '8.4.10',
    container_id: handle.container_id,
    container_labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' },
  };
  const targetOptions = {
    handle,
    confirm: `max236_reala@${handle.container_id.slice(0, 12)}:instance:9101`,
    resource_key: 'instance:9101',
  };

  it('accepts the confirmed recorded target', () => expect(() => assertWritableTarget(facts, targetOptions)).not.toThrow());
  it('refuses a caller-fabricated owner instead of trusting a prefix', () => {
    expect(refusal(() => assertWritableTarget(facts, { ...targetOptions, handle: undefined } as never)))
      .toBe('REAL_TARGET_OWNER_REFUSED');
    expect(refusal(() => assertWritableTarget({ ...facts, container_labels: { 'max236.owner': 'foreign-owner' } }, targetOptions)))
      .toBe('REAL_TARGET_OWNER_REFUSED');
  });
  it('refuses a production-like database', () => {
    expect(refusal(() => assertWritableTarget({ ...facts, database: 'slide' }, {
      ...targetOptions, confirm: 'slide@x:instance:9101',
    }))).toBe('REAL_TARGET_DATABASE_REFUSED');
  });
  it('refuses a container ID or hostname that is not the record', () => {
    expect(refusal(() => assertWritableTarget({ ...facts, container_id: 'f'.repeat(64) }, targetOptions)))
      .toBe('REAL_TARGET_CONTAINER_ID_MISMATCH');
    expect(refusal(() => assertWritableTarget({ ...facts, hostname: 'ffffffffffff' }, targetOptions)))
      .toBe('REAL_TARGET_HOSTNAME_MISMATCH');
  });
  it('refuses a resource outside the recorded write allow-list', () => {
    expect(refusal(() => assertWritableTarget(
      { ...facts, hostname: handle.container_id.slice(0, 12) },
      { ...targetOptions, resource_key: 'network_device:9301', confirm: `max236_reala@${handle.container_id.slice(0, 12)}:network_device:9301` },
    ))).toBe('REAL_TARGET_RESOURCE_REFUSED');
  });
  it('refuses a wrong confirmation string and an old server version', () => {
    expect(refusal(() => assertWritableTarget(facts, { ...targetOptions, confirm: 'max236_reala@x:instance:1' })))
      .toBe('REAL_TARGET_CONFIRMATION_MISMATCH');
    expect(refusal(() => assertWritableTarget({ ...facts, version: '5.7.44' }, targetOptions)))
      .toBe('REAL_TARGET_VERSION_REFUSED');
  });

  it('parses the creation record strictly', () => {
    expect(parseHandle(handle)).toEqual(handle);
    expect(refusal(() => parseHandle({ ...handle, container_id: 'short' }))).toBe('REAL_TARGET_HANDLE_INVALID');
    expect(refusal(() => parseHandle({ ...handle, password: '' }))).toBe('REAL_TARGET_HANDLE_INVALID');
    expect(refusal(() => parseHandle({ ...handle, resources: ['mysql:1'] }))).toBe('REAL_TARGET_HANDLE_INVALID');
  });

  it('parses a strict manifest and rejects unknown fields', () => {
    const manifest = {
      resource: { type: 'instance', id: 9101 },
      identities: [identity()],
      template_pins: [pin('tpl-a')],
      object_blockers: [],
    };
    expect(parseManifest(manifest).resource).toEqual({ type: 'instance', id: 9101 });
    expect(refusal(() => parseManifest({ ...manifest, extra: true, identities: [{ ...identity(), rogue: 1 }] })))
      .toBe('REAL_MANIFEST_INVALID');
    expect(refusal(() => parseManifest({ ...manifest, identities: [{ ...identity(), in_scope: 'yes' }] })))
      .toBe('REAL_MANIFEST_INVALID');
  });

  it('sorts and de-duplicates pins', () => {
    expect(parsePins([pin('tpl-b'), pin('tpl-a')]).map(item => item.template_id)).toEqual(['tpl-a', 'tpl-b']);
    expect(refusal(() => parsePins([pin('tpl-a'), pin('tpl-a')]))).toBe('REAL_TEMPLATE_PIN_DUPLICATE');
    expect(refusal(() => parsePins([{ ...pin('tpl-a'), content_hash: 'sha256:short' }]))).toBe('REAL_TEMPLATE_PIN_INVALID');
  });

  it('never opens a connection to build a plan', async () => {
    const session = {
      query: async (sql: string) => {
        if (sql.includes('information_schema.COLUMNS') && sql.includes('COLUMN_TYPE')) return [
          { TABLE_NAME: 'metric_policy_bindings', COLUMN_NAME: 'payload', COLUMN_TYPE: 'json', IS_NULLABLE: 'NO', COLUMN_KEY: '', EXTRA: '' },
        ];
        if (sql.includes('information_schema.STATISTICS')) return [];
        if (sql.includes('FROM app_schema_migrations')) return [{ migration_id: '001', checksum: 'x', status: 'completed' }];
        if (sql.includes('information_schema.TABLES')) return [{ table_name: 'metric_templates_v2' }, { table_name: 'metric_template_versions' }];
        if (sql.includes('information_schema.COLUMNS')) return [
          'metrics_history', 'metric_observations', 'metric_publications', 'alerts', 'server_metrics',
          'network_device_observations', 'audit_log_entries', 'instance_permissions'].flatMap(table => [
            { table_name: table, column_name: 'id' }, { table_name: table, column_name: 'value' },
          ]);
        if (sql.includes('FROM database_instances')) return [{ id: 9101, db_type: 'mysql' }];
        if (sql.includes('FROM metric_policy_bindings')) return [{ group_id: null, payload: JSON.stringify(payload({ revision: 0, package: packagePin, group_id: null, overrides: {} })) }];
        if (sql.includes('FROM metric_definitions')) return [{ id: 'cpu_usage', target_type: 'instance', unit: '%', is_collected: 1 }];
        if (sql.includes('FROM metric_templates_v2')) return [{ template_id: 'tpl-a', status: 'active' }];
        if (sql.includes('FROM metric_template_versions')) return [{
          template_id: 'tpl-a', version: 1, status: 'published', content_hash: pin('tpl-a').content_hash, retired_at: null,
          aggregate: JSON.stringify({ template_id: 'tpl-a', items: [], triggers: [] }), items: '[]',
        }];
        if (sql.includes('FROM metric_rollout')) return [];
        if (sql.includes('FROM metric_policy_audit')) return [{ id: 1, target: 'instance:9101', payload: JSON.stringify({ revision: 0, request_id: 'seed', configuration: { package: packagePin } }) }];
        if (sql.includes('FROM metric_schedule')) return [{ job_id: 'job-1', states: '{}' }];
        if (sql.startsWith('SELECT COUNT(*)')) return [{ n: 0 }];
        return [];
      },
      begin: async () => { throw new Error('read-only'); },
      commit: async () => { throw new Error('read-only'); },
      rollback: async () => undefined,
    } as unknown as SqlSession;
    const before = await readRealSnapshot(session, { type: 'instance', id: 9101 });
    const plan = planRealMigration(before, request({ template_pins: [pin('tpl-a')], identities: [identity()] }));
    expect(plan.cutover_allowed).toBe(true);
    expect(plan.pins).toEqual([pin('tpl-a')]);
  });

  it('serialises evidence with sorted keys', () => {
    expect(evidenceJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}');
  });
});

describe('saved plan invocation binding (B2)', () => {
  const plan = planRealMigration(snapshot(), request());

  it('accepts the exact manifest it was planned from', () => {
    expect(() => assertPlanInvocation(plan, request())).not.toThrow();
  });

  it('refuses a manifest that adds an object blocker', () => {
    expect(refusal(() => assertPlanInvocation(plan, request({ object_blockers: ['BOUNDARY_NEW_BLOCKER'] }))))
      .toBe('REAL_PLAN_INVOCATION_MISMATCH');
  });

  it('refuses changed identities, pins or resource', () => {
    expect(refusal(() => assertPlanInvocation(plan, request({ identities: [identity()] }))))
      .toBe('REAL_PLAN_INVOCATION_MISMATCH');
    expect(refusal(() => assertPlanInvocation(plan, request({ template_pins: [pin('tpl-a')] }))))
      .toBe('REAL_PLAN_INVOCATION_MISMATCH');
    expect(refusal(() => assertPlanInvocation(plan, request({ resource: { type: 'server', id: 9201 } }))))
      .toBe('REAL_PLAN_INVOCATION_MISMATCH');
  });
});

describe('rollback baseline binding (B2)', () => {
  const current = snapshot({
    binding: { ...snapshot().binding!, revision: 2, package: null, template_pins: [pin('tpl-a'), pin('tpl-b')] },
    revisions: [
      ...snapshot().revisions,
      { revision: 1, audit_id: 2, request_id: 'max236-migrate:one', package: null, template_pins: [pin('tpl-a')], group_id: null, overrides: {}, at: 'a', baseline: null },
      { revision: 2, audit_id: 3, request_id: 'max236-migrate:two', package: null, template_pins: [pin('tpl-a'), pin('tpl-b')], group_id: null, overrides: {}, at: 'b', baseline: null },
    ],
  });
  const failing: SqlSession = {
    query: async () => { throw new Error('no query expected'); },
    begin: async () => { throw new Error('no transaction expected'); },
    commit: async () => undefined, rollback: async () => undefined,
  };

  it('refuses a same-revision configuration drift with zero writes', async () => {
    const plan = planRealRollback(current, { target_revision: 0, expected_current_revision: 2 });
    const drifted = snapshot({
      ...current,
      binding: { ...current.binding!, overrides: { chief_drift: 1 } },
      binding_payload_digest: hashOf('drifted-payload'),
    });
    await expect(applyRealRollback(failing, plan, drifted, {
      target_revision: 0, expected_current_revision: 2, actor_id: 9001, at: 'now',
    })).rejects.toMatchObject({ code: 'REAL_ROLLBACK_BASELINE_DRIFT' });
  });

  it('refuses a plan whose baseline belongs to another revision', async () => {
    const plan = planRealRollback(current, { target_revision: 0, expected_current_revision: 2 });
    await expect(applyRealRollback(failing, { ...plan, baseline: { ...plan.baseline, revision: 1 } }, current, {
      target_revision: 0, expected_current_revision: 2, actor_id: 9001, at: 'now',
    })).rejects.toMatchObject({ code: 'REAL_PLAN_DIGEST_MISMATCH' });
  });

  it('still reaches the legal exact no-op replay', async () => {
    const plan = planRealRollback(current, { target_revision: 0, expected_current_revision: 2 });
    const requestId = `max236-rollback:${plan.digest}`;
    const applied = snapshot({
      binding: {
        ...snapshot().binding!, revision: plan.next_revision, package: plan.package, template_pins: plan.pins,
        group_id: plan.group_id, overrides: plan.overrides, resolved: null, application: PENDING,
      },
      revisions: [...current.revisions, {
        revision: plan.next_revision, audit_id: 4, request_id: requestId,
        package: plan.package, template_pins: plan.pins, group_id: plan.group_id, overrides: plan.overrides,
        at: 'c', baseline: plan.baseline,
      }],
    });
    const result = await applyRealRollback(failing, plan, applied, {
      target_revision: 0, expected_current_revision: 2, actor_id: 9001, at: 'now',
    });
    expect(result).toMatchObject({ outcome: 'noop', written: 0, revision: plan.next_revision });
  });
});

describe('consistent read-only snapshot (B1)', () => {
  const fake = (state: { isolation?: string; access_mode?: string }, log: string[]): SqlSession => ({
    query: async <R>(sql: string) => {
      log.push(sql);
      if (sql.includes('events_transactions_current')) {
        return [{
          isolation: state.isolation ?? 'REPEATABLE READ',
          access_mode: state.access_mode ?? 'READ ONLY',
        }] as R[];
      }
      return [] as R[];
    },
    begin: async () => { log.push('BEGIN'); throw new Error('begin() must not be used'); },
    commit: async () => { log.push('COMMIT'); },
    rollback: async () => { log.push('ROLLBACK'); },
  });

  it('starts an explicit REPEATABLE READ / READ ONLY transaction and verifies it', async () => {
    const log: string[] = [];
    await beginReadOnlySnapshot(fake({}, log));
    expect(log[0]).toContain('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(log[1]).toContain('START TRANSACTION READ ONLY');
    expect(log[2]).toContain('events_transactions_current');
    expect(log).not.toContain('BEGIN');
  });

  it('refuses when the transaction is not read-only or not REPEATABLE READ', async () => {
    await expect(beginReadOnlySnapshot(fake({ access_mode: 'READ WRITE' }, [])))
      .rejects.toMatchObject({ code: 'REAL_READ_SNAPSHOT_NOT_READ_ONLY' });
    await expect(beginReadOnlySnapshot(fake({ isolation: 'READ COMMITTED' }, [])))
      .rejects.toMatchObject({ code: 'REAL_READ_SNAPSHOT_ISOLATION_MISMATCH' });
  });

  it('rolls back (never commits) when the snapshot read fails', async () => {
    const log: string[] = [];
    await expect(readConsistentSnapshot(fake({}, log), { type: 'instance', id: 9101 })).rejects.toBeInstanceOf(RealRefusal);
    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
    expect(log.some(sql => sql.includes('events_transactions_current'))).toBe(true);
  });
});

describe('verified session identity (B1)', () => {
  const OWNER = '15coder1-reala';
  const CID = 'a'.repeat(60) + '1234';
  const handle: OwnedTargetHandle = {
    owner: OWNER, phase: 'P0-REAL-A', container_id: CID, container_name: 'max236-reala-15coder1',
    image: `sha256:${'b'.repeat(64)}`, network: 'max236-reala-15coder1-net', network_id: 'c'.repeat(64),
    volume: 'max236-reala-15coder1-data', volume_destination: '/var/lib/mysql',
    volume_labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' },
    port: 33440, database: 'max236_reala', user: 'root', password: 'empty',
    resources: ['instance:9101', 'server:9201'], created_at: '2026-10-27T00:00:00Z',
  };
  const inspection = (): EndpointInspection => ({
    container: {
      id: CID, name: '/max236-reala-15coder1', image: handle.image, running: true,
      labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' },
      mounts: [{ type: 'volume', name: handle.volume, destination: '/var/lib/mysql' }],
      networks: [handle.network],
      network_ids: [handle.network_id],
      published: [{ host_ip: '127.0.0.1', host_port: handle.port, container_port: 3306 }],
    },
    network: { id: handle.network_id, name: handle.network, labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' } },
    volume: { name: handle.volume, labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' } },
  });

  it('refuses localhost, which is not the inspected 127.0.0.1 publication', () => {
    expect(refusal(() => assertOwnedEndpoint('mysql://root@localhost:33440/max236_reala', handle, inspection())))
      .toBe('REAL_TARGET_DSN_REMOTE');
  });

  it('builds the socket from the verified endpoint with bounded timeouts', async () => {
    let config: Record<string, unknown> | undefined;
    await expect(openRealSession('mysql://root@127.0.0.1:33440/max236_reala', handle, {
      inspect: async () => inspection(),
      connect: async (value) => { config = value as unknown as Record<string, unknown>; throw new Error('stop after capture'); },
    })).rejects.toThrow('stop after capture');
    expect(config).toMatchObject({
      host: '127.0.0.1', port: 33440, user: 'root', password: '', database: 'max236_reala',
      connectTimeout: 10_000, multipleStatements: false,
    });
  });

  it('verifies the live connection identity BEFORE any state read', async () => {
    const queries: string[] = [];
    let closed = false;
    const connection = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('@@hostname')) {
          return [[{ database_name: 'max236_reala', hostname: 'f'.repeat(64), version: '8.4.10' }], []];
        }
        return [[], []];
      },
      end: async () => { closed = true; },
    };
    await expect(openVerifiedSession('mysql://root@127.0.0.1:33440/max236_reala', handle, {
      inspect: async () => inspection(),
      connect: async () => connection as never,
    })).rejects.toMatchObject({ code: 'REAL_TARGET_HOSTNAME_MISMATCH' });
    expect(closed).toBe(true);
    // The identity SELECT and the bounded SETs ran; no schema/state read did.
    expect(queries.some(sql => sql.includes('information_schema'))).toBe(false);
    expect(queries.some(sql => sql.includes('metric_policy_bindings'))).toBe(false);
  });

  it('verifies the live database identity too', async () => {
    const queries: string[] = [];
    const connection = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('@@hostname')) {
          return [[{ database_name: 'other_db', hostname: CID.slice(0, 12), version: '8.4.10' }], []];
        }
        return [[], []];
      },
      end: async () => undefined,
    };
    await expect(openVerifiedSession('mysql://root@127.0.0.1:33440/max236_reala', handle, {
      inspect: async () => inspection(),
      connect: async () => connection as never,
    })).rejects.toMatchObject({ code: 'REAL_TARGET_DATABASE_REFUSED' });
    expect(queries.some(sql => sql.includes('information_schema'))).toBe(false);
  });

  it('refuses a foreign owner label via assertTargetIdentity', () => {
    const facts = {
      database: 'max236_reala', hostname: CID.slice(0, 12), version: '8.4.10', container_id: CID,
      container_labels: { 'max236.owner': 'foreign', 'max236.phase': 'P0-REAL-A' },
    };
    expect(refusal(() => assertTargetIdentity(facts, handle))).toBe('REAL_TARGET_OWNER_REFUSED');
  });
});

/**
 * No-network shell proof: a fake `docker` on PATH records every invocation, so
 * the ownership checks that must precede each destructive/SQL action are
 * observable and a changed identity provably performs ZERO actions.
 */
describe('shell verify-before-act (B1)', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../../..'); // apps/db-ops-api/src/metrics/dry-run -> repo root
  const REAL_A = join(REPO, 'docs/slide/development/MAX-236/real-a');
  const hasShell = process.platform !== 'win32';
  const python = hasShell ? spawnSync('python3', ['-V'], { encoding: 'utf8' }) : undefined;
  const skip = !hasShell || python?.status !== 0;

  const OWNER = '15coder1-reala';
  const CID = 'a'.repeat(60) + '1234';
  const NETID = 'c'.repeat(64);
  const VOL = 'max236-reala-15coder1-data';
  const NET = 'max236-reala-15coder1-net';
  const IMAGE = `sha256:${'b'.repeat(64)}`;

  const setup = (overrides: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'max236-shell-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const calls = join(dir, 'calls.log');
    writeFileSync(calls, '');
    writeFileSync(join(dir, 'handle.json'), JSON.stringify({
      owner: OWNER, phase: 'P0-REAL-A', container_id: CID, container_name: 'max236-reala-15coder1',
      image: IMAGE, network: NET, network_id: NETID, volume: VOL,
      volume_destination: '/var/lib/mysql',
      volume_labels: { 'max236.owner': OWNER, 'max236.phase': 'P0-REAL-A' },
      port: 33440, database: 'max236_reala', user: 'root', password: 'empty',
      resources: ['instance:9101', 'server:9201'], created_at: '2026-10-27T00:00:00Z',
    }));
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "\${FAKE_FAIL:-}" in
  container-inspect) [ "$1" = container ] && [ "$2" = inspect ] && exit 1 ;;
  network-inspect) [ "$1" = network ] && [ "$2" = inspect ] && exit 1 ;;
  volume-inspect) [ "$1" = volume ] && [ "$2" = inspect ] && exit 1 ;;
esac
fmt5="$5"; fmt4="$4"
case "$1" in
  container) exit 0 ;;
  inspect)
    case "$fmt5" in
      *State.Running*) echo "true" ;;
      *Id*) echo "$FAKE_CID" ;;
      *Image*) echo "$FAKE_IMAGE" ;;
      *owner*) echo "$FAKE_OWNER" ;;
      *phase*) echo "$FAKE_PHASE" ;;
      *Mounts*) echo "volume|$FAKE_VOL|/var/lib/mysql;" ;;
      *Networks*) echo "$FAKE_NET;" ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  port) echo "127.0.0.1:$FAKE_PORT"; exit 0 ;;
  network)
    if [ "$2" = ls ]; then exit 0; fi
    case "$fmt4" in
      *Id*) echo "$FAKE_NETID" ;;
      *owner*) echo "$FAKE_OWNER" ;;
      *phase*) echo "$FAKE_PHASE" ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  volume)
    if [ "$2" = ls ]; then exit 0; fi
    case "$fmt4" in
      *Name*) echo "$FAKE_VOL" ;;
      *owner*) echo "\${FAKE_VOLUME_OWNER:-$FAKE_OWNER}" ;;
      *phase*) echo "$FAKE_PHASE" ;;
      *) echo "" ;;
    esac
    exit 0 ;;
esac
exit 0
`);
    chmodSync(join(bin, 'docker'), 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      DOCKER_CALLS: calls,
      MAX236_REALA_STATE_DIR: dir,
      MAX236_REALA_HANDLE: join(dir, 'handle.json'),
      FAKE_CID: CID, FAKE_IMAGE: IMAGE, FAKE_OWNER: OWNER, FAKE_PHASE: 'P0-REAL-A',
      FAKE_VOL: VOL, FAKE_NET: NET, FAKE_NETID: NETID, FAKE_PORT: '33440',
      ...overrides,
    };
    const read = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean);
    return { dir, env, read, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  const mutations = (lines: string[]) => lines.filter(line =>
    line.startsWith('stop ') || line.startsWith('rm ') || line.startsWith('network rm ')
    || line.startsWith('volume rm ') || line.startsWith('exec '));

  it.skipIf(skip)('env-clean verifies every object before it removes anything', () => {
    const fixture = setup();
    try {
      execFileSync('bash', [join(REAL_A, 'env-clean.sh')], { env: fixture.env, encoding: 'utf8' });
      const lines = fixture.read();
      const firstMutation = lines.findIndex(line => mutations([line]).length > 0);
      expect(firstMutation).toBeGreaterThan(0);
      const verified = lines.slice(0, firstMutation);
      expect(verified.some(line => line.includes('network inspect') && line.includes('owner'))).toBe(true);
      expect(verified.some(line => line.includes('volume inspect') && line.includes('owner'))).toBe(true);
      expect(lines[firstMutation]).toMatch(/^stop /);
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(skip)('env-clean performs ZERO actions when a volume label changed', () => {
    const fixture = setup({ FAKE_VOLUME_OWNER: 'foreign-owner' });
    try {
      expect(() => execFileSync('bash', [join(REAL_A, 'env-clean.sh')], { env: fixture.env, encoding: 'utf8', stdio: 'pipe' }))
        .toThrow();
      const lines = fixture.read();
      expect(mutations(lines)).toEqual([]);
      expect(lines.some(line => line.includes('volume inspect'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  // A non-zero `inspect` may be a daemon/permission/transient failure, so it is
  // never read as "already absent". Each object's failed probe must refuse with
  // zero stop/rm/volume-rm calls and keep the creation record.
  const failedInspect = (failMode: string, expectedCall: string) => {
    const fixture = setup({ FAKE_FAIL: failMode });
    try {
      expect(() => execFileSync('bash', [join(REAL_A, 'env-clean.sh')], { env: fixture.env, encoding: 'utf8', stdio: 'pipe' }))
        .toThrow();
      const lines = fixture.read();
      expect({ actions: mutations(lines), handleKept: existsSync(join(fixture.dir, 'handle.json')) })
        .toEqual({ actions: [], handleKept: true });
      expect(lines.some(line => line.includes(expectedCall))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  };

  it.skipIf(skip)('Chief: unknown network inspect refuses before any cleanup mutation', () => {
    failedInspect('network-inspect', 'network inspect');
  });

  it.skipIf(skip)('env-clean refuses when the container inspect failed (not absent)', () => {
    failedInspect('container-inspect', 'container inspect');
  });

  it.skipIf(skip)('env-clean refuses when the volume inspect failed (not absent)', () => {
    failedInspect('volume-inspect', 'volume inspect');
  });

  it.skipIf(skip)('run-evidence SQL verifies the exact container before docker exec', () => {
    const fixture = setup();
    try {
      execFileSync('bash', ['-c', 'source "$EVIDENCE_SCRIPT"; sql "SELECT 1"'], {
        env: { ...fixture.env, EVIDENCE_SCRIPT: join(REAL_A, 'run-evidence.sh') },
        encoding: 'utf8',
      });
      const lines = fixture.read();
      const exec = lines.findIndex(line => line.startsWith('exec -i '));
      expect(exec).toBeGreaterThan(0);
      expect(lines[exec]).toContain(CID);
      expect(lines.slice(0, exec).some(line => line.includes('network inspect'))).toBe(true);
      expect(lines.slice(0, exec).some(line => line.includes('volume inspect'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(skip)('run-evidence SQL performs ZERO actions when the container image changed', () => {
    const fixture = setup({ FAKE_IMAGE: `sha256:${'d'.repeat(64)}` });
    try {
      expect(() => execFileSync('bash', ['-c', 'source "$EVIDENCE_SCRIPT"; sql "SELECT 1"'], {
        env: { ...fixture.env, EVIDENCE_SCRIPT: join(REAL_A, 'run-evidence.sh') },
        encoding: 'utf8', stdio: 'pipe',
      })).toThrow();
      expect(mutations(fixture.read())).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(skip)('run-evidence SQL refuses a resource outside the recorded allow-list', () => {
    const fixture = setup();
    try {
      expect(() => execFileSync('bash', ['-c', 'source "$EVIDENCE_SCRIPT"; sql_for network_device:9301 "SELECT 1"'], {
        env: { ...fixture.env, EVIDENCE_SCRIPT: join(REAL_A, 'run-evidence.sh') },
        encoding: 'utf8', stdio: 'pipe',
      })).toThrow();
      expect(mutations(fixture.read())).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
