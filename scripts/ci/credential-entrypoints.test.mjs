import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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
    env: { ...process.env, SMOKE_PASSWORD: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SMOKE_PASSWORD must be explicitly injected/);
  assert.equal(result.stdout, '');
});
