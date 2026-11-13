import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { inspectSecrets, scanRepository } from './check-secrets.mjs';

// Construct synthetic probes at runtime; no usable credential is stored here.
const api = ['sk-', 'Z'.repeat(32)].join('');
const jwt = ['eyJ' + 'A'.repeat(12), 'B'.repeat(24), 'C'.repeat(32)].join('.');

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

test('invalid refs fail closed and never print source or native errors', () => {
  const result = spawnSync(process.execPath, ['scripts/ci/check-secrets.mjs', '--base', 'missing-ref'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^SECRET_SCAN_FAILED:/);
  assert.ok(!result.stderr.includes(api));
});
