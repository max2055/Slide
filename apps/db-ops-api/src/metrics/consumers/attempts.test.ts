import { beforeEach, describe, expect, it } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyService } from '../policy/service.js';
import { sealRelease } from '../packages/model.js';
import { MemoryPolicyStore, admin, testResources } from '../policy/test-support.js';
import type { CollectionAttempt } from '../../contracts/metrics/index.js';
import { MetricConsumerService } from './service.js';

describe('MAX-517/#530 derived attempt ownership', () => {
  const ref = { type: 'instance' as const, id: 1 }, now = '2026-09-18T00:02:00.000Z';
  const metric = 'mysql.transaction_commands.completed_rate';
  let attempts: CollectionAttempt[], reads: string[], service: MetricConsumerService;
  const attempt = (collector_id: string, second: number, error: CollectionAttempt['error'] = null): CollectionAttempt => ({
    id: `${collector_id}:${second}`, resource_id: '1', binding_id: 'instance:1', collector_id, config_revision: 1,
    started_at: `2026-09-18T00:01:${String(second).padStart(2, '0')}.000Z`,
    ended_at: now, status: error ? 'failed' : 'succeeded', error, observation_ids: [],
  });
  const query = async () => (await service.query(admin, { resource: ref, metric_ids: [metric] })).metrics[0];
  beforeEach(async () => {
    attempts = []; reads = [];
    const registry = createConfigurationRegistry(), store = new MemoryPolicyStore();
    const base = registry.list().find(r => r.package.id === 'mysql-representative')!;
    // A valid package DAG with two distinct SQL collectors plus nested formulas.
    const release = registry.install(sealRelease({ ...base, package: { ...base.package, id: 'fixture-multicollector' },
      derived: base.derived.map(d => d.output.id === metric ? { ...d, inputs: [...d.inputs,
        { id: 'mysql.queries.per_second', semantic_version: '1.0.0' }] } : d) }));
    const policies = new PolicyService(store, registry, testResources, () => now);
    const { id, version, digest } = release.package;
    await policies.changeBinding(admin, ref, { expected_revision: 0, package: { id, version, digest } }, true);
    store.caps.set('instance:1', release.package.collectors.flatMap(c => c.mappings.map(m => ({
      resource_id: '1', metric: m.metric, method: c.method, status: 'supported' as const,
      evaluated_at: now, valid_until: '2026-09-19T00:00:00.000Z', basis: [{ kind: 'permission' as const, evidence: 'fixture' }],
    }))));
    service = new MetricConsumerService(policies, registry, {
      queryWindow: async s => { reads.push(s.metric.id); return []; },
      inventory: async () => testResources.inventory(ref), dimensions: async () => [{}], attempts: async () => attempts,
    }, () => now);
  });
  it('ignores unrelated permission failures and wrong configuration/resource attempts', async () => {
    const before = await query();
    attempts = [attempt('mysql-connections', 50, 'permission_denied'),
      { ...attempt('mysql-transactions', 51, 'permission_denied'), config_revision: 2 },
      { ...attempt('mysql-transactions', 52, 'permission_denied'), resource_id: '2', binding_id: 'instance:2' }];
    expect(await query()).toEqual(before);
    expect(reads).toEqual([metric, metric]);
  });
  it.each(['permission_denied', 'timeout'] as const)('propagates transitive dependency %s despite a newer unrelated success', async error => {
    attempts = [attempt('mysql-transactions', 10, error), attempt('mysql-connections', 50)];
    expect(await query()).toMatchObject({ state: error === 'permission_denied' ? 'permission_denied' : 'temporary_failure', attempt: attempts[0] });
    expect(reads).toHaveLength(error === 'permission_denied' ? 0 : 1);
  });
  it('uses latest evidence per dependency, never letting another successful dependency mask failure', async () => {
    attempts = [attempt('mysql-transactions', 10, 'permission_denied'),
      attempt('derived:mysql.transaction_commands.commit_rate', 50)];
    expect(await query()).toMatchObject({ state: 'permission_denied', attempt: attempts[0] });
    attempts.push(attempt('mysql-transactions', 30));
    expect(await query()).toMatchObject({ state: 'available', attempt: attempts[1] });
    attempts.reverse();
    expect(await query()).toMatchObject({ state: 'available', attempt: attempts[1] });
  });
  it('retains failed/partial/cancelled dependency evidence even without an error code', async () => {
    for (const status of ['failed', 'partial', 'cancelled'] as const) {
      attempts = [{ ...attempt('mysql-transactions', 10), status }, attempt('mysql-connections', 50)];
      expect(await query()).toMatchObject({ state: 'temporary_failure', attempt: attempts[0] });
    }
  });
  it('keeps a failed SQL dependency when another SQL collector has a newer success, in either store order', async () => {
    const denied = attempt('mysql-status', 10, 'permission_denied');
    attempts = [denied, attempt('mysql-transactions', 50)];
    expect(await query()).toMatchObject({ state: 'permission_denied', attempt: denied });
    attempts.reverse();
    expect(await query()).toMatchObject({ state: 'permission_denied', attempt: denied });
    attempts.push(attempt('mysql-status', 30));
    expect(await query()).toMatchObject({ state: 'available', attempt: attempts[0] });
  });
});
