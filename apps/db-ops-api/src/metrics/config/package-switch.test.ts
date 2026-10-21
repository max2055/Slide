import { describe, expect, it } from 'vitest';
import { MetricConfigurationService } from './service.js';
import { PolicyService } from '../policy/service.js';
import { createConfigurationRegistry } from './registry.js';
import { admin, MemoryPolicyStore, at, resource } from '../policy/test-support.js';
import { AdapterError } from '../packages/adapters.js';

describe('existing binding trial and activation', () => {
  const ref = { type: 'instance' as const, id: 1 };
  async function setup() {
    const store = new MemoryPolicyStore(), registry = createConfigurationRegistry();
    const inventory = () => { const r = resource(); r.attributes['db.version'].value = '9.6.0'; return r; };
    const policy = new PolicyService(store, registry, { exists: async () => true, inventory: async () => inventory() }, () => at);
    const pin = (id: string, version: string) => {
      const p = registry.list().find(r => r.package.id === id && r.package.version === version)!.package;
      return { id: p.id, version: p.version, digest: p.digest };
    };
    await policy.changeGroup(admin, 'ops', { expected_revision: 0, overrides: {} }, true);
    await policy.changeBinding(admin, ref, { expected_revision: 0, package: pin('mysql-basic', '2.0.0'), group_id: 'ops' }, true);
    const state = { reads: 0, releases: 0, fail: false, revoked: false, duringRead: async () => {} };
    const service = new MetricConfigurationService(policy, registry, {
      reserve: async () => ({ connection: { ping: async () => {} }, release: async () => { state.releases++; } }), attempts: async () => [],
    }, { resolve: async () => ({ resource: inventory(), credential_ref: 'credential:fixture', evidence: {},
      resolve: async () => ({ method: 'sql', pool: { query: async () => {
        state.reads++; await state.duringRead(); if (state.fail) throw new AdapterError('timeout');
        // Partial remote support is truthful: uptime succeeds, other shapes are unknown.
        return [[{ Variable_name: 'Uptime', Value: '1000' }], []];
      } } }),
    }) }, { inventory: async () => inventory(), evidence: async () => ({ asset_enabled: true, global_enabled: true, in_flight: false,
      formal: { state: 'pending', generation: null, last_observed_at: null } }) },
      async seed => state.revoked ? { ...seed, permissions: [], instanceScopes: {} } : seed);
    return { store, policy, service, state, input: { expected_revision: 1, package: pin('mysql-diagnostics', '1.1.0') } };
  }
  it('trials the candidate without persistence; activate trials again and leaves formal visibility pending', async () => {
    const s = await setup();
    const trial = await s.service.trial(admin, ref, s.input);
    expect(trial.samples.some(o => o.value !== null && o.quality.status === 'good')).toBe(true);
    expect((await s.policy.binding(admin, ref)).binding.revision).toBe(1);
    const before = s.state.reads;
    const published = await s.service.activate(admin, ref, s.input);
    expect(s.state.reads).toBeGreaterThan(before);
    expect(published.resources[0].binding).toMatchObject({ revision: 2, package: s.input.package, group_id: 'ops' });
    expect(published.status).toMatchObject({ binding: { application: 'pending' }, formal_visibility: { state: 'pending', source: 'none' } });
    expect(s.state.releases).toBe(2);
  });
  it('does not replace the old binding if the target trial fails', async () => {
    const s = await setup(); s.state.fail = true;
    const before = await s.policy.binding(admin, ref);
    await expect(s.service.activate(admin, ref, s.input)).rejects.toThrow('CONFIGURATION_TRIAL_FAILED');
    expect(await s.policy.binding(admin, ref)).toEqual(before);
    expect(s.state.releases).toBe(1);
  });
  it('reloads live grants during a normal single-resource activation without an explicit bulk guard', async () => {
    const s = await setup();
    s.state.duringRead = async () => { s.state.revoked = true; };
    await expect(s.service.activate(admin, ref, s.input)).rejects.toThrow('POLICY_FORBIDDEN');
    expect((await s.policy.binding(admin, ref)).binding).toMatchObject({ revision: 1, package: { id: 'mysql-basic' } });
    expect(s.state.releases).toBe(1);
  });
  it.each(['permission', 'group', 'revision'] as const)('revalidates %s after remote IO and cannot publish a stale candidate', async fault => {
    const s = await setup();
    s.state.duringRead = async () => {
      s.state.duringRead = async () => {};
      if (fault === 'group') {
        const group = await s.policy.group(admin, 'ops');
        await s.policy.changeGroup(admin, 'ops', { expected_revision: group.revision, overrides: { max_rows: { mode: 'set', value: 20 } } }, true);
      } else if (fault === 'revision') await s.policy.changeBinding(admin, ref, { expected_revision: 1, overrides: { enabled: 'disable' } }, true);
    };
    await expect(s.service.activate(admin, ref, s.input, { check: async () => fault === 'permission' && s.state.reads > 0
      ? { ...admin, permissions: [], instanceScopes: {} } : admin })).rejects.toThrow(fault === 'permission' ? 'POLICY_FORBIDDEN' : 'POLICY_REVISION_CONFLICT');
    expect((await s.policy.binding(admin, ref)).binding.package.id).toBe('mysql-basic');
    expect(s.state.releases).toBe(1);
  });
});
