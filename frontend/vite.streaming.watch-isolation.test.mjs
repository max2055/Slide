import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, loadConfigFromFile, mergeConfig } from 'vite';
import { chromium } from '@playwright/test';
import { after, test } from 'node:test';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const streamingConfig = path.join(frontendRoot, 'vite.streaming.config.ts');
const devConfig = path.join(frontendRoot, 'vite.config.js');
const pagePath = '/e2e/fixtures/max285-watch-isolation.html';
const sourceFile = path.join(frontendRoot, 'e2e/fixtures/max285-watch-isolation.js');
const evidenceFile = path.join(frontendRoot, 'test-results-streaming/max285-evidence-probe.txt');
const originalSource = 'export const marker = \'isolation\';\n';
const configEnv = { command: 'serve', mode: 'development' };

test('mergeConfig still skips watch:null, exported streaming config does not', async () => {
  const skipped = mergeConfig(
    { server: { watch: { ignored: ['**/kept/**'] }, port: 1 } },
    { server: { hmr: false, watch: null } },
  );
  assert.deepEqual(skipped.server.watch, { ignored: ['**/kept/**'] });
  assert.equal(skipped.server.hmr, false);

  const streaming = await loadConfigFromFile(configEnv, streamingConfig, frontendRoot);
  const dev = await loadConfigFromFile(configEnv, devConfig, frontendRoot);
  assert.ok(streaming?.config.server);
  assert.equal(streaming.config.server.watch, null);
  assert.equal(streaming.config.server.hmr, false);
  assert.deepEqual(dev?.config.server?.watch, {
    ignored: ['**/test-results*/**', '**/playwright-report/**'],
  });
  assert.notEqual(dev?.config.server?.hmr, false);
  assert.equal(dev?.config.server?.port, 5173);

  const playwrightStreaming = (await import('./playwright.streaming.config.ts')).default;
  const playwrightLive = (await import('./playwright.streaming-live.config.ts')).default;
  for (const config of [playwrightStreaming, playwrightLive]) {
    assert.match(config.webServer.command, /--config vite\.streaming\.config\.ts/);
    assert.equal(config.webServer.reuseExistingServer, false);
  }
  assert.match(playwrightStreaming.webServer.command, /--port 5198/);
  assert.match(playwrightLive.webServer.command, /--port 5199/);
});

test('streaming page ignores source and evidence writes; dev config still reloads', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const streaming = await openPage(browser, streamingConfig);
    try {
      assert.equal(streaming.server.config.server.watch, null);
      assert.equal(streaming.server.config.server.hmr, false);
      assert.equal(streaming.server.watcher.constructor.name, 'NoopWatcher');
      assert.equal(await loads(streaming.page), '1');
      await writeFile(sourceFile, `${originalSource}// probe ${Date.now()}\n`);
      await mkdir(path.dirname(evidenceFile), { recursive: true });
      await writeFile(evidenceFile, `evidence ${Date.now()}\n`);
      await delay(2500);
      assert.equal(await loads(streaming.page), '1');
      assert.equal(await fullReloads(streaming.page), 0);
    } finally {
      await streaming.server.close();
      await streaming.page.context().close();
    }

    await writeFile(sourceFile, originalSource);
    const dev = await openPage(browser, devConfig);
    try {
      assert.notEqual(dev.server.config.server.watch, null);
      assert.notEqual(dev.server.config.server.hmr, false);
      assert.notEqual(dev.server.watcher.constructor.name, 'NoopWatcher');
      const ignored = dev.server.config.server.watch?.ignored;
      assert.ok(Array.isArray(ignored));
      assert.ok(ignored.some((item) => String(item).includes('test-results')));
      await waitForWatcher(dev.server);
      await writeFile(sourceFile, `${originalSource}// dev probe ${Date.now()}\n`);
      assert.equal(await waitForLoads(dev.page, '2', 8000), '2');
    } finally {
      await dev.server.close();
      await dev.page.context().close();
    }
  } finally {
    await browser.close();
    await writeFile(sourceFile, originalSource);
    await rm(evidenceFile, { force: true });
  }
});

after(async () => {
  assert.equal(await readFile(sourceFile, 'utf8'), originalSource);
});

async function openPage(browser, configFile) {
  const port = await freePort();
  const server = await createServer({
    configFile,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    throw error;
  }
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    await server.close();
    throw new Error('vite port missing');
  }
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        socket.addEventListener('message', (event) => {
          if (String(event.data).includes('full-reload')) {
            window.__fullReloads = (window.__fullReloads || 0) + 1;
          }
        });
        return socket;
      },
    });
  });
  await page.goto(`http://127.0.0.1:${address.port}${pagePath}`);
  await page.waitForFunction(() => document.documentElement.dataset.loads === '1');
  return { server, page };
}

function loads(page) {
  return page.evaluate(() => document.documentElement.dataset.loads);
}

function fullReloads(page) {
  return page.evaluate(() => window.__fullReloads || 0);
}

async function waitForLoads(page, expected, timeoutMs) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeoutMs) {
    value = await loads(page);
    if (value === expected) return value;
    await delay(100);
  }
  return value;
}

function waitForWatcher(server) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(undefined);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('dev watcher ready timeout'));
    }, 20000);
    server.watcher.once('ready', done);
    const watched = server.watcher.getWatched?.() ?? {};
    if (Object.values(watched).some((entries) => entries.length > 0)) done();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('free port missing'));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
    probe.on('error', reject);
  });
}
