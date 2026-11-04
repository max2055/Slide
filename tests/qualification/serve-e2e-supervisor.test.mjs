import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('serve-e2e stops its service tree and stays in the launcher group (#460)', () => {
  const result = spawnSync('bash', ['scripts/qualification/serve-e2e.supervisor.test.sh'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS api-exit/);
  assert.match(result.stdout, /PASS vite-exit/);
  assert.match(result.stdout, /PASS signal-term/);
  assert.match(result.stdout, /PASS signal-int/);
  assert.match(result.stdout, /PASS unrelated-orphan/);
  assert.match(result.stdout, /unrelated_orphan_after=alive/);
  assert.match(result.stdout, /PASS fork-gap/);
  assert.match(result.stdout, /service_exit=7/);
  assert.match(result.stdout, /orphan_before_owner=tracked/);
  assert.match(result.stdout, /PASS node-gap/);
  assert.match(result.stdout, /service_exit=3/);
  assert.match(result.stdout, /PASS playwright-sigkill/);
});
