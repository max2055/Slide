import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
function harness(work) {
  const directory = mkdtempSync(resolve(tmpdir(), 'slide-ci-modes-'));
  const trace = resolve(directory, 'trace');
  writeFileSync(trace, '');
  const stubs = {
    docker: '#!/bin/sh\nprintf "docker %s\\n" "$*" >> "$CI_TRACE"\ncase "$1" in port) echo 127.0.0.1:33306;; inspect) echo \'{"status":"running","running":true,"oomKilled":false,"exitCode":0,"memoryBytes":805306368}\';; rm) exit "${CI_STUB_CLEANUP_EXIT:-0}";; esac\n',
    pnpm: '#!/bin/sh\nprintf "pnpm %s\\n" "$*" >> "$CI_TRACE"\ncase "$*" in *"exec node -e"*|*"exec node --input-type=module -e"*|*"t12-startup.mjs probe "*) exit 0 ;; esac\nexit "${CI_STUB_EXIT:-0}"\n',
  };
  stubs.sleep = '#!/bin/sh\nexit 0\n';
  for (const [name, content] of Object.entries(stubs)) {
    writeFileSync(resolve(directory, name), content); chmodSync(resolve(directory, name), 0o755);
  }
  const run = (script, args, extra = {}) => {
    writeFileSync(trace, '');
    const result = spawnSync('bash', [resolve(root, script), ...args], { cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CI_TRACE: trace,
        T12_OUTPUT_DIR: resolve(directory, 'reports'), GITHUB_ACTIONS: 'false', ...extra } });
    // Runtime qualification creates its own ignored log; remove only this run's file.
    const log = result.stdout?.match(/log=(\.qualification\/runtime\/[^\s]+\.log)/)?.[1];
    if (log) rmSync(resolve(root, log), { force: true });
    return { ...result, trace: readFileSync(trace, 'utf8') };
  };
  try { work(run); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('rollout-only preserves capacity qualification and cleanup without repeating SQL/browser suites', () => harness(run => {
  const result = run('scripts/qualification/run-investigation-rollout.sh', ['--rollout']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /investigation-rollout\.ts/);
  assert.doesNotMatch(result.trace, /vitest|playwright|slide-api test/);
  assert.match(result.trace, /docker stop/);
}));

test('standalone API and integration modes retain their original coverage', () => harness(run => {
  const api = run('scripts/qualification/run-investigation-rollout.sh', ['--api']);
  assert.equal(api.status, 0, api.stderr);
  assert.match(api.trace, /slide-api test --maxWorkers=1/);
  assert.doesNotMatch(api.trace, /investigation-rollout\.ts|playwright/);
  const integration = run('scripts/qualification/run-investigation-rollout.sh', ['--integration']);
  assert.equal(integration.status, 0, integration.stderr);
  assert.match(integration.trace, /investigation-rollout\.ts/);
  assert.match(integration.trace, /vitest run src\/investigations/);
  assert.match(integration.trace, /playwright test --config playwright\.investigation\.config\.ts/);
}));

test('sharded API keeps the largest file in a dedicated self-contained exec leg', () => harness(run => {
  const shard = run('scripts/qualification/run-investigation-rollout.sh', ['--api'], { T12_API_SHARD: '3' });
  assert.equal(shard.status, 0, shard.stderr);
  assert.match(shard.trace, /slide-api test .*--shard=3\/8 --exclude \*\*\/execution-recovery\.mysql\.test\.ts/);
  assert.match(shard.trace, /mysql:9\.6/);
  const exec = run('scripts/qualification/run-investigation-rollout.sh', ['--api'], { T12_API_SHARD: 'exec' });
  assert.equal(exec.status, 0, exec.stderr);
  assert.match(exec.trace, /slide-api test .*src\/investigations\/execution-recovery\.mysql\.test\.ts/);
  assert.doesNotMatch(exec.trace, /--shard=/);
  assert.doesNotMatch(exec.trace, /mysql:9\.6/);
  const invalid = run('scripts/qualification/run-investigation-rollout.sh', ['--api'], { T12_API_SHARD: '9' });
  assert.equal(invalid.status, 64);
  assert.equal(invalid.trace, '');
}));

test('failed rollout propagates failure while still cleaning up its container', () => harness(run => {
  const result = run('scripts/qualification/run-investigation-rollout.sh', ['--rollout'], { CI_STUB_EXIT: '23' });
  assert.notEqual(result.status, 0);
  assert.match(result.trace, /docker stop/);
  assert.doesNotMatch(result.trace, /playwright/);
}));

test('runtime-only retains real runtime qualification while standalone mysql retains SQL suites', () => harness(run => {
  const lean = run('scripts/qualification/run-agent-runtime.sh', ['--mode', 'mysql', '--runtime-only']);
  assert.equal(lean.status, 0, lean.stderr);
  assert.match(lean.trace, /agent-runtime\.ts mysql/);
  assert.doesNotMatch(lean.trace, /vitest/);
  const standalone = run('scripts/qualification/run-agent-runtime.sh', ['--mode', 'mysql']);
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.match(standalone.trace, /agent-tool-approval-execution\.mysql\.test\.ts/);
  assert.match(standalone.trace, /execution-recovery\.mysql\.test\.ts/);
  assert.equal(run('scripts/qualification/run-agent-runtime.sh', ['--runtime-only']).status, 64);
  const failed = run('scripts/qualification/run-agent-runtime.sh', ['--mode', 'mysql', '--runtime-only'], { CI_STUB_EXIT: '23' });
  assert.equal(failed.status, 23);
}));

test('rootless modes retain the disposable-host guard and reject unknown options', () => harness(run => {
  for (const args of [[], ['--runtime-only']]) {
    const result = run('scripts/qualification/run-rootless-sandbox.sh', args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Requires a disposable GitHub-hosted Linux runner/);
    assert.equal(result.trace, '');
  }
  assert.equal(run('scripts/qualification/run-rootless-sandbox.sh', ['--unknown']).status, 64);
}));

// MAX-642: the four schemas still share MigrationRunner's instance-level lock.
test('retention qualification serializes files while retaining every SQL suite', () => harness(run => {
  const result = run('scripts/qualification/run-metric-retention.sh', []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /vitest run --no-file-parallelism/);
  for (const file of ['src/workflows/metric-retention-handler.test.ts', 'src/metrics/storage.mysql.test.ts',
    'src/metrics/rollout/control.mysql.test.ts', 'src/consistency-checker.mysql.test.ts']) {
    assert.ok(result.trace.includes(file), file);
  }
  assert.doesNotMatch(result.trace, /--retry|--testTimeout|--hookTimeout/);
  assert.match(result.trace, /docker rm -f slide-metric-retention-/);
}));

test('retention qualification preserves test failures and fails closed on cleanup errors', () => harness(run => {
  const failed = run('scripts/qualification/run-metric-retention.sh', [], { CI_STUB_EXIT: '23', CI_STUB_CLEANUP_EXIT: '24' });
  assert.equal(failed.status, 23);
  assert.match(failed.stdout, /test_exit=23 cleanup_exit=24/);
  const cleanupFailed = run('scripts/qualification/run-metric-retention.sh', [], { CI_STUB_CLEANUP_EXIT: '24' });
  assert.equal(cleanupFailed.status, 24);
  assert.match(cleanupFailed.stdout, /test_exit=0 cleanup_exit=24/);
}));

// MAX-413: source fixtures share an instance-level migration lock across schemas.
test('source qualification serializes files and retains all source SQL suites', () => harness(run => {
  const result = run('scripts/qualification/run-v23-source.sh', []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /vitest run --no-file-parallelism/);
  for (const file of ['control', 'runtime', 'authorization']) {
    assert.ok(result.trace.includes(`src/operations/source-package/${file}.mysql.test.ts`), file);
  }
  assert.equal((result.trace.match(/pnpm .*exec vitest run/g) ?? []).length, 1);
  assert.doesNotMatch(result.trace, /--retry|--testTimeout|--hookTimeout|--exclude|--testNamePattern/);
  assert.match(result.trace, /docker stop slide-v23-source-ci-/);
}));

test('source qualification propagates test failure and still cleans up its container', () => harness(run => {
  const result = run('scripts/qualification/run-v23-source.sh', [], { CI_STUB_EXIT: '23' });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.trace, /vitest run --no-file-parallelism/);
  assert.match(result.trace, /docker stop slide-v23-source-ci-/);
}));
