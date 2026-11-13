/** MAX-607: explicit opt-in, isolated real schema + production JWT/HTTP/SQL. */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { createVerifyToken } from '../auth-middleware.js';
import { MigrationRunner } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../testing/owned-fixture.js';
import { registerNetworkDeviceRoutes } from '../network-devices/network-device-routes.js';
import { registerCapabilityRoutes } from '../../tests/fixtures/capability-routes.js';
import { MysqlCapabilityStore } from './capability-service.js';

const enabled = process.env.MAX607_MYSQL === '1';
const output = process.env.MAX607_EVIDENCE_DIR;
describe.skipIf(!enabled)('MAX-607 real capability validity HTTP/MySQL', () => {
  let root: Pool, pool: Pool, owned: OwnedDatabase, app: ReturnType<typeof Fastify>, base: string;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  let readerId: number;
  const secret = randomBytes(32).toString('hex');
  const bearer = (id = 1) => jwt.sign({ userId: id, sessionVersion: 1 }, secret, { expiresIn: '10m' });
  const report: Record<string, unknown> = { checks: [], cleanup: {}, scope: 'real MySQL schema, JWT live permissions and TCP HTTP; controlled capability evidence, no device/production claims' };
  const mark = (name: string) => (report.checks as string[]).push(name);
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const call = async (path: string, status = 200, payload?: unknown, token: string | null = bearer()) => {
    const response = await fetch(base + path, { method: payload === undefined ? 'GET' : 'PUT', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(10000) });
    const body = await response.json() as { capabilities: Array<{ state: string; reason: string | null }>; capability: { state: string; validUntil: string | null }; error?: string }; expect(response.status, JSON.stringify(body)).toBe(status); return body;
  };
  const path = '/api/resources/network_device/7/capabilities/metrics.core';
  const snapshot = () => rows('SELECT * FROM resource_capabilities ORDER BY resource_type,resource_id,capability_key');
  beforeAll(async () => {
    const config = JSON.parse(process.env.MAX607_MYSQL_CONFIG ?? 'null');
    if (!config || !config.port || Number(config.port) === 3306 || config.database || !output) throw new Error('explicit non3306 config without database and evidence directory required');
    root = mysql.createPool(config);
    owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'capabilityvalidity', handleDir: join(output, 'handles') });
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 2, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await pool.query('UPDATE users SET session_version=1 WHERE id=1');
    await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT 1,id FROM roles WHERE name='admin'");
    await pool.query("INSERT INTO users(username,password_hash,session_version) VALUES('max607-reader','fixture-not-for-login',1)");
    readerId = Number((await rows("SELECT id FROM users WHERE username='max607-reader'"))[0].id);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='dba'", [readerId]);
    await pool.query("INSERT INTO network_devices(id,name,host) VALUES(7,'MAX607 controlled capability fixture','192.0.2.7'),(8,'MAX607 isolation fixture','192.0.2.8')");
    app = Fastify(); const verify = createVerifyToken(secret);
    await registerNetworkDeviceRoutes(app, verify); registerCapabilityRoutes(app, verify);
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    report.environment = { database: owned.database, mysqlPort: config.port, poolLimit: 2, base };
  }, 60000);
  afterAll(async () => {
    const errors: string[] = [];
    const cleanup = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); } catch { errors.push(name); } };
    await cleanup('http', async () => { await app?.close(); }); poolSpy?.mockRestore();
    await cleanup('pool', async () => { await pool?.end(); });
    await cleanup('schema', async () => { await owned?.drop(); });
    await cleanup('root', async () => { await root?.end(); });
    report.cleanup = { complete: errors.length === 0, errors };
    if (output) writeFileSync(join(output, 'real-workflow.json'), JSON.stringify(report, null, 2));
    expect(errors).toEqual([]);
  }, 30000);

  it('#549 keeps all read entrypoints consistent without persisting expiry', async () => {
    await pool.query("INSERT INTO resource_capabilities(resource_type,resource_id,capability_key,state,checked_at,valid_until) VALUES('network_device',8,'other','verified','2020-01-01','2020-01-02'),('server',7,'other','verified','2020-01-01','2020-01-02')");
    for (const [state, deadline, expected] of [
      ['verified', '2035-01-01T00:00:00Z', 'verified'], ['verified', '2020-01-02T00:00:00Z', 'configured'], ['verified', null, 'verified'],
      ...['declared', 'configured', 'degraded', 'unsupported'].map(s => [s, '2020-01-02T00:00:00Z', s]),
    ]) {
      await call(path, 200, { state, evidence: { probe: 'collector' }, reason: 'fixture', checkedAt: '2020-01-01T00:00:00Z', validUntil: deadline });
      const before = await snapshot();
      const list = await call('/api/network-devices/7/capabilities');
      const key = await call('/api/network-devices/7/capabilities?key=metrics.core');
      const detail = await call(path);
      expect(list).toEqual(key); expect(list.capabilities).toHaveLength(1);
      expect(list.capabilities[0].state).toBe(expected); expect(detail.capability.state).toBe(expected);
      expect(list.capabilities[0].reason).toBe(state === 'verified' && expected === 'configured' ? 'capability_verification_expired' : 'fixture');
      expect(await snapshot()).toEqual(before);
    }
    expect((await call('/api/network-devices/7/capabilities?key=missing')).capabilities).toEqual([]);
    expect((await call('/api/network-devices/999/capabilities')).capabilities).toEqual([]);
    mark('#549 effective/expired/null/other states; list,key,generic agree; SQL unchanged; resource isolation');
  });
  it('#550 rejects either invalid date before calling the SQL store and preserves valid dates/null', async () => {
    const put = vi.spyOn(MysqlCapabilityStore.prototype, 'put');
    try {
      const before = await snapshot();
      for (const field of ['checkedAt', 'validUntil']) {
        const result = await call(path, 400, { state: 'configured', checkedAt: '2020-01-01T00:00:00Z', [field]: 'abc' });
        expect(result.error).toBe('CAPABILITY_TIME_INVALID');
      }
      expect(put).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
      for (const validUntil of [null, '2035-01-01T00:00:00Z']) {
        await call(path, 200, { state: 'configured', checkedAt: '2020-01-01T00:00:00Z', validUntil });
        expect((await call(path)).capability.validUntil).toBe(validUntil === null ? null : '2035-01-01T00:00:00.000Z');
      }
      mark('#550 checkedAt/validUntil invalid: HTTP400 CAPABILITY_TIME_INVALID, store not invoked, SQL unchanged; valid/null roundtrip');
    } finally { put.mockRestore(); }
  });
  it('enforces current permissions and session revocation with real JWT', async () => {
    const token = bearer(readerId); const before = await snapshot();
    await call('/api/network-devices/7/capabilities', 401, undefined, null);
    await call('/api/network-devices/7/capabilities', 401, undefined, 'invalid');
    await call('/api/network-devices/7/capabilities', 200, undefined, token);
    await call(path, 404, { state: 'configured' }, token);
    await pool.query('DELETE FROM user_roles WHERE user_id=?', [readerId]);
    await call('/api/network-devices/7/capabilities', 403, undefined, token);
    await call('/api/network-devices/7/capabilities?key=metrics.core', 403, undefined, token);
    await call(path, 404, undefined, token);
    await pool.query('UPDATE users SET session_version=2 WHERE id=?', [readerId]);
    await call('/api/network-devices/7/capabilities', 401, undefined, token);
    expect(await snapshot()).toEqual(before);
    mark('JWT unauthenticated/malformed rejected; read-only write denied; role revocation and session invalidation take effect');
  });
});
