/** Authorized disposable users only; never logs SQL containing passwords or native error messages. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import oracledb from 'oracledb';
import dmdb from 'dmdb';
import { vendorCredentials } from './max237-vendor-credentials.js';
import { trialDatabaseTransport } from '../src/metrics/config/database-transport.js';
import type { DatabaseConnection } from '../src/database-service.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { runPackage } from '../src/metrics/packages/runner.js';
import { vendorLifecycleSpecs } from '../src/metrics/database/catalog.js';

const nonce = randomBytes(5).toString('hex').toUpperCase();
const directory = resolve('../../outputs/max237-least-privilege-' + nonce);
mkdirSync(directory, { recursive: true });
const credentials = vendorCredentials();
const report: any = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  authorization: 'MAX-235 member 01a19bf9-3af0-7316-bfc2-9e28af62d6c1', targets: {}, model_calls: 0,
  scope: 'Oracle root only; disposable users; no business writes; no existing grants changed; no platform DB' };
const save = () => writeFileSync(directory + '/evidence.json', JSON.stringify(report, null, 2));
const safe = (e: any) => ({ code: typeof e?.code === 'string' ? e.code : null, number: e?.errorNum ?? e?.errCode ?? null });
let phase = 'start';
try {
  for (const engine of ['oracle', 'dameng'] as const) {
    const user = (engine === 'oracle' ? 'C##MAX237_' : 'MAX237_') + nonce;
    const password = 'Mq7_' + randomBytes(20).toString('hex');
    const connect = (account: { user: string; password: string }) => engine === 'oracle'
      ? oracledb.getConnection({ ...account, connectString: '127.0.0.1:1521/ORCLCDB' })
      : dmdb.getConnection({ ...account, connectString: '127.0.0.1:5236', loginEncrypt: false, connectTimeout: 5000, socketTimeout: 5000 });
    const e: any = report.targets[engine] = { user, grants: [], cleanup: {}, collections: [] };
    let admin: any, client: any, oraclePool: any, created = false;
    try {
      phase = engine + ':admin'; admin = await connect(credentials[engine]);
      e.identity = (await admin.execute(engine === 'oracle'
        ? "SELECT SYS_CONTEXT('USERENV','CON_NAME'), VERSION_FULL FROM V$INSTANCE"
        : 'SELECT SVR_VERSION FROM V$INSTANCE')).rows;
      if (engine === 'oracle') assert.equal(e.identity[0][0], 'CDB$ROOT');
      const users = engine === 'oracle' ? 'DBA_USERS' : 'DBA_USERS';
      assert.equal(Number((await admin.execute(`SELECT COUNT(*) FROM ${users} WHERE USERNAME='${user}'`)).rows[0][0]), 0);
      phase = engine + ':create';
      // Oracle root requires a common C## identity. All privilege grants remain CURRENT (root),
      // so creating this identity does not grant login or collection access in any PDB.
      await admin.execute(`CREATE USER ${user} IDENTIFIED BY "${password}"${engine === 'oracle' ? ' CONTAINER=ALL' : ''}`);
      created = true; save();
      // Union exactly the published collector permissions; no DBA/CONNECT/RESOURCE role.
      const grants = [...new Set(vendorLifecycleSpecs.filter(s => s.applicability[0].values.includes(engine)).flatMap(s => s.permissions))];
      for (const grant of grants) {
        phase = engine + ':grant:' + grant;
        await admin.execute(grant === 'CREATE SESSION' ? `GRANT CREATE SESSION TO ${user}`
          : `GRANT SELECT ON SYS.${grant.slice(7)} TO ${user}`);
        e.grants.push(grant); save();
      }
      phase = engine + ':restricted-login'; client = await connect({ user, password });
      e.roles = (await client.execute('SELECT GRANTED_ROLE FROM USER_ROLE_PRIVS')).rows;
      e.system_privileges = (await client.execute('SELECT PRIVILEGE FROM SESSION_PRIVS')).rows;
      assert.equal(e.roles.length, 0, 'UNEXPECTED_ROLE');
      assert.deepEqual(e.system_privileges.map((r: any) => r[0]).sort(), ['CREATE SESSION']);
      e.object_grants = (await admin.execute(`SELECT OWNER,TABLE_NAME,PRIVILEGE FROM DBA_TAB_PRIVS WHERE GRANTEE='${user}' ORDER BY TABLE_NAME`)).rows;
      assert.equal(e.object_grants.length, 4);
      assert(e.object_grants.every((r: any) => r[0] === 'SYS' && r[2] === 'SELECT'));
      if (engine === 'oracle') oraclePool = await oracledb.createPool({ user, password, connectString: '127.0.0.1:1521/ORCLCDB', poolMin: 0, poolMax: 1 });
      const connection = { id: engine === 'oracle' ? 237901 : 237902, db_type: engine, oraclePool,
        config: { user, password, host: '127.0.0.1', port: engine === 'oracle' ? 1521 : 5236 } } as DatabaseConnection;
      const registry = createConfigurationRegistry();
      const p = registry.list().find(r => r.package.id === engine + '-representative' && r.package.version === (engine === 'oracle' ? '1.3.0' : '1.2.0'))!.package;
      const selection = { package: { id: p.id, version: p.version, digest: p.digest }, credential_ref: 'credential:restricted', overrides: {} };
      e.pin = selection.package;
      const collect = () => runPackage(registry, selection, {
        resource: { type: 'instance', id: String(connection.id), attributes: {
          'db.engine': { value: engine, source: 'driver', observed_at: new Date().toISOString() },
          'db.version': { value: engine === 'oracle' ? '19.19' : '8.1', source: 'driver', observed_at: new Date().toISOString() },
        } }, binding_id: 'restricted-' + nonce, attempt_id: randomBytes(8).toString('hex'), config_revision: 1,
        observed_at: new Date().toISOString(), evidence: {}, resolve: async () => trialDatabaseTransport(connection),
      });
      for (let round = 0; round < 2; round++) {
        phase = engine + ':collect'; const result = await collect();
        e.collections.push(result); save();
        assert(result.attempts.length === 3 && result.attempts.every(a => a.status === 'succeeded'));
        assert(result.raw?.length === 3 && result.raw.every(r => r.quality.status === 'good'));
      }
      // Read-only denial against an existing system catalog, never a possibly successful write.
      phase = engine + ':protected-read';
      const sql = engine === 'oracle' ? 'SELECT 1 FROM SYS.USER$ WHERE 1=0' : 'SELECT 1 FROM SYS.SYSUSER WHERE 1=0';
      assert.equal(Number((await admin.execute(engine === 'oracle'
        ? "SELECT COUNT(*) FROM DBA_OBJECTS WHERE OWNER='SYS' AND OBJECT_NAME='USER$'"
        : "SELECT COUNT(*) FROM DBA_OBJECTS WHERE OWNER='SYS' AND OBJECT_NAME='SYSUSER'")).rows[0][0]) > 0, true);
      try { await client.execute(sql); e.protected_read = { sql, unexpected_success: true }; save(); throw Error('PROTECTED_READ_ALLOWED'); }
      catch (error) { if ((error as Error).message === 'PROTECTED_READ_ALLOWED') throw error; e.protected_read = { sql, error: safe(error) }; }
      assert(engine === 'oracle' ? e.protected_read.error.number === 942 || e.protected_read.error.number === 1031 : e.protected_read.error.number === -551);
      e.minimum_privilege_verified = true; save();
    } catch (error) {
      e.failure = { phase, ...safe(error) }; save(); throw error;
    } finally {
      phase = engine + ':cleanup';
      await oraclePool?.close(0); await client?.close();
      if (created) {
        await admin.execute(`DROP USER ${user}`);
        e.cleanup.absent = Number((await admin.execute(`SELECT COUNT(*) FROM DBA_USERS WHERE USERNAME='${user}'`)).rows[0][0]) === 0;
        assert(e.cleanup.absent);
      }
      await admin?.close(); save();
    }
    console.log('PASS ' + engine + ' least privilege; disposable user removed');
  }
  report.passed = true; save();
} catch (error) {
  report.failure = { phase, ...safe(error), assertion: (error as any)?.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : null };
  save(); console.log('FAIL ' + phase + ' (details sanitized in evidence)'); process.exitCode = 1;
}
console.log('Evidence: ' + directory);
