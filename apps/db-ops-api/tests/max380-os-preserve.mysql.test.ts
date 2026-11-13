import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requirePermission } from '../src/auth/require-permission.js';
import { dbConnection, encryptData } from '../src/db-connection.js';
import { serverDatabaseService } from '../src/server-database-service.js';

/**
 * MAX-380 real update chain.
 *
 * Default collection does not read credentials. Real acceptance is opt-in and
 * requires an injected 127.0.0.1:3308 account plus a 32-byte encryption key.
 * The key and password stay in the process environment.
 *
 * JWT boundary: this file does not call the production login route and does
 * not load a user session. A local Fastify preHandler uses the production
 * requirePermission('servers:manage') check. The bearer value is a test
 * marker, not a signed platform JWT. Persistence goes through
 * serverDatabaseService.updateServer, the same function PUT /api/servers/:id
 * calls after that permission check.
 */

type MysqlEnv = Record<string, string | undefined>;

function acceptanceEnabled(env: MysqlEnv = process.env): boolean {
  return env.MAX380_MYSQL_ACCEPTANCE === '1';
}

function mysqlTestConfig(env: MysqlEnv = process.env): mysql.ConnectionOptions {
  const host = env.MAX380_MYSQL_HOST;
  const portText = env.MAX380_MYSQL_PORT;
  const user = env.MAX380_MYSQL_USER;
  const password = env.MAX380_MYSQL_PASSWORD;
  const encryptionKey = env.MAX380_ENCRYPTION_KEY;
  const port = Number(portText);
  if (host !== '127.0.0.1' || portText !== '3308' || !Number.isInteger(port) || !user || password === undefined) {
    throw new Error(
      'MAX380_MYSQL_ACCEPTANCE=1 requires MAX380_MYSQL_HOST=127.0.0.1, MAX380_MYSQL_PORT=3308, MAX380_MYSQL_USER, and MAX380_MYSQL_PASSWORD',
    );
  }
  if (!encryptionKey || Buffer.byteLength(encryptionKey, 'utf8') !== 32) {
    throw new Error('MAX380_MYSQL_ACCEPTANCE=1 requires MAX380_ENCRYPTION_KEY to be exactly 32 UTF-8 bytes');
  }
  return { host, port, user, password };
}

const SCHEMA_NAME = /^max380_[a-z0-9]+$/;

function isConfirmedCreateDatabaseReceipt(receipt: unknown): boolean {
  const packet = Array.isArray(receipt) ? receipt[0] : receipt;
  if (!packet || typeof packet !== 'object') return false;
  const row = packet as { fieldCount?: unknown; affectedRows?: unknown; serverStatus?: unknown; warningStatus?: unknown };
  return row.fieldCount === 0
    && typeof row.affectedRows === 'number'
    && Number.isFinite(row.affectedRows)
    && typeof row.serverStatus === 'number'
    && typeof row.warningStatus === 'number';
}

describe('MAX-380 injected mysql acceptance config', () => {
  it('stays disabled until this task explicitly enables real acceptance', () => {
    expect(acceptanceEnabled({})).toBe(false);
    expect(acceptanceEnabled({ MAX380_MYSQL_ACCEPTANCE: '0' })).toBe(false);
  });

  it('fails when real acceptance is enabled without the injected 3308 endpoint', () => {
    expect(() => mysqlTestConfig({ MAX380_MYSQL_ACCEPTANCE: '1' })).toThrow(/MAX380_MYSQL_PORT=3308/);
    expect(() => mysqlTestConfig({
      MAX380_MYSQL_ACCEPTANCE: '1',
      MAX380_MYSQL_HOST: '127.0.0.1',
      MAX380_MYSQL_PORT: '3306',
      MAX380_MYSQL_USER: 'root',
      MAX380_MYSQL_PASSWORD: 'injected',
      MAX380_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    })).toThrow(/MAX380_MYSQL_PORT=3308/);
    expect(() => mysqlTestConfig({
      MAX380_MYSQL_ACCEPTANCE: '1',
      MAX380_MYSQL_HOST: '127.0.0.1',
      MAX380_MYSQL_PORT: '3308',
      MAX380_MYSQL_USER: 'root',
      MAX380_MYSQL_PASSWORD: 'injected',
    })).toThrow(/MAX380_ENCRYPTION_KEY/);
  });
});

