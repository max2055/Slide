import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { checkSourcePolicy, inspectDiff, inspectLine } from './check-source-policy.mjs';

const home = ['/', 'Users', '/alice/project/'].join('');
const linuxHome = ['/', 'home', '/alice/project/'].join('');
const windowsHome = ['C:', '\\', 'Users', '\\', 'alice'].join('');

test('rejects added personal paths and focused test declarations without echoing their source', () => {
  for (const value of [home, linuxHome, windowsHome, ['.config', '/slide-test-access'].join('')]) {
    const findings = inspectLine('apps/api/src/check.test.ts', 7, `const path = '${value}';`);
    assert.equal(findings[0]?.rule, 'private-path', value);
    assert.equal(findings[0].line, 7);
    assert.ok(!JSON.stringify(findings).includes(value));
  }
  for (const value of ['test.only(', '  it.only.each(', 'describe.concurrent.only(']) {
    assert.equal(inspectLine('frontend/e2e/check.spec.ts', 1, value)[0]?.rule, 'focused-test');
  }
  for (const value of ['test(', 'describe.skipIf(!enabled)(', '// test.only(', "const example = 'test.only(';", 'const path = process.env.TEST_PATH;']) {
    assert.deepEqual(inspectLine('tests/check.test.ts', 1, value), []);
  }
  assert.deepEqual(inspectLine('docs/guide.md', 1, home), []);
});

test('checks only added lines with current line numbers, including multiple hunks', () => {
  const diff = `--- a/tests/a.ts\n+++ b/tests/a.ts\n@@ -1 +1 @@\n-${home}\n+const ok = true;\n@@ -10,0 +11,2 @@\n+test.only('bad');\n+const path = '${home}';\n`;
  assert.deepEqual(inspectDiff('tests/a.ts', diff).map(({ line, rule }) => [line, rule]), [[11, 'focused-test'], [12, 'private-path']]);
});

test('CLI covers full commit range, renamed and untracked files, and propagates failure', () => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'slide-source-policy-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const script = resolve(import.meta.dirname, 'check-source-policy.mjs');
  try {
    git('init', '-q'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'CI test');
    mkdirSync(resolve(cwd, 'tests'));
    writeFileSync(resolve(cwd, 'tests/old.ts'), `const historical = '${home}';\n`);
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    assert.deepEqual(checkSourcePolicy(base, undefined, cwd), []);
    writeFileSync(resolve(cwd, 'tests/staged.ts'), 'test.only("staged", () => {});\n');
    git('add', 'tests/staged.ts');
    writeFileSync(resolve(cwd, 'tests/old.ts'), `const historical = '${home}';\nit.only("unstaged", () => {});\n`);
    assert.deepEqual(checkSourcePolicy(base, undefined, cwd).map(f => f.path).sort(), ['tests/old.ts', 'tests/staged.ts']);
    writeFileSync(resolve(cwd, 'tests/staged.ts'), 'test("working copy cleaned but index still focused", () => {});\n');
    assert.ok(checkSourcePolicy(base, undefined, cwd).some(f => f.path === 'tests/staged.ts'));
    git('reset', '--hard', base);
    git('mv', 'tests/old.ts', 'tests/new\nname.ts');
    git('commit', '-qam', 'rename');
    assert.equal(checkSourcePolicy(base, 'HEAD', cwd)[0]?.rule, 'private-path');
    writeFileSync(resolve(cwd, 'tests/untracked.ts'), 'it.only("bad", () => {});\n');
    assert.equal(checkSourcePolicy('HEAD', undefined, cwd)[0]?.rule, 'focused-test');
    const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /focused-test/);
    assert.ok(!result.stderr.includes(home));
    rmSync(resolve(cwd, 'tests/untracked.ts'));
    assert.equal(spawnSync(process.execPath, [script], { cwd }).status, 0);
    assert.notEqual(spawnSync(process.execPath, [script, 'missing-ref'], { cwd }).status, 0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
