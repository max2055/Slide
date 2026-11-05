const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const crypto = require('node:crypto');
const source = readFileSync(require('node:path').join(__dirname, '../apps/db-ops-api/src/ssh-session-pool.ts'), 'utf8');
const compiled = stripTypeScriptTypes(source).replace(/^import .*;$/gm, '').replace(/^export .*;$/gm, '');
const clients = [];
class Client {
  handlers = {};
  ended = false;
  on(event, handler) { this.handlers[event] = handler; return this; }
  connect() { clients.push(this); }
  end() { this.ended = true; }
}
const Pool = new Function(
  'createHash',
  'timingSafeEqual',
  'Client',
  'authorizeServerTarget',
  'createOptionalSshHostVerifier',
  'normalizeOptionalSshHostKeyFingerprint',
  `${compiled}\nreturn SshSessionPool;`,
)(
  crypto.createHash,
  crypto.timingSafeEqual,
  Client,
  async ({ host, port }) => ({ hostname: host, address: host, port }),
  () => undefined,
  (value) => value || undefined,
);

(async () => {
  const pool = new Pool();
  const pending = pool.getConnection('192.0.2.1', 22, 'operator', 'password', 'synthetic-old-secret');
  await new Promise((resolve) => setImmediate(resolve));
  if (clients.length !== 1) throw new Error(`expected one connecting client, got ${clients.length}`);
  const revoked = pool.revokeSessions({ host: '192.0.2.1', port: 22, username: 'operator' });
  clients[0].handlers.ready();
  let late = null;
  let lateError = null;
  try {
    late = await pending;
  } catch (error) {
    lateError = error;
  }
  let reused = null;
  if (late) {
    pool.releaseConnection(late);
    reused = await pool.getConnection('192.0.2.1', 22, 'operator', 'password', 'synthetic-old-secret');
  }
  const result = {
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    transport: 'mock; local source, imports replaced, same race as the review probe',
    revoked,
    lateError: lateError && lateError.message,
    lateSessionReturned: late !== null,
    lateSessionReused: Boolean(late) && reused === late,
    ended: clients[0].ended,
    stats: pool.getPoolStats(),
  };
  console.log(JSON.stringify(result, null, 2));
  pool.closeAll();
  if (result.revoked !== 1 || result.lateSessionReturned || result.lateSessionReused || !result.ended || result.stats.total !== 0) {
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
