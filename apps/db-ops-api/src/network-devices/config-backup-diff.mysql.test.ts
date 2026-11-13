/** #537 qualification: MAX605_MYSQL=1, MAX605_MYSQL_CONFIG (JSON), MAX605_EVIDENCE_DIR.
 * Credentials are injected explicitly; default collection opens no connections.
 * Run: pnpm --filter slide-api exec vitest run src/network-devices/config-backup-diff.mysql.test.ts
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import mysql, { type Pool, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection, encryptData } from '../db-connection.js';
import { createVerifyToken } from '../auth-middleware.js';
import { MigrationRunner } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../testing/owned-fixture.js';
import { ConfigBackupService, createSqlStore } from './config-backup-service.js';
import { networkDeviceDatabaseService } from './network-device-database-service.js';
import { registerNetworkDeviceRoutes } from './network-device-routes.js';

describe.skipIf(process.env.MAX605_MYSQL !== '1')('MAX-605 real SQL storage / JWT / HTTP diff', () => {
  let root: Pool, pool: Pool, owned: OwnedDatabase;
  let app: ReturnType<typeof Fastify>, base: string;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  let deviceId: number, otherDeviceId: number, userId: number, roleId: number;
  const secret = randomBytes(32).toString('hex');
  let token: string;
  const output = process.env.MAX605_EVIDENCE_DIR;
  const evidence: Record<string, unknown> = { scope: 'owned real MySQL schema + AES encrypted SQL backups + application JWT/permission + TCP HTTP; synthetic stored configurations; no device collection', checks: [], cleanup: {} };
  const mark = (name: string) => (evidence.checks as string[]).push(name);
  const store = () => createSqlStore(() => pool);
  const save = async (content: string) => (await store().insert!({ deviceId, contentEncrypted: encryptData(content),
    contentSha256: createHash('sha256').update(content).digest('hex'), sourceProtocol: 'ssh', collectedAt: new Date(),
    sizeBytes: Buffer.byteLength(content), redactionStatus: /password/.test(content) ? 'redacted' : 'unredacted', createdBy: userId })).summary.id;
  const call = async (path: string, status = 200, bearer = token) => {
    const response = await fetch(`${base}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    const body = await response.json() as { fromId: number; toId: number; diff: string };
    expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(status);
    return body;
  };
  const url = (from: number, to: number, device = deviceId) => `/api/network-devices/${device}/config-backups/${to}/diff?from=${from}`;

  beforeAll(async () => {
    const config = JSON.parse(process.env.MAX605_MYSQL_CONFIG ?? 'null');
    if (!config?.port || Number(config.port) === 3306 || config.database || !output) throw Error('Explicit non3306 config without database and evidence directory required');
    mkdirSync(output, { recursive: true });
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    root = mysql.createPool({ ...config, connectTimeout: 5000 });
    owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'configdiff', handleDir: join(output, 'handles') });
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 2, connectTimeout: 5000 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    const [user] = await pool.query<ResultSetHeader>("INSERT INTO users(username,password_hash,session_version) VALUES('max605-reader','fixture-no-login',1)");
    userId = user.insertId;
    const [role] = await pool.query<ResultSetHeader>("INSERT INTO roles(name,description) VALUES('max605-reader','diff qualification')");
    roleId = role.insertId;
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)', [userId, roleId]);
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code='network_devices:view'", [roleId]);
    const [device] = await pool.query<ResultSetHeader>("INSERT INTO network_devices(name,host) VALUES('max605','192.0.2.7')");
    deviceId = device.insertId;
    const [other] = await pool.query<ResultSetHeader>("INSERT INTO network_devices(name,host) VALUES('max605-other','192.0.2.8')");
    otherDeviceId = other.insertId;
    token = jwt.sign({ userId, sessionVersion: 1 }, secret, { expiresIn: '10m' });
    app = Fastify();
    await registerNetworkDeviceRoutes(app, createVerifyToken(secret), {
      backupService: new ConfigBackupService({ deviceService: networkDeviceDatabaseService, store: store() }),
    });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    evidence.environment = { schema: owned.database, mysqlPort: Number(config.port), poolLimit: 2, apiBase: base };
  }, 60000);

  afterAll(async () => {
    const errors: string[] = [];
    const cleanup = async (name: string, action: () => Promise<unknown>) => { try { await action(); } catch { errors.push(name); } };
    await cleanup('http', async () => { await app?.close(); });
    poolSpy?.mockRestore();
    await cleanup('pool', async () => { await pool?.end(); });
    await cleanup('schema', async () => { await owned?.drop(); });
    await cleanup('root', async () => { await root?.end(); });
    vi.unstubAllEnvs();
    evidence.cleanup = { complete: errors.length === 0, errors };
    if (output) writeFileSync(join(output, 'real-diff-workflow.json'), JSON.stringify(evidence, null, 2));
    expect(errors).toEqual([]);
  }, 15000);

  it('preserves ordered edits, redaction, limits and live authorization through actual HTTP', async () => {
    for (const [name, left, right, expected] of [
      ['duplicate deletion', 'a\na\nb', 'a\nb', '-a'],
      ['duplicate insertion', 'a\nb', 'a\na\nb', '+a'],
      ['reordering', 'a\nb', 'b\na', '-a\n+a'],
      ['ordinary replacement', 'sysname edge\n old\nend', 'sysname edge\n new\nend', '- old\n+ new'],
      ['identical', 'a\na\nb', 'a\na\nb', ''],
      ['redacted duplicate deletion', 'password SyntheticOld\npassword SyntheticOld\nb', 'password SyntheticNew\nb', '-password <redacted>'],
      ['redacted value change only', 'password SyntheticOld', 'password SyntheticNew', ''],
    ]) {
      const from = await save(left), to = await save(right);
      const result = await call(url(from, to));
      expect(result).toEqual({ fromId: from, toId: to, diff: expected });
      expect(JSON.stringify(result)).not.toMatch(/SyntheticOld|SyntheticNew|contentEncrypted|v2:/);
      mark(name);
    }
    const prefix = 'x'.repeat(64 * 1024);
    const from = await save(`${prefix}old`), to = await save(`${prefix}new`);
    expect((await call(url(from, to))).diff).toBe('');
    const changed = await save(`${prefix.slice(1)}a`);
    expect((await call(url(from, changed))).diff).not.toBe('');
    mark('existing 64 Ki character preview boundary');
    const manyBefore = await save(Array(16_000).fill('a').join('\n'));
    const manyAfter = await save(Array(16_000).fill('b').join('\n'));
    const start = performance.now();
    const large = await call(url(manyBefore, manyAfter));
    expect(large.diff.split('\n')).toEqual([...Array(16_000).fill('-a'), ...Array(16_000).fill('+b')]);
    evidence.largeDiff = { linesPerSide: 16_000, elapsedMs: performance.now() - start, outputBytes: Buffer.byteLength(large.diff) };
    mark('bounded large-region replacement');
    await call(url(from, to), 401, '');
    await call(url(from, to), 401, 'invalid');
    await call(url(from, to, otherDeviceId), 404);
    await call(url(from, 999999), 404);
    await call(url(from, to).replace(`from=${from}`, 'from=0'), 400);
    await call(`/api/network-devices/${deviceId}/config-backups/${from}?raw=true`, 403);
    mark('missing/invalid JWT, device-scoped lookup, missing backup, invalid ID, reader raw denial');
    const [rows] = await pool.query<RowDataPacket[]>('SELECT content_encrypted FROM network_device_config_backups');
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every(row => row.content_encrypted.startsWith('v2:') && !/SyntheticOld|SyntheticNew/.test(row.content_encrypted))).toBe(true);
    evidence.encryptedRows = rows.length;
    mark('AES encrypted SQL storage');
    await pool.query('DELETE FROM role_permissions WHERE role_id=?', [roleId]);
    await call(url(from, to), 403);
    await pool.query('UPDATE users SET session_version=session_version+1 WHERE id=?', [userId]);
    await call(url(from, to), 401);
    mark('live permission and session revocation');
  }, 15000);
});
