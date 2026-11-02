import oracledb from 'oracledb';
import dmdb from 'dmdb';
import { createRequire } from 'node:module';
import { vendorCredentials } from './max237-vendor-credentials.js';

const credentials = vendorCredentials();
const code = (e: any) => ({ code: e.code ?? null, errorNum: e.errorNum ?? e.errCode ?? null });
for (const service of ['ORCLCDB', 'orclpdb1']) {
  let c: any;
  try {
    c = await oracledb.getConnection({ ...credentials.oracle, connectString: `127.0.0.1:1521/${service}` });
    c.callTimeout = 5000;
    for (const sql of ["SELECT BANNER_FULL FROM V$VERSION", "SELECT SYS_CONTEXT('USERENV','CON_NAME'),SYS_CONTEXT('USERENV','SERVICE_NAME') FROM DUAL",
      'SELECT PRIVILEGE FROM SESSION_PRIVS', 'SELECT GRANTED_ROLE FROM USER_ROLE_PRIVS',
      'SELECT COUNT(*) FROM V$SESSION', "SELECT VALUE FROM V$PARAMETER WHERE NAME='processes'",
      "SELECT TO_CHAR(VALUE, 'FM99999999999999999999') FROM V$SYSSTAT WHERE NAME='user commits'"]) {
      try { console.log(JSON.stringify({ engine: 'oracle', service, sql, rows: (await c.execute(sql)).rows })); }
      catch (e) { console.log(JSON.stringify({ engine: 'oracle', service, sql, error: code(e) })); }
    }
  } catch (e) { console.log(JSON.stringify({ engine: 'oracle', service, connection: code(e) })); }
  finally { await c?.close(); }
}
let c: any;
// Read the actual server handshake version; V$VERSION in this image only exposes V8/build.
const { Login } = createRequire(import.meta.url)('dmdb/src/net/msg/login.js');
const originalVersion = Login.processServerVersion;
Login.processServerVersion = function(version: string, connection: unknown) {
  if (/^\d+(\.\d+)+$/.test(version)) console.log(JSON.stringify({ engine: 'dameng', handshake_version: version }));
  return originalVersion.call(this, version, connection);
};
try {
  c = await dmdb.getConnection({ ...credentials.dameng, connectString: '127.0.0.1:5236', loginEncrypt: false, connectTimeout: 5000, socketTimeout: 5000 });
  const instance = await c.execute('SELECT * FROM V$INSTANCE');
  console.log(JSON.stringify({ engine: 'dameng', instance_columns: instance.metaData.map((m: any) => m.name) }));
  for (const sql of ['SELECT * FROM V$VERSION', 'SELECT SVR_VERSION FROM V$INSTANCE', 'SELECT SF_GET_VERSION() FROM DUAL', 'SELECT * FROM SESSION_PRIVS', 'SELECT GRANTED_ROLE FROM USER_ROLE_PRIVS',
    'SELECT COUNT(*) FROM V$SESSIONS', "SELECT VALUE FROM V$PARAMETER WHERE NAME='max_sessions'",
    "SELECT CAST(STAT_VAL AS VARCHAR(20)) FROM V$SYSSTAT WHERE NAME='transaction commit count'"]) {
    try { console.log(JSON.stringify({ engine: 'dameng', sql, rows: (await c.execute(sql)).rows })); }
    catch (e) { console.log(JSON.stringify({ engine: 'dameng', sql, error: code(e) })); }
  }
} catch (e) { console.log(JSON.stringify({ engine: 'dameng', connection: code(e) })); }
finally { Login.processServerVersion = originalVersion; await c?.close(); }
