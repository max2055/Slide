import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { safeFrame } from './process-evidence.mjs';
import { fileURLToPath } from 'node:url';
test('rejects forged paths, accessors and proxies without reading exception data', () => {
  for (const frame of [null, new Proxy({}, { ownKeys() { throw Error('secret'); } }),
    { get url() { throw Error('secret'); } }, { url: 'file:///repo/a.ts?key=secret', lineNumber: 0, columnNumber: 0 },
    { url: 'file:///outside/secret.ts', lineNumber: 0, columnNumber: 0 }]) assert.equal(safeFrame(frame, '/repo'), null);
  assert.deepEqual(safeFrame({ url: 'file:///repo/src/a.ts', lineNumber: 1, columnNumber: 2 }, '/repo'), { path: 'src/a.ts', line: 2, column: 3 });
});
test('preload preserves real fatal exit without emitting messages, causes or URLs', () => {
  const child = spawnSync(process.execPath, ['--import', new URL('./process-evidence.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/fatal-rejection.mjs', import.meta.url))],
    { cwd: fileURLToPath(new URL('../../apps/db-ops-api', import.meta.url)), env: { ...process.env, SLIDE_TEST_PROCESS_EVIDENCE: '1' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /FATAL_UNHANDLED_REJECTION/); assert.doesNotMatch(child.stderr, /secret|https:/);
  const engine = child.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(engine.some(event => event.frames?.some(frame => frame.path === 'scripts/diagnostics/fixtures/fatal-rejection.mjs')));
});
