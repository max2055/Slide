import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingSql, runObservation, cleanupContainer } from './recovery-observation.mjs';
test('pending SQL preserves concurrent identities, safe labels and elapsed time', () => {
  const begin = { event: 'begin', kind: 'sql', utc: '2026-10-23T00:00:00Z', monotonicNs: '1000000', pid: 7, id: 1, label: 'select', database: 'own-db' };
  assert.deepEqual(pendingSql([begin, { ...begin, id: 2 }, { ...begin, id: 2, event: 'error' }], 1201000000n),
    [{ pid: 7, id: 1, database: 'own-db', label: 'select', durationMs: 1200 }]);
});
test('runner refuses non-owned containers before invoking docker or a test', async () => {
  await assert.rejects(runObservation('shared-mysql', '3306', 'never-run', []), /Invalid isolated/);
});
test('failed child keeps its exit status, pending SQL and pre-cleanup snapshot', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'recovery-runner-'));
  const previous = { PATH: process.env.PATH, RECOVERY_OBSERVATION_DIR: process.env.RECOVERY_OBSERVATION_DIR };
  try {
    const bin = join(directory, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\ncase "$1" in inspect) echo "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";; image) echo "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aarch64 linux";; stats) echo "1%|20MiB|0B|1";; exec) exit 0;; rm) exit 0;; *) exit 90;; esac\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${previous.PATH}`;
    process.env.RECOVERY_OBSERVATION_DIR = directory;
    const child = join(directory, 'child.mjs');
    writeFileSync(child, `import {writeFileSync,existsSync} from 'node:fs';
      import {join} from 'node:path';
      const dir=process.env.RECOVERY_OBSERVATION_DIR;
      const database='investigation_test_123_${'a'.repeat(32)}';
      writeFileSync(join(dir,'hook-123.jsonl'),JSON.stringify({utc:new Date().toISOString(),monotonicNs:process.hrtime.bigint().toString(),event:'begin',kind:'sql',id:1,pid:123,database,label:'alter'})+'\\n');
      writeFileSync(join(dir,'cleanup-123'),database);
      const deadline=Date.now()+4000;
      while(!existsSync(join(dir,'cleanup-123.ack'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
      process.exitCode=7;`);
    assert.equal(await runObservation('slide-report-recovery-123-456', '12345', process.execPath, [child]), 7);
    const rows = readFileSync(join(directory, 'runner.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(r => r.event === 'final-snapshot' && r.pendingSql[0]?.label === 'alter'));
    assert.equal(rows.at(-1).code, 7);
    assert.ok(readFileSync(join(directory, 'cleanup-123.ack'), 'utf8'));
    assert.equal(await cleanupContainer('slide-report-recovery-123-456'), 0);
    assert.equal(JSON.parse(readFileSync(join(directory, 'cleanup.json'), 'utf8')).removed, true);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 9\n', { mode: 0o755 });
    assert.equal(await cleanupContainer('slide-report-recovery-123-456'), 1);
    assert.equal(JSON.parse(readFileSync(join(directory, 'cleanup.json'), 'utf8')).removed, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cleanup rejects shared container identities before invoking docker', async () => {
  await assert.rejects(cleanupContainer('shared-mysql'), /Invalid cleanup/);
});
