import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import ts from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requirePermission } from './auth/require-permission.js';
import { dbConnection, encryptData } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';
import type { MigrationPool } from './migrations/types.js';
import {
  SERVER_ADDRESS_ALREADY_MANAGED,
  SERVER_HAS_HISTORICAL_REPORTS,
  SERVER_UPDATE_FAILED,
  serverDatabaseService as servers,
} from './server-database-service.js';

const policy = vi.hoisted(() => ({
  authorizeServerTarget: vi.fn(),
}));

vi.mock('./security/server-target-policy.js', async () => {
  const actual = await vi.importActual<typeof import('./security/server-target-policy.js')>('./security/server-target-policy.js');
  policy.authorizeServerTarget.mockImplementation(actual.authorizeServerTarget);
  return { ...actual, authorizeServerTarget: policy.authorizeServerTarget };
});

type ActualPolicy = typeof import('./security/server-target-policy.js');
let actualPolicy: ActualPolicy;

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const updateRoute = serverSource.slice(
  serverSource.indexOf("  fastify.put('/api/servers/:id'"),
  serverSource.indexOf('  // 删除服务器'),
);
const routeJs = ts.transpileModule(updateRoute, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

type MemoryRow = {
  id: number;
  host: string;
  port: number;
  label: string | null;
  os_type: string;
  credential_type: 'password' | 'key';
  credential_encrypted: string;
  host_key_fingerprint: string | null;
  ssh_trust_mode: string | null;
  status: 'offline';
  last_check_at: null;
  collection_enabled: number;
  created_at: Date;
  updated_at: Date;
};

function driverError(code: string, errno: number, message: string) {
  const error = new Error(message) as Error & { code: string; errno: number; sqlMessage: string; sql: string };
  error.code = code;
  error.errno = errno;
  error.sqlMessage = message;
  error.sql = "UPDATE servers SET host = '192.0.2.10' WHERE id = 1";
  return error;
}

function createMemoryPool() {
  const rows: MemoryRow[] = [];
  let nextId = 1;
  let failDriver = false;
  let chain: Promise<void> = Promise.resolve();
  const acquire = () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const previous = chain;
    chain = gate;
    return previous.then(() => release);
  };

  class Connection {
    private draft: MemoryRow[] | null = null;
    private releaseLock: (() => void) | null = null;

    async beginTransaction() {
      this.releaseLock = await acquire();
      this.draft = rows.map(row => ({ ...row }));
    }

    async execute(sql: string, values: unknown[] = []) {
      const table = this.draft ?? rows;
      if (sql.startsWith('SELECT')) {
        const id = Number(values[0]);
        return [table.filter(row => row.id === id).map(row => ({ ...row })), []];
      }
      if (!sql.startsWith('UPDATE servers SET ')) throw new Error(`unexpected sql ${sql}`);
      if (failDriver) {
        throw driverError('ER_NO_SUCH_TABLE', 1146, "Table 'max371.servers' doesn't exist; marker max371-driver-secret");
      }
      const assignments = sql.slice('UPDATE servers SET '.length).replace(/ WHERE id = \?$/, '').split(', ');
      const id = Number(values[values.length - 1]);
      const row = table.find(item => item.id === id);
      if (!row) return [{ affectedRows: 0 }, []];
      const next = { ...row };
      assignments.forEach((assignment, index) => {
        const field = assignment.replace(' = ?', '') as keyof MemoryRow;
        (next as Record<string, unknown>)[field] = values[index];
      });
      next.port = Number(next.port);
      if (table.some(other => other.id !== id && other.host === next.host && Number(other.port) === next.port)) {
        throw driverError('ER_DUP_ENTRY', 1062, "Duplicate entry '192.0.2.10-22' for key 'servers.uq_host_port'");
      }
      Object.assign(row, next);
      return [{ affectedRows: 1 }, []];
    }

    async commit() {
      if (this.draft) rows.splice(0, rows.length, ...this.draft);
      this.unlock();
    }

    async rollback() {
      this.unlock();
    }

    release() {
      this.unlock();
    }

    private unlock() {
      this.releaseLock?.();
      this.releaseLock = null;
    }
  }

  return {
    rows,
    setDriverFailure(value: boolean) { failDriver = value; },
    insert(patch: Partial<MemoryRow> & Pick<MemoryRow, 'host' | 'port'>): MemoryRow {
      const row: MemoryRow = {
        id: nextId++,
        host: patch.host,
        port: patch.port,
        label: patch.label ?? null,
        os_type: patch.os_type ?? 'centos',
        credential_type: patch.credential_type ?? 'password',
        credential_encrypted: patch.credential_encrypted ?? 'stored-secret',
        host_key_fingerprint: patch.host_key_fingerprint ?? null,
        ssh_trust_mode: patch.ssh_trust_mode ?? null,
        status: 'offline',
        last_check_at: null,
        collection_enabled: patch.collection_enabled ?? 1,
        created_at: new Date(),
        updated_at: new Date(),
      };
      rows.push(row);
      return row;
    },
    getConnection: async () => new Connection(),
    async execute() { throw new Error('update must use the locked connection'); },
  };
}

