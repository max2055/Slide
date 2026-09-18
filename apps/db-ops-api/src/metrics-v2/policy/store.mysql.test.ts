import mysql, { type Pool } from 'mysql2/promise';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { createBuiltinRegistry, builtinReleases } from '../packages/builtins.js';
import { sealRelease } from '../packages/model.js';
import { MysqlPolicyStore } from './store.js';
import { PolicyService } from './service.js';
import { admin, pin, at, resource, capabilities } from './test-support.js';

// Explicit disposable localhost database; never loads application .env.
const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
describe.skipIf(!port)('policy isolated MySQL', () => {
  let root: Pool, pool: Pool, store: MysqlPolicyStore, service: PolicyService;
  const database = `max69_${process.pid}`;
  const ref = { type: 'instance' as const, id: 1 };
  const runner = () => new MigrationRunner(pool as unknown as MigrationPool);
  const registry = createBuiltinRegistry();
  const upgraded = sealRelease({ ...builtinReleases()[0], package: { ...builtinReleases()[0].package, version: '1.1.0' },
    recommendations: { ...builtinReleases()[0].recommendations, interval_ms: 90000 } });
  registry.install(upgraded);
  const upgradePin = { id: upgraded.package.id, version: upgraded.package.version, digest: upgraded.package.digest };
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 8 });
    await runner().run();
    await pool.execute("INSERT INTO database_instances (name, db_type, host, port, username, password_encrypted) VALUES ('fixture', 'mysql', 'localhost', 3306, 'fixture', 'canary-encrypted')");
    store = new MysqlPolicyStore(() => pool);
    service = new PolicyService(store, registry, { exists: async () => true, inventory: async ref => resource(ref.id) }, () => at);
  }, 120000);
  afterAll(async () => { await pool?.end(); if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); } });
  beforeEach(async () => {
    for (const table of ['metric_v2_policy_bindings', 'metric_v2_policy_groups', 'metric_v2_policy_audit']) await pool.query(`DELETE FROM ${table}`);
  });
  const create = (id = 1, group_id: string | null = null) => service.changeBinding(admin, { ...ref, id }, { expected_revision: 0, package: pin, group_id }, true);
  it('full migration succeeds and rerun preserves ledger and legacy data', async () => {
    const before = await runner().inspect(); await runner().run(); expect(await runner().inspect()).toEqual(before);
    expect(before.find(m => m.migration_id === '099_metric_v2_policy.sql')?.status).toBe('completed');
    const [rows] = await pool.query<any[]>("SELECT password_encrypted FROM database_instances WHERE name = 'fixture'");
    expect(rows[0].password_encrypted).toBe('canary-encrypted');
  });
  it('persists across service instances and audits without credentials', async () => {
    await create();
    const restarted = new PolicyService(new MysqlPolicyStore(() => pool), registry, { exists: async () => true, inventory: async () => resource() }, () => at);
    expect((await restarted.binding(admin, ref)).binding.package).toEqual(pin);
    expect((await restarted.binding(admin, ref)).application.applied_revision).toBeNull();
    expect(await restarted.audits(admin, ref)).toMatchObject([{ revision: 1, action: 'binding.publish' }]);
    expect(JSON.stringify(await restarted.binding(admin, ref))).not.toContain('canary-encrypted');
  });
  it('serializes competing initial inserts and subsequent revision updates', async () => {
    const initial = await Promise.allSettled([create(), create()]);
    expect(initial.filter(v => v.status === 'fulfilled')).toHaveLength(1);
    expect((initial.find(v => v.status === 'rejected') as PromiseRejectedResult).reason.message).toBe('POLICY_REVISION_CONFLICT');
    const changes = await Promise.allSettled([1, 2].map(() => service.changeBinding(admin, ref, { expected_revision: 1 }, true)));
    expect(changes.filter(v => v.status === 'fulfilled')).toHaveLength(1);
    expect((await service.binding(admin, ref)).binding.revision).toBe(2);
    expect(await service.audits(admin, ref)).toHaveLength(2);
  });
  it('group membership invalidates stale preview revision, and group publication increments members atomically', async () => {
    await service.changeGroup(admin, 'g', { expected_revision: 0, overrides: {} }, true);
    await create(1, 'g');
    const preview = await service.changeGroup(admin, 'g', { expected_revision: 2, overrides: { enabled: 'disable' } }, false);
    expect(preview.affected_resources).toBe(1); await create(2, 'g');
    await expect(service.changeGroup(admin, 'g', { expected_revision: 2, overrides: { enabled: 'disable' } }, true)).rejects.toThrow('POLICY_REVISION_CONFLICT');
    const result = await service.changeGroup(admin, 'g', { expected_revision: 3, overrides: { enabled: 'disable' } }, true);
    expect(result.resources.map(r => r.binding.revision)).toEqual([2, 2]);
    expect(result.requests_per_hour_after).toBe(0);
    expect((await service.binding(admin, { ...ref, id: 2 })).resolved.settings.enabled).toBe(false);
  });
  it('invalid group combination leaves all members, group and audit unchanged', async () => {
    await service.changeGroup(admin, 'g', { expected_revision: 0, overrides: {} }, true);
    await create(1, 'g'); await create(2, 'g');
    await service.changeBinding(admin, { ...ref, id: 2 }, { expected_revision: 1, overrides: { timeout_ms: { mode: 'set', value: 15000 } } }, true);
    const group = await service.group(admin, 'g');
    await expect(service.changeGroup(admin, 'g', { expected_revision: group.revision, overrides: { interval_ms: { mode: 'set', value: 10000 } } }, true)).rejects.toThrow('POLICY_TIMEOUT');
    expect(await service.group(admin, 'g')).toEqual(group); expect((await service.binding(admin, ref)).binding.revision).toBe(1);
    expect(await service.audits(admin, ref)).toHaveLength(1);
  });
  it('audit failure rolls back binding and membership changes in the real transaction', async () => {
    await create();
    await pool.query("CREATE TRIGGER policy_audit_failure BEFORE INSERT ON metric_v2_policy_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture audit failure'");
    try {
      await expect(service.changeBinding(admin, ref, { expected_revision: 1, overrides: { enabled: 'disable' } }, true)).rejects.toThrow('fixture audit failure');
      expect((await service.binding(admin, ref)).binding.revision).toBe(1); expect(await service.audits(admin, ref)).toHaveLength(1);
    } finally { await pool.query('DROP TRIGGER policy_audit_failure'); }
  });
  it('upgrade and rollback retain user overrides, clear old capability evidence and never affect other resources', async () => {
    await create(); await create(2);
    await service.changeBinding(admin, ref, { expected_revision: 1, overrides: { timeout_ms: { mode: 'set', value: 4000 } } }, true);
    await store.reportCapabilities(ref, 2, capabilities(), null);
    const upgraded = await service.changeBinding(admin, ref, { expected_revision: 2, package: upgradePin }, true);
    expect(upgraded.resources[0].resolved.settings).toMatchObject({ timeout_ms: 4000, interval_ms: 90000 });
    expect(await store.transaction(tx => tx.capabilities(ref))).toEqual([]);
    const rollback = await service.changeBinding(admin, ref, { expected_revision: 3, package: pin }, true);
    expect(rollback.resources[0].resolved.settings).toMatchObject({ timeout_ms: 4000, interval_ms: 60000 });
    expect((await service.binding(admin, { ...ref, id: 2 })).binding.revision).toBe(1);
  });
  it('separates published and applied revision; stale reports are rejected', async () => {
    await create(); await store.reportApplied(ref, 1, at, 'applied');
    await service.changeBinding(admin, ref, { expected_revision: 1, overrides: { enabled: 'disable' } }, true);
    expect((await service.binding(admin, ref)).application).toMatchObject({ status: 'pending', applied_revision: 1 });
    await expect(store.reportApplied(ref, 1, at, 'applied')).rejects.toThrow('POLICY_REVISION_CONFLICT');
    await store.reportApplied(ref, 2, at, 'failed'); expect((await service.binding(admin, ref)).application.applied_revision).toBe(1);
    await store.reportApplied(ref, 2, at, 'applied'); expect((await service.binding(admin, ref)).application.applied_revision).toBe(2);
  });
  it('timeout preserves capability evidence and overrides; expired evidence resolves unknown on query', async () => {
    await create(); await store.reportCapabilities(ref, 1, capabilities(), null);
    const before = await service.binding(admin, ref);
    await store.reportCapabilities(ref, 1, [], 'timeout');
    expect(await service.binding(admin, ref)).toEqual(before);
    expect(await store.transaction(tx => tx.capabilities(ref))).toEqual(capabilities());
    expect((await service.effective(admin, ref)).resolved.plan.entries[0].decision).toBe('collect');
    const future = new PolicyService(store, registry, { exists: async () => true, inventory: async () => resource() }, () => '2026-09-20T00:00:00.000Z');
    expect((await future.effective(admin, ref)).resolved.plan.entries[0].decision).toBe('capability_unknown');
    await expect(store.reportCapabilities(ref, 2, capabilities(), null)).rejects.toThrow('POLICY_REVISION_CONFLICT');
    await expect(store.reportCapabilities(ref, 1, capabilities(2), null)).rejects.toThrow('POLICY_CAPABILITY_IDENTITY');
  });
});
