import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../qualification/run-agent-runtime.sh', import.meta.url));

test('MAX-681 runtime CLI refuses missing password before launching mysql work', t => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-credentials-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, 'calls');
  // Record presence/equality only; do not print even synthetic credentials.
  writeFileSync(join(dir, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
const names = ['DB_PASSWORD', 'APPROVAL_TEST_MYSQL_PASSWORD', 'AGENT_RUN_TEST_MYSQL_PASSWORD', 'AUTH_TEST_MYSQL_PASSWORD'];
fs.appendFileSync(process.env.RUNTIME_CREDENTIAL_CAPTURE, JSON.stringify(Object.fromEntries(names.map(k => [k, {present: Object.hasOwn(process.env,k), equal: process.env[k] === process.env.RUNTIME_EXPECTED_PASSWORD}])))+'\\n');
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNTIME_CREDENTIAL_CAPTURE: capture };
  for (const name of ['DB_PASSWORD', 'APPROVAL_TEST_MYSQL_PASSWORD', 'AGENT_RUN_TEST_MYSQL_PASSWORD', 'AUTH_TEST_MYSQL_PASSWORD']) delete env[name];
  for (const extra of [[], ['--runtime-only']]) {
    const result = spawnSync('bash', [script, '--mode', 'mysql', ...extra], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /DB_PASSWORD must be explicitly injected/);
  }
  assert.throws(() => readFileSync(capture), { code: 'ENOENT' });
  for (const password of ['', 'synthetic-runtime-input']) {
    writeFileSync(capture, '');
    const result = spawnSync('bash', [script, '--mode', 'mysql'], {
      env: { ...env, DB_PASSWORD: password, RUNTIME_EXPECTED_PASSWORD: password }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 3);
    for (const call of calls) assert.deepEqual(call.DB_PASSWORD, { present: true, equal: true });
    assert.deepEqual(calls[1].APPROVAL_TEST_MYSQL_PASSWORD, { present: true, equal: true });
    for (const key of ['AGENT_RUN_TEST_MYSQL_PASSWORD', 'AUTH_TEST_MYSQL_PASSWORD']) {
      assert.deepEqual(calls[2][key], { present: true, equal: true });
    }
  }
});
