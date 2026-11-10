import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
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
      vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName').mockResolvedValue([]);
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

// A local non-loopback interface is required because production target policy
// rejects loopback. The relay forwards real MySQL bytes and admits only this host.
describe.skipIf(!process.env.ADD_DATABASE_TEST_MYSQL_URL || !process.env.ADD_DATABASE_TEST_RELAY_HOST)('MAX-311 real database management chain', () => {
  it('connects, persists, reconciles and recovers with real services and single-use references', async () => {
    const url = new URL(process.env.ADD_DATABASE_TEST_MYSQL_URL!);
    const relayHost = process.env.ADD_DATABASE_TEST_RELAY_HOST!;
    const admin = mysql.createPool(url.toString());
    const suffix = randomBytes(6).toString('hex');
    const schema = `max311_${suffix}`;
    const targetSchema = `max311_target_${suffix}`;
    const targetUser = `max311_${suffix}`;
    const secret = randomBytes(24).toString('hex');
    const sockets = new Set<Socket>();
    let acceptedConnections = 0;
    const relay = createServer(socket => {
      if (socket.remoteAddress !== relayHost) { socket.destroy(); return; }
      acceptedConnections++;
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
      await admin.query(`CREATE DATABASE ${targetSchema}`);
      await admin.query("CREATE USER ?@'%' IDENTIFIED BY ?", [targetUser, secret]);
      for (const name of [schema, targetSchema]) await admin.query(`GRANT SELECT ON ${name}.* TO ?@'%'`, [targetUser]);
      vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
      await pool.execute('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
      await pool.execute('INSERT INTO users VALUES (7)');
      const schemaSql = readFileSync(new URL('../../../../sql/schema.sql', import.meta.url), 'utf8');
      const instanceDdl = schemaSql.match(/CREATE TABLE IF NOT EXISTS `database_instances`[\s\S]*?;\s/);
      if (!instanceDdl) throw new Error('INSTANCE_SCHEMA_NOT_FOUND');
      await pool.query(instanceDdl[0]);
      await pool.query(readFileSync(new URL('../../../../sql/migrations/111_instance_removal_lifecycle.sql', import.meta.url), 'utf8'));
      await pool.query(readFileSync(new URL('../../../../sql/migrations/056_agent_credential_references.sql', import.meta.url), 'utf8'));
      // Configuration injection only: enumeration, consume, connection test,
      // target authorization and createInstance all execute their real code.
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
      await new Promise<void>((resolve, reject) => { relay.once('error', reject); relay.listen(0, relayHost, resolve); });
      const port = (relay.address() as { port: number }).port;
      const actor = { actor: { userId: 7 } as any };
      const baseArgs = { db_type: 'mysql', name: 'recovery', host: relayHost, port, username: targetUser, database_name: schema };
      const reference = async (password = secret) => (await credentialReferenceService.create(7, addDatabaseTool.name, password)).ref;
      const rowsFor = async (database: string) => (await pool.query<any[]>('SELECT id, password_encrypted FROM database_instances WHERE host = ? AND port = ? AND database_name = ?', [relayHost, port, database]))[0];
      const assertConsumed = async (ref: string) => {
        const [rows] = await pool.query<any[]>('SELECT status, consumed_at FROM agent_credential_references WHERE ref_id = ?', [ref]);
        expect(rows[0].status).toBe('consumed');
        expect(rows[0].consumed_at).not.toBeNull();
        expect(await credentialReferenceService.consume(ref, 7, addDatabaseTool.name)).toBeNull();
      };
      const rejectedRef = await reference(randomBytes(24).toString('hex'));
      const rejectedArgs = { ...baseArgs, credential_ref: rejectedRef };
      const rejected = await addDatabaseTool.handler(rejectedArgs, actor);
      expect(rejected).toMatchObject({ errorCode: 'CONNECTION_FAILED', details: { terminal: true, retryable: false } });
      expect(await rowsFor(schema)).toHaveLength(0);
      await assertConsumed(rejectedRef);
      expect(await addDatabaseTool.handler(rejectedArgs, actor)).toMatchObject({ errorCode: 'INVALID_CREDENTIAL_REF' });
      console.log('PASS real authentication refusal: rows=0, consumed=1, old reference denied');

      // Real database rejection after a successful real connection, before commit.
      await pool.query("CREATE TRIGGER max311_reject BEFORE INSERT ON database_instances FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAX311_INSERT_REJECTED'");
      const failedRef = await reference();
      const failed = await addDatabaseTool.handler({ ...baseArgs, credential_ref: failedRef }, actor);
      expect(failed).toMatchObject({ errorCode: 'CREATE_INSTANCE_FAILED', details: { terminal: true, retryable: false } });
      expect(failed.next_actions?.[0]).toContain('对账');
      expect(await rowsFor(schema)).toHaveLength(0);
      await assertConsumed(failedRef);
      await pool.query('DROP TRIGGER max311_reject');
      console.log('PASS real INSERT rejection: reconciled rows=0; failed reference stays consumed');

      const recoveredRef = await reference();
      const recovered = await addDatabaseTool.handler({ ...baseArgs, credential_ref: recoveredRef }, actor);
      expect(recovered).toMatchObject({ success: true, data: { connectionStatus: 'connected' } });
      const recoveredRows = await rowsFor(schema);
      expect(recoveredRows).toHaveLength(1);
      expect(recoveredRows[0].id).toBe((recovered.data as any).instanceId);
      expect(recoveredRows[0].password_encrypted).not.toContain(secret);
      await assertConsumed(recoveredRef);
      console.log('PASS fresh reference recovery: real connection + createInstance + encrypted row, rows=1');

      const duplicateRef = await reference();
      const duplicate = await addDatabaseTool.handler({ ...baseArgs, name: 'same-address-different-name', credential_ref: duplicateRef }, actor);
      expect(duplicate).toMatchObject({ errorCode: 'INSTANCE_EXISTS', data: { instanceId: recoveredRows[0].id }, details: { terminal: true, retryable: false } });
      expect(await rowsFor(schema)).toHaveLength(1);
      await assertConsumed(duplicateRef);
      console.log('PASS physical address reuse: different name resolves existing ID, rows=1');

      // Only the acknowledgement is fault-injected, after the real INSERT commits.
      const execute = pool.execute.bind(pool);
      let committedInserts = 0;
      vi.spyOn(pool, 'execute').mockImplementation((async (sql: string, values?: any) => {
        const result = await execute(sql, values);
        if (sql.trim().startsWith('INSERT INTO database_instances')) {
          committedInserts++;
          throw new Error('MAX311_INSERT_ACKNOWLEDGEMENT_LOST');
        }
        return result;
      }) as typeof pool.execute);
      const unknownRef = await reference();
      const unknownArgs = { ...baseArgs, name: 'unknown-commit', database_name: targetSchema, credential_ref: unknownRef };
      const unknown = await addDatabaseTool.handler(unknownArgs, actor);
      expect(unknown).toMatchObject({ errorCode: 'CREATE_INSTANCE_FAILED', details: { terminal: true, retryable: false } });
      expect(unknown.error).toContain('结果未知');
      expect(unknown.next_actions?.[0]).toMatch(/对账.*不要.*重试/);
      const committedRows = await rowsFor(targetSchema);
      expect(committedRows).toHaveLength(1);
      await assertConsumed(unknownRef);
      const reconciled = await addDatabaseTool.handler(unknownArgs, actor);
      expect(reconciled).toMatchObject({ errorCode: 'INSTANCE_EXISTS', data: { instanceId: committedRows[0].id } });
      expect(await rowsFor(targetSchema)).toHaveLength(1);
      expect(committedInserts).toBe(1);
      for (const result of [rejected, failed, recovered, duplicate, unknown, reconciled]) expect(JSON.stringify(result)).not.toContain(secret);
      console.log('PASS lost acknowledgement after real commit: reconciled rows=1, INSERT count=1, existing ID reused');
      const [version] = await pool.query<any[]>('SELECT VERSION() AS version');
      console.log(JSON.stringify({ version: version[0].version, schema, targetSchema, targetHost: relayHost, targetPort: port, acceptedConnections, expectedConnections: 5 }));
      expect(acceptedConnections).toBe(5);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      for (const socket of sockets) socket.destroy();
      if (relay.listening) await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve()));
      await pool.end();
      try {
        await admin.query('DROP USER IF EXISTS ?@\'%\'', [targetUser]);
        await admin.query(`DROP DATABASE IF EXISTS ${targetSchema}`);
        await admin.query(`DROP DATABASE IF EXISTS ${schema}`);
        const [schemas] = await admin.query<any[]>('SELECT COUNT(*) AS remaining FROM information_schema.schemata WHERE schema_name IN (?, ?)', [schema, targetSchema]);
        const [users] = await admin.query<any[]>('SELECT COUNT(*) AS remaining FROM mysql.user WHERE user = ?', [targetUser]);
        expect(Number(schemas[0].remaining)).toBe(0);
        expect(Number(users[0].remaining)).toBe(0);
        console.log('CLEANUP schemas=0, test users=0, relay closed');
      } finally { await admin.end(); }
    }
  });
});
