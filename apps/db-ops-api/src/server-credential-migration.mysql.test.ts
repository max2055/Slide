import { createCipheriv, randomBytes } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from './migrations/runner.js';
import type { MigrationPool } from './migrations/types.js';
import { dbConnection, decryptData, encryptData } from './db-connection.js';
import { LOST_KEY_ROTATION_SENTINEL } from './credential-rotation.js';
import { serverDatabaseService as servers } from './server-database-service.js';

// Explicit opt-in to an owned disposable MySQL. Never uses the application .env.
const port = Number(process.env.MAX318_MYSQL_PORT);
describe.skipIf(!port)('GitHub #589 server credential migration (real MySQL)', () => {
  const schema = `max318_${randomBytes(8).toString('hex')}`;
  const key = '0123456789abcdef'.repeat(4);
  const credentials = { username: 'fixture', password: 'synthetic password with spaces' };
  let root: Pool;
  let pool: Pool;
  let id: number;
  let old: string;
  let log: ReturnType<typeof vi.spyOn>;

  function legacy(value: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', Buffer.from(key.slice(0, 32)), iv);
    return `${iv.toString('hex')}:${cipher.update(value, 'utf8', 'hex')}${cipher.final('hex')}`;
  }
  async function stored(): Promise<string> {
    const [rows] = await pool.query<any[]>('SELECT credential_encrypted FROM servers WHERE id = ?', [id]);
    return rows[0].credential_encrypted;
  }

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${schema}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database: schema });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
  }, 180000);
  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', key);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
    old = legacy(JSON.stringify(credentials));
    const [result] = await pool.execute<any>(`INSERT INTO servers
      (host,port,os_type,credential_type,credential_encrypted,collection_enabled)
      VALUES ('203.0.113.18',22,'centos','password',?,0)`, [old]);
    id = result.insertId;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await pool.query('DROP TRIGGER IF EXISTS max318_reject_migration');
    await pool.query('DELETE FROM servers');
  });
  afterAll(async () => {
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${schema}`);
      const [remaining] = await root.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [schema]);
      expect(remaining).toHaveLength(0);
      await root.end();
    }
  }, 60000);

  it('returns CBC credentials after a real UPDATE trigger failure and logs only a fixed code', async () => {
    await pool.query(`CREATE TRIGGER max318_reject_migration BEFORE UPDATE ON servers
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic password with spaces'`);
    expect(await servers.getDecryptedCredentials(id)).toEqual(credentials);
    expect(await stored()).toBe(old);
    expect(log.mock.calls).toEqual([['服务器凭据迁移失败', { serverId: id, code: 'SERVER_CREDENTIAL_MIGRATION_FAILED' }]]);
  });

  it('persists and decrypts v2 after normal migration', async () => {
    expect(await servers.getDecryptedCredentials(id)).toEqual(credentials);
    expect(await stored()).toMatch(/^v2:/);
    expect(JSON.parse(decryptData(await stored()))).toEqual(credentials);
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps a concurrently saved new credential when the legacy read attempts CAS', async () => {
    const read = servers.getServerById.bind(servers);
    const newer = encryptData(JSON.stringify({ ...credentials, password: 'newer synthetic password' }));
    vi.spyOn(servers, 'getServerById').mockImplementationOnce(async serverId => {
      const snapshot = await read(serverId);
      await pool.execute('UPDATE servers SET credential_encrypted = ? WHERE id = ?', [newer, serverId]);
      return snapshot;
    });
    expect(await servers.getDecryptedCredentials(id)).toEqual(credentials);
    expect(await stored()).toBe(newer);
    expect((await servers.getDecryptedCredentials(id))?.password).toBe('newer synthetic password');
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['malformed-envelope', 'invalid JSON'])('returns null without writing or leaking %s', async value => {
    const encrypted = value === 'invalid JSON' ? legacy(credentials.password) : value;
    await pool.execute('UPDATE servers SET credential_encrypted = ? WHERE id = ?', [encrypted, id]);
    expect(await servers.getDecryptedCredentials(id)).toBeNull();
    expect(await stored()).toBe(encrypted);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(credentials.password);
    expect(JSON.stringify(log.mock.calls)).not.toContain(encrypted);
  });

  it('preserves the lost-key recovery refusal', async () => {
    const marker = encryptData(LOST_KEY_ROTATION_SENTINEL);
    await pool.execute('UPDATE servers SET credential_encrypted = ? WHERE id = ?', [marker, id]);
    await expect(servers.getDecryptedCredentials(id)).rejects.toMatchObject({ code: 'CREDENTIAL_ROTATION_REQUIRED' });
    expect(await stored()).toBe(marker);
    expect(log).not.toHaveBeenCalled();
  });
});