let currentUser: { permissions?: string[]; username?: string } | undefined;

async function put(id: number, payload: Record<string, unknown>) {
  const app = Fastify();
  const verifyToken = async (request: { user?: unknown }) => { request.user = currentUser; };
  new Function(
    'fastify', 'verifyToken', 'requirePermission', 'warnUnknown', 'serverDatabaseService', 'recordSshTrustRequest',
    routeJs,
  )(app, verifyToken, requirePermission, () => {}, servers, async () => {});
  try {
    const response = await app.inject({ method: 'PUT', url: `/api/servers/${id}`, payload });
    return { status: response.statusCode, body: response.json() };
  } finally {
    await app.close();
  }
}

function assertNoDriverLeak(payload: unknown, markers: string[]) {
  const text = JSON.stringify(payload);
  for (const marker of markers) expect(text).not.toContain(marker);
}

describe('MAX-371 / MAX-372 server edit target and duplicate response', () => {
  const pool = createMemoryPool();
  const calls: Array<{ host: string; port: number }> = [];

  beforeAll(async () => {
    actualPolicy = await vi.importActual<ActualPolicy>('./security/server-target-policy.js');
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  });

  beforeEach(() => {
    pool.rows.splice(0, pool.rows.length);
    pool.setDriverFailure(false);
    calls.length = 0;
    currentUser = { permissions: ['servers:manage'], username: 'max371-manager' };
    policy.authorizeServerTarget.mockImplementation(async (input: { host: string; port: number }) => {
      calls.push({ host: input.host, port: Number(input.port) });
      if (String(input.host).includes('dns-fail.example')) {
        throw new actualPolicy.ServerTargetPolicyError('SERVER_TARGET_DNS_FAILED');
      }
      if (String(input.host).includes('denied-name.example')) {
        throw new actualPolicy.ServerTargetPolicyError('SERVER_TARGET_ADDRESS_DENIED');
      }
      return actualPolicy.authorizeServerTarget(input);
    });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as never);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('keeps the production permission hook and the fixed duplicate contract', () => {
    expect(updateRoute).toContain("requirePermission('servers:manage')");
    expect(updateRoute).toContain('verifyToken');
    expect(updateRoute).toContain('result.error');
    expect(updateRoute).not.toContain('error.sqlMessage');
    const service = readFileSync(new URL('./server-database-service.ts', import.meta.url), 'utf8');
    const update = service.slice(service.indexOf('async updateServer('), service.indexOf('async deleteServer'));
    const remove = service.slice(service.indexOf('async deleteServer'), service.indexOf('async testConnection'));
    expect(update).toContain('serverTargetUnchanged');
    expect(update).toContain('FOR UPDATE');
    expect(update).toContain('updateClientError');
    expect(update).not.toContain('error.message');
    expect(service).toContain(`export const SERVER_ADDRESS_ALREADY_MANAGED = '该主机地址和端口已被纳管，请勿重复添加'`);
    expect(remove).toContain('SELECT id FROM reports WHERE server_id = ? LIMIT 1 FOR UPDATE');
    expect(remove).toContain('ER_ROW_IS_REFERENCED_2');
  });

  it.each([
    ['omitted', {}],
    ['explicit same', { host: 'Example.COM', port: 22 }],
    ['normalized', { host: '  example.com  ', port: '22' }],
  ] as const)('updates label, collection, and OS when host and port are %s despite injected DNS and policy failures', async (_name, address) => {
    const row = pool.insert({ host: 'Example.COM', port: 22, label: 'old', collection_enabled: 1, os_type: 'centos' });
    const result = await servers.updateServer(row.id, {
      ...(address as { host?: string; port?: number }),
      label: 'renamed',
      collection_enabled: 0,
      os_type: 'RHEL 9',
    });
    expect(result).toEqual({ success: true });
    expect(calls).toEqual([]);
    expect(pool.rows[0]).toMatchObject({
      label: 'renamed',
      collection_enabled: 0,
      os_type: 'rhel',
      port: 22,
    });
    expect(pool.rows[0].host === 'Example.COM' || pool.rows[0].host === 'example.com').toBe(true);
  });

  it('persists the canonical host for an equivalent submitted value and still skips DNS', async () => {
    const row = pool.insert({ host: 'Example.COM', port: 22 });
    expect(await servers.updateServer(row.id, { host: ' example.com ' })).toEqual({ success: true });
    expect(calls).toEqual([]);
    expect(pool.rows[0].host).toBe('example.com');
    expect(pool.rows[0].port).toBe(22);
  });

  it.each([
    ['host', { host: '192.0.2.50' }, { host: '192.0.2.50', port: 22 }],
    ['port', { port: 2222 }, { host: '192.0.2.10', port: 2222 }],
    ['both', { host: '192.0.2.51', port: 2223 }, { host: '192.0.2.51', port: 2223 }],
  ] as const)('authorizes and stores the changed %s pair', async (_name, patch, expected) => {
    const row = pool.insert({ host: '192.0.2.10', port: 22, label: 'keep' });
    expect(await servers.updateServer(row.id, patch as { host?: string; port?: number })).toEqual({ success: true });
    expect(calls).toEqual([expected]);
    expect(pool.rows[0]).toMatchObject({ ...expected, label: 'keep' });
  });

  it('does not let an omitted field, empty value, or near-miss comparison skip a real target change', async () => {
    const row = pool.insert({ host: '192.0.2.10', port: 22, label: 'before' });
    const denied = await servers.updateServer(row.id, { port: 2222, host: undefined as unknown as string, label: 'nope' });
    expect(denied).toEqual({ success: true });
    expect(calls.at(-1)).toEqual({ host: '192.0.2.10', port: 2222 });

    const emptyHost = await servers.updateServer(row.id, { host: '', label: 'empty-host' });
    expect(emptyHost.error).toBe('SERVER_TARGET_INVALID_HOST');
    const emptyPort = await servers.updateServer(row.id, { port: '' as unknown as number, label: 'empty-port' });
    expect(emptyPort.error).toBe('SERVER_TARGET_INVALID_PORT');
    const nearHost = await servers.updateServer(row.id, { host: '192.0.2.100', label: 'near' });
    expect(nearHost).toEqual({ success: true });
    const loopback = await servers.updateServer(row.id, { host: '127.0.0.1', label: 'loop' });
    expect(loopback.error).toBe('SERVER_TARGET_ADDRESS_DENIED');
    const dns = await servers.updateServer(row.id, { host: 'dns-fail.example', label: 'dns' });
    expect(dns.error).toBe('SERVER_TARGET_DNS_FAILED');
    const omittedDanger = await servers.updateServer(row.id, { label: 'still-safe' });
    expect(omittedDanger).toEqual({ success: true });
    expect(pool.rows[0]).toMatchObject({ host: '192.0.2.100', port: 2222, label: 'still-safe' });
    expect(pool.rows[0].label).not.toBe('loop');
  });

  it('keeps an in-flight target change serialized with a later host change', async () => {
    const row = pool.insert({ host: '192.0.2.10', port: 22 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    policy.authorizeServerTarget.mockImplementation(async (input: { host: string; port: number }) => {
      calls.push({ host: input.host, port: Number(input.port) });
      if (Number(input.port) === 2222 && input.host === '192.0.2.10') await gate;
      return actualPolicy.authorizeServerTarget(input);
    });
    const first = servers.updateServer(row.id, { port: 2222 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = servers.updateServer(row.id, { host: '192.0.2.11' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toHaveLength(1);
    release();
    expect(await first).toEqual({ success: true });
    expect(await second).toEqual({ success: true });
    expect(calls[1]).toEqual({ host: '192.0.2.11', port: 2222 });
    expect(pool.rows[0]).toMatchObject({ host: '192.0.2.11', port: 2222 });
  });

  it('returns the create duplicate message and hides non-duplicate driver text', async () => {
    const first = pool.insert({ host: '192.0.2.10', port: 22, label: 'one' });
    const second = pool.insert({ host: '192.0.2.11', port: 22, label: 'two' });
    const duplicate = await servers.updateServer(second.id, { host: '192.0.2.10', port: 22, label: 'collided' });
    expect(duplicate).toEqual({ success: false, error: SERVER_ADDRESS_ALREADY_MANAGED });
    assertNoDriverLeak(duplicate, ['uq_host_port', 'Duplicate entry', 'ER_DUP_ENTRY', 'max371-driver-secret']);
    expect(pool.rows.find(row => row.id === second.id)).toMatchObject({ host: '192.0.2.11', label: 'two' });
    expect(pool.rows.find(row => row.id === first.id)?.label).toBe('one');

    pool.setDriverFailure(true);
    const broken = await servers.updateServer(second.id, { label: 'should-not-stick' });
    expect(broken).toEqual({ success: false, error: SERVER_UPDATE_FAILED });
    assertNoDriverLeak(broken, ['max371-driver-secret', 'ER_NO_SUCH_TABLE', "doesn't exist"]);
    expect(pool.rows.find(row => row.id === second.id)?.label).toBe('two');
  });

  it('preserves designed business errors and the HTTP permission boundary', async () => {
    const row = pool.insert({ host: '192.0.2.10', port: 22, credential_type: 'password' });
    expect(await servers.updateServer(row.id, { os_type: 'not-an-os' })).toEqual({ success: false, error: 'HOST_OS_UNSUPPORTED' });
    expect(await servers.updateServer(999, { label: 'missing' })).toEqual({ success: false, error: '服务器不存在' });
    expect(await servers.updateServer(row.id, {
      credential_type: 'key',
      credential_value: 'new-key',
      credential_username: 'root',
    })).toEqual({ success: false, error: 'SSH_TRUST_CONFIRMATION_REQUIRED' });
    expect(pool.rows[0].credential_encrypted).toBe('stored-secret');

    currentUser = undefined;
    expect((await put(row.id, { label: 'anon' })).status).toBe(401);
    currentUser = { permissions: ['servers:view'], username: 'reader' };
    expect((await put(row.id, { label: 'denied' })).status).toBe(403);
    currentUser = { permissions: ['servers:manage'], username: 'max371-manager' };
    const allowed = await put(row.id, { label: 'from-http' });
    expect(allowed.status).toBe(200);
    expect(pool.rows[0].label).toBe('from-http');
    const conflict = await put(pool.insert({ host: '192.0.2.12', port: 22 }).id, { host: '192.0.2.10', port: 22 });
    expect(conflict.status).toBe(400);
    expect(conflict.body).toEqual({ error: SERVER_ADDRESS_ALREADY_MANAGED });
    assertNoDriverLeak(conflict.body, ['uq_host_port', 'Duplicate entry']);
  });
});

type MysqlEnv = Record<string, string | undefined>;

function acceptanceEnabled(env: MysqlEnv = process.env): boolean {
  return env.MAX371_MYSQL === '1';
}

function readMysqlTestProfile(env: MysqlEnv = process.env) {
  const host = env.MAX371_MYSQL_HOST;
  const portText = env.MAX371_MYSQL_PORT;
  const user = env.MAX371_MYSQL_USER;
  const password = env.MAX371_MYSQL_PASSWORD;
  const port = Number(portText);
  if (host !== '127.0.0.1' || portText !== '3308' || !Number.isInteger(port) || !user || password === undefined || password === '') {
    throw new Error('MAX371_MYSQL=1 requires MAX371_MYSQL_HOST=127.0.0.1, MAX371_MYSQL_PORT=3308, MAX371_MYSQL_USER, and MAX371_MYSQL_PASSWORD');
  }
  return { host, port, user, password };
}

const SAFE_DATABASE_NAME = /^max371_[a-z0-9_]+$/;
const realMysql = acceptanceEnabled();
const evidence: Record<string, unknown> = {
  task: 'MAX-371/MAX-372',
  github: [586, 587],
  mode: realMysql ? 'real-mysql3308-isolated-schema' : 'injected-policy-and-memory-lock',
  dns: 'injected ServerTargetPolicyError or IP literals; this suite does not call external DNS',
  jwt: 'not tested; verifyToken is injected and requirePermission is the production function',
};

describe('MAX-371 injected mysql acceptance config', () => {
  it('stays off unless the isolated 3308 endpoint is injected', () => {
    expect(acceptanceEnabled({})).toBe(false);
    expect(() => readMysqlTestProfile({ MAX371_MYSQL: '1', MAX371_MYSQL_PORT: '3306' })).toThrow(/3308/);
  });
});

describe.skipIf(!realMysql)('MAX-371 real mysql3308 server edit', () => {
  const database = `max371_${process.pid}`;
  let admin: Pool;
  let pool: Pool;
  let owned = false;
  let profile: ReturnType<typeof readMysqlTestProfile>;

  beforeAll(async () => {
    expect(SAFE_DATABASE_NAME.test(database)).toBe(true);
    profile = readMysqlTestProfile();
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    actualPolicy = await vi.importActual<ActualPolicy>('./security/server-target-policy.js');
    policy.authorizeServerTarget.mockImplementation(async (input: { host: string; port: number }) => {
      if (String(input.host).includes('dns-fail.example')) {
        throw new actualPolicy.ServerTargetPolicyError('SERVER_TARGET_DNS_FAILED');
      }
      return actualPolicy.authorizeServerTarget(input);
    });
    admin = mysql.createPool({
      host: profile.host, port: profile.port, user: profile.user, password: profile.password,
      connectionLimit: 4,
    });
    const [schemas] = await admin.query<RowDataPacket[]>(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database],
    );
    if (schemas.length > 0) throw new Error(`refusing to adopt existing database ${database}`);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    owned = true;
    pool = mysql.createPool({
      host: profile.host, port: profile.port, user: profile.user, password: profile.password,
      database, connectionLimit: 6,
    });
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      await new MigrationRunner(pool as unknown as MigrationPool).run();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as never);
    const [identity] = await pool.query<RowDataPacket[]>('SELECT @@port AS port, DATABASE() AS db');
    evidence.endpoint = { host: profile.host, port: profile.port, database: identity[0].db, server_port: Number(identity[0].port) };
  }, 180000);

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await pool?.end().catch(() => undefined);
    if (owned) {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      const [left] = await admin.query<RowDataPacket[]>(
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        [database],
      );
      evidence.schema_removed = left.length === 0;
    }
    await admin?.end().catch(() => undefined);
    const directory = process.env.MAX371_EVIDENCE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
    }
  }, 60000);

  async function insert(host: string, port: number, label = 'server') {
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, collection_enabled)
       VALUES (?, ?, ?, 'centos', 'password', ?, 1)`,
      [host, port, label, encryptData(JSON.stringify({ username: 'u', password: 'stored' }))],
    );
    return Number(result.insertId);
  }

  async function read(id: number) {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT host, port, label, os_type, collection_enabled FROM servers WHERE id = ?',
      [id],
    );
    return rows[0];
  }

  it('persists an unchanged-address edit while injected DNS failure blocks a real change', async () => {
    const id = await insert('192.0.2.71', 22, 'before');
    expect(await servers.updateServer(id, { label: 'after', collection_enabled: 0, os_type: 'kylin' })).toEqual({ success: true });
    expect(await read(id)).toMatchObject({ host: '192.0.2.71', port: 22, label: 'after', os_type: 'kylin', collection_enabled: 0 });
    const denied = await servers.updateServer(id, { host: '127.0.0.1', label: 'blocked' });
    expect(denied.error).toBe('SERVER_TARGET_ADDRESS_DENIED');
    const dns = await servers.updateServer(id, { host: 'dns-fail.example', label: 'blocked-dns' });
    expect(dns.error).toBe('SERVER_TARGET_DNS_FAILED');
    expect(await read(id)).toMatchObject({ host: '192.0.2.71', label: 'after' });
    evidence.unchanged_edit = { persisted: true, denied_address_unchanged: true, injected_dns_unchanged: true };
  });

  it('returns the fixed Chinese duplicate message from MySQL and HTTP without driver text', async () => {
    const kept = await insert('192.0.2.72', 22, 'kept');
    const moving = await insert('192.0.2.73', 22, 'moving');
    const created = await servers.createServer({
      host: '192.0.2.74', port: 22, os_type: 'centos', credential_type: 'password',
      credential_username: 'u', credential_value: 'secret', label: 'created',
    });
    expect(created.success).toBe(true);
    const duplicateCreate = await servers.createServer({
      host: '192.0.2.74', port: 22, os_type: 'centos', credential_type: 'password',
      credential_username: 'u', credential_value: 'secret', label: 'again',
    });
    expect(duplicateCreate.success).toBe(false);
    expect(duplicateCreate.error).not.toContain('uq_host_port');
    expect(duplicateCreate.error).not.toContain('Duplicate entry');

    const conflict = await servers.updateServer(moving, { host: '192.0.2.72', port: 22, label: 'lost' });
    expect(conflict).toEqual({ success: false, error: SERVER_ADDRESS_ALREADY_MANAGED });
    assertNoDriverLeak(conflict, ['uq_host_port', 'Duplicate entry', 'ER_DUP_ENTRY']);
    expect(await read(moving)).toMatchObject({ host: '192.0.2.73', label: 'moving' });
    expect((await read(kept)).label).toBe('kept');

    currentUser = { permissions: ['servers:manage'], username: 'max371-manager' };
    const httpConflict = await put(moving, { host: '192.0.2.74', port: 22 });
    expect(httpConflict).toMatchObject({ status: 400, body: { error: SERVER_ADDRESS_ALREADY_MANAGED } });
    assertNoDriverLeak(httpConflict.body, ['uq_host_port', 'Duplicate entry']);
    currentUser = { permissions: ['servers:view'] };
    expect((await put(moving, { label: 'nope' })).status).toBe(403);
    expect((await read(moving)).label).toBe('moving');

    await pool.query('DROP TRIGGER IF EXISTS max371_driver_fail');
    await pool.query(
      "CREATE TRIGGER max371_driver_fail BEFORE UPDATE ON servers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'max371-driver-secret uq_host_port'",
    );
    const leaked = await servers.updateServer(moving, { label: 'trigger' });
    expect(leaked).toEqual({ success: false, error: SERVER_UPDATE_FAILED });
    assertNoDriverLeak(leaked, ['max371-driver-secret', 'uq_host_port', 'SQLSTATE']);
    expect((await read(moving)).label).toBe('moving');
    await pool.query('DROP TRIGGER IF EXISTS max371_driver_fail');
    const restored = await servers.updateServer(moving, { label: 'restored' });
    expect(restored).toEqual({ success: true });
    expect((await read(moving)).label).toBe('restored');
    evidence.duplicate = {
      update_error: conflict.error,
      http_status: httpConflict.status,
      permission_without_manage: 403,
      driver_error: SERVER_UPDATE_FAILED,
      create_duplicate_hides_index: true,
    };
  });

  it('serializes a port change with a following host change and keeps historical reports', async () => {
    const id = await insert('192.0.2.75', 22, 'race');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: Array<{ host: string; port: number }> = [];
    policy.authorizeServerTarget.mockImplementation(async (input: { host: string; port: number }) => {
      seen.push({ host: input.host, port: Number(input.port) });
      if (input.host === '192.0.2.75' && Number(input.port) === 2275) await gate;
      return actualPolicy.authorizeServerTarget(input);
    });
    const first = servers.updateServer(id, { port: 2275 });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const second = servers.updateServer(id, { host: '192.0.2.76' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(seen).toHaveLength(1);
    release();
    expect(await first).toEqual({ success: true });
    expect(await second).toEqual({ success: true });
    expect(seen[1]).toEqual({ host: '192.0.2.76', port: 2275 });
    expect(await read(id)).toMatchObject({ host: '192.0.2.76', port: 2275 });

    const reported = await insert('192.0.2.77', 22, 'reported');
    await pool.execute(
      `INSERT INTO reports (name, type, format, server_id, content, status)
       VALUES ('MAX-371 historical', 'server_health', 'json', ?, 'max371-report', 'completed')`,
      [reported],
    );
    expect(await servers.deleteServer(reported)).toEqual({ success: false, error: SERVER_HAS_HISTORICAL_REPORTS });
    expect(await read(reported)).toMatchObject({ host: '192.0.2.77', label: 'reported' });
    const [reports] = await pool.query<RowDataPacket[]>('SELECT id FROM reports WHERE server_id = ?', [reported]);
    expect(reports).toHaveLength(1);
    evidence.concurrency = { authorized_second_pair: seen[1], stored: await read(id) };
    evidence.delete_protection = { error: SERVER_HAS_HISTORICAL_REPORTS, report_rows: 1 };
  });
});
