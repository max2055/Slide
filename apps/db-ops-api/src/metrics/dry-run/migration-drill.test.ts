/**
 * MAX-236 stage-11 focused checks for the isolated migration/rollback drill.
 *
 * These prove the reference model's rules, not a real migration: every
 * resource below is a fixture. The real 33-identity evidence lives in
 * `docs/slide/development/MAX-236/10-legacy-identity-disposition-ledger.md`;
 * the three resource classes here are the drill inputs, and the
 * network_device one is synthetic because the platform currently has 0 devices.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMigration, digestOf, dispose, identityKey, planMigration, rollbackMigration,
  runScenario, verifyPreservation,
  type AuditEntry, type DrillResource, type DrillScenario, type IdentityInput,
  type TemplatePin,
} from './migration-drill.js';

const AT = '2026-10-26T16:00:00.000Z';
const hash = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const pin = (template_id: string, version = 1): TemplatePin =>
  ({ template_id, version, content_hash: hash(template_id.replace(/\W/g, 'x')) });

const identity = (overrides: Partial<IdentityInput> = {}): IdentityInput => ({
  resource_type: 'instance', engine: 'mysql', old_id: 'connections', unit: 'count',
  target_metric_id: 'mysql.processlist.count', target_unit: 'count', in_scope: true,
  has_custom_sql: false, custom_sql_reviewed: false, ...overrides,
});

const entry = (id: number, action: string, resource_key: string): AuditEntry =>
  ({ id, actor: 'admin', action, resource_key, detail: { fixture: true }, at: AT });

const resource = (overrides: Partial<DrillResource> = {}): DrillResource => ({
  resource_key: 'instance:1',
  resource_type: 'instance',
  engine: 'mysql',
  credential_refs: ['credential:asset-instance-1'],
  acl: [],
  legacy_history: { metrics_history: 776 },
  audit: [entry(1, 'publish', 'instance:1')],
  revisions: [{ revision: 1, pins: [], package: 'mysql-diagnostics@1.1.0#sha256:abc',
    migration_digest: null, reason: 'legacy single package', at: AT }],
  schedules: ['instance:1'],
  event_ids: ['alert:4101'],
  ...overrides,
});

// The instance scenario mirrors the MySQL half of the real 33 identities:
// mapped identities, identities with no proven equivalent, and one unit review.
const instanceIdentities = [
  identity({ old_id: 'connections', target_metric_id: 'mysql.processlist.count' }),
  identity({ old_id: 'buffer_pool_hit_rate', unit: '%', target_metric_id: 'mysql.buffer_pool.read_hit_percent', target_unit: '%' }),
  identity({ old_id: 'qps', unit: 'ops/s', target_metric_id: null, target_unit: null }),
  identity({ old_id: 'cpu_usage', unit: '%', target_metric_id: null, target_unit: null }),
  identity({ old_id: 'disk_usage', unit: '%', target_metric_id: 'mysql.tables.allocated_bytes', target_unit: 'By' }),
  identity({ resource_type: 'instance', engine: 'postgresql', old_id: 'qps', unit: 'ops/s',
    target_metric_id: null, target_unit: null, in_scope: false }),
];

const serverIdentities = [
  identity({ resource_type: 'server', engine: null, old_id: 'cpu_usage', unit: '%',
    target_metric_id: 'linux.cpu.user_system_percent', target_unit: '%' }),
  identity({ resource_type: 'server', engine: null, old_id: 'memory_usage', unit: '%',
    target_metric_id: 'linux.memory.used_percent', target_unit: '%' }),
  identity({ resource_type: 'server', engine: null, old_id: 'disk_usage', unit: '%',
    target_metric_id: null, target_unit: null }),
];

// Synthetic: the platform has 0 network devices. Only the mechanics are proven.
const deviceIdentities = [
  identity({ resource_type: 'network_device', engine: null, old_id: 'device_uptime_seconds', unit: 'seconds',
    target_metric_id: 'snmp.agent.uptime_seconds', target_unit: 'seconds' }),
  identity({ resource_type: 'network_device', engine: null, old_id: 'interface_oper_status', unit: 'state',
    target_metric_id: null, target_unit: null }),
];

const scenario = (overrides: Partial<DrillScenario> = {}): DrillScenario => ({
  name: 'instance',
  resource: resource(),
  identities: instanceIdentities,
  template: pin('tpl-db-basic'),
  actor: 'admin',
  at: AT,
  ...overrides,
});

describe('D8 disposition', () => {
  it('maps only an explicit target with an identical unit', () => {
    const row = dispose(identity());
    expect(row.disposition).toBe('mapped');
    expect(row.actions[0]).toContain('canonical identity');
  });

  it('keeps legacy when no equivalent is proven', () => {
    expect(dispose(identity({ target_metric_id: null, target_unit: null })).disposition).toBe('keep-legacy');
  });

  it('keeps legacy instead of converting a unit', () => {
    const row = dispose(identity({ unit: '%', target_unit: 'By' }));
    expect(row.disposition).toBe('keep-legacy');
    expect(row.reason).toContain('UNIT_REVIEW_REQUIRED');
    expect(row.actions.join(' ')).toContain('no silent unit conversion');
  });

  it('keeps legacy until a many-to-one provider is chosen', () => {
    expect(dispose(identity({ ambiguous_provider: true })).disposition).toBe('keep-legacy');
  });

  it('blocks a target the catalog lacks', () => {
    expect(dispose(identity({ target_missing: true })).disposition).toBe('blocked');
  });

  it('blocks unreviewed custom SQL and allows reviewed SQL', () => {
    expect(dispose(identity({ has_custom_sql: true })).disposition).toBe('blocked');
    expect(dispose(identity({ has_custom_sql: true, custom_sql_reviewed: true })).disposition).toBe('mapped');
  });

  it('never maps a catalog-only identity', () => {
    const row = dispose(identity({ in_scope: false }));
    expect(row.disposition).toBe('keep-legacy');
    expect(row.in_scope).toBe(false);
  });

  it('uses a stable identity key', () => {
    expect(identityKey(identity())).toBe('instance:mysql:connections');
    expect(identityKey(identity({ resource_type: 'server', engine: null }))).toBe('server:-:connections');
  });
});

describe('plan', () => {
  it('is deterministic regardless of identity input order', () => {
    const a = planMigration(resource(), instanceIdentities, { template: pin('tpl-db-basic') });
    const b = planMigration(resource(), [...instanceIdentities].reverse(), { template: pin('tpl-db-basic') });
    expect(a.digest).toBe(b.digest);
    expect(a.rows.map(row => row.identity)).toEqual(a.rows.map(row => row.identity).sort());
  });

  it('changes the digest when a disposition changes', () => {
    const a = planMigration(resource(), instanceIdentities, { template: pin('tpl-db-basic') });
    const changed = instanceIdentities.map(input => input.old_id === 'qps' && input.in_scope
      ? identity({ ...input, target_metric_id: 'mysql.queries.per_second', target_unit: 'ops/s' }) : input);
    const b = planMigration(resource(), changed, { template: pin('tpl-db-basic') });
    expect(b.digest).not.toBe(a.digest);
  });

  it('carries object blockers and identity blockers into the gate', () => {
    const blockedIdentity = instanceIdentities.map(input => input.old_id === 'connections'
      ? identity({ target_missing: true }) : input);
    const plan = planMigration(resource(), blockedIdentity,
      { objectBlockers: ['PACKAGE_PIN_DRIFT:instance:1'], template: pin('tpl-db-basic') });
    expect(plan.cutover_allowed).toBe(false);
    expect(plan.blockers).toContain('PACKAGE_PIN_DRIFT:instance:1');
    expect(plan.blockers).toContain('instance:mysql:connections');
  });

  it('refuses a cutover with nothing mapped', () => {
    const plan = planMigration(resource(), [identity({ target_metric_id: null, target_unit: null })],
      { template: pin('tpl-db-basic') });
    expect(plan.pins).toEqual([]);
    expect(plan.cutover_allowed).toBe(false);
  });
});

describe('three resource classes', () => {
  it('runs the instance scenario end to end', () => {
    const result = runScenario(scenario());
    expect(result.cutover_allowed).toBe(true);
    expect(result.applied).toBe('applied');
    expect(result.idempotent).toBe(true);
    expect(result.rollback_exact).toBe(true);
    expect(result.preserved).toBe(true);
  });

  it('runs the server scenario end to end', () => {
    const result = runScenario(scenario({
      name: 'server',
      resource: resource({ resource_key: 'server:3', resource_type: 'server', engine: null,
        credential_refs: ['credential:asset-server-3'], legacy_history: { server_metrics: 120 },
        schedules: ['server:3'], event_ids: [] }),
      identities: serverIdentities,
      template: pin('tpl-server-basic'),
    }));
    expect(result.cutover_allowed).toBe(true);
    expect(result.applied).toBe('applied');
    expect(result.preserved).toBe(true);
  });

  it('runs the synthetic network_device scenario for mechanics only', () => {
    const result = runScenario(scenario({
      name: 'network_device',
      resource: resource({ resource_key: 'network_device:9', resource_type: 'network_device', engine: null,
        credential_refs: ['credential:netdev-9'], acl: ['role:network-operator'],
        legacy_history: { network_device_observations: 480 },
        schedules: ['network_device:9'], event_ids: [] }),
      identities: deviceIdentities,
      template: pin('tpl-network-basic'),
    }));
    expect(result.cutover_allowed).toBe(true);
    expect(result.applied).toBe('applied');
    expect(result.preserved).toBe(true);
    // A zero-device platform cannot make this synthetic case a real acceptance.
    expect(result.name).toBe('network_device');
  });
});

describe('idempotency and rollback', () => {
  it('does not create a second revision or audit row when re-applied', () => {
    const base = resource();
    const plan = planMigration(base, instanceIdentities, { template: pin('tpl-db-basic') });
    const first = applyMigration(base, plan, { actor: 'admin', at: AT });
    const second = applyMigration(first.resource, plan, { actor: 'admin', at: AT });
    expect(second.outcome).toBe('noop');
    expect(second.resource.revisions).toHaveLength(first.resource.revisions.length);
    expect(second.resource.audit).toHaveLength(first.resource.audit.length);
    expect(first.resource.revisions.at(-1)?.revision).toBe(2);
  });

  it('rolls back by appending a revision that points at the old pin set', () => {
    const base = resource({
      revisions: [{ revision: 1, pins: [pin('tpl-legacy-a'), pin('tpl-legacy-b')],
        package: null, migration_digest: null, reason: 'multi-template baseline', at: AT }],
    });
    const plan = planMigration(base, instanceIdentities, { template: [pin('tpl-db-basic'), pin('tpl-db-shared')] });
    const applied = applyMigration(base, plan, { actor: 'admin', at: AT });
    expect(applied.resource.revisions.at(-1)?.pins).toHaveLength(2);
    const back = rollbackMigration(applied.resource, {
      target_revision: 1, expected_current_revision: applied.resource.revisions.at(-1)!.revision,
      actor: 'admin', at: AT,
    });
    expect(back.resource.revisions.map(revision => revision.revision)).toEqual([1, 2, 3]);
    expect(back.resource.revisions.at(-1)?.pins).toEqual([pin('tpl-legacy-a'), pin('tpl-legacy-b')]);
    expect(back.resource.revisions.at(-1)?.package).toBeNull();
    expect(verifyPreservation(applied.resource, back.resource).ok).toBe(true);
  });

  it('reports exact rollback and multi-template preservation', () => {
    const base = resource({
      revisions: [{ revision: 1, pins: [pin('tpl-legacy-a'), pin('tpl-legacy-b')],
        package: null, migration_digest: null, reason: 'multi-template baseline', at: AT }],
    });
    const result = runScenario(scenario({ resource: base, template: [pin('tpl-db-basic'), pin('tpl-db-shared')] }));
    expect(result.rollback_exact).toBe(true);
    expect(result.multi_template_preserved).toBe(true);
    expect(result.preserved).toBe(true);
  });

  it('refuses a rollback to a missing revision', () => {
    expect(() => rollbackMigration(resource(), {
      target_revision: 99, expected_current_revision: 1, actor: 'admin', at: AT,
    })).toThrow(/DRILL_ROLLBACK_TARGET_MISSING/);
  });

  it('refuses a rollback computed against a stale current revision', () => {
    const base = resource();
    const plan = planMigration(base, instanceIdentities, { template: pin('tpl-db-basic') });
    const applied = applyMigration(base, plan, { actor: 'admin', at: AT });
    const current = applied.resource.revisions.at(-1)!.revision;
    expect(() => rollbackMigration(applied.resource, {
      target_revision: 1, expected_current_revision: current - 1, actor: 'admin', at: AT,
    })).toThrow(/DRILL_ROLLBACK_CONFLICT/);
    expect(applied.resource.revisions.at(-1)!.revision).toBe(current);
  });
});

/**
 * stage12 M1/M2 safety fences. These are the four independent counterexamples
 * from `chief-stage11-review-20261027.md`, reproduced in the accepted suite,
 * plus the digest/rollback fences that keep a plan inside its own resource.
 */
