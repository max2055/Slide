import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../../../db-connection.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { credentialReferenceService } from '../../../security/credential-reference-service.js';
import { addDatabaseTool } from './add_database.js';

// Real credential schema, encryption and atomic consumption; instance outcomes are
// injected. This verifies durable single-use recovery, not real target connectivity.
describe.skipIf(!process.env.ADD_DATABASE_TEST_MYSQL_URL)('MAX-311 MySQL credential persistence', () => {
  it('never restores consumed references after connection rejection, create rejection, duplicate address or lost acknowledgement', async () => {
    const url = new URL(process.env.ADD_DATABASE_TEST_MYSQL_URL!);
    const admin = mysql.createPool(url.toString());
    const schema = `max311_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${schema}`);
    url.pathname = `/${schema}`;
    const pool = mysql.createPool(url.toString());
    const secret = randomBytes(20).toString('hex');
    const context = { actor: { userId: 7 } as any };
    try {
      vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
      await pool.execute('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
      await pool.execute('INSERT INTO users VALUES (7)');
      await pool.query(readFileSync(new URL('../../../../sql/migrations/056_agent_credential_references.sql', import.meta.url), 'utf8'));
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
      vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([]);
      const connection = vi.spyOn(instanceDatabaseService, 'testConnection');
      const create = vi.spyOn(instanceDatabaseService, 'createInstance');
      for (const scenario of ['connection_rejected', 'create_rejected', 'address_exists', 'acknowledgement_lost']) {
        const { ref } = await credentialReferenceService.create(7, addDatabaseTool.name, secret);
        const args = { db_type: 'mysql', name: scenario, host: 'db.internal', port: 3306, username: 'slide', credential_ref: ref };
        connection.mockResolvedValue({ success: scenario !== 'connection_rejected', message: secret });
        create.mockReset();
        create.mockImplementation(async () => {
          if (scenario === 'acknowledgement_lost') throw new Error(secret);
          return { success: false, ...(scenario === 'address_exists' ? { instanceId: 73 } : {}), error: secret };
        });
        const first = await addDatabaseTool.handler(args, context);
        expect(first).toMatchObject({ success: false, details: { terminal: true, retryable: false } });
        expect(first.errorCode).toBe({ connection_rejected: 'CONNECTION_FAILED', create_rejected: 'CREATE_INSTANCE_FAILED', address_exists: 'INSTANCE_EXISTS', acknowledgement_lost: 'ADD_DATABASE_FAILED' }[scenario]);
        const [rows] = await pool.query<any[]>('SELECT status, consumed_at, secret_encrypted FROM agent_credential_references WHERE ref_id = ?', [ref]);
        expect(rows[0].status).toBe('consumed');
        expect(rows[0].consumed_at).not.toBeNull();
        expect(rows[0].secret_encrypted).not.toContain(secret);
        expect(JSON.stringify(first)).not.toContain(secret);
        const second = await addDatabaseTool.handler(args, context);
        expect(second.errorCode).toBe('INVALID_CREDENTIAL_REF');
        expect(create).toHaveBeenCalledTimes(scenario === 'connection_rejected' ? 0 : 1);
        expect(await credentialReferenceService.consume(ref, 7, addDatabaseTool.name)).toBeNull();
      }
      const [rows] = await pool.query<any[]>("SELECT COUNT(*) AS total FROM agent_credential_references WHERE status = 'consumed'");
      expect(Number(rows[0].total)).toBe(4);
      console.log('4 scenarios: durable consumed state, encrypted storage, replay denied; injected instance outcomes');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await pool.end();
      await admin.query(`DROP DATABASE ${schema}`);
      await admin.end();
      console.log('MAX-311 isolated schema removed');
    }
  });
});
