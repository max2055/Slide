import { describe, expect, it } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyService } from './service.js';
import { type Ref, metricKey } from './model.js';
import { admin, at, capabilities, MemoryPolicyStore, resource } from './test-support.js';

const registry = createConfigurationRegistry();
const pin = (id: string, version: string) => {
  const p = registry.list().find(r => r.package.id === id && r.package.version === version)!.package;
  return { id: p.id, version: p.version, digest: p.digest };
};
const basic = pin('mysql-basic', '2.0.0'), diagnostics = pin('mysql-diagnostics', '1.1.0');
function setup(version = '9.6.0') {
  const store = new MemoryPolicyStore();
  const service = new PolicyService(store, registry, { exists: async () => true, inventory: async ref => {
    if (ref.type === 'server') return { type: ref.type, id: String(ref.id), attributes: {
      'os.family': { value: 'linux', source: 'fixture', observed_at: at },
    } };
    const value = resource(ref.id); value.attributes['db.version'].value = version; return value;
  } }, () => at);
  return { store, service };
}
const ref: Ref = { type: 'instance', id: 1 };

describe('compatible package replacement on an existing binding', () => {
  it.each([
    [ref, basic, diagnostics],
    [{ type: 'server', id: 3 } as Ref, pin('linux-basic', '1.0.0'), pin('linux-host', '1.1.0')],
  ])('previews and publishes %j without replacing the resource or losing overrides', async (target, before, after) => {
    const { service, store } = setup();
    await service.changeGroup(admin, 'ops', { expected_revision: 0, overrides: { max_rows: { mode: 'set', value: 25 } } }, true);
    const overrides = { interval_ms: { mode: 'set', value: 30000 }, enabled: 'enable' };
    await service.changeBinding(admin, target, { expected_revision: 0, package: before, group_id: 'ops', overrides }, true);
    const change = { expected_revision: 1, package: after };
    const preview = await service.changeBinding(admin, target, change, false);
    expect((await service.binding(admin, target)).binding.package).toEqual(before);
    const next = preview.resources[0];
    expect(next.binding).toMatchObject({ resource: target, package: after, group_id: 'ops', overrides, revision: 2 });
    expect(next.resolved.settings).toMatchObject({ interval_ms: 30000, max_rows: 25 });
    expect(next.resolved.sources.max_rows.layer).toBe('group');
    expect(next.resolved.metric_templates.length).toBeGreaterThan((await service.binding(admin, target)).resolved.metric_templates.length);
    expect(preview.requests_per_hour_after).toBeGreaterThan(preview.requests_per_hour_before);
    await service.changeBinding(admin, target, change, true);
    expect(store.bindings.size).toBe(1);
    expect((await service.audits(admin, target)).at(-1)).toMatchObject({ action: 'binding.publish', revision: 2,
      configuration: { package: after, group_id: 'ops', overrides, group: { overrides: { max_rows: { mode: 'set', value: 25 } } } } });
  });

  it('resets old capability evidence, preserves common metric toggles and fences stale CAS', async () => {
    const { service, store } = setup();
    const overrides = { metrics: { 'db.uptime_seconds@1.0.0': 'disable' } };
    await service.changeBinding(admin, ref, { expected_revision: 0, package: basic, overrides }, true);
    store.caps.set('instance:1', capabilities());
    const result = await service.changeBinding(admin, ref, { expected_revision: 1, package: diagnostics }, true);
    expect(result.resources[0].resolved.metric_templates.find(t => t.metric.id === 'db.uptime_seconds')?.enabled).toBe(false);
    expect(store.caps.has('instance:1')).toBe(false);
    expect(result.resources[0].resolved.metric_templates.every(t => t.capability.status === 'unknown')).toBe(true);
    await expect(service.changeBinding(admin, ref, { expected_revision: 1, package: basic }, true)).rejects.toMatchObject({ code: 'POLICY_REVISION_CONFLICT', status: 409 });
  });

  it.each(['resource', 'group'])('rejects incompatible %s metric overrides without silently discarding them', async layer => {
    const { service } = setup('8.0.46');
    const overrides = { metrics: { 'mysql.queries.total@1.0.0': 'disable', 'mysql.queries.per_second@1.0.0': 'disable' } };
    if (layer === 'group') await service.changeGroup(admin, 'legacy', { expected_revision: 0, overrides }, true);
    const original = (await service.changeBinding(admin, ref, { expected_revision: 0, package: pin('mysql-basic', '1.0.0'),
      ...(layer === 'group' ? { group_id: 'legacy' } : { overrides }) }, true)).resources[0];
    await expect(service.changeBinding(admin, ref, { expected_revision: 1, package: basic }, false)).rejects.toMatchObject({ code: 'POLICY_UNKNOWN_METRIC' });
    expect(await service.binding(admin, ref)).toEqual(original);
    // Explicit resource replacement is already the documented overrides contract.
    if (layer === 'resource') expect((await service.changeBinding(admin, ref, { expected_revision: 1, package: basic, overrides: {} }, true)).published).toBe(true);
  });

  it.each([false, true])('rejects an incompatible target version even on direct publish (publish=%s)', async publish => {
    const { service } = setup();
    await service.changeBinding(admin, ref, { expected_revision: 0, package: diagnostics }, true);
    // mysql-basic@1 is deliberately restricted to MySQL 8.0.
    await expect(service.changeBinding(admin, ref, { expected_revision: 1, package: pin('mysql-basic', '1.0.0') }, publish))
      .rejects.toMatchObject({ code: 'PACKAGE_INCOMPATIBLE', status: 422 });
    expect((await service.binding(admin, ref)).binding.revision).toBe(1);
  });

  it('retains resource type, live permission and immutable digest validation', async () => {
    const { service } = setup();
    await service.changeBinding(admin, ref, { expected_revision: 0, package: basic }, true);
    await expect(service.changeBinding(admin, ref, { expected_revision: 1, package: pin('linux-host', '1.1.0') }, true)).rejects.toThrow('POLICY_PACKAGE_RESOURCE');
    await expect(service.changeBinding({ ...admin, permissions: ['instance:view'], instanceScopes: { 1: 'read-only' } }, ref,
      { expected_revision: 1, package: diagnostics }, true)).rejects.toMatchObject({ code: 'POLICY_FORBIDDEN', status: 403 });
    await expect(service.changeBinding(admin, ref, { expected_revision: 1, package: { ...diagnostics, digest: `sha256:${'0'.repeat(64)}` } }, true)).rejects.toThrow('PACKAGE_PIN');
  });

  it('rolls back atomically on audit failure and returns to the prior package through a newer revision', async () => {
    const { service, store } = setup();
    await service.changeBinding(admin, ref, { expected_revision: 0, package: basic }, true);
    store.failAudit = true;
    await expect(service.changeBinding(admin, ref, { expected_revision: 1, package: diagnostics }, true)).rejects.toThrow('audit failed');
    expect((await service.binding(admin, ref)).binding).toMatchObject({ package: basic, revision: 1 });
    store.failAudit = false;
    await service.changeBinding(admin, ref, { expected_revision: 1, package: diagnostics }, true);
    const rollback = await service.changeBinding(admin, ref, { expected_revision: 2, package: basic }, true);
    expect(rollback.resources[0].binding).toMatchObject({ package: basic, revision: 3 });
    expect(rollback.resources[0].resolved.metric_templates.map(t => metricKey(t.metric))).toEqual(['db.uptime_seconds@1.0.0']);
    expect(store.logs.map(a => a.revision)).toEqual([1, 2, 3]);
  });
});