describe('stage12 plan safety', () => {
  it('never maps an identity whose canonical unit is unknown', () => {
    const row = dispose(identity({ target_unit: null }));
    expect(row.disposition).not.toBe('mapped');
    expect(row.reason).toContain('CANONICAL_UNIT_UNPROVEN');

    const plan = planMigration(resource(), [identity({ target_unit: null })], { template: pin('tpl-db-basic') });
    expect(plan.rows.every(entry => entry.disposition !== 'mapped')).toBe(true);
    expect(plan.pins).toEqual([]);
    expect(plan.cutover_allowed).toBe(false);
  });

  it('does not let a PostgreSQL identity authorize a MySQL migration', () => {
    const plan = planMigration(resource(), [identity({
      engine: 'postgresql', target_metric_id: 'postgresql.connections.count',
    })], { template: pin('tpl-db-basic') });
    expect(plan.rows).toEqual([]);
    expect(plan.cutover_allowed).toBe(false);
    expect(plan.pins).toEqual([]);
  });

  it('refuses to apply a plan made for another resource', () => {
    const original = resource();
    const plan = planMigration(original, instanceIdentities, { template: pin('tpl-db-basic') });
    const other = resource({
      resource_key: 'instance:2',
      credential_refs: ['credential:asset-instance-2'],
      schedules: ['instance:2'],
    });
    expect(() => applyMigration(other, plan, { actor: 'admin', at: AT }))
      .toThrow(/DRILL_PLAN_RESOURCE_MISMATCH/);
    expect(other.revisions).toHaveLength(1);
    expect(other.audit).toHaveLength(1);
  });

  it('refuses a revision-1 plan once the resource is at revision 2', () => {
    const original = resource();
    const plan = planMigration(original, instanceIdentities, { template: pin('tpl-db-basic') });
    const advanced = resource();
    advanced.revisions.push({ ...advanced.revisions[0]!, revision: 2, reason: 'concurrent update' });
    expect(() => applyMigration(advanced, plan, { actor: 'admin', at: AT }))
      .toThrow(/DRILL_PLAN_STALE/);
    expect(advanced.revisions.at(-1)?.revision).toBe(2);
    expect(advanced.audit).toHaveLength(1);
  });

  it('refuses a plan whose digest does not match its content', () => {
    const original = resource();
    const plan = planMigration(original, instanceIdentities, { template: pin('tpl-db-basic') });
    const forged = { ...plan, pins: [pin('tpl-forged')] };
    expect(() => applyMigration(original, forged, { actor: 'admin', at: AT }))
      .toThrow(/DRILL_PLAN_DIGEST_MISMATCH/);
    expect(original.revisions).toHaveLength(1);
  });

  it('binds base revision, resource identity and blockers into the digest', () => {
    const base = planMigration(resource(), instanceIdentities, { template: pin('tpl-db-basic') });
    const blocked = planMigration(resource(), instanceIdentities,
      { template: pin('tpl-db-basic'), objectBlockers: ['PACKAGE_PIN_DRIFT:instance:1'] });
    const nextRevision = resource();
    nextRevision.revisions.push({ ...nextRevision.revisions[0]!, revision: 2, reason: 'advance' });
    const later = planMigration(nextRevision, instanceIdentities, { template: pin('tpl-db-basic') });
    const otherEngine = planMigration(resource({ engine: 'postgresql' }), instanceIdentities,
      { template: pin('tpl-db-basic') });
    expect(new Set([base.digest, blocked.digest, later.digest, otherEngine.digest]).size).toBe(4);
  });

  it('treats an exact replay as a no-op and allows a plan built at the current revision', () => {
    const base = resource();
    const plan = planMigration(base, instanceIdentities, { template: pin('tpl-db-basic') });
    const applied = applyMigration(base, plan, { actor: 'admin', at: AT });
    expect(applyMigration(applied.resource, plan, { actor: 'admin', at: AT }).outcome).toBe('noop');
    const later = planMigration(applied.resource, instanceIdentities, { template: pin('tpl-db-basic') });
    const second = applyMigration(applied.resource, later, { actor: 'admin', at: AT });
    expect(second.outcome).toBe('applied');
    expect(second.resource.revisions.at(-1)?.revision).toBe(3);
  });
});

