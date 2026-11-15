import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('serve-e2e stops its service tree and stays in the launcher group (#460)', async () => {
  // Own an isolated harness group so a failed fixture cannot retain our pipes
  // or leave service children to the Actions orphan sweep (MAX-6 gate recovery).
  const child = spawn('bash', ['scripts/qualification/serve-e2e.supervisor.test.sh'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = { stdout: '', stderr: '', status: null, signal: null, error: null, timedOut: false };
  child.stdout.setEncoding('utf8').on('data', chunk => { result.stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { result.stderr += chunk; });
  const timer = setTimeout(() => {
    result.timedOut = true;
    // This group was created by this spawn; never target the runner's group.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') result.error = error; }
  }, 120_000);
  try {
    await new Promise(resolve => {
      child.once('error', error => { result.error = error; resolve(); });
      child.once('close', (status, signal) => { result.status = status; result.signal = signal; resolve(); });
    });
  } finally {
    clearTimeout(timer);
    // Also stop run-owned watchdog sleepers that do not inherit our pipes.
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') result.error = error; }
    }
  }
  assert.equal(result.status, 0,
    `timedOut=${result.timedOut} signal=${result.signal} error=${result.error?.code ?? 'none'}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.error, null);
  assert.doesNotMatch(result.stdout, /FAIL |watchdog instead/);
  assert.match(result.stdout, /PASS api-exit/);
  assert.match(result.stdout, /PASS vite-exit/);
  assert.match(result.stdout, /PASS signal-term/);
  assert.match(result.stdout, /PASS signal-int/);
  assert.match(result.stdout, /PASS signal-during-collect/);
  assert.match(result.stdout, /PASS signal-int-during-collect/);
  // MAX-590 D1: withdrawn optional diagnostics cannot break startup or cleanup.
  for (const scenario of ['missing', 'unwritable', 'directory', 'invalidated']) {
    assert.match(result.stdout, new RegExp(`PASS diagnostics-${scenario}`));
  }
  assert.match(result.stdout, /PASS unrelated-orphan/);
  assert.match(result.stdout, /unrelated_orphan_after=alive/);
  assert.match(result.stdout, /PASS relative-fork-gap/);
  assert.match(result.stdout, /PASS fork-gap/);
  assert.match(result.stdout, /service_exit=7/);
  assert.match(result.stdout, /orphan_before_owner=tracked/);
  assert.match(result.stdout, /PASS node-gap/);
  assert.match(result.stdout, /service_exit=3/);
  assert.match(result.stdout, /PASS playwright-sigkill/);
});
