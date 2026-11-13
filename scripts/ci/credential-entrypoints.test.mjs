import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('MAX-681 shared MySQL entrypoint refuses missing credentials before Docker operations', () => {
  const result = spawnSync('bash', ['scripts/qualification/run-existing-mysql.sh', 'stability'], {
    env: { ...process.env, QUALIFICATION_MYSQL_PASSWORD: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALIFICATION_MYSQL_PASSWORD must be explicitly injected/);
  assert.equal(result.stdout, '');
});

test('MAX-681 smoke entrypoint refuses missing credentials before HTTP requests', () => {
  const result = spawnSync(process.execPath, ['apps/db-ops-api/tests/smoke-test.ts'], {
    env: { ...process.env, SMOKE_PASS: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SMOKE_PASS must be explicitly injected/);
  assert.equal(result.stdout, '');
});

test('MAX-681 smoke login sends the explicitly injected legacy SMOKE_PASS value', async t => {
  const injected = ['controlled', 'login', 'probe'].join('-');
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(401, { 'content-type': 'text/plain' });
    response.end('controlled refusal; stop after login');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, ['apps/db-ops-api/tests/smoke-test.ts'], {
    env: { ...process.env, SMOKE_PASS: injected, SMOKE_USER: 'controlled-fixture', SMOKE_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: 'ignore', timeout: 5000,
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.equal(received?.password, injected);
  assert.equal(received?.username, 'controlled-fixture');
});
