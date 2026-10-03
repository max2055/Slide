import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { encryptData } from './db-connection.js';

const password = 'w03-fake-pg-password';
const hexKey = '0123456789abcdef'.repeat(4);

function legacyEncrypt(key: string): string {
  const iv = crypto.randomBytes(16);
  // Historical instance writer treated the first 32 characters as UTF-8,
  // including when ENCRYPTION_KEY was hex/base64 text.
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key.slice(0, 32)), iv);
  return `${iv.toString('hex')}:${cipher.update(password, 'utf8', 'hex')}${cipher.final('hex')}`;
}

interface ClientPlan {
  connectError?: Error;
  queryError?: Error;
  malformed?: boolean;
  endError?: Error;
}

export class CollectionPgClient {
  static clients: CollectionPgClient[] = [];
  static plans: ClientPlan[] = [];
  readonly discovery: boolean;
  readonly plan: ClientPlan;
  constructor(readonly config: Record<string, unknown>) {
    this.discovery = CollectionPgClient.clients.length === 0;
    this.plan = CollectionPgClient.plans[CollectionPgClient.clients.length] ?? {};
    CollectionPgClient.clients.push(this);
  }
  connect = vi.fn(async () => {
    if (this.plan.connectError) throw this.plan.connectError;
  });
  query = vi.fn(async (sql: string) => {
    if (this.plan.queryError) throw this.plan.queryError;
    if (this.plan.malformed) return { rows: this.discovery ? null : [null] };
    if (sql.includes('FROM pg_database')) return { rows: [{ datname: 'analytics' }, { datname: 'app' }] };
    return { rows: [{
      schema_name: 'public', table_name: 'widgets', column_name: 'id',
      column_type: 'integer', index_name: 'widgets_pkey', seq: 1,
      non_unique: true, is_valid: true, index_type: 'btree',
    }] };
  });
  end = vi.fn(async () => {
    if (this.plan.endError) throw this.plan.endError;
  });
}

