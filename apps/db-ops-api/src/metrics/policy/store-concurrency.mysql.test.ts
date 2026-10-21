import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MysqlPolicyStore } from './store.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
describe.skipIf(!port)('policy reads do not starve their shared MySQL pool', () => {
  let root: Pool, pool: Pool;
  const database = `policy_pool_${process.pid}`;
  beforeAll(async () => {
    const config = { host: '127.0.0.1', port, user: 'root', password: process.env.METRICS_TEST_MYSQL_PASSWORD || '' };
    root = mysql.createPool(config);
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 2 });
    pool.on('connection', connection => { connection.query('SET innodb_lock_wait_timeout = 1'); });
    await pool.query('CREATE TABLE metric_policy_lock (id INT PRIMARY KEY)');
    await pool.query('INSERT INTO metric_policy_lock VALUES (1)');
  });
  afterAll(async () => {
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });
  it('completes parallel policy callbacks that read inventory through the same pool, across store instances', async () => {
    const stores = [new MysqlPolicyStore(() => pool), new MysqlPolicyStore(() => pool)];
    // Real effective-policy resolution reads inventory while holding the policy
    // lock. Waiting lock transactions must leave a connection for that read.
    const results = await Promise.all(stores.map((store, index) => store.transaction(async () => {
      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT ? AS resource_id', [index + 1]);
      return rows[0].resource_id;
    })));
    expect(results).toEqual([1, 2]);
  });
  it('releases admission after a rejected transaction so later reads still complete', async () => {
    const store = new MysqlPolicyStore(() => pool);
    const failed = store.transaction(async () => { throw new Error('expected rollback'); });
    const next = store.transaction(async () => { await pool.query('SELECT 1'); return 'readable'; });
    await expect(failed).rejects.toThrow('expected rollback');
    await expect(next).resolves.toBe('readable');
  });
});
