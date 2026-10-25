import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeTestFixture } from './investigations/bridge-test-fixture.js';
import { dbConnection } from './db-connection.js';
import { alertDatabaseService as alerts } from './alert-database-service.js';
import { serverAlertEvaluator } from './server-alert-evaluator.js';

// Only the metric evidence boundary is controlled. Finder, create, touch and
// recovery execute production SQL against a disposable, fully migrated MySQL.
const evidence = vi.hoisted(() => ({ value: 90, dimensions: {} as Record<string, string> }));
vi.mock('./metrics/consumers/operational.js', () => ({
  evaluateOperationalRule: async (_ref: unknown, rule: { threshold: number; dimensions?: Record<string, string> }) => {
    const same = !rule.dimensions || Object.entries(rule.dimensions).every(([k, v]) => evidence.dimensions[k] === v);
    return { handled: true, level: same && evidence.value > rule.threshold ? 'warning' : null,
      value: same ? evidence.value : null, recovery: same && evidence.value <= rule.threshold,
      dimensions: evidence.dimensions, observation: { observedAt: '2026-10-26T00:00:00Z',
        from: '2026-10-25T23:59:00Z', to: '2026-10-26T00:00:00Z', quality: 'good' } };
  },
}));

describe('server alert identity / real MySQL', () => {
  let f: Awaited<ReturnType<typeof bridgeTestFixture>>;
  beforeAll(async () => {
    f = await bridgeTestFixture();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(f.pool);
    vi.spyOn(dbConnection, 'isConnected').mockReturnValue(true);
    await f.pool.query(`INSERT INTO servers (id, label, host, port, os_type, credential_type, credential_encrypted, collection_enabled)
      VALUES (901, 'isolation', 'fixture.invalid', 22, 'linux', 'password', 'unused', 1)`);
  }, 120_000);
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);
  beforeEach(async () => {
    await f.pool.query('DELETE FROM alerts');
    await f.pool.query('UPDATE alert_rules SET enabled=0');
    evidence.value = 90; evidence.dimensions = {};
  });

  const insert = async (tags: unknown, serverId = 901, metric = 'cpu_usage', status = 'unread') => {
    const [result] = await f.pool.execute<any>(`INSERT INTO alerts
      (server_id, target_type, alert_type, level, title, message, metric_name, threshold_value, tags, status)
      VALUES (?, 'server', 'performance', 'warning', 'snapshot', 'threshold 50', ?, '50', ?, ?)`,
    [serverId, metric, tags === null ? null : JSON.stringify(tags), status]);
    return result.insertId as number;
  };
  const rows = async () => (await f.pool.query<any[]>("SELECT * FROM alerts ORDER BY JSON_EXTRACT(tags, '$.rule_id'), id"))[0];
  const rules = async () => {
    await f.pool.query(`INSERT INTO alert_rules
      (id, name, target_type, server_id, metric_name, operator, threshold, duration_seconds, severity, enabled)
      VALUES (901, 'low', 'server', 901, 'cpu_usage', '>', 10, 0, 'warning', 1),
        (902, 'high', 'server', 901, 'cpu_usage', '>', 50, 0, 'warning', 1)
      ON DUPLICATE KEY UPDATE enabled=1`);
  };

  it('never falls back to another current rule, resource, metric or resolved row', async () => {
    await insert({ rule_id: 901 });
    expect(await alerts.findActiveServerAlert(901, 'cpu_usage', 902)).toBeNull();
    expect(await alerts.findActiveServerAlert(902, 'cpu_usage', 901)).toBeNull();
    expect(await alerts.findActiveServerAlert(901, 'memory_usage', 901)).toBeNull();
    await insert({ rule_id: 902 }, 901, 'cpu_usage', 'resolved');
    expect(await alerts.findActiveServerAlert(901, 'cpu_usage', 902)).toBeNull();
  });

  it.each([null, {}, { rule_id: null }])('retains only rule-less legacy fallback: %j', async tags => {
    const legacy = await insert(tags);
    await insert({ rule_id: 903 });
    expect((await alerts.findActiveServerAlert(901, 'cpu_usage', 902))?.id).toBe(legacy);
    const exact = await insert({ rule_id: 902 });
    expect((await alerts.findActiveServerAlert(901, 'cpu_usage', 902))?.id).toBe(exact);
  });

  it('compares the whole dimension identity, independent of key order, for exact and legacy rows', async () => {
    const a = await insert({ rule_id: 901, dimensions: { device: 'sda', mount: '/' } });
    await insert({ rule_id: 901, dimensions: { device: 'sdb', mount: '/data' } });
    expect((await alerts.findActiveServerAlert(901, 'cpu_usage', 901, { mount: '/', device: 'sda' }))?.id).toBe(a);
    expect(await alerts.findActiveServerAlert(901, 'cpu_usage', 901, { device: 'sda' })).toBeNull();
    expect(await alerts.findActiveServerAlert(901, 'cpu_usage', 901)).toBeNull();
    const legacy = await insert({ dimensions: { device: 'sdc' } });
    expect((await alerts.findActiveServerAlert(901, 'cpu_usage', 902, { device: 'sdc' }))?.id).toBe(legacy);
    expect(await alerts.findActiveServerAlert(901, 'cpu_usage', 902, { device: 'sdd' })).toBeNull();
    const empty = await insert({ rule_id: 901, dimensions: {} });
    expect((await alerts.findActiveServerAlert(901, 'cpu_usage', 901))?.id).toBe(empty);
  });

  it('triggers, touches and recovers two rules separately with consistent snapshots', async () => {
    await rules();
    await serverAlertEvaluator.evaluateServerRules();
    let state = await rows(); expect(state).toHaveLength(2);
    const ids = state.map(r => r.id);
    evidence.value = 80;
    await serverAlertEvaluator.evaluateServerRules();
    state = await rows(); expect(state.map(r => r.id)).toEqual(ids);
    for (const [index, threshold] of [10, 50].entries()) {
      expect(Number(state[index].threshold_value)).toBe(threshold);
      expect(state[index].tags.rule_id).toBe(901 + index);
      expect(state[index].metric_value).toBe('80');
      expect(state[index].message).toContain(`超过阈值 ${threshold}`);
      expect(state[index].tags.collected_at).toBe('2026-10-26T00:00:00.000Z');
    }
    evidence.value = 30;
    await serverAlertEvaluator.evaluateServerRules();
    state = await rows(); expect(state.map(r => r.status)).toEqual(['unread', 'resolved']);
    const recovered = state[1];
    evidence.value = 5;
    await serverAlertEvaluator.evaluateServerRules();
    state = await rows(); expect(state.map(r => r.status)).toEqual(['resolved', 'resolved']);
    expect(state[1]).toEqual(recovered); // no cross-rule touch after recovery
  });

  it('keeps dimension-specific alerts separate during trigger, touch and recovery', async () => {
    await rules();
    const run = (device: string) => {
      evidence.dimensions = { device };
      return serverAlertEvaluator.evaluateServerRules(new Map([[901, { device }]]));
    };
    await run('sda'); await run('sdb');
    let state = await rows(); expect(state).toHaveLength(2);
    evidence.value = 70; await run('sda');
    state = await rows(); expect(state.map(r => r.metric_value)).toEqual(['70', '90']);
    evidence.value = 5; await run('sda');
    state = await rows(); expect(state.map(r => r.status)).toEqual(['resolved', 'unread']);
    await run('sdb');
    expect((await rows()).map(r => r.status)).toEqual(['resolved', 'resolved']);
  });

  it('binds a reused legacy row to its rule and updates the threshold snapshot atomically with the observation', async () => {
    const legacy = await insert({ audit_marker: 'preserved' });
    await rules();
    await serverAlertEvaluator.evaluateServerRules(new Map([[901, {}]]));
    let state = await rows(); expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ id: legacy, threshold_value: '10.00',
      tags: { rule_id: 901, audit_marker: 'preserved' } });
    await serverAlertEvaluator.evaluateServerRules(new Map([[902, {}]]));
    state = await rows(); expect(state).toHaveLength(2);
    expect(state[0].id).toBe(legacy);
    expect(state[1].tags.rule_id).toBe(902);
    expect(Number(state[1].threshold_value)).toBe(50);
  });

  it('recovers only the healthy dimension even while an unfiltered rule still fires elsewhere', async () => {
    await rules();
    await f.pool.query('UPDATE alert_rules SET enabled=0 WHERE id=902');
    evidence.dimensions = { device: 'sda' };
    await serverAlertEvaluator.evaluateServerRules();
    evidence.dimensions = { device: 'sdb' };
    await serverAlertEvaluator.evaluateServerRules();
    evidence.value = 5;
    await serverAlertEvaluator.evaluateServerRules();
    let state = await rows(); expect(state).toHaveLength(2);
    expect(state.map(r => r.status)).toEqual(['unread', 'resolved']);
    evidence.dimensions = { device: 'sda' };
    await serverAlertEvaluator.evaluateServerRules();
    state = await rows(); expect(state.map(r => r.status)).toEqual(['resolved', 'resolved']);
  });
});
