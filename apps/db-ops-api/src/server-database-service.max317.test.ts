import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { format } from 'node:util';
import Fastify from 'fastify';
import mysql, { type Pool } from 'mysql2/promise';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection, decryptData, encryptData } from './db-connection.js';
import { LOST_KEY_ROTATION_SENTINEL as marker } from './credential-rotation.js';
import { recordSshTrustRequest } from './security/ssh-trust-audit.js';
import { MigrationRunner } from './migrations/runner.js';
import type { MigrationPool } from './migrations/types.js';
import { serverDatabaseService as servers } from './server-database-service.js';

// #588 / MAX-317: execute the production PUT handler, real crypto and service.
// Auth hooks are stubbed; this suite does not claim JWT/permission E2E coverage.
const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const start = source.indexOf("  fastify.put('/api/servers/:id'");
const end = source.indexOf('  // 删除服务器', start);
if (start < 0 || end < 0) throw new Error('Server update route not found');
const route = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function put(id: number, payload: Record<string, unknown>) {
  const logs: string[] = [];
  const app = Fastify({ logger: { stream: { write: (line: string) => { logs.push(line); } } } });
  new Function('fastify', 'verifyToken', 'requirePermission', 'warnUnknown', 'serverDatabaseService', 'recordSshTrustRequest', route)(
    app, async () => {}, () => async () => {}, () => {}, servers, recordSshTrustRequest,
  );
  try {
    const response = await app.inject({ method: 'PUT', url: `/api/servers/${id}`, payload });
    return { status: response.statusCode, body: response.json(), logs };
  } finally { await app.close(); }
}

