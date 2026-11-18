import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { inspectKnownValues, inspectSecrets, scanRepository } from './check-secrets.mjs';

// Construct synthetic probes at runtime; no usable credential is stored here.
const api = ['sk-', 'Z'.repeat(32)].join('');
const jwt = ['eyJ' + 'A'.repeat(12), 'B'.repeat(24), 'C'.repeat(32)].join('.');

test('scans a short reused value in assignments, fixtures and comments without emitting it', () => {
  const value = ['Qa', 'Text', '07'].join('');
  const source = `QUALIFICATION_ADMIN_PASSWORD: ${value}\nfill('${value}')\n-- fixture: ${value}`;
  assert.deepEqual(inspectSecrets('fixture', source), []);
  const findings = inspectKnownValues('fixture', source, [value, value]);
  assert.deepEqual(findings, [1, 2, 3].map(line => ({ path: 'fixture', line, rule: 'known-value' })));
  assert.ok(!JSON.stringify(findings).includes(value));
  assert.throws(() => inspectKnownValues('fixture', source, ['']), /INVALID_KNOWN_VALUES/);
});

test('scans documentation, YAML, JSON, samples and tests with no directory exemptions', () => {
  for (const file of ['AGENTS.md', 'docs/guide.md', '.github/workflows/test.yml', '.env.example', 'settings.json', 'src/fixture.test.ts']) {
    assert.ok(inspectSecrets(file, api).some(f => f.rule === 'api-key'));
  }
});

test('adversarial fields, encoding, multiline keys, JWTs and credential URLs', () => {
  for (const field of ['API_KEY', 'api-key', 'apiKey', 'clientSecret', 'access_token', 'JWT_SECRET_KEY', 'Password']) {
    assert.ok(inspectSecrets('probe', `"${field}":\n "${'x'.repeat(32)}"`).some(f => f.rule === 'credential-field'), field);
  }
  assert.ok(inspectSecrets('probe', jwt).some(f => f.rule === 'jwt'));
  assert.ok(inspectSecrets('probe', ['-----BEGIN', ' RSA PRIVATE KEY-----'].join('\n')).some(f => f.rule === 'private-key'));
  assert.ok(inspectSecrets('probe', 'mysql://fixture:' + 'x'.repeat(16) + '@localhost/db').some(f => f.rule === 'credential-url'));
  assert.ok(inspectSecrets('probe', 'Bearer\n' + 'x'.repeat(32)).some(f => f.rule === 'bearer'));
  assert.ok(inspectSecrets('probe', 'API_KEY=' + 'x'.repeat(32)).some(f => f.rule === 'credential-field-unquoted'));
  assert.ok(inspectSecrets('probe', 'client_secret: |\n  ' + 'x'.repeat(32)).some(f => f.rule === 'credential-field-multiline'));
  const encoded = [...api].map(c => '%' + c.charCodeAt(0).toString(16)).join('');
  assert.equal(inspectSecrets('probe', 'intro\n' + encoded)[0].line, 2);
  assert.ok(!JSON.stringify(inspectSecrets('probe', api)).includes(api));
});

test('incremental comparison blocks copied, changed and additional occurrences', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'slide-secret-scan-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(cwd, 'old.md'), api);
  git('add', '.'); git('commit', '-qm', 'synthetic baseline');
  assert.equal(scanRepository({ cwd, base: 'HEAD' }).findings.length, 0);
  writeFileSync(path.join(cwd, 'old.md'), api + '\n' + api);
  mkdirSync(path.join(cwd, 'tests'));
  writeFileSync(path.join(cwd, 'tests', 'fixture.json'), JSON.stringify({ example: api }));
  assert.equal(scanRepository({ cwd, base: 'HEAD' }).findings.filter(f => f.rule === 'api-key').length, 2);
  git('add', '.'); git('commit', '-qm', 'synthetic new risks');
  assert.equal(scanRepository({ cwd, base: 'HEAD^', head: 'HEAD' }).findings.filter(f => f.rule === 'api-key').length, 2);
});

test('known-value CLI reports inherited matches and fails without exposing values', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'slide-known-value-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const value = ['Fixture', '07'].join('');
  git('init', '-q');
  writeFileSync(path.join(cwd, 'default.sql'), `-- Seed: ${value}`);
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic baseline');
  const cli = path.resolve('scripts/ci/check-secrets.mjs');
  const result = spawnSync(process.execPath, [cli, '--known-values-stdin', '--base', 'HEAD', '--head', 'HEAD'], {
    cwd, input: JSON.stringify([value]), encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings, [{ path: 'default.sql', line: 1, rule: 'known-value' }]);
  assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value));
});

