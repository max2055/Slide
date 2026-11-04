import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('serve-e2e stops its own process group when API or Vite exits (#460)', () => {
  const result = spawnSync('bash', ['scripts/qualification/serve-e2e.supervisor.test.sh'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS api-exit/);
  assert.match(result.stdout, /PASS vite-exit/);
  assert.match(result.stdout, /PASS signal-term/);
  assert.match(result.stdout, /PASS signal-int/);
});
