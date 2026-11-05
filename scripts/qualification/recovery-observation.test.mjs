import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingSql, runObservation, cleanupContainer, boundedCommand, CLEANUP_WINDOW_MS, CLEANUP_WATCH_MS, CLEANUP_ACK_POLL_MS, CLEANUP_ACK_WRITE_MS, CLEANUP_MARGIN_MS, STATS_RETRY_BUDGET_MS } from './recovery-observation.mjs';
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

test('docker stats SIGPIPE is retried and a hard stats failure still fails the run', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previous = {
    PATH: process.env.PATH,
    RECOVERY_OBSERVATION_DIR: process.env.RECOVERY_OBSERVATION_DIR,
    RECOVERY_STATS_MODE: process.env.RECOVERY_STATS_MODE,
  };
  const directory = mkdtempSync(join(tmpdir(), 'recovery-stats-'));
  try {
    const bin = join(directory, 'bin'); mkdirSync(bin);
    const count = join(directory, 'stats-count');
    writeFileSync(join(bin, 'docker'), `#!/bin/bash
case "$1" in
  inspect) echo "sha256:${'a'.repeat(64)}";;
  image) echo "sha256:${'a'.repeat(64)} aarch64 linux";;
  stats)
    n=0; [ -f ${JSON.stringify(count)} ] && n=$(cat ${JSON.stringify(count)})
    n=$((n + 1)); echo "$n" > ${JSON.stringify(count)}
    case "$RECOVERY_STATS_MODE" in
      pipe) if [ "$n" -le 1 ]; then trap - PIPE; kill -PIPE $$; fi;;
      always) trap - PIPE; kill -PIPE $$;;
      exit) exit 2;;
    esac
    echo "1%|20MiB|0B|1";;
  exec|rm) exit 0;;
  *) exit 90;;
esac
`, { mode: 0o755 });
    const child = join(directory, 'child.mjs');
    writeFileSync(child, `import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
      writeFileSync(join(process.env.RECOVERY_OBSERVATION_DIR,'hook-9.jsonl'), JSON.stringify({utc:new Date().toISOString(),monotonicNs:'1',event:'hook-exit',kind:'stage',pid:9,commit:process.env.RECOVERY_OBSERVATION_COMMIT,database:'investigation_test_9_${'a'.repeat(32)}',pending:[]})+'\\n');
`);
    process.env.PATH = `${bin}:${previous.PATH}`;
    const observe = async mode => {
      writeFileSync(count, '0');
      process.env.RECOVERY_OBSERVATION_DIR = mkdtempSync(join(directory, 'out-'));
      process.env.RECOVERY_STATS_MODE = mode;
      const code = await runObservation('slide-report-recovery-123-456', '12345', process.execPath, [child]);
      const rows = readFileSync(join(process.env.RECOVERY_OBSERVATION_DIR, 'runner.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      return { code, rows, calls: Number(readFileSync(count, 'utf8')) };
    };
    const recovered = await observe('pipe');
    assert.equal(recovered.code, 0);
    assert.equal(recovered.calls, 2);
    assert.equal(recovered.rows.at(-1).recordingFailed, false);
    assert.equal(recovered.rows.find(row => row.event === 'final-snapshot').stats.ok, true);
    const persistent = await observe('always');
    assert.equal(persistent.code, 1);
    assert.equal(persistent.calls, 3);
    assert.equal(persistent.rows.at(-1).code, 0);
    assert.equal(persistent.rows.at(-1).recordingFailed, true);
    assert.equal(persistent.rows.find(row => row.event === 'final-snapshot').stats.signal, 'SIGPIPE');
    const hard = await observe('exit');
    assert.equal(hard.code, 1);
    assert.equal(hard.calls, 1);
    assert.equal(hard.rows.find(row => row.event === 'final-snapshot').stats.code, 2);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stats retry budget fits inside the 4s cleanup window', () => {
  assert.equal(CLEANUP_WINDOW_MS, 4000);
  assert.equal(CLEANUP_WATCH_MS + CLEANUP_ACK_POLL_MS + CLEANUP_ACK_WRITE_MS + CLEANUP_MARGIN_MS + STATS_RETRY_BUDGET_MS, CLEANUP_WINDOW_MS);
  assert.ok(STATS_RETRY_BUDGET_MS > 2500);
  assert.ok(STATS_RETRY_BUDGET_MS < 2500 * 3);
});

test('delayed SIGPIPE retries stay inside one deadline and still fail when it expires', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'recovery-deadline-'));
  try {
    const script = join(directory, 'stats.sh');
    const count = join(directory, 'count');
    writeFileSync(script, `#!/bin/bash
n=0; [ -f "$1" ] && n=$(cat "$1"); n=$((n + 1)); echo "$n" > "$1"
case "$2" in
  once) [ "$n" -eq 1 ] && sleep 0.25 && { trap - PIPE; kill -PIPE $$; };;
  always) sleep 0.3; trap - PIPE; kill -PIPE $$;;
esac
echo ok
`, { mode: 0o755 });
    const run = async (mode, budget) => {
      writeFileSync(count, '0');
      const started = performance.now();
      const result = await boundedCommand(script, [count, mode], { retries: 2, timeout: 2500, deadlineMs: started + budget });
      return { ...result, elapsed: performance.now() - started, calls: Number(readFileSync(count, 'utf8')) };
    };
    const recovered = await run('once', 2000);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.calls, 2);
    assert.ok(recovered.elapsed < 2000);
    const persistent = await run('always', 500);
    assert.equal(persistent.ok, false);
    assert.equal(persistent.calls, 2);
    assert.ok(persistent.elapsed < 750, `elapsed ${persistent.elapsed}`);
    assert.ok(persistent.elapsed >= 450, `elapsed ${persistent.elapsed}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('delayed stats failure acks the cleanup snapshot before the worker drops its database', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previous = {
    PATH: process.env.PATH,
    RECOVERY_OBSERVATION_DIR: process.env.RECOVERY_OBSERVATION_DIR,
    RECOVERY_STATS_MODE: process.env.RECOVERY_STATS_MODE,
  };
  const directory = mkdtempSync(join(tmpdir(), 'recovery-window-'));
  try {
    const bin = join(directory, 'bin'); mkdirSync(bin);
    const count = join(directory, 'stats-count');
    writeFileSync(join(bin, 'docker'), `#!/bin/bash
case "$1" in
  inspect) echo "sha256:${'a'.repeat(64)}";;
  image) echo "sha256:${'a'.repeat(64)} aarch64 linux";;
  stats)
    n=0; [ -f ${JSON.stringify(count)} ] && n=$(cat ${JSON.stringify(count)})
    n=$((n + 1)); echo "$n" > ${JSON.stringify(count)}
    ack="\${RECOVERY_OBSERVATION_DIR}/cleanup-123.ack"
    case "$RECOVERY_STATS_MODE" in
      delay-once) if [ "$n" -eq 1 ]; then sleep 0.25; trap - PIPE; kill -PIPE $$; fi;;
      delay-always) if [ ! -f "$ack" ]; then sleep 2.2; trap - PIPE; kill -PIPE $$; fi;;
    esac
    echo "1%|20MiB|0B|1";;
  exec|rm) exit 0;;
  *) exit 90;;