export function describePGCollection(options: {
  collect: () => Promise<any>;
  loadInstance: Mock;
  save: Mock;
}): void {
  describe('PostgreSQL credentials and temporary client ownership', () => {
    let instance: Record<string, unknown>;
    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubEnv('ENCRYPTION_KEY', hexKey);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      CollectionPgClient.clients = [];
      CollectionPgClient.plans = [];
      instance = {
        id: 1, db_type: 'postgresql', host: '127.0.0.1', port: 5432,
        username: 'w03', database_name: 'app', password_encrypted: encryptData(password),
      };
      options.loadInstance.mockResolvedValue(instance);
      options.save.mockResolvedValue({ success: true });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    const keys = [
      ['UTF-8', 'w03-test-encryption-key-32-bytes'],
      ['hex', hexKey],
      ['base64', Buffer.from('w03-test-encryption-key-32-bytes').toString('base64')],
    ];
    for (const [keyName, key] of keys) {
      for (const format of ['v2', 'legacy CBC']) {
        it(`uses the instance writer's ${keyName} key for ${format} in every client`, async () => {
          vi.stubEnv('ENCRYPTION_KEY', key);
          instance.password_encrypted = format === 'v2' ? encryptData(password) : legacyEncrypt(key);
          expect(await options.collect()).toMatchObject({ tables: 2, collected: 2 });
          expect(CollectionPgClient.clients.map(c => c.config.password)).toEqual([password, password, password]);
          expect(CollectionPgClient.clients.map(c => c.config.database)).toEqual(['app', 'app', 'analytics']);
          for (const client of CollectionPgClient.clients) expect(client.end).toHaveBeenCalledExactlyOnceWith();
          expect(options.save).toHaveBeenCalledWith(1, expect.arrayContaining([
            expect.objectContaining({ table_name: 'app.public.widgets', column_name: 'id' }),
            expect.objectContaining({ table_name: 'analytics.public.widgets', column_name: 'id' }),
          ]));
        });
      }
    }

    it('retains an explicitly empty password', async () => {
      instance.password_encrypted = '';
      expect(await options.collect()).toHaveProperty('collected', 2);
      expect(CollectionPgClient.clients.every(c => c.config.password === '')).toBe(true);
    });

    it('discovers via postgres when no default database is configured', async () => {
      instance.database_name = null;
      expect(await options.collect()).toMatchObject({ tables: 3, collected: 3 });
      expect(CollectionPgClient.clients.map(c => c.config.database)).toEqual(['postgres', 'postgres', 'analytics', 'app']);
      for (const client of CollectionPgClient.clients) expect(client.end).toHaveBeenCalledOnce();
    });

    for (const failure of ['malformed', 'tampered v2', 'wrong key', 'missing key', 'legacy default key']) {
      it(`fails before any connection for ${failure} without logging credentials`, async () => {
        if (failure === 'malformed') instance.password_encrypted = 'bad-ciphertext';
        if (failure === 'tampered v2') {
          const parts = String(instance.password_encrypted).split(':');
          parts[3] = '00'.repeat(16);
          instance.password_encrypted = parts.join(':');
        }
        if (failure === 'wrong key') vi.stubEnv('ENCRYPTION_KEY', 'x'.repeat(32));
        if (failure === 'missing key') vi.stubEnv('ENCRYPTION_KEY', undefined);
        if (failure === 'legacy default key') {
          instance.password_encrypted = legacyEncrypt('default-encryption-key-change-in-production');
          vi.stubEnv('ENCRYPTION_KEY', undefined);
        }
        const result = await options.collect();
        expect(result).toEqual({ error: expect.stringMatching(/密码解密失败/) });
        expect(CollectionPgClient.clients).toHaveLength(0);
        expect(options.save).not.toHaveBeenCalled();
        const logged = JSON.stringify([vi.mocked(console.error).mock.calls, vi.mocked(console.warn).mock.calls, result]);
        expect(logged).not.toContain(password);
        expect(logged).not.toContain(String(instance.password_encrypted));
        expect(logged).not.toContain(hexKey);
      });
    }

    for (const phase of ['connect', 'query', 'parse']) {
      it(`releases discovery on ${phase} failure, even if close also fails`, async () => {
        CollectionPgClient.plans = [{
          connectError: phase === 'connect' ? new Error('discovery-primary') : undefined,
          queryError: phase === 'query' ? new Error('discovery-primary') : undefined,
          malformed: phase === 'parse', endError: new Error('close-secondary'),
        }];
        const result = await options.collect();
        expect(result).toHaveProperty('error');
        if (phase !== 'parse') expect(result.error).toBe('discovery-primary');
        expect(result.error).not.toContain('close-secondary');
        expect(CollectionPgClient.clients).toHaveLength(1);
        expect(CollectionPgClient.clients[0].end).toHaveBeenCalledOnce();
        expect(options.save).not.toHaveBeenCalled();
      });

      it(`releases each database on ${phase} failure and retains the primary error`, async () => {
        const plan = {
          connectError: phase === 'connect' ? new Error('database-primary') : undefined,
          queryError: phase === 'query' ? new Error('database-primary') : undefined,
          malformed: phase === 'parse', endError: new Error('close-secondary'),
        };
        CollectionPgClient.plans = [{}, plan, plan];
        const result = await options.collect();
        expect(result).toHaveProperty('error');
        if (phase !== 'parse') expect(result.error).toContain('database-primary');
        expect(result.error).not.toContain('close-secondary');
        expect(CollectionPgClient.clients).toHaveLength(3);
        for (const client of CollectionPgClient.clients) expect(client.end).toHaveBeenCalledOnce();
        expect(options.save).not.toHaveBeenCalled();
      });
    }

    it('continues to the next database after a failed query and closes both', async () => {
      CollectionPgClient.plans = [{}, { queryError: new Error('app-query-failed') }, {}];
      expect(await options.collect()).toMatchObject({ tables: 1, collected: 1 });
      for (const client of CollectionPgClient.clients) expect(client.end).toHaveBeenCalledOnce();
      expect(options.save).toHaveBeenCalledWith(1, [expect.objectContaining({ table_name: 'analytics.public.widgets' })]);
    });

    it('preserves a successful collection when cleanup rejects', async () => {
      CollectionPgClient.plans = Array.from({ length: 3 }, () => ({ endError: new Error('close-secondary') }));
      expect(await options.collect()).toMatchObject({ tables: 2, collected: 2 });
      for (const client of CollectionPgClient.clients) expect(client.end).toHaveBeenCalledOnce();
    });

    it('closes every temporary client before a snapshot persistence error', async () => {
      options.save.mockRejectedValue(new Error('snapshot-failed'));
      expect(await options.collect()).toEqual({ error: 'snapshot-failed' });
      for (const client of CollectionPgClient.clients) expect(client.end).toHaveBeenCalledOnce();
    });
  });
}
