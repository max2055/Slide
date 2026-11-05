import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { dbConnection, decryptData } from '../../../db-connection.js';
import { credentialReferenceService } from '../../../security/credential-reference-service.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { updateDbConfigTool } from './update_db_config.js';

// Opt-in, isolated schemas/users only. All business services execute real code;
// only pool selection and explicitly labelled transport faults are injected.
describe.skipIf(!process.env.UPDATE_DB_CONFIG_TEST_MYSQL_URL || !process.env.UPDATE_DB_CONFIG_TEST_RELAY_HOST)('MAX-320 real MySQL config update', () => {
  it('atomically rolls back, retries once, rejects replay and reconciles unknown outcomes', async () => {
    const url = new URL(process.env.UPDATE_DB_CONFIG_TEST_MYSQL_URL!);
    const host = process.env.UPDATE_DB_CONFIG_TEST_RELAY_HOST!;
    const admin = mysql.createPool(url.toString());
    const suffix = randomBytes(6).toString('hex');
    const schema = `max320_${suffix}`;
    const user = `max320_${suffix}`;
    const secret = randomBytes(24).toString('hex');
    const oldSecret = randomBytes(24).toString('hex');
    const sockets = new Set<Socket>();
    let connections = 0;
    const relay = createServer(socket => {
      if (socket.remoteAddress !== host) { socket.destroy(); return; }
      connections++;
      const upstream = createConnection({ host: url.hostname, port: Number(url.port || 3306) });
      for (const item of [socket, upstream]) {
        sockets.add(item);
        item.on('close', () => sockets.delete(item));
        item.on('error', () => { socket.destroy(); upstream.destroy(); });
      }
      socket.pipe(upstream).pipe(socket);
    });
    url.pathname = `/${schema}`;
    const pool = mysql.createPool(url.toString());
    try {
      await admin.query(`CREATE DATABASE ${schema}`);
      await admin.query("CREATE USER ?@'%' IDENTIFIED BY ?", [user, secret]);
      await admin.query(`GRANT SELECT ON ${schema}.* TO ?@'%'`, [user]);
      vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
      await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
      await pool.query('INSERT INTO users VALUES (7), (8)');
      const sql = readFileSync(new URL('../../../../sql/schema.sql', import.meta.url), 'utf8');
      await pool.query(sql.match(/CREATE TABLE IF NOT EXISTS `database_instances`[\s\S]*?;\s/)![0]);
      for (const file of ['111_instance_removal_lifecycle.sql', '056_agent_credential_references.sql']) {
        await pool.query(readFileSync(new URL(`../../../../sql/migrations/${file}`, import.meta.url), 'utf8'));
      }
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
      await new Promise<void>((resolve, reject) => { relay.once('error', reject); relay.listen(0, host, resolve); });
      const port = (relay.address() as { port: number }).port;
      const created = await instanceDatabaseService.createInstance({ name: 'max320', db_type: 'mysql', host, port, username: user, password: oldSecret, database_name: schema, environment: 'development', created_by: 7 });
      expect(created.success).toBe(true);
      const instance_id = created.instanceId!;
      const context = { actor: { userId: 7 } as any };
      const issue = async (owner = 7, tool = updateDbConfigTool.name, password = secret) => (await credentialReferenceService.create(owner, tool, password)).ref;
      const state = async (ref: string) => (await pool.query<any[]>('SELECT status, consumed_at FROM agent_credential_references WHERE ref_id = ?', [ref]))[0][0];
      const config = async () => (await pool.query<any[]>('SELECT name, password_encrypted FROM database_instances WHERE id = ?', [instance_id]))[0][0];
      const run = (ref: string, extra = {}) => updateDbConfigTool.handler({ instance_id, credential_ref: ref, ...extra }, context);

      // A real server-side statement rejection must leave both rows unchanged.
      await pool.query("CREATE TRIGGER max320_reject BEFORE UPDATE ON database_instances FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAX320_UPDATE_REJECTED'");
      const retryRef = await issue();
      const failed = await run(retryRef, { name: 'retry-success' });
      expect(failed).toMatchObject({ errorCode: 'UPDATE_FAILED', details: { credentialConsumed: false, retryable: true } });
      expect(await state(retryRef)).toMatchObject({ status: 'active', consumed_at: null });
      expect(decryptData((await config()).password_encrypted)).toBe(oldSecret);
      expect((await config()).name).toBe('max320');
      await pool.query('DROP TRIGGER max320_reject');
      expect(await run(retryRef, { name: 'retry-success' })).toMatchObject({ success: true, data: { connectionSuccess: true } });
      expect(decryptData((await config()).password_encrypted)).toBe(secret);
      expect((await state(retryRef)).status).toBe('consumed');
      expect(await run(retryRef, { name: 'replayed' })).toMatchObject({ errorCode: 'INVALID_CREDENTIAL_REF' });
      expect((await config()).name).toBe('retry-success');
      console.log('PASS real UPDATE rejection: config unchanged/ref active; same-ref retry commits once + real authentication; replay denied');

      // Same reference contends on its row lock, so exactly one update can commit.
      const concurrentRef = await issue();
      const concurrent = await Promise.all([run(concurrentRef, { name: 'winner-a' }), run(concurrentRef, { name: 'winner-b' })]);
      expect(concurrent.filter(result => result.success)).toHaveLength(1);
      expect(concurrent.filter(result => result.errorCode === 'INVALID_CREDENTIAL_REF')).toHaveLength(1);
      expect((await config()).name).toMatch(/^winner-[ab]$/);
      console.log('PASS real concurrent same-reference updates: commits=1, replay denied=1');

      // Actor, tool, expiry and lifecycle boundaries do not commit any consumption.
      for (const ref of [await issue(8), await issue(7, 'slide_add_database')]) {
        expect(await run(ref)).toMatchObject({ errorCode: 'INVALID_CREDENTIAL_REF' });
        expect((await state(ref)).status).toBe('active');
      }
      const expired = await issue();
      await pool.query('UPDATE agent_credential_references SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE ref_id = ?', [expired]);
      expect(await run(expired)).toMatchObject({ errorCode: 'INVALID_CREDENTIAL_REF' });
      for (const extra of [{ host: '127.0.0.1' }, { instance_id: instance_id + 9999 }]) {
        const ref = await issue();
        expect(await run(ref, extra)).toMatchObject({ errorCode: 'UPDATE_FAILED', details: { retryable: true } });
        expect((await state(ref)).status).toBe('active');
      }
      await pool.query("UPDATE database_instances SET lifecycle_state = 'deleting' WHERE id = ?", [instance_id]);
      const deletingRef = await issue();
      expect(await run(deletingRef)).toMatchObject({ errorCode: 'UPDATE_FAILED' });
      expect((await state(deletingRef)).status).toBe('active');
      await pool.query("UPDATE database_instances SET lifecycle_state = 'available' WHERE id = ?", [instance_id]);
      console.log('PASS real owner/tool/expiry/target/lifecycle boundaries: no credential consumption');

      // Only the acknowledgement is fault-injected, after real COMMIT succeeds.
      const getConnection = pool.getConnection.bind(pool);
      const fault = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
        const connection = await getConnection();
        const commit = connection.commit.bind(connection);
        connection.commit = async () => { await commit(); throw new Error(secret); };
        return connection;
      });
      const unknownRef = await issue();
      const unknown = await run(unknownRef, { name: 'ack-lost' });
      fault.mockRestore();
      expect(unknown).toMatchObject({ errorCode: 'UPDATE_OUTCOME_UNKNOWN', details: { retryable: false } });
      expect(unknown.next_actions?.[0]).toContain('对账');
      expect(JSON.stringify(unknown)).not.toContain(secret);
      expect((await config()).name).toBe('ack-lost');
      expect((await state(unknownRef)).status).toBe('consumed');
      expect(await run(unknownRef, { name: 'should-not-write' })).toMatchObject({ errorCode: 'INVALID_CREDENTIAL_REF' });
      const newerSecret = randomBytes(24).toString('hex');
      const newerRef = await issue(7, updateDbConfigTool.name, newerSecret);
      expect(await run(newerRef, { name: 'newer-credential' })).toMatchObject({ success: true, status: 'warning' });
      expect(await run(unknownRef, { name: 'stale-overwrite' })).toMatchObject({ errorCode: 'INVALID_CREDENTIAL_REF' });
      expect(decryptData((await config()).password_encrypted)).toBe(newerSecret);
      expect((await config()).name).toBe('newer-credential');
      expect(await run(await issue(), { name: 'ack-lost' })).toMatchObject({ success: true });
      console.log('PASS COMMIT ack loss: client unknown/nonretryable; reconciled config committed/ref consumed; replay denied');

      // Abrupt transport loss between consumption and commit: InnoDB rolls back.
      const interruptedRef = await issue();
      const disconnect = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
        const connection = await getConnection();
        const execute = connection.execute.bind(connection);
        connection.execute = (async (sql: string, values?: any) => {
          const result = await execute(sql, values);
          if (sql.startsWith('UPDATE agent_credential_references')) {
            connection.destroy();
            throw new Error(secret);
          }
          return result;
        }) as typeof connection.execute;
        return connection;
      });
      const interrupted = await run(interruptedRef, { name: 'interrupted' });
      disconnect.mockRestore();
      expect(interrupted).toMatchObject({ errorCode: 'UPDATE_OUTCOME_UNKNOWN', details: { retryable: false } });
      // A locking read waits for server-side rollback before deciding to retry.
      const [reconciled] = await pool.query<any[]>('SELECT status FROM agent_credential_references WHERE ref_id = ? FOR UPDATE', [interruptedRef]);
      expect(reconciled[0].status).toBe('active');
      expect((await config()).name).toBe('ack-lost');
      expect(await run(interruptedRef, { name: 'after-reconciliation' })).toMatchObject({ success: true });
      console.log('PASS connection loss before config write: unknown response; reconciled active ref/unchanged config; retry after reconciliation commits');

      const test = vi.spyOn(instanceDatabaseService, 'testConnection').mockRejectedValueOnce(new Error(secret));
      const testFailureRef = await issue();
      const testFailure = await run(testFailureRef);
      test.mockRestore();
      expect(testFailure).toMatchObject({ success: true, status: 'warning', details: { configCommitted: true, retryable: false } });
      expect(JSON.stringify(testFailure)).not.toContain(secret);
      expect((await state(testFailureRef)).status).toBe('consumed');
      expect(await run(testFailureRef)).toMatchObject({ errorCode: 'INVALID_CREDENTIAL_REF' });
      expect(connections).toBeGreaterThan(0);
      console.log('PASS post-commit connection-test exception: saved warning, secret suppressed, consumed reference never restored');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      for (const socket of sockets) socket.destroy();
      if (relay.listening) await new Promise<void>(resolve => relay.close(() => resolve()));
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${schema}`);
      await admin.query("DROP USER IF EXISTS ?@'%'", [user]);
      await admin.end();
      console.log('MAX-320 isolated schema, test user and relay removed');
    }
  }, 30_000);
});
