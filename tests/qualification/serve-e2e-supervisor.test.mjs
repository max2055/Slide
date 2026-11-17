import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('serve-e2e stops its service tree and stays in the launcher group (#460)', async () => {
  // Own an isolated harness group so a failed fixture cannot retain our pipes
  // or leave service children to the Actions orphan sweep (MAX-6 gate recovery).
  const collectionErrors = [];
  let evidenceDir;
  try {
    const base = resolve(root, process.env.SUPERVISOR_EVIDENCE_DIR ?? '.qualification/supervisor');
    mkdirSync(base, { recursive: true });
    evidenceDir = mkdtempSync(join(base, 'run-'));
  } catch (error) { collectionErrors.push(error.code); }
  const child = spawn('bash', ['scripts/qualification/serve-e2e.supervisor.test.sh'], {
    cwd: root,
    env: { ...process.env, SERVE_E2E_EVIDENCE_DIR: evidenceDir ?? '' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = { stdout: '', stderr: '', status: null, signal: null, error: null, timedOut: false };
  child.stdout.setEncoding('utf8').on('data', chunk => { result.stdout = (result.stdout + chunk).slice(0, 512 * 1024); });
  child.stderr.setEncoding('utf8').on('data', chunk => { result.stderr = (result.stderr + chunk).slice(0, 128 * 1024); });
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
  // Write before assertions so a failed child or an assertion failure retains its first error.
  try {
    if (evidenceDir) {
      writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify({ ...result, collectionErrors }, null, 2));
    }
  } catch (error) { collectionErrors.push(error.code); }
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
  assert.doesNotMatch(result.stderr, /EVIDENCE_ERROR/);
  assert.deepEqual(collectionErrors, [], 'supervisor evidence collection failed');
  // Passing runs need no artifact; failing runs retain the bounded result and shell reports.
  if (evidenceDir) rmSync(evidenceDir, { recursive: true, force: true });
});
