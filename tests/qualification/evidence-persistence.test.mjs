/**
 * CI entry for GitHub #725 / MAX-303.
 * The backend job runs `node --test tests/qualification/*.test.mjs` and does
 * not collect the TypeScript file. This wrapper executes that file unchanged.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const cases = [
  'missing port is refused before initialize',
  'a port other than the isolated port is refused before initialize',
  'a matching database name on the shared default port is refused before initialize',
  'a missing host is refused before initialize',
  'blank, padded, and parsed-prefix ports are refused before initialize',
  'localhost, a blank host, and a non-evidence database name are refused before initialize',
  'the isolated host, explicit port, and database name call initialize once',
  'script entry refuses a closed non-isolated port before any database session',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('CI collects the evidence persistence isolation guard', async () => {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  // The parent `node --test` marks this process as a test worker. Leaving that
  // mark makes the child runner skip the TypeScript file.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    const result = await exec('pnpm', [
      '--filter', 'slide-api', 'exec',
      'node', '--import', 'tsx', '--test', '--test-reporter=tap',
      '../../tests/qualification/evidence-persistence.test.ts',
    ], { cwd: root, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
    code = error.code ?? 1;
  }
  const output = `${stdout}\n${stderr}`;
  console.log(output);
  assert.equal(code, 0, 'evidence persistence tests exited non-zero');
  for (const name of cases) {
    assert.match(output, new RegExp(`^ok\\s+\\d+\\s+-\\s+${escapeRegExp(name)}(?:\\s|$)`, 'm'));
  }
  assert.match(output, /^# tests 8$/m);
  assert.match(output, /^# pass 8$/m);
  assert.match(output, /^# fail 0$/m);
  assert.match(output, /^# cancelled 0$/m);
  assert.match(output, /^# skipped 0$/m);
});
