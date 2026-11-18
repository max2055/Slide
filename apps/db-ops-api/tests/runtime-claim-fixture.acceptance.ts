// Explicit opt-in, disposable SQL/JWT/TCP acceptance for the runtime-only helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { runtimeClaimFixture } from './runtime-claim-fixture.js';
import { dbConnection } from '../src/db-connection.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import { ActorContextService, signAccessToken } from '../src/auth/actor-context.js';

const port = Number(process.env.RUNTIME_FIXTURE_MYSQL_PORT);
test('runtime-only claim: SQL/JWT and live authorization boundaries', { skip: !port }, async t => {
  assert.ok(Number.isInteger(port) && port > 0 && port !== 3306);
  const config = { host: '127.0.0.1', port, user: 'root', password: '' };
  const database = 'max684_fixture_' + randomUUID().replaceAll('-', '');
  const admin = mysql.createPool(config);
  const pool = mysql.createPool({ ...config, database });
  const nonce = randomUUID();
  const secret = randomBytes(32).toString('hex');
  // A non-superuser owner makes chat:view revocation observable. Managed UI
  // uses the same helper with its fixed default admin owner, not this account.
  const app = runtimeClaimFixture(nonce, { NODE_ENV: 'test', JWT_SECRET_KEY: secret }, 'fixture-owner');
  try {
    await admin.query('CREATE DATABASE ' + database);
    await new MigrationRunner(pool).run();
    assert.equal(await dbConnection.initialize({ ...config, database }), true);
    for (const [id, username] of [[68481, 'fixture-owner'], [68482, 'fixture-other']] as const) {
      await pool.query("INSERT INTO users(id,username,password_hash) VALUES(?,?,'test-not-login')", [id, username]);
      await pool.query('INSERT INTO roles(id,name) VALUES(?,?)', [id, 'fixture-' + id]);
      await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)', [id, id]);
      await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code='chat:view'", [id]);
    }
    const actors = new ActorContextService();
    const token = (id = 68481, seconds = 60) => actors.loadActiveActor(id).then(a => signAccessToken(a, secret, seconds));
    const session = async (owner = 68481, batch = nonce) => {
      const id = randomUUID();
      await pool.query("INSERT INTO chat_sessions(session_id,user_id,title) VALUES(?,?,'fixture')", [id, owner]);
      await pool.query("INSERT INTO chat_messages(session_id,message_id,role,content) VALUES(?,?,'user',?)", [id, randomUUID(), `runtime-qualification:recovery:${batch}:${randomUUID()}`]);
      return id;
    };
    const count = async () => { const [rows] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM agent_runs'); return rows[0].n; };
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const call = async (sessionId: string, jwt?: string) => fetch(url + '/claim', { method: 'POST',
      headers: { 'content-type': 'application/json', ...(jwt ? { authorization: 'Bearer ' + jwt } : {}) },
      body: JSON.stringify({ sessionId, messageId: randomUUID(), requestKey: randomUUID() }) });
    await t.test('legal token/owner creates one run with all credential bindings', async () => {
      const before = await count();
      const response = await call(await session(), await token());
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ['runId']);
      assert.equal(await count(), before + 1);
      const [rows] = await pool.query<any[]>('SELECT chat_session_version IS NOT NULL AS versionBound, chat_credential_ref IS NOT NULL AS credentialBound, chat_credential_expires_ms IS NOT NULL AS expiryBound FROM agent_runs WHERE id=?', [body.runId]);
      assert.deepEqual(rows.map(r => [!!r.versionBound, !!r.credentialBound, !!r.expiryBound]), [[true, true, true]]);
    });
    for (const [name, getToken] of [
      ['missing', async () => undefined], ['expired', () => token(68481, -1)],
      ['invalid signature', async () => signAccessToken(await actors.loadActiveActor(68481), randomBytes(32).toString('hex'))],
    ] as const) await t.test(name + ' token creates zero runs', async () => {
      const before = await count();
      assert.equal((await call(await session(), await getToken())).status, 401);
      assert.equal(await count(), before);
    });
    await t.test('sessionVersion mismatch creates zero runs', async () => {
      const jwt = await token(); const before = await count();
      await pool.query('UPDATE users SET session_version=session_version+1 WHERE id=68481');
      assert.equal((await call(await session(), jwt)).status, 401);
      assert.equal(await count(), before);
    });
    for (const [name, owner, batch] of [['cross owner', 68482, nonce], ['other batch', 68481, randomUUID()]] as const) await t.test(name + ' creates zero runs', async () => {
      const before = await count();
      assert.equal((await call(await session(owner, batch), await token())).status, 403);
      assert.equal(await count(), before);
    });
    await t.test('live chat permission revoked after signing creates zero runs', async () => {
      const jwt = await token(); const before = await count();
      await pool.query('DELETE FROM role_permissions WHERE role_id=68481');
      assert.equal((await call(await session(), jwt)).status, 403);
      assert.equal(await count(), before);
    });
  } finally {
    await app.close(); await dbConnection.close(); await pool.end();
    await admin.query('DROP DATABASE IF EXISTS ' + database); await admin.end();
  }
});
