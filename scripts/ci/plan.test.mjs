import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { planChecks, requiredJobs, selections, validateResults } from './plan.mjs';

const selected = plan => Object.keys(plan).filter(key => plan[key]).sort();
const full = [...selections].sort();

test('main, nightly and manual candidates retain every qualification', () => {
  for (const event of ['push', 'schedule', 'workflow_dispatch', 'merge_group']) {
    assert.deepEqual(selected(planChecks(event, ['docs/readme.md'])), full);
  }
});

test('documentation keeps basic checks without heavy qualification', () => {
  const plan = planChecks('pull_request', ['docs/guide.md', 'README.md', 'AGENTS.md']);
  assert.deepEqual(selected(plan), []);
  assert.equal(requiredJobs(plan).backend, true);
  assert.equal(requiredJobs(plan).security, true);
});

test('UI changes retain real browser, permissions and SQL-backed acceptance', () => {
  for (const path of ['frontend/src/app/ui/views/instances.ts', 'frontend/e2e/fixtures/server.ts', 'frontend/src/app/styles/layout.css']) {
    assert.deepEqual(selected(planChecks('pull_request', [path])), ['browser', 'integration']);
  }
});

test('ordinary API changes retain the full SQL candidate and recovery', () => {
  assert.deepEqual(selected(planChecks('pull_request', ['apps/db-ops-api/src/metrics-v2/storage.ts'])), ['api', 'browser', 'integration', 'recovery']);
});

test('cross-cutting, unknown, deleted and mixed paths require the full candidate', () => {
  for (const path of ['.github/workflows/ci.yml', 'scripts/ci/plan.mjs', 'tests/qualification/startup-readiness.test.ts',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.nvmrc', 'compose.production.yaml', 'deploy/Dockerfile',
    'frontend/vite.config.ts', 'frontend/playwright.audit.config.ts', 'frontend/package.json',
    'packages/agent-core/src/loop.ts', 'apps/sandbox-controller/src/server.ts', 'apps/db-ops-api/server.ts',
    'apps/db-ops-api/sql/migrations/123.sql', 'apps/db-ops-api/src/auth/permissions.ts',
    'apps/db-ops-api/src/security/policy.ts', 'apps/db-ops-api/src/investigations/store.ts',
    'apps/db-ops-api/src/sql-executor.security.test.ts', 'frontend/src/app/ui/views/permissions.ts',
    'apps/db-ops-api/src/adapter/direct-adapter.ts', 'apps/db-ops-api/src/lifecycle/worker-startup.ts',
    'apps/db-ops-api/src/contracts/public-api.ts', 'apps/db-ops-api/src/db-connection.ts', 'new-module/code.ts']) {
    assert.deepEqual(selected(planChecks('pull_request', ['docs/guide.md', 'frontend/src/app.ts', path])), full, path);
  }
  assert.deepEqual(selected(planChecks('pull_request', [])), full);
});

function results(plan) {
  return { plan: { result: 'success' }, ...Object.fromEntries(Object.entries(requiredJobs(plan)).map(([name, wanted]) => [name, { result: wanted ? 'success' : 'skipped' }])), 'release-artifact': { result: 'success' } };
}

test('the gate accepts only intentional skips and successful selected checks', () => {
  for (const plan of [planChecks('push'), planChecks('pull_request', ['docs/guide.md']), planChecks('pull_request', ['frontend/src/app.ts'])]) {
    const needs = results(plan);
    assert.doesNotThrow(() => validateResults(plan, needs));
    for (const name of Object.keys(needs)) {
      for (const status of ['failure', 'cancelled', 'skipped', 'success', undefined]) {
        if (status === needs[name].result) continue;
        assert.throws(() => validateResults(plan, { ...needs, [name]: status ? { result: status } : undefined }), undefined, `${name}: ${status}`);
      }
    }
  }
});

test('invalid or inconsistent selection cannot approve a candidate', () => {
  assert.throws(() => requiredJobs({}));
  const plan = planChecks('pull_request', ['docs/guide.md']);
  assert.throws(() => requiredJobs({ ...plan, api: 'true' }));
  assert.throws(() => requiredJobs({ ...plan, rollout: true }));
  assert.throws(() => requiredJobs({ ...plan, integration: true }));
});

test('release precheck validates every check before a package is built', () => {
  const plan = planChecks('push'), needs = results(plan);
  delete needs['release-artifact'];
  assert.doesNotThrow(() => validateResults(plan, needs, false));
  assert.throws(() => validateResults(plan, needs));
  needs['investigation-api-qualification'].result = 'failure';
  assert.throws(() => validateResults(plan, needs, false));
});

test('CLI handles deletion, renaming and filenames containing newlines using the full PR range', () => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'slide-ci-plan-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'CI test');
    writeFileSync(resolve(cwd, 'old-code.ts'), 'code'); git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    git('mv', 'old-code.ts', 'README.md'); writeFileSync(resolve(cwd, 'new\ncode.ts'), 'code');
    git('add', '.'); git('commit', '-qm', 'head');
    const event = resolve(cwd, 'event.json'), output = resolve(cwd, 'output');
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: git('rev-parse', 'HEAD') } } }));
    execFileSync(process.execPath, [resolve('scripts/ci/plan.mjs')], { cwd, env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' } });
    assert.match(readFileSync(output, 'utf8'), /rollout=true/);
    writeFileSync(event, JSON.stringify({ pull_request: {} }));
    assert.throws(() => execFileSync(process.execPath, [resolve('scripts/ci/plan.mjs')], { cwd, env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: '' }, stdio: 'pipe' }));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
