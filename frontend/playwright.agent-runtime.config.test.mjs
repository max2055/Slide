import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

// Load both real configs without launching their managed services or a browser.
async function config(env) {
  const context = vm.createContext({ process: { env }, URL });
  const modules = new Map();
  const dependency = (id, values) => {
    if (!modules.has(id)) modules.set(id, new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context }));
    return modules.get(id);
  };
  async function load(name) {
    const url = new URL(name, import.meta.url);
    const module = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, 'utf8')), {
      context, initializeImportMeta(meta) { meta.url = url.href; },
    });
    await module.link(id => {
      if (id === './playwright.config') return load('./playwright.config.ts');
      if (id === '@playwright/test') return dependency(id, { defineConfig: value => value, devices: { 'Desktop Chrome': { browserName: 'chromium' } } });
      return dependency(id, { 'node:crypto': crypto, 'node:os': os, 'node:path': path }[id]);
    });
    return module;
  }
  const module = await load('./playwright.agent-runtime.config.ts');
  await module.evaluate();
  return module.namespace.default;
}

test('direct managed entry supplies stable claim identity and preserves server budgets', async () => {
  const env = { PLAYWRIGHT_MANAGED_ENV: '1', NODE_OPTIONS: '--enable-source-maps' };
  const first = await config(env), worker = await config(env);
  assert.match(env.RUNTIME_CLAIM_NONCE, /^[a-f0-9-]{36}$/);
  assert.equal(first.webServer.env.RUNTIME_CLAIM_NONCE, worker.webServer.env.RUNTIME_CLAIM_NONCE);
  assert.equal(first.webServer.env.RUNTIME_CLAIM_COORDINATE, worker.webServer.env.RUNTIME_CLAIM_COORDINATE);
  assert.ok(path.isAbsolute(env.RUNTIME_CLAIM_COORDINATE));
  assert.equal(first.webServer.command, 'bash ../scripts/qualification/serve-e2e.sh');
  assert.equal(first.webServer.timeout, 180_000);
  assert.equal(first.webServer.reuseExistingServer, false);
  assert.equal(first.timeout, 30_000);
  assert.equal(first.use.trace, 'off');
  assert.match(first.webServer.env.NODE_OPTIONS, /^--enable-source-maps --import=file:.*runtime-claim-preload\.mjs$/);
  assert.equal(env.NODE_OPTIONS, '--enable-source-maps');
});

test('explicit launcher identity is retained without changing unmanaged service ownership', async () => {
  const env = { RUNTIME_CLAIM_NONCE: crypto.randomUUID(), RUNTIME_CLAIM_COORDINATE: '/synthetic-fixture/coordinate.json' };
  const before = { ...env }, value = await config(env);
  assert.deepEqual(env, before);
  assert.equal(value.webServer, undefined);
  assert.equal(value.use.trace, 'off');
});
