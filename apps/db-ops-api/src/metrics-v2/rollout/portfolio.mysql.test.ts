import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { MetricPortfolioService, MysqlPortfolioInventory, type PortfolioDependencies, type PortfolioPackage } from './portfolio.js';

const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
const actor = { userId: 9, username: 'admin', roles: ['admin'], permissions: ['*'], sessionVersion: 1, instanceScopes: {}, requestId: 'portfolio-mysql' };

describe.skipIf(!port)('Metrics V2 portfolio persisted state', () => {
  let root: Pool;
  let pool: Pool;
  let packages: PortfolioPackage[];
  let service: MetricPortfolioService;
  const database = `max85_portfolio_${process.pid}`;

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 8 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    packages = createConfigurationRegistry().list().map(({ package: item }) => ({
      id: item.id, version: item.version, digest: item.digest, resource_type: item.resource_type,
    }));
    const dependencies: PortfolioDependencies = {
      inventory: new MysqlPortfolioInventory(pool, packages), packages,
      publish: vi.fn(async () => undefined), startShadow: vi.fn(async () => undefined),
      cutover: vi.fn(async () => undefined), confirm: vi.fn(async () => undefined),
    };
    service = new MetricPortfolioService(dependencies);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM metric_v2_rollout_events');
    await pool.query('DELETE FROM metric_v2_rollout_resources');
    await pool.query('DELETE FROM metric_v2_rollout');
    await pool.query('DELETE FROM metric_v2_policy_bindings');
    await pool.query('DELETE FROM network_device_credentials');
    await pool.query('DELETE FROM network_devices');
    await pool.query('DELETE FROM servers');
    await pool.query('DELETE FROM database_instances');
    await pool.query(`INSERT INTO database_instances
      (id, name, db_type, db_version, host, port, username, password_encrypted, status)
      VALUES (1, 'mysql', 'mysql', '8.4.10', '192.0.2.1', 3306, 'collector', 'encrypted', 'active')`);
    await pool.query(`INSERT INTO servers
      (id, host, port, label, os_type, credential_type, credential_encrypted, status, collection_enabled)
      VALUES (2, '192.0.2.2', 22, 'linux', 'RHEL 9.4', 'password', 'encrypted', 'online', 1)`);
    await pool.query(`INSERT INTO network_devices
      (id, name, host, vendor, collection_enabled) VALUES (3, 'switch', '192.0.2.3', 'cisco', 1)`);
    await pool.query(`INSERT INTO network_device_credentials
      (device_id, protocol, username, community_encrypted) VALUES (3, 'snmpv2c', '', 'encrypted')`);
  });

  const pin = (id: string) => packages.find(item => item.id === id)!;
  const published = (key: string, selected: PortfolioPackage) => {
    const [type, id] = key.split(':');
    return { binding: { resource: { type, id: Number(id) }, package: {
      id: selected.id, version: selected.version, digest: selected.digest,
    }, revision: 2 }, application: { applied_revision: 2, status: 'applied' } };
  };

  async function markV2(key: string, selected: PortfolioPackage, hashes: string[]) {
    const [type, id] = key.split(':');
    await pool.query('INSERT INTO metric_v2_policy_bindings (resource_key, group_id, payload, capabilities) VALUES (?, NULL, ?, ?)',
      [key, JSON.stringify(published(key, selected)), '[]']);
    await pool.query(`INSERT INTO metric_v2_rollout_resources
      (resource_key, resource_type, resource_id, phase, revision, generation, gate_json, actor_id, request_id)
      VALUES (?, ?, ?, 'v2', 2, 2, ?, 9, 'portfolio-mysql')`, [key, type, id, JSON.stringify({ sample_count: 20 })]);
    for (const hash of hashes) {
      await pool.query(`INSERT INTO metric_v2_rollout
        (series_hash, source, generation, read_mode, package_pin, published_revision, applied_revision, resource_type, resource_id)
        VALUES (?, 'v2', 2, 'v2', ?, 2, 2, ?, ?)`, [hash, JSON.stringify(selected), type, id]);
    }
  }

  it('derives coverage and completion from all managed assets without exposing asset secrets', async () => {
    const initial = await service.status(actor);
    expect(initial.summary).toEqual({ total: 3, supported: 3, blocked: 0, v2: 0, complete: false });
    expect(initial.resources.map(item => [item.key, item.package?.id])).toEqual([
      ['instance:1', 'mysql-representative'], ['server:2', 'linux-host'], ['network_device:3', 'if-mib-basic'],
    ]);
    expect(JSON.stringify(initial)).not.toContain('192.0.2.');
    expect(JSON.stringify(initial)).not.toContain('encrypted');

    await markV2('instance:1', pin('mysql-representative'), ['1'.repeat(64), '2'.repeat(64)]);
    await markV2('server:2', pin('linux-host'), ['3'.repeat(64)]);
    await markV2('network_device:3', pin('if-mib-basic'), ['4'.repeat(64)]);
    const complete = await service.status(actor);
    expect(complete.plan_hash).toBe(initial.plan_hash);
    expect(complete.summary).toEqual({ total: 3, supported: 3, blocked: 0, v2: 3, complete: true });

    await pool.query('UPDATE metric_v2_rollout SET generation = 3 WHERE series_hash = ?', ['2'.repeat(64)]);
    const mixed = await service.status(actor);
    expect(mixed.summary.complete).toBe(false);
    expect(mixed.resources.find(item => item.key === 'instance:1')).toMatchObject({ state: 'blocked', blockers: ['rollout_mixed'] });
  });

  it('changes the plan hash when authoritative inventory metadata changes', async () => {
    const before = await service.status(actor);
    await pool.query("UPDATE database_instances SET db_version = '8.0.40' WHERE id = 1");
    const after = await service.status(actor);
    expect(after.plan_hash).not.toBe(before.plan_hash);
  });
});