describe.skipIf(!acceptanceEnabled())('MAX-380 unknown os_type survives the real update chain', () => {
  const owned = new Set<string>();
  const schema = `max380_${randomBytes(4).toString('hex')}`;
  let admin: mysql.Connection | null = null;
  let app: FastifyInstance | null = null;
  const manageToken = `max380-manage-${randomBytes(4).toString('hex')}`;
  const viewToken = `max380-view-${randomBytes(4).toString('hex')}`;
  let unknownId = 0;
  let emptyId = 0;
  let versionedId = 0;
  let kylinId = 0;
  let untouchedId = 0;

  beforeAll(async () => {
    const config = mysqlTestConfig();
    process.env.ENCRYPTION_KEY = process.env.MAX380_ENCRYPTION_KEY;
    admin = await mysql.createConnection({ ...config, multipleStatements: false });
    if (!SCHEMA_NAME.test(schema)) throw new Error('INVALID_SCHEMA_NAME');
    const receipt = await admin.query(`CREATE DATABASE \`${schema}\``);
    if (!isConfirmedCreateDatabaseReceipt(receipt)) throw new Error('CREATE_DATABASE_RECEIPT_UNKNOWN');
    owned.add(schema);
    await admin.query(`USE \`${schema}\``);
    await admin.query(`
      CREATE TABLE servers (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        host VARCHAR(255) NOT NULL,
        port INT UNSIGNED NOT NULL DEFAULT 22,
        label VARCHAR(255) DEFAULT NULL,
        os_type VARCHAR(50) NOT NULL,
        credential_type ENUM('password','key') NOT NULL,
        credential_encrypted TEXT NOT NULL,
        host_key_fingerprint VARCHAR(255) DEFAULT NULL,
        ssh_trust_mode VARCHAR(32) DEFAULT NULL,
        status ENUM('online','offline','error','unreachable') NOT NULL DEFAULT 'offline',
        last_check_at DATETIME DEFAULT NULL,
        collection_enabled TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_host_port (host, port)
      ) ENGINE=InnoDB
    `);
    const encrypted = encryptData(JSON.stringify({ username: 'ops', password: 'unused' }));
    const insert = async (host: string, osType: string, label: string) => {
      const [result] = await admin!.execute(
        `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, status, collection_enabled)
         VALUES (?, 22, ?, ?, 'password', ?, 'offline', 0)`,
        [host, label, osType, encrypted],
      );
      return Number((result as { insertId: number }).insertId);
    };
    unknownId = await insert('192.0.2.80', 'Ubuntu 22.04', '未知系统');
    emptyId = await insert('192.0.2.81', '', '空系统');
    versionedId = await insert('192.0.2.82', 'CentOS Linux 7', '带版本');
    kylinId = await insert('192.0.2.83', 'kylin', '麒麟');
    untouchedId = await insert('192.0.2.84', 'debian', '不修改');
    await dbConnection.close();
    const connected = await dbConnection.initialize({
      host: String(config.host),
      port: Number(config.port),
      user: String(config.user),
      password: String(config.password),
      database: schema,
    });
    if (!connected) throw new Error('ISOLATED_DATABASE_UNAVAILABLE');

    app = Fastify({ logger: false });
    app.decorateRequest('user', null);
    app.addHook('preHandler', async (request, reply) => {
      const header = request.headers.authorization ?? '';
      if (header === `Bearer ${manageToken}`) {
        request.user = { userId: 380, username: 'max380-manage', permissions: ['servers:manage'] };
        return;
      }
      if (header === `Bearer ${viewToken}`) {
        request.user = { userId: 381, username: 'max380-view', permissions: ['servers:view'] };
        return;
      }
      return reply.code(401).send({ error: '请先登录' });
    });
    app.put('/api/servers/:id', { preHandler: [requirePermission('servers:manage')] }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const data = request.body as Record<string, unknown>;
      const result = await serverDatabaseService.updateServer(Number(id), data);
      if (!result.success) return reply.code(400).send({ error: result.error });
      return reply.send({ message: '更新成功' });
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    const cleanupErrors: string[] = [];
    if (app) {
      try { await app.close(); } catch { cleanupErrors.push('app'); }
    }
    try { await dbConnection.close(); } catch { cleanupErrors.push('pool'); }
    if (admin) {
      for (const name of [...owned]) {
        if (!SCHEMA_NAME.test(name)) {
          cleanupErrors.push(name);
          continue;
        }
        try {
          await admin.query(`DROP DATABASE \`${name}\``);
          owned.delete(name);
        } catch {
          cleanupErrors.push(name);
        }
      }
      try { await admin.end(); } catch { cleanupErrors.push('admin'); }
    }
    if (cleanupErrors.length) throw new Error(`CLEANUP_ERROR ${cleanupErrors.join(',')}`);
  });

  async function readOs(id: number): Promise<string> {
    const [rows] = await admin!.execute('SELECT os_type, label FROM servers WHERE id = ?', [id]);
    const row = (rows as Array<{ os_type: string; label: string }>)[0];
    if (!row) throw new Error('ROW_MISSING');
    return row.os_type;
  }

  async function put(id: number, token: string, body: Record<string, unknown>) {
    return app!.inject({
      method: 'PUT',
      url: `/api/servers/${id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: body,
    });
  }

  it('keeps an unknown value when the update omits os_type, and rejects a raw unknown write', async () => {
    const before = await readOs(unknownId);
    expect(before).toBe('Ubuntu 22.04');
    const rejected = await put(unknownId, manageToken, {
      label: '未知系统',
      os_type: 'Ubuntu 22.04',
      credential_type: 'password',
      credential_username: 'ops',
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: 'HOST_OS_UNSUPPORTED' });
    expect(await readOs(unknownId)).toBe('Ubuntu 22.04');

    const saved = await put(unknownId, manageToken, {
      label: '只改标签',
      host: '192.0.2.80',
      port: 22,
      credential_type: 'password',
      credential_username: 'ops',
    });
    expect(saved.statusCode).toBe(200);
    expect(await readOs(unknownId)).toBe('Ubuntu 22.04');
    const [rows] = await admin!.execute('SELECT label FROM servers WHERE id = ?', [unknownId]);
    expect((rows as Array<{ label: string }>)[0]?.label).toBe('只改标签');
  });

  it('preserves empty, versioned, and canonical values until a supported type is chosen', async () => {
    const emptySaved = await put(emptyId, manageToken, { label: '空系统-新', credential_type: 'password', credential_username: 'ops' });
    expect(emptySaved.statusCode).toBe(200);
    expect(await readOs(emptyId)).toBe('');

    const versioned = await put(versionedId, manageToken, { label: '带版本-新', host: '192.0.2.82', port: 22 });
    expect(versioned.statusCode).toBe(200);
    expect(await readOs(versionedId)).toBe('CentOS Linux 7');

    const kylin = await put(kylinId, manageToken, { label: '麒麟-新' });
    expect(kylin.statusCode).toBe(200);
    expect(await readOs(kylinId)).toBe('kylin');

    const changed = await put(kylinId, manageToken, { os_type: 'rhel', label: '改为rhel' });
    expect(changed.statusCode).toBe(200);
    expect(await readOs(kylinId)).toBe('rhel');

    const explicitCentos = await put(versionedId, manageToken, { os_type: 'centos' });
    expect(explicitCentos.statusCode).toBe(200);
    expect(await readOs(versionedId)).toBe('centos');
  });

  it('does not write when manage permission is absent, and leaves other rows alone', async () => {
    const denied = await put(untouchedId, viewToken, { label: '越权', os_type: 'centos' });
    expect(denied.statusCode).toBe(403);
    const missing = await put(untouchedId, 'not-a-token', { label: '匿名', os_type: 'centos' });
    expect(missing.statusCode).toBe(401);
    expect(await readOs(untouchedId)).toBe('debian');
    const [count] = await admin!.execute('SELECT COUNT(*) AS total FROM servers');
    expect(Number((count as Array<{ total: number }>)[0]?.total)).toBe(5);
  });
});
