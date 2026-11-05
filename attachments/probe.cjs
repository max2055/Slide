const { execFileSync } = require('node:child_process');
const { stripTypeScriptTypes } = require('node:module');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const head = 'a26f093526b50e422bd3b02ea19f350f92d82060';
const raw = JSON.parse(execFileSync('gh', ['api', `repos/max2055/Slide/contents/apps/db-ops-api/src/ssh-session-pool.ts?ref=${head}`], { encoding: 'utf8' }));
const source = Buffer.from(raw.content, 'base64').toString('utf8');
const compiled = stripTypeScriptTypes(source).replace(/^import .*;$/gm, '').replace(/^export .*;$/gm, '');
const clients = [];
class Client {
  handlers = {};
  ended = false;
  on(event, handler) { this.handlers[event] = handler; return this; }
  connect() { clients.push(this); }
  end() { this.ended = true; }
}
const Pool = new Function('createHash', 'timingSafeEqual', 'Client', 'authorizeServerTarget', 'createOptionalSshHostVerifier', 'normalizeOptionalSshHostKeyFingerprint', `${compiled}\nreturn SshSessionPool;`)(crypto.createHash, crypto.timingSafeEqual, Client, async ({host, port}) => ({hostname: host, address: host, port}), () => undefined, value => value || undefined);
(async () => {
  const pool = new Pool();
  const pending = pool.getConnection('192.0.2.1', 22, 'operator', 'password', 'synthetic-old-secret');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clients.length, 1);
  const revoked = pool.revokeSessions({host: '192.0.2.1', port: 22, username: 'operator'});
  clients[0].handlers.ready();
  const late = await pending;
  pool.releaseConnection(late);
  const reused = await pool.getConnection('192.0.2.1', 22, 'operator', 'password', 'synthetic-old-secret');
  assert.equal(reused, late);
  assert.equal(late.ended, false);
  console.log(JSON.stringify({head, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), transport: 'mock; exact candidate methods, imports replaced', revoked, lateSessionReturned: true, lateSessionReused: reused === late, ended: late.ended, stats: pool.getPoolStats()}, null, 2));
  pool.closeAll();
})().catch(error => { console.error(error); process.exitCode = 1; });
