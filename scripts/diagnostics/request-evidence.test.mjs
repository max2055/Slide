import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('request preload preserves hook/response behavior and emits only fixed fields', () => {
  const script = `
    const app = require('fastify')();
    app.addHook('onRequest', (q,p,next) => next());
    app.addHook('onRequest', async () => {});
    app.addHook('onSend', async (q,p,data) => data);
    app.get('/private', {preHandler: async (q,p) => {p.code(401).send({error:'secret https://host/?token=secret'});}}, async () => ({value:'secret'}));
    (async()=>{const r=await app.inject({url:'/private',headers:{'x-slide-test-request':'p10-anon-1'}});console.log(JSON.stringify({status:r.statusCode,body:r.body}));await app.close()})().catch(()=>process.exit(2));`;
  const run = enabled => spawnSync(process.execPath, ['--import', new URL('./request-evidence.mjs', import.meta.url).href, '-e', script], {
    cwd: fileURLToPath(new URL('../../apps/db-ops-api', import.meta.url)), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, SLIDE_TEST_REQUEST_EVIDENCE: enabled ? '1' : '0' },
  });
  const plain = run(false), observed = run(true);
  assert.equal(plain.status, 0); assert.equal(observed.status, 0);
  assert.equal(observed.stdout, plain.stdout);
  assert.match(observed.stderr, /p10-anon-1/);
  assert.doesNotMatch(observed.stderr, /secret|https:|token/);
  for (const line of observed.stderr.trim().split('\n')) {
    const event = JSON.parse(line);
    assert.ok(Object.keys(event).every(key => ['event','ms','id','phase','branch','status','sent','code'].includes(key)));
  }
});