describe('stage13 exact replay', () => {
  const appliedFixture = () => {
    const base = resource();
    const plan = planMigration(base, instanceIdentities, { template: pin('tpl-db-basic') });
    const applied = applyMigration(base, plan, { actor: 'admin', at: AT }).resource;
    return { plan, applied };
  };

  it('keeps a legal exact replay a no-op with the same revisions and audit', () => {
    const { plan, applied } = appliedFixture();
    const replay = applyMigration(applied, plan, { actor: 'admin', at: AT });
    expect(replay.outcome).toBe('noop');
    expect(replay.written).toBe(0);
    expect(replay.resource.revisions).toEqual(applied.revisions);
    expect(replay.resource.audit).toEqual(applied.audit);
  });

  it('refuses a matching digest when the current pins drifted', () => {
    const { plan, applied } = appliedFixture();
    const drifted = JSON.parse(JSON.stringify(applied)) as DrillResource;
    drifted.revisions.at(-1)!.pins = [];
    expect(() => applyMigration(drifted, plan, { actor: 'admin', at: AT }))
      .toThrow(/DRILL_REPLAY_CONFLICT/);
    expect(drifted.revisions).toHaveLength(applied.revisions.length);
    expect(drifted.audit).toHaveLength(applied.audit.length);
    expect(drifted.revisions.at(-1)!.pins).toEqual([]);
  });

  it('refuses a matching digest when the current revision advanced', () => {
    const { plan, applied } = appliedFixture();
    const drifted = JSON.parse(JSON.stringify(applied)) as DrillResource;
    drifted.revisions.at(-1)!.revision += 1;
    expect(() => applyMigration(drifted, plan, { actor: 'admin', at: AT }))
      .toThrow(/DRILL_REPLAY_CONFLICT/);
    expect(drifted.revisions).toHaveLength(applied.revisions.length);
    expect(drifted.audit).toHaveLength(applied.audit.length);
    expect(drifted.revisions.at(-1)!.revision).toBe(applied.revisions.at(-1)!.revision + 1);
  });

  it('refuses a matching digest when the current result still carries a legacy package', () => {
    const { plan, applied } = appliedFixture();
    const drifted = JSON.parse(JSON.stringify(applied)) as DrillResource;
    drifted.revisions.at(-1)!.package = 'mysql-diagnostics@1.1.0#sha256:legacy';
    expect(() => applyMigration(drifted, plan, { actor: 'admin', at: AT }))
      .toThrow(/DRILL_REPLAY_CONFLICT/);
    expect(drifted.revisions).toHaveLength(applied.revisions.length);
    expect(drifted.audit).toHaveLength(applied.audit.length);
  });

  it('cannot reuse a digest when the invocation content changed', () => {
    const { plan, applied } = appliedFixture();
    const changed = { ...plan, pins: [pin('tpl-db-shared')] };
    expect(() => applyMigration(applied, changed, { actor: 'admin', at: AT }))
      .toThrow(/DRILL_PLAN_DIGEST_MISMATCH/);
    expect(applied.revisions).toHaveLength(2);
    expect(applied.audit).toHaveLength(2);
  });
});

