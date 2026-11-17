import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTestResource } from '../qualification/test-resource-manifest.mjs';

const fixtureSecret = ['synthetic', 'value'].join('-');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'slide-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  mkdirSync(repository);
  const profilesFile = path.join(root, 'profiles.json');
  const manifestFile = path.join(root, 'manifest.json');
  writeFileSync(profilesFile, JSON.stringify({ fixture: { host: 'localhost', port: 1, user: 'fixture', password: fixtureSecret } }), { mode: 0o600 });
  const manifest = { version: 1, resources: { 'mysql-test': { kind: 'database', owner: 'fixture', profilesFile, profile: 'fixture' } } };
  const save = () => writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  save();
  return { root, repository, profilesFile, manifestFile, manifest, save, options: { enabled: true, resource: 'mysql-test', repository, env: { SLIDE_TEST_RESOURCE_MANIFEST: manifestFile } } };
}

test('default collection never accesses private configuration', () => {
  assert.equal(loadTestResource({ env: new Proxy({}, { get() { throw new Error('private read'); } }) }), undefined);
});

test('explicit acceptance fails closed without injected configuration', () => {
  assert.throws(() => loadTestResource({ enabled: true, env: {} }), /SLIDE_TEST_RESOURCE_MANIFEST_REQUIRED/);
  const result = spawnSync(process.execPath, ['scripts/qualification/test-resource-manifest.mjs', '--real', '--resource', 'mysql-test'], { env: { ...process.env, SLIDE_TEST_RESOURCE_MANIFEST: '' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SLIDE_TEST_RESOURCE_MANIFEST_REQUIRED/);
});

test('only selected resource is read; secret remains in memory', t => {
  const f = fixture(t);
  f.manifest.resources.unselected = { kind: 'vm', passwordFile: 'unreadable' };
  f.save();
  assert.equal(loadTestResource(f.options).connection.password, fixtureSecret);
  assert.throws(() => loadTestResource({ ...f.options, resource: 'constructor' }), /RESOURCE_NOT_CONFIGURED/);
});

test('private files must be outside checkout, owned and restricted', t => {
  const f = fixture(t);
  chmodSync(f.profilesFile, 0o644);
  assert.throws(() => loadTestResource(f.options), /RESOURCE_FILE_UNSAFE_OR_UNREADABLE/);
  chmodSync(f.profilesFile, 0o600);
  const inside = path.join(f.repository, 'profiles.json');
  writeFileSync(inside, '{}', { mode: 0o600 });
  f.manifest.resources['mysql-test'].profilesFile = inside;
  f.save();
  assert.throws(() => loadTestResource(f.options), /RESOURCE_FILE_UNSAFE_OR_UNREADABLE/);
});

test('symlinks and malformed files fail without echoing contents or paths', t => {
  const f = fixture(t);
  const link = path.join(f.root, 'link');
  symlinkSync(f.profilesFile, link);
  f.manifest.resources['mysql-test'].profilesFile = link;
  f.save();
  assert.throws(() => loadTestResource(f.options), /RESOURCE_FILE_UNSAFE_OR_UNREADABLE/);
  writeFileSync(f.manifestFile, 'sensitive invalid JSON');
  assert.throws(() => loadTestResource(f.options), error => error.message === 'RESOURCE_MANIFEST_INVALID');
});

test('VM and model references use same private-file checks', t => {
  const f = fixture(t);
  const secret = path.join(f.root, 'secret');
  writeFileSync(secret, fixtureSecret, { mode: 0o600 });
  f.manifest.resources.vm = { kind: 'vm', owner: 'fixture', host: 'localhost', port: 22, user: 'fixture', passwordFile: secret };
  f.manifest.resources.model = { kind: 'model', owner: 'fixture', envFile: secret, budgetLedger: secret };
  f.save();
  assert.equal(loadTestResource({ ...f.options, resource: 'vm' }).password, fixtureSecret);
  assert.equal(loadTestResource({ ...f.options, resource: 'model' }).kind, 'model');
  chmodSync(secret, 0o644);
  assert.throws(() => loadTestResource({ ...f.options, resource: 'model' }), /RESOURCE_FILE_UNSAFE_OR_UNREADABLE/);
});