test('invalid refs fail closed and never print source or native errors', () => {
  const result = spawnSync(process.execPath, ['scripts/ci/check-secrets.mjs', '--base', 'missing-ref'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^SECRET_SCAN_FAILED:/);
  assert.ok(!result.stderr.includes(api));
});

test('required Bash injection is an expression; defaults and single quotes remain audited', () => {
  const reference = '${QUALIFICATION_MYSQL_PASSWORD:?must be injected}';
  const field = ['pass', 'word'].join('');
  assert.equal(inspectSecrets('entry.sh', `${field}="${reference}"`).length, 0);
  assert.ok(inspectSecrets('entry.sh', `${field}='${reference}'`).length > 0);
  assert.ok(inspectSecrets('entry.sh', field + '="${DB_PASSWORD:-public-fixture-default}"').length > 0);
  assert.ok(inspectSecrets('entry.sh', `${field}="prefix-${reference}"`).length > 0);
  assert.ok(inspectSecrets('entry.sh', `${field}="${api}"`).some(f => f.rule === 'api-key'));
});

// MAX-681 Reviewer R1/R2: exercise the shipped CLI, not just internal patterns.
test('R1/R2 CLI blocks literals and suffix changes in worktree and commit modes', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'slide-secret-cli-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--allow-empty', '-qm', 'empty');
  const cli = path.resolve('scripts/ci/check-secrets.mjs');
  const field = ['pass', 'word'].join('');
  const ref = '${SYNTHETIC_PARAMETER}';
  const cases = [
    ['early apostrophe', `"${"isn't-a-usable-secret-fixture"}"`],
    ['inverse quotes', `'${'is"not-a-usable-secret-fixture'}'`],
    ['escaped double', JSON.stringify('short"synthetic-secret-fixture')],
    ['escaped single', "'short\\'synthetic-secret-fixture'"],
    ['ordinary control', '"ordinary-synthetic-fixture"'],
    ['mixed literal', `'${ref}"'`],
    ['single literal', `'${ref}'`],
    ['quoted heredoc', `"${ref}"`, "cat <<'CONFIG'\n", '\nCONFIG'],
    ['escaped heredoc', `"${ref}"`, 'cat <<\\CONFIG\n', '\nCONFIG'],
    ['outer quote', `"${ref}"`, "text='\n", "\n'"],
    ['unknown context', `"${ref}"`, 'some_command\n'],
    ['required injection', '"${SYNTHETIC_PARAMETER:?required}"', '', '', 0],
    ['pure injection', `"${ref}"`, '#!/bin/bash\n', '', 0],
    ['default remains audited', '"${SYNTHETIC_PARAMETER:-fixture-default}"'],
    ['trailing literal', `"${ref}"'suffix'`],
  ];
  for (const [name, value, prefix = '', suffix = '', expected = 1] of cases) {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(path.join(cwd, 'probe.sh'), prefix + field + '=' + value + suffix + '\n');
    const run = args => {
      const result = spawnSync(process.execPath, [cli, '--base', base, ...args], { cwd, encoding: 'utf8' });
      assert.equal(result.status, expected, name + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.findings.length > 0, expected === 1, name);
      assert.ok(!result.stdout.includes(value), 'no source disclosure');
    };
    run([]);
    git('add', '.'); git('commit', '-qm', name);
    run(['--head', 'HEAD']);
    // Remove each probe so the next scenario is an actual addition.
    git('rm', 'probe.sh'); git('commit', '-qm', 'remove probe');
  }
  for (const quote of ['"', "'"]) {
    for (const middle of [quote === '"' ? "'" : '"', '\\' + quote]) {
      writeFileSync(path.join(cwd, 'probe.env'), field + '=' + quote + 'long-synthetic-prefix' + middle + 'old-suffix' + quote);
      git('add', '.'); git('commit', '-qm', 'suffix baseline');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(path.join(cwd, 'probe.env'), field + '=' + quote + 'long-synthetic-prefix' + middle + 'new-suffix' + quote);
      const check = args => {
        const result = spawnSync(process.execPath, [cli, '--base', base, ...args], { cwd, encoding: 'utf8' });
        assert.equal(result.status, 1, 'suffix change');
        assert.ok(JSON.parse(result.stdout).findings.length > 0);
      };
      check([]);
      git('add', '.'); git('commit', '-qm', 'suffix changed');
      check(['--head', 'HEAD']);
    }
  }
});
