import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(new URL('../../scripts/qualification/run-existing-mysql.sh', import.meta.url), 'utf8');
const allocation = source.split('\n').find(line => line.trim().startsWith('backup="$(mktemp'));
const cleanup = source.slice(source.indexOf('cleanup() {'), source.indexOf('trap cleanup'));
const exec = promisify(execFile);

// GitHub #459: exercise the script's real template with the host BSD/GNU mktemp.
test('#459 sequential and concurrent backup allocations remain distinct', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup temp '));
  const options = { env: { ...process.env, TMPDIR: dir }, encoding: 'utf8' };
  const command = `${allocation}\nprintf '%s' "$backup"`;
  try {
    const paths = [];
    for (let i = 0; i < 20; i++) paths.push(execFileSync('bash', ['-euc', command], options));
    paths.push(...(await Promise.all(Array.from({ length: 20 }, () => exec('bash', ['-euc', command], options)))).map(r => r.stdout));
    assert.equal(new Set(paths).size, 40);
    assert.equal(readdirSync(dir).length, 40);
    for (const path of paths) assert.ok(!path.includes('XXXXXX'), path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const status of [0, 23]) {
  test(`#459 EXIT cleanup removes allocated backup after status ${status}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup cleanup '));
    try {
      // Database cleanup is stubbed here; real backup/restore is a separate MySQL drill.
      const command = `server_pid=''; backup=''; database=test; restore_database=test_restore
        drop_database() { :; }
        ${cleanup}
        trap cleanup EXIT
        ${allocation}
        test -f "$backup"
        printf fixture > "$backup"
        exit ${status}`;
      let actual = 0;
      try { execFileSync('bash', ['-euc', command], { env: { ...process.env, TMPDIR: dir } }); }
      catch (error) { actual = error.status; }
      assert.equal(actual, status);
      assert.deepEqual(readdirSync(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
