import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trialDatabaseTransport } from './database-transport.js';
import { collectDatabase } from '../database/collector.js';
import { databaseReads, implementationId } from '../database/catalog.js';
import type { DatabaseConnection } from '../../database-service.js';

const port = Number(process.env.METRICS_V2_TEST_PG_PORT);
describe.skipIf(!port)('isolated PostgreSQL production transport counter evidence', () => {
  const database = `max85_counter_${process.pid}`, user = `max85_reader_${process.pid}`;
  const read = databaseReads.find(r => r.engine === 'postgresql' && r.name === 'transactions')!;
  let root: Client, target: Client;
  const transport = () => trialDatabaseTransport({ db_type: 'postgresql', connected: true,
    config: { host: '127.0.0.1', port, user, password: '', database } } as DatabaseConnection);
  const collect = () => collectDatabase(implementationId(read), transport(), {}, 3000);
  beforeAll(async () => {
    root = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
    await root.connect();
    await root.query(`CREATE DATABASE ${database}`);
    await root.query(`CREATE ROLE ${user} LOGIN`);
    target = new Client({ host: '127.0.0.1', port, user: 'postgres', database });
    await target.connect();
  });
  afterAll(async () => {
    await target?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.query(`DROP ROLE IF EXISTS ${user}`);
      await root.end();
    }
  });
  it('reads the bound database with an unprivileged role and retains a stable epoch between sessions', async () => {
    const first = (await collect())[0], second = (await collect())[0];
    expect(first.dimensions.database).toBe(database);
    expect(first.fields.commits?.encoding).toBe('uint64');
    expect(first.counter?.discontinuity?.epoch).toMatch(/^[a-f0-9]{64}$/);
    expect(second.counter).toEqual(first.counter);
    expect(Date.parse(first.observed_at!)).toBeGreaterThan(Date.now() - 10000);
    expect((await root.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE usename = $1', [user])).rows[0].n).toBe(0);
  });
  it('observes a real pg_stat_reset as a new epoch without deriving it from the numeric counter', async () => {
    const before = (await collect())[0];
    await target.query('SELECT pg_stat_reset()');
    const after = (await collect())[0];
    expect(after.counter?.discontinuity?.reason).toBe('reset');
    expect(after.counter?.discontinuity?.epoch).not.toEqual(before.counter?.discontinuity?.epoch);
    expect((await collect())[0].counter).toEqual(after.counter);
  });
  it('closes the private session after a native statement timeout', async () => {
    const t = transport();
    if (t.method !== 'sql') throw new Error('EXPECTED_SQL');
    await expect(t.pool.query({ sql: 'SELECT pg_sleep(1)', timeout: 30 })).rejects.toMatchObject({ code: '57014' });
    expect((await root.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE usename = $1', [user])).rows[0].n).toBe(0);
  });
});
