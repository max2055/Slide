import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { safeFrame } from './process-evidence.mjs';
test('rejects forged paths, accessors and proxies without reading exception data', () => {
  for (const frame of [null, new Proxy({}, { ownKeys() { throw Error('secret'); } }),
    { get url() { throw Error('secret'); } }, { url: 'file:///repo/a.ts?key=secret', lineNumber: 0, columnNumber: 0 },
    { url: 'file:///outside/secret.ts', lineNumber: 0, columnNumber: 0 }]) assert.equal(safeFrame(frame, '/repo'), null);
  assert.deepEqual(safeFrame({ url: 'file:///repo/src/a.ts', lineNumber: 1, columnNumber: 2 }, '/repo'), { path: 'src/a.ts', line: 2, column: 3 });
});
test('preload preserves real fatal exit without emitting messages, causes or URLs', () => {
  const child = spawnSync(process.execPath, ['--import', new URL('./process-evidence.mjs', import.meta.url).href, '-e',
    `process.on('unhandledRejection', () => { console.error('FATAL_UNHANDLED_REJECTION'); process.exit(1); }); Promise.reject(new Error('secret https://host/?key=secret', {cause:'secret'}));`],
    { env: { ...process.env, SLIDE_TEST_PROCESS_EVIDENCE: '1' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /FATAL_UNHANDLED_REJECTION/); assert.doesNotMatch(child.stderr, /secret|https:/);
});
