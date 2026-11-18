import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Execute the actual handler, removing types only. These module substitutes
// model already-authenticated requests and SQL scope replies; no listener,
// credential verification, SQL service or database write is exercised here.
async function fixture({ query = async () => [[{ user_id: 7 }]], claim } = {}) {
  const actor = Object.freeze({ userId: 7, username: 'admin' });
  const calls = [], queries = [];
  let handler;
  const dependencies = {
    fastify: { default: () => ({ post(_path, _options, callback) { handler = callback; } }) },
    '../src/auth-middleware.js': { createVerifyToken: () => () => {} },
    '../src/auth/actor-context.js': { ActorContextService: class {} },
    '../src/config/security-config.js': { loadSecurityConfig: () => ({ jwtSecret: 'synthetic-test-only' }) },
    '../src/db-connection.js': { dbConnection: { getPool: () => ({ query(...args) { queries.push(args); return query(...args); } }) } },
    '../src/adapter/agent-run-service.js': { AgentRunService: class {
      async claim(...args) {
        calls.push(args);
        assert.equal(args[4], actor, 'pass the original request Actor');
        return claim ? claim(...args) : { run: { id: 'synthetic-run-' + calls.length } };
      }
    } },
  };
  const source = stripTypeScriptTypes(readFileSync(new URL('./runtime-claim-fixture.ts', import.meta.url), 'utf8'));
  const module = new vm.SourceTextModule(source);
  await module.link(specifier => {
    const exports = dependencies[specifier];
    assert.ok(exports, specifier);
    return new vm.SyntheticModule(Object.keys(exports), function() {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    });
  });
  await module.evaluate();
  const nonce = '00000000-0000-4000-8000-000000000001';
  module.namespace.runtimeClaimFixture(nonce);
  return { calls, queries, actor, nonce, async request(key, user = actor) {
    const reply = { statusCode: 200, code(status) { this.statusCode = status; return this; }, send(body) { return body; } };
    const body = await handler({ user, body: { sessionId: 'same-session', messageId: 'message-' + key, requestKey: key } }, reply);
    return { status: reply.statusCode, body };
  } };
}

test('single legal request preserves scope parameters, original Actor and minimal reply', async () => {
  const f = await fixture();
  assert.deepEqual(await f.request('one'), { status: 200, body: { runId: 'synthetic-run-1' } });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.queries[0][1], ['same-session', 7, `runtime-qualification:recovery:${f.nonce}:%`]);
  assert.deepEqual(f.calls[0], [7, 'same-session', 'message-one', 'one', f.actor]);
});

for (const first of [0, 1]) test(`overlapping scope queries admit only their first completed request (${first})`, async () => {
  const pending = [];
  const f = await fixture({ query: () => new Promise(resolve => pending.push(resolve)) });
  const responses = [f.request('one'), f.request('two')];
  assert.equal(pending.length, 2, 'both requests must be suspended at the SQL boundary');
  pending[first]([[{ user_id: 7 }]]);
  assert.equal((await responses[first]).status, 200);
  pending[1 - first]([[{ user_id: 7 }]]);
  assert.deepEqual(await responses[1 - first], { status: 403, body: { error: 'FIXTURE_SCOPE' } });
  assert.equal(f.calls.length, 1, 'different requestKeys cannot both reach claim');
  assert.equal(f.calls[0][3], first === 0 ? 'one' : 'two');
});

test('sequential duplicate cannot query or claim again', async () => {
  const f = await fixture();
  assert.equal((await f.request('one')).status, 200);
  assert.deepEqual(await f.request('one'), { status: 403, body: { error: 'FIXTURE_SCOPE' } });
  assert.deepEqual(await f.request('two'), { status: 403, body: { error: 'FIXTURE_SCOPE' } });
  assert.equal(f.queries.length, 1); assert.equal(f.calls.length, 1);
});

test('unknown claim outcome retains admission and refuses another claim', async () => {
  const f = await fixture({ claim: async () => { throw new Error('synthetic unknown claim outcome'); } });
  assert.deepEqual(await f.request('one'), { status: 403, body: { error: 'FIXTURE_CLAIM_REJECTED' } });
  assert.deepEqual(await f.request('one'), { status: 403, body: { error: 'FIXTURE_SCOPE' } });
  assert.deepEqual(await f.request('two'), { status: 403, body: { error: 'FIXTURE_SCOPE' } });
  assert.equal(f.queries.length, 1); assert.equal(f.calls.length, 1);
});

test('invalid owner or SQL scope does not consume a later legal admission', async () => {
  let inScope = false;
  const f = await fixture({ query: async () => [inScope ? [{ user_id: 7 }] : []] });
  assert.equal((await f.request('wrong-owner', { userId: 8, username: 'other-owner' })).status, 403);
  assert.equal(f.queries.length, 0);
  assert.equal((await f.request('wrong-scope')).status, 403);
  assert.equal(f.calls.length, 0);
  inScope = true;
  assert.equal((await f.request('legal')).status, 200);
  assert.equal(f.queries.length, 2); assert.equal(f.calls.length, 1);
});