esac
`, { mode: 0o755 });
    const child = join(directory, 'child.mjs');
    writeFileSync(child, `import {writeFileSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
const dir = process.env.RECOVERY_OBSERVATION_DIR;
const database = 'investigation_test_123_${'a'.repeat(32)}';
writeFileSync(join(dir, 'hook-123.jsonl'), JSON.stringify({utc:new Date().toISOString(), monotonicNs:'1', event:'hook-exit', kind:'stage', pid:123, commit:process.env.RECOVERY_OBSERVATION_COMMIT, database, pending:[]}) + '\\n');
const request = join(dir, 'cleanup-123');
writeFileSync(request, database);
const started = Date.now();
const ack = request + '.ack';
while (!existsSync(ack) && Date.now() - started < ${CLEANUP_WINDOW_MS}) await new Promise(r => setTimeout(r, 20));
const sawAck = existsSync(ack);
const log = existsSync(join(dir, 'runner.jsonl')) ? readFileSync(join(dir, 'runner.jsonl'), 'utf8') : '';
writeFileSync(join(dir, 'timing.json'), JSON.stringify({ sawAck, elapsed: Date.now() - started, snapshotBeforeAck: sawAck && log.includes('"event":"final-snapshot"') }));
`);
    process.env.PATH = `${bin}:${previous.PATH}`;
    const observe = async mode => {
      writeFileSync(count, '0');
      process.env.RECOVERY_OBSERVATION_DIR = mkdtempSync(join(directory, 'out-'));
      process.env.RECOVERY_STATS_MODE = mode;
      const code = await runObservation('slide-report-recovery-123-456', '12345', process.execPath, [child]);
      const output = process.env.RECOVERY_OBSERVATION_DIR;
      const rows = readFileSync(join(output, 'runner.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const timing = JSON.parse(readFileSync(join(output, 'timing.json'), 'utf8'));
      return { code, rows, timing, ack: readFileSync(join(output, 'cleanup-123.ack'), 'utf8') };
    };
    const recovered = await observe('delay-once');
    assert.equal(recovered.code, 0);
    assert.equal(recovered.ack, 'captured');
    assert.equal(recovered.timing.sawAck, true);
    assert.equal(recovered.timing.snapshotBeforeAck, true);
    assert.ok(recovered.timing.elapsed < CLEANUP_WINDOW_MS);
    assert.equal(recovered.rows.find(row => row.event === 'final-snapshot').stats.ok, true);
    assert.equal(recovered.rows.at(-1).recordingFailed, false);
    const persistent = await observe('delay-always');
    assert.equal(persistent.code, 1);
    assert.equal(persistent.ack, 'captured');
    assert.equal(persistent.timing.sawAck, true);
    assert.equal(persistent.timing.snapshotBeforeAck, true);
    assert.ok(persistent.timing.elapsed < CLEANUP_WINDOW_MS, `ack elapsed ${persistent.timing.elapsed}`);
    assert.ok(persistent.timing.elapsed > 3000, `ack elapsed ${persistent.timing.elapsed}`);
    const cleanupSnapshot = persistent.rows.find(row => row.event === 'final-snapshot');
    assert.equal(cleanupSnapshot.stats.ok, false);
    assert.equal(persistent.rows.at(-1).code, 0);
    assert.equal(persistent.rows.at(-1).recordingFailed, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
