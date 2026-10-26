import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeTestFixture } from './investigations/bridge-test-fixture.js';
import { dbConnection } from './db-connection.js';
import { serverAlertEvaluator } from './server-alert-evaluator.js';
import { createConfigurationRegistry } from './metrics/config/registry.js';
import { policyService } from './metrics/policy/service.js';
import { MysqlPolicyStore } from './metrics/policy/store.js';
import { admin } from './metrics/policy/test-support.js';
import { RolloutControl } from './metrics/rollout/control.js';
import { identify } from './contracts/metrics/fixtures.js';
import type { NormalizedObservation } from './contracts/metrics/index.js';

// No evaluator, metric-query or alert-service mocks. Deterministic observations
// are published to the real formal store; this does not test SSH collection.
describe('server rule lifecycle / formal metrics and alerts in MySQL', () => {
  let f: Awaited<ReturnType<typeof bridgeTestFixture>>;
  const ref = { type: 'server' as const, id: 901 };
  const registry = createConfigurationRegistry();
  const pin = registry.list().find(r => r.package.id === 'linux-host')!.package;
  const cpu = registry.catalog(pin).find(d => d.id === 'linux.cpu.user_system_percent')!;
  const disk = registry.catalog(pin).find(d => d.id === 'host.filesystem.used_bytes')!;
  beforeAll(async () => {
    f = await bridgeTestFixture();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(f.pool);
    vi.spyOn(dbConnection, 'isConnected').mockReturnValue(true);
    await f.pool.query(`INSERT INTO servers (id, label, host, os_type, credential_type, credential_encrypted, collection_enabled)
      VALUES (901, 'business', 'fixture.invalid', 'centos', 'password', 'unused', 1)`);
    await policyService.changeBinding(admin, ref, { expected_revision: 0,
      package: { id: pin.id, version: pin.version, digest: pin.digest } }, true);
    const at = new Date().toISOString();
    await new MysqlPolicyStore(() => f.pool).reportCapabilities(ref, 1, pin.collectors.flatMap(c => c.mappings.map(m => ({
      resource_id: '901', metric: m.metric, method: c.method, status: 'supported' as const,
      basis: [{ kind: 'permission' as const, evidence: 'isolated SQL observation fixture' }],
      evaluated_at: at, valid_until: new Date(Date.now() + 3600_000).toISOString(),
    }))), null);
  }, 120_000);
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);
  beforeEach(async () => {
    for (const table of ['alerts', 'metric_publications', 'metric_rollout', 'metric_observations']) await f.pool.query(`DELETE FROM ${table}`);
    await f.pool.query('UPDATE alert_rules SET enabled=0');
    await f.pool.query(`INSERT INTO alert_rules
      (id,name,target_type,server_id,metric_name,operator,threshold,duration_seconds,severity,enabled)
      VALUES (901,'low','server',901,'cpu_usage','>',10,0,'warning',1),
        (902,'high','server',901,'cpu_usage','>',50,0,'warning',1)
      ON DUPLICATE KEY UPDATE enabled=1,metric_name='cpu_usage'`);
  });
  const rows = async () => (await f.pool.query<any[]>("SELECT * FROM alerts ORDER BY JSON_EXTRACT(tags,'$.rule_id'),id"))[0];
  async function publish(definition: typeof cpu, points: Array<{ value: number; dimensions: Record<string, string>; age?: number }>) {
    // Replace this test's observation window so each phase has sustained,
    // fresh evidence at the new value, including both filesystem dimensions.
    for (const table of ['metric_publications', 'metric_rollout', 'metric_observations']) await f.pool.query(`DELETE FROM ${table}`);
    const control = new RolloutControl(f.pool);
    for (const point of points) {
      const observation = (age: number) => {
        const at = new Date(Date.now() - age).toISOString();
        return identify<NormalizedObservation>({ id: 'pending', stage: 'normalized', resource_type: 'server', resource_id: '901',
          metric: { id: definition.id, semantic_version: definition.semantic_version }, dimensions: point.dimensions,
          observed_at: at, collected_at: at, stored_at: at, unit: definition.unit,
          value: definition.value_type === 'uint64' ? { encoding: 'uint64', value: String(point.value) } : { encoding: 'float64', value: point.value },
          quality: { status: 'good', reason: 'none' }, accuracy: 'exact', production: 'measured',
          source: { binding_id: 'server:901', metric_binding_id: definition.id, collector_id: 'fixture', attempt_id: `fixture-${age}` },
          versions: { contract: '1.0.0', package_id: pin.id, package_version: pin.version, transform_version: '1.0.0', config_revision: 1 },
          lineage: [{ id: 'isolated-raw', stage: 'raw' }] });
      };
      const first = observation((point.age ?? 1000) + 120_000);
      await control.initialize(first, { source: 'semantic', read: 'semantic', revision: 1,
        package: { id: pin.id, version: pin.version, digest: pin.digest } });
      const ticket = { source: 'semantic', generation: 1, revision: 1 };
      await control.applied(first, ticket);
      await control.publish(first, definition, ticket);
      await control.publish(observation(point.age ?? 1000), definition, ticket);
    }
    await serverAlertEvaluator.evaluateServerRules();
  }
  it('separately triggers, touches and recovers two thresholds from actual formal SQL reads', async () => {
    const run = (value: number) => publish(cpu, [{ value, dimensions: {} }]);
    await run(90);
    let state = await rows(); expect(state).toHaveLength(2);
    const ids = state.map(r => r.id);
    await run(80); state = await rows(); expect(state.map(r => r.id)).toEqual(ids);
    for (const [i, threshold] of [10, 50].entries()) {
      expect(Number(state[i].threshold_value)).toBe(threshold);
      expect(state[i].tags.rule_id).toBe(901 + i);
      expect(Number(state[i].metric_value)).toBe(80);
      expect(state[i].message).toContain(`超过阈值 ${threshold}`);
      expect(state[i].tags.observed_from).toBeTruthy();
      expect(state[i].tags.observed_to).toBeTruthy();
      expect(state[i].tags.quality).toBe('good');
    }
    await run(30); expect((await rows()).map(r => r.status)).toEqual(['unread', 'resolved']);
    const recovered = (await rows())[1];
    await run(5); state = await rows(); expect(state.map(r => r.status)).toEqual(['resolved', 'resolved']);
    expect(state[1]).toEqual(recovered);
  });
  it('recovers one filesystem while another is firing, then recovers the remaining filesystem', async () => {
    await f.pool.query("UPDATE alert_rules SET metric_name='filesystem_used_bytes',enabled=(id=901) WHERE id IN (901,902)");
    const dims = (device: string) => ({ device, mount: `/${device}`, fs_type: 'ext4' });
    const run = (a: number, b: number) => publish(disk, [{ value: a, dimensions: dims('sda') }, { value: b, dimensions: dims('sdb') }]);
    await run(90, 5);
    // Missing fresh input for sda must keep its alert active while sdb fires.
    await publish(disk, [{ value: 90, dimensions: dims('sda'), age: 300_000 }, { value: 90, dimensions: dims('sdb') }]);
    let state = await rows(); expect(state).toHaveLength(2);
    await run(5, 70); state = await rows();
    expect(state.map(r => r.status)).toEqual(['resolved', 'unread']);
    expect(state[1].tags.dimensions).toEqual(dims('sdb')); expect(Number(state[1].metric_value)).toBe(70);
    await run(5, 5); expect((await rows()).map(r => r.status)).toEqual(['resolved', 'resolved']);
  });
});