const port = Number(process.env.MAX317_MYSQL_PORT);
describe.each(['memory', ...(port ? ['mysql'] : [])])('MAX-317 server credentials (%s storage)', (storage) => {
  const schema = `max317_${process.pid}`;
  let root: Pool | undefined;
  let schemaCreated = false;
  let pool: Pool;
  let row: any;
  let id: number;
  let execute: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.spyOn>;
  const secret = 'synthetic-MAX317-secret-with-spaces 中文';
  const credentials = { username: 'old-user', password: secret };

  beforeAll(async () => {
    if (storage !== 'mysql') return;
    // Explicit disposable test endpoint only; never load application .env.
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${schema}`);
    schemaCreated = true;
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database: schema });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
  }, 180000);

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    row = { id: 317, host: '203.0.113.30', port: 22, os_type: 'centos', credential_type: 'password',
      credential_encrypted: encryptData(JSON.stringify(credentials)), collection_enabled: 0 };
    if (storage === 'mysql') {
      await pool.query('DELETE FROM servers');
      const [result] = await pool.execute<any>(`INSERT INTO servers
        (host, port, os_type, credential_type, credential_encrypted, collection_enabled)
        VALUES (?, 22, 'centos', 'password', ?, 0)`, [row.host, row.credential_encrypted]);
      id = result.insertId;
      execute = vi.fn((sql: string, values: any[]) => pool.execute(sql, values));
    } else {
      id = row.id;
      execute = vi.fn(async (sql: string, values: any[]) => {
        if (sql.startsWith('SELECT')) return [[{ ...row }], []];
        const assignments = sql.match(/SET (.+) WHERE/)?.[1].split(', ') ?? [];
        assignments.forEach((assignment, index) => { row[assignment.slice(0, -4)] = values[index]; });
        return [{ affectedRows: 1 }, []];
      });
    }
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({
      execute,
      getConnection: async () => storage === 'mysql' ? pool.getConnection() : {
        execute,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release() {},
        destroy() {},
      },
    } as any);
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    if (!root) return;
    await pool?.end();
    if (schemaCreated) await root.query(`DROP DATABASE ${schema}`);
    await root.end();
  });

  async function store(blob: string, type: 'password' | 'key' = 'password') {
    if (storage === 'mysql') await pool.execute('UPDATE servers SET credential_encrypted = ?, credential_type = ? WHERE id = ?', [blob, type, id]);
    else { row.credential_encrypted = blob; row.credential_type = type; }
  }
  async function stored() {
    return (await servers.getServerById(id))!;
  }

  it.each(['non-json', 'truncated-json', 'wrong-key', 'corrupt-ciphertext'])('returns only a fixed code for %s without writing or logging plaintext', async (kind) => {
    let blob = encryptData(kind === 'non-json' ? secret : `{"password":"${secret}`);
    if (kind === 'wrong-key') blob = encryptData(JSON.stringify(credentials), randomBytes(32).toString('base64'));
    if (kind === 'corrupt-ciphertext') blob = 'v2:invalid-key-id:00:00:00';
    await store(blob);
    const response = await put(id, { credential_username: 'new-user' });
    // Boolean comparisons keep potential plaintext out of failing test output.
    expect(JSON.stringify(response.body) === JSON.stringify({ error: 'SERVER_CREDENTIALS_INVALID' })).toBe(true);
    expect(response.status).toBe(400);
    expect((await stored()).credential_encrypted === blob).toBe(true);
    expect(execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    const output = response.logs.join('') + log.mock.calls.map(args => format(...args)).join('');
    for (const fragment of ['synthetic', 'MAX317-secret', 'with-spaces', '中文']) expect(output.includes(fragment)).toBe(false);
  });

  it('sanitizes direct credential reads as well as update errors', async () => {
    await store(encryptData(secret));
    expect(() => servers.decryptCredentials(encryptData(secret))).toThrow(/^SERVER_CREDENTIALS_INVALID$/);
    expect(await servers.getDecryptedCredentials(id)).toBeNull();
    expect(log.mock.calls.map(args => format(...args)).join('').includes('synthetic')).toBe(false);
  });

  it.each(['password', 'key'] as const)('keeps the existing %s when only the username changes', async (type) => {
    const field = type === 'password' ? 'password' : 'privateKey';
    await store(encryptData(JSON.stringify({ username: 'old-user', [field]: secret })), type);
    const response = await put(id, { credential_username: 'new-user' });
    expect(response.status).toBe(200);
    const saved = await stored();
    const decoded = JSON.parse(decryptData(saved.credential_encrypted));
    expect(decoded.username).toBe('new-user');
    expect(decoded[field] === secret).toBe(true);
    expect(saved.credential_type).toBe(type);
    expect(saved.collection_enabled).toBe(0);
  });

  it('reuses the stored username when replacing only the password', async () => {
    expect((await put(id, { credential_value: 'synthetic-replacement' })).status).toBe(200);
    const decoded = await servers.getDecryptedCredentials(id);
    expect(decoded?.username).toBe('old-user');
    expect(decoded?.password === 'synthetic-replacement').toBe(true);
  });

  it.each(['non-json', 'wrong-key', 'rotation-marker'])('allows complete replacement of %s credentials', async (kind) => {
    await store(kind === 'wrong-key' ? encryptData(secret, randomBytes(32).toString('base64'))
      : encryptData(kind === 'rotation-marker' ? marker : secret));
    expect((await put(id, { credential_type: 'key', credential_username: 'replacement-user', credential_value: secret, host_key_fingerprint: 'SHA256:' + 'A'.repeat(43) })).status).toBe(200);
    const saved = await stored();
    expect(saved.credential_type).toBe('key');
    expect(saved.collection_enabled).toBe(0);
    expect((await servers.getDecryptedCredentials(id))?.privateKey === secret).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([marker, JSON.stringify({ username: 'old-user', password: marker })])('preserves rotation-marker rejection', async (payload) => {
    const blob = encryptData(payload);
    await store(blob);
    expect(() => servers.decryptCredentials(blob)).toThrow('CREDENTIAL_ROTATION_REQUIRED');
    const response = await put(id, { credential_username: 'new-user' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('CREDENTIAL_ROTATION_REQUIRED');
    expect((await stored()).credential_encrypted === blob).toBe(true);
  });
});
