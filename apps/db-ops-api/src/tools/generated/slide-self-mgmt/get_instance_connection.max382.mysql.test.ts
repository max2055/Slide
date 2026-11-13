/** Opt-in real SQL read; actor, approval/config and audit are injected, no JWT login. */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../auth/actor-context.js';
import { dbConnection } from '../../../db-connection.js';
import { agentExecutionConfigService } from '../../../security/agent-execution-config-service.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../../../testing/owned-fixture.js';
import { executeToolWithPolicy } from '../../policy.js';
import { getInstanceConnectionTool as tool } from './get_instance_connection.js';

describe.skipIf(process.env.MAX382_MYSQL_ACCEPTANCE !== '1')('MAX-382 isolated mysql3308 public metadata', () => {
  it('reads only public columns through production policy/service and removes its owned schema', async () => {
    const { MAX382_MYSQL_HOST: host, MAX382_MYSQL_PORT: port, MAX382_MYSQL_USER: user,
      MAX382_MYSQL_PASSWORD: password } = process.env;
    if (host !== '127.0.0.1' || port !== '3308' || !user || password === undefined
      || process.env.MAX382_MYSQL_CONTAINER !== 'mysql3308') {
      throw new Error('explicit mysql3308 configuration required');
    }
    let root: mysql.Connection | undefined;
    let pool: Pool | undefined;
    let owned: OwnedDatabase | undefined;
    const failures: unknown[] = [];
    try {
      root = await mysql.createConnection({ host, port: Number(port), user, password, connectTimeout: 5000 });
      owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'max382',
        handleDir: fileURLToPath(new URL('../../../../.max238-handles/', import.meta.url)) });
      pool = mysql.createPool({ host, port: Number(port), user, password, database: owned.database, connectionLimit: 1 });
      await pool.query(`CREATE TABLE database_instances (
        id INT PRIMARY KEY, name VARCHAR(100), db_type VARCHAR(32), host VARCHAR(255), port INT,
        username VARCHAR(100), database_name VARCHAR(100), health_status VARCHAR(32), environment VARCHAR(32),
        password_encrypted TEXT, api_key TEXT, connection_string TEXT)`);
      const secret = randomBytes(32).toString('hex');
      const publicRow = { id: 5, name: 'max382-public', db_type: 'mysql', host: 'db.example', port: 3306,
        username: 'metadata-reader', database_name: 'orders', health_status: 'unknown', environment: 'testing' };
      await pool.execute('INSERT INTO database_instances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [...Object.values(publicRow), secret, secret, `mysql://user:${secret}@db.example/orders`]);
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
      vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({
        approvalEnabled: true, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY',
      });
      const actor: ActorContext = { userId: 7, username: 'owner', roles: ['admin'], permissions: [], sessionVersion: 1,
        instanceScopes: {}, requestId: 'max382-real' };
      const read = (id: number, denied = false) => executeToolWithPolicy(
        { ...actor, ...(denied ? { resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } } : {}) },
        tool, { instance_id: id, approvalId: 'fixture' }, undefined,
        { consume: async () => true }, { record: async () => {} },
      );
      const result = (await read(5)).result;
      expect(result.success).toBe(true);
      expect(result.data).toEqual(publicRow);
      expect(result.details?.instance).toEqual(publicRow);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toMatch(/password_encrypted|api_key|connection_string|mysql:\/\//);
      expect((await read(999)).result.errorCode).toBe('INSTANCE_NOT_FOUND');
      expect((await read(5, true)).result).toMatchObject({ errorCode: 'INSTANCE_SCOPE_DENIED', error: 'Tool access denied' });
      console.log('MAX382 real SQL PASS: public projection, secret exclusion, absent resource, scope denial');
    } catch (error) {
      failures.push(error);
    } finally {
      vi.restoreAllMocks();
      // Run every cleanup step, retain business failure first, close root last.
      for (const step of [async () => { await pool?.end(); }, async () => { await owned?.drop(); }, async () => { await root?.end(); }]) {
        try { await step(); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'MAX382 acceptance/cleanup failed');
    console.log('MAX382 cleanup PASS: owned schema verified absent; pool and root closed');
  }, 20_000);
});
