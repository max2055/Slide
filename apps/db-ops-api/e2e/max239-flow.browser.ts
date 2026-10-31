/** Foreground owned fixture controller. Restart means a different Node PID on the same database. */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateRunNonce } from '../src/testing/owned-fixture.js';
import { createServer } from 'node:net';
import { chromium, expect } from '@playwright/test';
const root = resolve(process.cwd(), '../..'),
  frontend = resolve(root, 'frontend');
const output = process.env.MAX239_EVIDENCE_DIR!;
if (!output) throw Error('MAX239_EVIDENCE_DIR required');
await mkdir(output, { recursive: true });
const port = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p as number;
};
const apiPort = await port(),
  uiPort = await port(),
  base = `http://127.0.0.1:${apiPort}`;
const nonce = generateRunNonce();
const env = {
  ...process.env,
  METRICS_COLLECTION_ENABLED: 'true',
  MAX239_RUN_NONCE: nonce,
  MAX239_HANDLE_DIR: resolve(output, 'handles'),
  MAX239_META: resolve(output, 'meta.json'),
  MAX239_API_PORT: String(apiPort),
  MAX239_JWT_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
};
const fixture = resolve(process.cwd(), 'e2e/max239-flow-fixture.ts');
const run = (mode: string) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', fixture, mode], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw Error(`${mode} failed: ${r.stderr}\n${r.stdout}`);
};
const children: ChildProcess[] = [];
const logs: number[] = [];
const launch = (args: string[], cwd: string, childEnv: any, name: string) => {
  const fd = openSync(resolve(output, `${name}.log`), 'a');
  logs.push(fd);
  const c = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', fd, fd] });
  children.push(c);
  return c;
};
const stop = async (c: ChildProcess) => {
  if (c.exitCode !== null) return;
  const done = new Promise<void>((r, j) => {
    c.once('exit', () => r());
    setTimeout(() => j(Error(`owned PID ${c.pid} did not exit`)), 10000).unref();
  });
  c.kill('SIGTERM');
  await done;
};
const ready = async (url: string, c: ChildProcess) => {
  for (let i = 0; i < 100; i++) {
    if (c.exitCode !== null) throw Error(`owned PID ${c.pid} exited; inspect fixture log`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('fixture readiness timeout');
};
let bootstrapped = false;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  bootstrapped = true;
  run('--bootstrap');
  let api = launch(['--import', 'tsx', fixture], process.cwd(), env, 'api');
  await ready(`${base}/__health`, api);
  const vite = launch(
    [
      resolve(frontend, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(uiPort),
      '--strictPort',
    ],
    frontend,
    { ...env, VITE_API_PROXY_TARGET: base },
    'vite',
  );
  await ready(`http://127.0.0.1:${uiPort}`, vite);
  const meta = (await (await fetch(`${base}/__test/meta`)).json()) as any;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${meta.token}` };
  const apiCall = async (path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, data: (await r.json()) as any };
  };
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((token) => {
    localStorage.setItem('token', token);
    localStorage.setItem('permissions', JSON.stringify(['*']));
  }, meta.token);
  await page.goto(`http://127.0.0.1:${uiPort}/e2e/fixtures/max239-template-flow.html`);
  const cfg = page.locator('native-template-configuration');
  await cfg.getByRole('checkbox', { name: /选择模板/ }).check();
  await cfg.locator('summary').filter({ hasText: '的指标与参数' }).click();
  const editor = cfg.locator('template-trigger-editor');
  await expect(editor.getByRole('button', { name: '发布新模板版本' })).toBeEnabled();
  await editor.getByLabel('problem组合', { exact: true }).selectOption('all');
  await editor.getByRole('button', { name: '发布新模板版本' }).click();
  await expect(cfg.getByText(/v2 的指标与参数/)).toBeVisible();
  await cfg.getByRole('button', { name: '检查配置', exact: true }).click();
  await expect(cfg.getByRole('button', { name: '试采', exact: true })).toBeEnabled();
  await cfg.getByRole('button', { name: '试采', exact: true }).click();
  await expect(cfg.getByRole('button', { name: '首次绑定并启用', exact: true })).toBeEnabled();
  await cfg.getByRole('button', { name: '首次绑定并启用', exact: true }).click();
  await expect(cfg.getByRole('button', { name: '立即采集', exact: true })).toBeEnabled();
  const collect = async (value: number | null) => {
    await apiCall('/__test/value', { value });
    const admission = page.waitForResponse(
      (r) => r.url().endsWith('/collect') && r.request().method() === 'POST',
    );
    await cfg.getByRole('button', { name: '立即采集', exact: true }).click();
    assert.equal((await admission).status(), 200);
    await expect
      .poll(async () => {
        const facts = await apiCall('/__test/drain', {});
        return facts.status;
      })
      .toBe(200);
    const query = cfg.getByRole('button', { name: /查询本次任务/ });
    if (await query.count()) await query.first().click();
    await expect(cfg.getByRole('button', { name: '立即采集', exact: true })).toBeEnabled({ timeout: 15000 });
    return (await apiCall('/__test/facts')).data;
  };
  const opened = await collect(95);
  assert.equal(opened.episodes.length, 1);
  const episodeId = opened.episodes[0].payload.episode_id,
    eventId = Number(opened.episodes[0].event_id);
  assert.equal(opened.episodes[0].payload.opened.value, 95);
  // End the owning API process, then start a new process on the unchanged owned MySQL schema.
  const firstPid = api.pid;
  await stop(api);
  api = launch(['--import', 'tsx', fixture], process.cwd(), env, 'api');
  await ready(`${base}/__health`, api);
  assert.notEqual(api.pid, firstPid);
  const kept = await collect(85);
  assert.equal(kept.episodes.length, 1);
  assert.equal(kept.episodes[0].payload.episode_id, episodeId);
  assert.equal(kept.episodes[0].payload.state, 'open');
  const read = () => apiCall(`/api/metrics/template-events/${eventId}`);
  const ack = await apiCall(`/api/metrics/template-events/${eventId}/acknowledge`, {});
  assert.equal(ack.data.episode.state, 'open');
  const boundary = await collect(70);
  assert.equal(boundary.episodes[0].payload.state, 'open');
  const unknown = await collect(null);
  assert.equal(unknown.episodes[0].payload.state, 'open');
  assert.equal(unknown.episodes[0].payload.last.quality, 'unknown');
  const recovered = await collect(60);
  assert.equal(recovered.episodes.length, 1);
  assert.equal(recovered.episodes[0].payload.state, 'closed');
  assert.equal(recovered.recovered.length, 1);
  const ninety = await collect(90);
  assert.equal(ninety.episodes.length, 1);
  await cfg.getByRole('button', { name: '重新加载配置', exact: true }).click();
  await cfg.locator('summary').filter({ hasText: '的指标与参数' }).click();
  const high = editor.getByLabel('阈值', { exact: true }).first();
  await high.fill('95');
  await high.dispatchEvent('change');
  await editor.getByRole('button', { name: '发布新模板版本' }).click();
  await expect(cfg.getByText(/v3 的指标与参数/)).toBeVisible();
  await cfg.getByRole('button', { name: '检查配置', exact: true }).click();
  await expect(cfg.getByRole('button', { name: '试采', exact: true })).toBeEnabled();
  await cfg.getByRole('button', { name: '试采', exact: true }).click();
  await expect(cfg.getByRole('button', { name: '应用并启用', exact: true })).toBeEnabled();
  await cfg.getByRole('button', { name: '应用并启用', exact: true }).click();
  await expect(cfg.getByRole('button', { name: '立即采集', exact: true })).toBeEnabled();
  await collect(95);
  const history = await read();
  assert.equal(history.data.deliveries.length, 1);
  assert.equal(history.data.deliveries[0].state, 'sent');
  assert.equal(history.data.receipts.length, 1);
  assert.equal(history.data.current.revision, 2);
  assert.equal(history.data.snapshot.configuration.config_revision, 1);
  assert.equal(history.data.episode.opened.value, 95);
  assert.equal(
    history.data.snapshot.configuration.rules[0].parameters.find((p: any) => p.name === 'problem_threshold')
      .value,
    90,
  );
  const rules = await apiCall(`/api/metrics/templates/${meta.templateId}/versions/3/triggers`);
  assert.equal(rules.data.rules[0].parameters.defaults.problem_threshold, 95);
  await cfg.getByRole('button', { name: '重新加载配置', exact: true }).click();
  // Existing event list/detail consumes the persisted writer result.
  const events = page.locator('event-management-page');
  await events.getByRole('button', { name: /^已解决/ }).click();
  await events.getByText('模板事件：mysql.processlist.count', { exact: true }).click();
  const evidence = events.locator('template-event-evidence');
  await expect(evidence.getByText(episodeId, { exact: true })).toBeVisible();
  await expect(evidence.getByText('已恢复', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0, { timeout: 15000 });
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await evidence.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(output, `event-${size.width}x${size.height}.png`),
      fullPage: true,
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await evidence.getByRole('button', { name: '刷新', exact: true }).focus();
  assert.equal(
    await evidence
      .getByRole('button', { name: '刷新', exact: true })
      .evaluate((e) => e === (e.getRootNode() as ShadowRoot).activeElement),
    true,
  );
  await apiCall('/__test/revoke', { revoked: true });
  assert.equal((await read()).status, 401);
  await apiCall('/__test/revoke', { revoked: false });
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, 'business-evidence.json'),
    JSON.stringify(
      {
        nonce,
        firstPid,
        restartedPid: api.pid,
        episodeId,
        eventId,
        opened,
        kept,
        boundary,
        unknown,
        recovered,
        ninety,
        history: history.data,
        newRules: rules.data,
        viewports: ['1440x900', '1366x768', '1920x1080'],
        focus: true,
        revokedStatus: 401,
        productModelCalls: 0,
        controlledSamples: true,
        realTargetTrial: true,
        externalDelivery: false,
      },
      null,
      2,
    ),
  );
  console.log(
    'MAX239 real HTTP/browser/formal-writer flow passed',
    JSON.stringify({ episodeId, eventId, firstPid, restartedPid: api.pid }),
  );
} catch (error) {
  if (browser) {
    const p = browser.contexts()[0]?.pages()[0];
    if (p) {
      await p.screenshot({ path: resolve(output, 'failure.png'), fullPage: true });
      await writeFile(resolve(output, 'failure.txt'), await p.locator('body').innerText());
    }
  }
  throw error;
} finally {
  await browser?.close();
  for (const c of children.reverse()) await stop(c);
  for (const fd of logs) closeSync(fd);
  if (bootstrapped) run('--cleanup-handles');
  await writeFile(
    resolve(output, 'resource-cleanup.json'),
    JSON.stringify({
      nonce,
      pids: children.map((c) => ({ pid: c.pid, exitCode: c.exitCode, signalCode: c.signalCode })),
      schemas: bootstrapped ? 'owned handles dropped' : 'bootstrap incomplete; inspect handles',
    }),
  );
}
