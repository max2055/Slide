import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection, encryptData } from './db-connection.js';
import { LOST_KEY_ROTATION_SENTINEL as marker } from './credential-rotation.js';
import { instanceDatabaseService as instances } from './instance-database-service.js';
import { serverDatabaseService as servers } from './server-database-service.js';

const ssh = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('ssh2', () => ({ Client: class {
  on() { return this; }
  connect = ssh.connect;
  end() {}
} }));

const rotationError = { code: 'CREDENTIAL_ROTATION_REQUIRED', message: expect.stringContaining('重新录入凭据') };

// GitHub #321 / MAX-307: real encryption, simulated storage and transports.
describe('MAX-307 lost-key markers never reach authentication', () => {
  let execute: ReturnType<typeof vi.fn>;
  let row: any;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    row = {
      id: 307, name: 'rotation-fixture', environment: 'testing', db_type: 'mysql',
      host: '203.0.113.30', port: 3306, username: 'fixture', status: 'inactive',
      lifecycle_state: 'available', password_encrypted: encryptData(marker),
      credential_type: 'password', credential_encrypted: encryptData(marker), collection_enabled: 0,
    };
    execute = vi.fn(async (sql: string, values: any[]) => {
      if (sql.startsWith('SELECT')) return [[{ ...row }], []];
      const assignments = sql.match(/SET (.+) WHERE/)?.[1].split(', ') ?? [];
      assignments.forEach((assignment, index) => {
        if (assignment.endsWith(' = ?')) row[assignment.slice(0, -4)] = values[index];
      });
      return [{ affectedRows: 1 }, []];
    });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ssh.connect.mockImplementation(() => { throw new Error('unexpected SSH authentication'); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); ssh.connect.mockReset(); });

  it.each(['getInstancePassword', 'getInstanceWithDecryptedPassword'] as const)('rejects encrypted markers through %s with an actionable error', async (method) => {
    await expect(instances[method](307)).rejects.toMatchObject(rotationError);
    expect(execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses instance reactivation without changing its disabled state', async () => {
    await expect(instances.markInstanceActive(307)).rejects.toMatchObject(rotationError);
    expect(execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    expect(row.status).toBe('inactive');
  });

  it.each(['mysql', 'postgresql', 'oracle', 'dameng'])('refuses a manual %s connection test before creating a transport', async (db_type) => {
    const createPool = vi.spyOn(mysql, 'createPool').mockImplementation(() => { throw new Error('unexpected database authentication'); });
    await expect(instances.testConnection({ db_type, host: row.host, port: row.port, username: row.username, password: marker }))
      .resolves.toEqual({ success: false, message: expect.stringContaining('重新录入凭据') });
    expect(createPool).not.toHaveBeenCalled();
  });

  it('refuses server credential reads before JSON parsing and preserves the explicit error', async () => {
    expect(() => servers.decryptCredentials(row.credential_encrypted)).toThrow('重新录入凭据');
    await expect(servers.getDecryptedCredentials(307)).rejects.toMatchObject(rotationError);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['username', 'password', 'privateKey'])('refuses a marker embedded in server %s', (field) => {
    const payload = { username: 'fixture', password: 'synthetic-secret', [field]: marker };
    expect(() => servers.decryptCredentials(encryptData(JSON.stringify(payload)))).toThrow('重新录入凭据');
  });

  it.each(['password', 'key'])('refuses manual SSH %s authentication with the marker', async (type) => {
    await expect(servers.testConnection(row.host, 22, type, marker, 'fixture'))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('重新录入凭据') });
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  it('accepts a newly saved instance password without activating collection implicitly', async () => {
    const secret = randomBytes(18).toString('hex');
    expect(await instances.updateInstance(307, { password: secret })).toEqual({ success: true });
    expect(await instances.getInstancePassword(307) === secret).toBe(true);
    expect(row.status).toBe('inactive');
    await expect(instances.markInstanceActive(307)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['password', 'key'] as const)('accepts a replacement server %s without decrypting the marker or enabling collection', async (type) => {
    const secret = randomBytes(18).toString('hex');
    expect(await servers.updateServer(307, { credential_type: type, credential_username: 'fixture', credential_value: secret })).toEqual({ success: true });
    const read = await servers.getDecryptedCredentials(307);
    expect(read?.[type === 'password' ? 'password' : 'privateKey'] === secret).toBe(true);
    expect(row.collection_enabled).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['', 'SLIDE_CREDENTIAL_ROTATION_REQUIRED:other', `prefix:${marker}`, `${marker}:suffix`])('preserves non-marker instance passwords (%j)', async (password) => {
    row.password_encrypted = password === '' ? '' : encryptData(password);
    expect(await instances.getInstancePassword(307)).toBe(password);
  });
});