describe('refusal and failure injection', () => {
  it('refuses a blocked object without touching it', () => {
    const base = resource();
    const result = runScenario(scenario({ resource: base, objectBlockers: ['ROLLOUT_WITHOUT_BINDING:instance:1'] }));
    expect(result.applied).toBe('refused');
    expect(result.error).toContain('DRILL_CUTOVER_BLOCKED');
    expect(result.preserved).toBe(true);
    expect(base.revisions).toHaveLength(1);
  });

  it('leaves the state untouched at every injected failure point', () => {
    const base = resource();
    const plan = planMigration(base, instanceIdentities, { template: pin('tpl-db-basic') });
    for (const failAt of ['before-write', 'after-binding', 'before-audit'] as const) {
      expect(() => applyMigration(base, plan, { actor: 'admin', at: AT, failAt }))
        .toThrow(/DRILL_INJECTED_FAILURE/);
    }
    expect(base.revisions).toHaveLength(1);
    expect(base.audit).toHaveLength(1);
  });
});

describe('preservation', () => {
  const changed = (mutate: (copy: DrillResource) => void) => {
    const before = resource();
    const copy = JSON.parse(JSON.stringify(before)) as DrillResource;
    mutate(copy);
    return verifyPreservation(before, copy);
  };

  it('accepts an unchanged resource', () => {
    expect(verifyPreservation(resource(), resource()).ok).toBe(true);
  });

  it('detects rewritten history', () => {
    const report = changed(copy => { copy.legacy_history.metrics_history = 775; });
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.name === 'history')?.ok).toBe(false);
  });

  it('detects a plaintext credential instead of a reference', () => {
    const report = changed(copy => { copy.credential_refs = ['hunter2']; });
    expect(report.checks.find(check => check.name === 'credentials')?.ok).toBe(false);
  });

  it('detects widened ACL', () => {
    const report = changed(copy => { copy.acl = ['role:admin']; });
    expect(report.checks.find(check => check.name === 'acl')?.ok).toBe(false);
  });

  it('detects a rewritten audit entry', () => {
    const report = changed(copy => { copy.audit[0]!.action = 'rewritten'; });
    expect(report.checks.find(check => check.name === 'audit-append-only')?.ok).toBe(false);
  });

  it('detects a dropped revision', () => {
    const report = changed(copy => { copy.revisions = []; });
    expect(report.checks.find(check => check.name === 'revisions-retained')?.ok).toBe(false);
  });

  it('detects a second executor for the same resource', () => {
    const report = changed(copy => { copy.schedules = ['instance:1', 'instance:1:shadow']; });
    expect(report.checks.find(check => check.name === 'single-executor')?.ok).toBe(false);
  });

  it('detects a re-fired event', () => {
    const report = changed(copy => { copy.event_ids = ['alert:4101', 'alert:4102']; });
    expect(report.checks.find(check => check.name === 'events-unchanged')?.ok).toBe(false);
  });
});

describe('digest', () => {
  it('is canonical for object key order', () => {
    expect(digestOf({ a: 1, b: [2, 3] })).toBe(digestOf({ b: [2, 3], a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });
});
