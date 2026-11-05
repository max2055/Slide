import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection, decryptData, encryptData } from './db-connection.js';
import { serverDatabaseService as servers } from './server-database-service.js';

const key = '0123456789abcdef'.repeat(4);
const credentials = { username: 'fixture', password: 'synthetic password with spaces' };

function legacy(value: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key.slice(0, 32)), iv);
  return `${iv.toString('hex')}:${cipher.update(value, 'utf8', 'hex')}${cipher.final('hex')}`;
}

// GitHub #589 / MAX-318: real crypto, simulated SQL boundary.
describe('server credential migration availability', () => {
  let execute: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.spyOn>;
  let envelope: string;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', key);
    envelope = legacy(JSON.stringify(credentials));
    execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    vi.spyOn(servers, 'getServerById').mockImplementation(async () => ({ id: 318, credential_encrypted: envelope }) as any);
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('returns decrypted legacy credentials when migration UPDATE fails without logging its secret-bearing error', async () => {
    execute.mockRejectedValue(Object.assign(new Error(credentials.password), { sql: envelope, cause: credentials }));
    expect(await servers.getDecryptedCredentials(318)).toEqual(credentials);
    expect(log.mock.calls).toEqual([['服务器凭据迁移失败', { serverId: 318, code: 'SERVER_CREDENTIAL_MIGRATION_FAILED' }]]);
  });

  it('migrates a real CBC envelope to v2 using the observed ciphertext as the CAS predicate', async () => {
    expect(await servers.getDecryptedCredentials(318)).toEqual(credentials);
    const [sql, values] = execute.mock.calls[0];
    expect(sql).toBe('UPDATE servers SET credential_encrypted = ? WHERE id = ? AND credential_encrypted = ?');
    expect(values.slice(1)).toEqual([318, envelope]);
    expect(values[0]).toMatch(/^v2:/);
    expect(JSON.parse(decryptData(values[0]))).toEqual(credentials);
    expect(log).not.toHaveBeenCalled();
  });

  it('returns the read snapshot when CAS loses without retrying or overwriting the newer credential', async () => {
    execute.mockResolvedValue([{ affectedRows: 0 }, []]);
    expect(await servers.getDecryptedCredentials(318)).toEqual(credentials);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['invalid ciphertext', 'invalid JSON'])('returns null for %s without migration or plaintext logs', async (kind) => {
    envelope = kind === 'invalid ciphertext' ? 'malformed-envelope' : legacy(credentials.password);
    expect(await servers.getDecryptedCredentials(318)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(credentials.password);
    expect(JSON.stringify(log.mock.calls)).not.toContain(envelope);
  });

  it('does not write an already current envelope', async () => {
    envelope = encryptData(JSON.stringify(credentials));
    expect(await servers.getDecryptedCredentials(318)).toEqual(credentials);
    expect(execute).not.toHaveBeenCalled();
  });
});
