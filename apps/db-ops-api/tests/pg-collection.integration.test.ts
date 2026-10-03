import crypto from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Only the isolated fixture may register a loopback target. Keep the real
// target validation, PG driver, credential writer and MySQL persistence.
vi.mock('../src/security/database-target-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/security/database-target-policy.js')>();
  return {
    ...actual,
    authorizeDatabaseTarget: (input: any, options: any = {}) => actual.authorizeDatabaseTarget(input, {
      ...options, production: false, allowManagedLoopback: true,
    }),
  };
});

import { dbConnection, decryptData } from '../src/db-connection.js';
import { databaseService } from '../src/database-service.js';
import { instanceDatabaseService } from '../src/instance-database-service.js';
import { schemaDatabaseService } from '../src/schema-database-service.js';
import { indexDatabaseService } from '../src/index-database-service.js';
import { schemaService } from '../src/schema-service.js';
import { indexService } from '../src/index-service.js';

describe.skipIf(process.env.W03_PG_INTEGRATION !== '1')('isolated password-authenticated PG collection', () => {
  let instanceId: number;
  let admin: Client;
  const password = 'w03-fake-pg-password';
  const pgPort = Number(process.env.W03_PG_PORT);
  beforeAll(async () => {
    // Runner supplies dynamically allocated loopback ports and test-only DB.
    if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'w03_metadata'
      || !Number.isInteger(pgPort) || pgPort < 1024) throw new Error('Invalid isolated W03 fixture');
    expect(await dbConnection.initialize()).toBe(true);
    admin = new Client({ host: '127.0.0.1', port: pgPort, user: 'w03_admin', password: 'w03-fake-admin-password', database: 'w03_primary' });
    await admin.connect();
    const created = await instanceDatabaseService.createInstance({
      name: 'w03-isolated-pg', environment: 'development', db_type: 'postgresql',
      host: '127.0.0.1', port: pgPort, username: 'w03_reader', password,
      database_name: 'w03_primary',
    });
    expect(created.success).toBe(true);
    instanceId = created.instanceId!;
  }, 30_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (instanceId) await databaseService.removeConnection(instanceId);
    if (admin) await admin.end();
    await dbConnection.close();
  });

  async function readerSessions(): Promise<number> {
    const result = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename = 'w03_reader'");
    return result.rows[0].count;
  }

  async function assertCollected(): Promise<void> {
    expect(await schemaService.collectSchema(instanceId)).toMatchObject({ tables: 2, columns: 4 });
    expect(await indexService.collectIndexes(instanceId)).toMatchObject({ tables: 2, indexes: 4 });
    const schema = await schemaDatabaseService.getLatestSnapshot(instanceId);
    expect(schema.map(r => r.table_name)).toEqual(expect.arrayContaining([
      'w03_primary.public.widgets', 'w03_secondary.public.widgets',
    ]));
    const indexes = await indexDatabaseService.getIndexesByInstance(instanceId);
    expect(indexes.map(r => r.index_name)).toEqual(expect.arrayContaining(['widgets_pkey', 'widgets_name_idx']));
    expect(await readerSessions()).toBe(1); // Only the managed base connection remains.
  }

  it('saves v2 in MySQL then connects and persists multi-database schema/index snapshots', async () => {
    const stored = await instanceDatabaseService.getInstanceById(instanceId);
    expect(stored!.password_encrypted).toMatch(/^v2:/);
    const instance = await instanceDatabaseService.getInstanceWithDecryptedPassword(instanceId);
    expect(instance!.password).toBe(password);
    expect(await databaseService.addConnection(instanceId, instance!.name, {
      db_type: 'postgresql', host: instance!.host, port: instance!.port,
      user: instance!.username, password: instance!.password, database: instance!.database_name!,
    })).toBe(true);
    await assertCollected();
    expect((await instanceDatabaseService.getInstanceById(instanceId))!.password_encrypted).toBe(stored!.password_encrypted);
  });

  it('rejects an incorrect password with actual PG authentication', async () => {
    const client = new Client({ host: '127.0.0.1', port: pgPort, user: 'w03_reader', password: 'wrong-test-password', database: 'w03_primary' });
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: '28P01' });
    } finally {
      await client.end();
    }
    expect(await readerSessions()).toBe(1);
  });

  it('reads historical CBC using the original key text without rewriting the stored credential', async () => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(process.env.ENCRYPTION_KEY!.slice(0, 32)), iv);
    const legacy = `${iv.toString('hex')}:${cipher.update(password, 'utf8', 'hex')}${cipher.final('hex')}`;
    await dbConnection.query('UPDATE database_instances SET password_encrypted = ? WHERE id = ?', [legacy, instanceId]);
    expect(decryptData(legacy)).toBe(password);
    await assertCollected();
    expect((await instanceDatabaseService.getInstanceById(instanceId))!.password_encrypted).toBe(legacy);
  });

  for (const phase of ['discovery', 'schema tables', 'schema columns', 'indexes']) {
    it(`releases temporary sessions after a real server query error in ${phase}`, async () => {
      const originalQuery = Client.prototype.query;
      const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, sql: any, ...args: any[]) {
        const text = typeof sql === 'string' ? sql : sql?.text;
        const matches = phase === 'discovery' ? text?.includes('FROM pg_database')
          : phase === 'schema tables' ? text?.includes('FROM pg_class c')
          : phase === 'schema columns' ? text?.includes('FROM pg_attribute a')
          : text?.includes('FROM pg_index ix');
        return (originalQuery as any).call(this, matches ? 'SELECT 1 / 0' : sql, ...args);
      } as any);
      try {
        const collect = phase === 'indexes' ? indexService.collectIndexes.bind(indexService) : schemaService.collectSchema.bind(schemaService);
        expect(await collect(instanceId)).toEqual({ error: expect.stringContaining('division by zero') });
      } finally {
        spy.mockRestore();
      }
      expect(await readerSessions()).toBe(1);
    });
  }
});
