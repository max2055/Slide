import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import { MigrationRunner } from '../migrations/runner.js';
import { dbConnection } from '../db-connection.js';
import { alertDatabaseService } from '../alert-database-service.js';
import { NetworkDeviceAlertEvaluator } from './network-device-alert-evaluator.js';

// Controlled semantic samples; real operational rule compilation/evaluation,
// formal MySQL schema, device discovery, dedup, INSERT, UPDATE and recovery.
const samples = vi.hoisted(() => ({ query: vi.fn(), source: vi.fn(), effective: vi.fn() }));
vi.mock('../metrics/consumers/runtime.js', () => ({
  internalMetricConsumerService: { query: samples.query }, operationalSource: samples.source,
}));
vi.mock('../metrics/policy/service.js', () => ({ policyService: { effective: samples.effective } }));

describe.skipIf(process.env.NETWORK_ALERT_MYSQL !== '1')('MAX-567 #340 #481 #539 / real MySQL with controlled SNMP metric samples', () => {
  let f: { pool: Pool };
  let admin: Pool | undefined;
  const schema = `max567_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const evaluator = new NetworkDeviceAlertEvaluator();
  const metric = 'snmp.agent.uptime_seconds';
  const dimensions = { if_index: 'oldest', interface: 'GE0/0/101' };
  const sample = (value = 92) => {
    const to = new Date().toISOString(), from = new Date(Date.now() - 60_000).toISOString();
    return { metrics: [{ definition: { id: metric, kind: 'gauge', unit: 'seconds' }, state: 'available',
      series: [{ dimensions, buckets: [{ value: { encoding: 'float64', value }, unit: 'seconds',
        window: { from, to }, freshness: 'fresh', coverage: 1, quality: { status: 'good' }, accuracy: 'exact', sample_count: 1 }] }] }] };
  };
  const count = async () => (await f.pool.query<any[]>('SELECT id, network_device_id, status, metric_value FROM alerts ORDER BY id'))[0];
  beforeAll(async () => {
    if (!process.env.T08_TEST_MYSQL_PORT) throw new Error('Explicit isolated MySQL endpoint required');
    const config = { host: '127.0.0.1', port: Number(process.env.T08_TEST_MYSQL_PORT),
      user: 'root', password: process.env.T08_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(config);
    await admin.query(`CREATE DATABASE ${schema}`);
    f = { pool: mysql.createPool({ ...config, database: schema, connectionLimit: 4 }) };
    await new MigrationRunner(f.pool).run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(f.pool);
    vi.spyOn(dbConnection, 'isConnected').mockReturnValue(true);
    await f.pool.query('UPDATE alert_rules SET enabled=0');
    await f.pool.query("INSERT INTO network_devices(id,name,host,collection_enabled) VALUES(901,'edge-1','sample.invalid',1),(902,'edge-2','sample2.invalid',1)");
    await f.pool.query(`INSERT INTO alert_rules(id,name,target_type,metric_name,operator,threshold,duration_seconds,severity,enabled)
      VALUES(901,'uptime sample','network_device','device_uptime_seconds','>=',80,0,'warning',1)`);
  }, 120_000);
  beforeEach(async () => {
    vi.clearAllMocks();
    samples.source.mockResolvedValue('semantic');
    samples.effective.mockResolvedValue({ resolved: { plan: { binding: { package: { id: 'snmp-representative' } } }, settings: { interval_ms: 60_000 } } });
    samples.query.mockImplementation(async () => sample());
    await f.pool.query('DROP TRIGGER IF EXISTS max567_fail_insert');
    await f.pool.query('DROP TRIGGER IF EXISTS max567_fail_touch');
    await f.pool.query('DELETE FROM alerts');
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    try { await f?.pool.end(); if (admin) await admin.query(`DROP DATABASE IF EXISTS ${schema}`); }
    finally { await admin?.end(); }
  }, 30_000);

  it('continues the second device after a real semantic adapter query rejection', async () => {
    samples.query.mockRejectedValueOnce(new Error('CONTROLLED_QUERY_FAILURE'));
    expect(await evaluator.evaluate()).toMatchObject({ status: 'partial', matched: 1, triggered: 1, failed: 1 });
    expect(await count()).toMatchObject([{ network_device_id: 902 }]);
  });
  it('INSERT SQL failure is not a trigger success; following cycle creates the missing alert', async () => {
    await f.pool.query(`CREATE TRIGGER max567_fail_insert BEFORE INSERT ON alerts FOR EACH ROW
      BEGIN IF NEW.network_device_id=901 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAX567_INSERT_FAILED'; END IF; END`);
    expect(await evaluator.evaluate()).toMatchObject({ status: 'partial', matched: 2, triggered: 1, failed: 1 });
    expect(await count()).toHaveLength(1);
    await f.pool.query('DROP TRIGGER max567_fail_insert');
    expect(await evaluator.evaluate()).toMatchObject({ status: 'complete', matched: 2, triggered: 2, failed: 0 });
    expect(await count()).toHaveLength(2);
  });
  it('finds and touches the oldest of 102 dimensions with reordered keys; handles no dimensions', async () => {
    const input = { target_type: 'network_device' as const, network_device_id: 901, alert_type: 'performance' as const,
      level: 'warning' as const, title: 'oldest', message: 'sample', metric_name: 'device_uptime_seconds', metric_value: '81' };
    const oldest = await alertDatabaseService.createAlert({ ...input, tags: { rule_id: 901, dimensions: { interface: dimensions.interface, if_index: dimensions.if_index } } });
    expect(oldest.success).toBe(true);
    for (let i = 0; i < 101; i++) {
      expect((await alertDatabaseService.createAlert({ ...input, tags: { rule_id: 901, dimensions: { if_index: String(i) } } })).success).toBe(true);
    }
    await f.pool.query('UPDATE alerts SET created_at=DATE_SUB(NOW(),INTERVAL 1 DAY) WHERE id=?', [oldest.alertId]);
    expect(await alertDatabaseService.findActiveNetworkDeviceAlert(901, input.metric_name, 901, dimensions)).toMatchObject({ id: oldest.alertId });
    expect(await evaluator.evaluate()).toMatchObject({ failed: 0, triggered: 2 });
    const rows = await count();
    expect(rows).toHaveLength(103); // device 902 creates one; device 901 touches, never duplicates
    expect(rows.find(r => r.id === oldest.alertId).metric_value).toBe('92');
    const noDimensions = await alertDatabaseService.createAlert({ ...input, tags: { rule_id: 901 } });
    expect(await alertDatabaseService.findActiveNetworkDeviceAlert(901, input.metric_name, 901, {})).toMatchObject({ id: noDimensions.alertId });
    expect(await alertDatabaseService.findActiveNetworkDeviceAlert(901, input.metric_name, 901)).toMatchObject({ id: noDimensions.alertId });
  });
  it('touch SQL failure is visible and does not prevent the second device from updating', async () => {
    await evaluator.evaluate();
    await f.pool.query(`CREATE TRIGGER max567_fail_touch BEFORE UPDATE ON alerts FOR EACH ROW
      BEGIN IF NEW.network_device_id=901 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAX567_TOUCH_FAILED'; END IF; END`);
    expect(await evaluator.evaluate()).toMatchObject({ status: 'partial', matched: 2, triggered: 1, failed: 1 });
    expect(await count()).toHaveLength(2);
  });
  it('unknown samples preserve active alerts; fresh healthy samples resolve them', async () => {
    await evaluator.evaluate();
    samples.source.mockResolvedValue('pending');
    expect(await evaluator.evaluate()).toMatchObject({ triggered: 0, skipped: 2 });
    expect((await count()).every(r => r.status === 'unread')).toBe(true);
    samples.source.mockResolvedValue('semantic');
    samples.query.mockImplementation(async () => sample(40));
    expect(await evaluator.evaluate()).toMatchObject({ status: 'complete', triggered: 0 });
    expect((await count()).every(r => r.status === 'resolved')).toBe(true);
  });
});
