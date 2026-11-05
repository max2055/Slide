import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from './migrations/runner.js';
import type { MigrationPool } from './migrations/types.js';
import { dbConnection, encryptData } from './db-connection.js';
import { LOST_KEY_ROTATION_SENTINEL as marker } from './credential-rotation.js';
import { instanceDatabaseService as instances } from './instance-database-service.js';
import { serverDatabaseService as servers } from './server-database-service.js';
import * as targetPolicy from './security/database-target-policy.js';

// Dedicated disposable MySQL only. No application .env or persistent business rows are used.
const port = Number(process.env.MAX307_MYSQL_PORT);
describe.skipIf(!port)('GitHub #321 real MySQL credential recovery', () => {
  const schema = `max307_${process.pid}`;
  const user = `max307_${process.pid}`;
  const secret = randomBytes(24).toString('hex');
  let root: Pool;
  let pool: Pool;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  let targetSpy: ReturnType<typeof vi.spyOn>;
  let instanceId: number;
  let serverId: number;

  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${schema}`);
    await root.query("CREATE USER ?@'%' IDENTIFIED BY ?", [user, secret]);
    await root.query(`GRANT SELECT ON ${schema}.* TO ?@'%'`, [user]);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database: schema });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    // Production blocks loopback enrollment. This owned fixture opts into the
    // existing managed-loopback policy; encryption, SQL and drivers stay real.
    const authorize = targetPolicy.authorizeDatabaseTarget;
    targetSpy = vi.spyOn(targetPolicy, 'authorizeDatabaseTarget').mockImplementation(input =>
      authorize(input, { allowManagedLoopback: true, production: false }));
    const [instance] = await pool.execute<any>(`INSERT INTO database_instances
      (name,environment,db_type,host,port,username,password_encrypted,database_name,status,lifecycle_state)
      VALUES ('max307-fixture','testing','mysql','127.0.0.1',?,?,?,?,'inactive','available')`,
    [port, user, encryptData(marker), schema]);
    instanceId = instance.insertId;
    const [server] = await pool.execute<any>(`INSERT INTO servers
      (host,port,os_type,credential_type,credential_encrypted,collection_enabled)
      VALUES ('203.0.113.30',22,'centos','password',?,0)`, [encryptData(marker)]);
    serverId = server.insertId;
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    targetSpy?.mockRestore();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${schema}`);
      await root.query("DROP USER IF EXISTS ?@'%'", [user]);
      await root.end();
    }
    vi.unstubAllEnvs();
  }, 60000);

  it('rejects stored markers, restores valid credentials, and authenticates only after replacement', async () => {
    for (const read of [() => instances.getInstancePassword(instanceId), () => instances.getInstanceWithDecryptedPassword(instanceId),
      () => instances.markInstanceActive(instanceId), () => servers.getDecryptedCredentials(serverId)]) {
      await expect(read()).rejects.toMatchObject({ code: 'CREDENTIAL_ROTATION_REQUIRED', message: expect.stringContaining('重新录入凭据') });
    }
    const [before] = await pool.query<any[]>('SELECT status FROM database_instances WHERE id = ?', [instanceId]);
    expect(before[0].status).toBe('inactive');

    let accepted = 0;
    const probe = createServer(socket => { accepted++; socket.destroy(); });
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    try {
      const probePort = (probe.address() as { port: number }).port;
      const test = await instances.testConnection({ db_type: 'mysql', host: '127.0.0.1', port: probePort, username: user, password: marker });
      expect(test).toMatchObject({ success: false, message: expect.stringContaining('重新录入凭据') });
      const sshTest = await servers.testConnection('127.0.0.1', probePort, 'password', marker, user);
      expect(sshTest).toMatchObject({ success: false, error: expect.stringContaining('重新录入凭据') });
      expect(accepted).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    }

    expect(await instances.updateInstance(instanceId, { password: secret })).toEqual({ success: true });
    const recovered = await instances.getInstanceWithDecryptedPassword(instanceId);
    expect(recovered?.password === secret).toBe(true);
    const connected = await instances.testConnection({ db_type: 'mysql', host: recovered!.host, port: recovered!.port,
      username: recovered!.username, password: recovered!.password, database: schema }, instanceId);
    expect(connected.success).toBe(true);
    await instances.markInstanceActive(instanceId);
    const [after] = await pool.query<any[]>('SELECT status FROM database_instances WHERE id = ?', [instanceId]);
    expect(after[0].status).toBe('active');

    expect(await servers.updateServer(serverId, { credential_username: user, credential_value: secret })).toEqual({ success: true });
    expect((await servers.getDecryptedCredentials(serverId))?.password === secret).toBe(true);
    const [server] = await pool.query<any[]>('SELECT collection_enabled FROM servers WHERE id = ?', [serverId]);
    expect(server[0].collection_enabled).toBe(0);
  }, 30000);
});
