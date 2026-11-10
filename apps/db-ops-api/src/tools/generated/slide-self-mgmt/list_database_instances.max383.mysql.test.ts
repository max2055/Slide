/** Opt-in SQL acceptance. Actor/config/audit are injected; no JWT login or LLM. */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../auth/actor-context.js';
import { dbConnection } from '../../../db-connection.js';
import { agentExecutionConfigService } from '../../../security/agent-execution-config-service.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../../../testing/owned-fixture.js';
import { executeToolWithPolicy } from '../../policy.js';
import { listDatabaseInstancesTool as tool } from './list_database_instances.js';

describe.skipIf(process.env.MAX383_MYSQL_ACCEPTANCE !== '1')('MAX-383 isolated mysql3308 list filtering', () => {
  it('uses production policy/service SQL, preserves visibility and removes only the owned schema', async () => {
    const { MAX383_MYSQL_HOST: host, MAX383_MYSQL_PORT: port, MAX383_MYSQL_USER: user,
      MAX383_MYSQL_PASSWORD: password } = process.env;
    if (host !== '127.0.0.1' || port !== '3308' || !user || password === undefined
      || process.env.MAX383_MYSQL_CONTAINER !== 'mysql3308') {
      throw new Error('explicit mysql3308 configuration required');
    }
    let root: mysql.Connection | undefined;
    let pool: Pool | undefined;
    let owned: OwnedDatabase | undefined;
    const failures: unknown[] = [];
    try {
      root = await mysql.createConnection({ host, port: Number(port), user, password, connectTimeout: 5000 });
      owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'max383',
        handleDir: fileURLToPath(new URL('../../../../.max238-handles/', import.meta.url)) });
      console.log(`MAX383 owned schema: ${owned.database}`);
      pool = mysql.createPool({ host, port: Number(port), user, password, database: owned.database,
        connectionLimit: 1, connectTimeout: 5000 });
      await pool.query(`CREATE TABLE database_instances (
        id INT PRIMARY KEY, name VARCHAR(100), environment VARCHAR(32), db_type VARCHAR(32),
        host VARCHAR(255), port INT, username VARCHAR(100), password_encrypted TEXT,
        database_name VARCHAR(100), connection_string TEXT, max_connections INT, connection_timeout_ms INT,
        status VARCHAR(32), lifecycle_state VARCHAR(32), removal_requested_at DATETIME, removed_at DATETIME,
        removal_reasons JSON, health_score INT, health_status VARCHAR(32), last_health_check_at DATETIME,
        db_version VARCHAR(100), data_size_gb DOUBLE, tags JSON, description TEXT, created_by INT,
        created_at DATETIME, updated_at DATETIME)`);
      const secret = randomBytes(32).toString('hex');
      for (const [id, name, type, status, lifecycle] of [
        [1, 'a-visible-mysql', 'mysql', 'active', 'available'],
        [2, 'b-visible-pg', 'postgresql', 'active', 'available'],
        [3, 'c-hidden-mysql', 'mysql', 'active', 'available'],
        [4, 'd-inactive', 'mysql', 'inactive', 'available'],
        [5, 'e-tombstone', 'mysql', 'active', 'deleted'],
      ]) {
        await pool.execute(`INSERT INTO database_instances
          (id, name, db_type, status, lifecycle_state, environment, host, port, username, password_encrypted,
           connection_string, health_status) VALUES (?, ?, ?, ?, ?, 'testing', 'db.example', 3306, ?, ?, ?, 'healthy')`,
        [id, name, type, status, lifecycle, secret, secret, secret]);
      }
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
      vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: true,
        restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY' });
      const actor: ActorContext = { userId: 7, username: 'reader', roles: ['viewer'], permissions: ['instance:view'],
        sessionVersion: 1, instanceScopes: { 1: 'read-only', 2: 'read-only', 4: 'read-only', 5: 'read-only' }, requestId: 'max383-real' };
      const run = async (args: Record<string, unknown>, caller = actor) => (await executeToolWithPolicy(
        caller, tool, args, undefined, { consume: async () => false }, { record: async () => {} },
      )).result;
      for (const db_type of ['mysql', 'MySQL', 'MYSQL', ' mysql ', '\tMySQL\r\n']) {
        const result = await run({ db_type });
        expect(result).toMatchObject({ success: true, data: [{ id: 1 }], details: { count: 1 },
          summary: '找到 1 个 mysql数据库实例' });
        expect(result.data).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toMatch(/password|connection_string|username|hidden|inactive|tombstone/);
      }
      expect(await run({ db_type: ' PostgreSQL ' })).toMatchObject({ success: true, data: [{ id: 2 }], details: { count: 1 } });
      expect(await run({})).toMatchObject({ success: true, data: [{ id: 1 }, { id: 2 }], details: { count: 2 } });
      expect((await run({})).data).toHaveLength(2);
      for (const db_type of ['oracle', 'unrecognized']) {
        expect(await run({ db_type })).toMatchObject({ success: true, data: [], details: { count: 0 } });
      }
      for (const db_type of ['', ' \t', null, 1, true, ['mysql'], {}]) {
        expect(await run({ db_type })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
      }
      expect(await run({ db_type: 'MySQL' }, { ...actor, instanceScopes: { 2: 'read-only' } }))
        .toMatchObject({ success: true, data: [], details: { count: 0 } });
      expect(await run({}, { ...actor, resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } }))
        .toMatchObject({ success: true, data: [], details: { count: 0 } });
      expect((await run({ db_type: 'MySQL' }, { ...actor, permissions: [] })).success).toBe(false);
      console.log('MAX383 SQL PASS: five mysql variants=[1], PostgreSQL=[2], unfiltered=[1,2], hidden-only/boundary/absent=[], invalid rejected, revoked denied, secrets excluded');
    } catch (error) {
      failures.push(error);
    } finally {
      vi.restoreAllMocks();
      // Keep the first business error; attempt every close even if cleanup fails.
      for (const step of [async () => { await pool?.end(); }, async () => { await owned?.drop(); }, async () => { await root?.end(); }]) {
        try { await step(); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'MAX383 acceptance/cleanup failed');
    console.log('MAX383 cleanup PASS: owned schema verified absent, pool and root closed');
  }, 20_000);
});
