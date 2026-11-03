/** Real Lit/Fastify/MySQL acceptance; run from repository root:
 * pnpm --filter slide-api exec tsx e2e/max238-unbind-flow.ts
 * Target reads use the real read-only MySQL adapter. The optional collector hold
 * delays an already completed read, never manufactures observations or events.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
const root = resolve(process.cwd(), '../..'),
  front = resolve(root, 'frontend');
const out = process.env.MAX238_EVIDENCE_DIR
  ? resolve(process.env.MAX238_EVIDENCE_DIR)
  : resolve(root, 'outputs/max238-unbind-flow-' + Date.now());
await mkdir(out, { recursive: true });
const base = 'http://127.0.0.1:51976',
  ui = 'http://127.0.0.1:51977';
const children: ReturnType<typeof spawn>[] = [];
const evidence: any = { source: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() };
const launch = (cmd: string, args: string[], env: any, name: string) => {
  const fd = openSync(resolve(out, name + '.log'), 'a');
  const p = spawn(cmd, args, { cwd: front, env, stdio: ['ignore', fd, fd] });
  children.push(p);
  return p;
};
const request = async (path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  return data as any;
};
const ready = async (url: string, p: any) => {
  for (let i = 0; i < 180; i++) {
    assert.equal(p.exitCode, null, 'fixture exited');
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error('readiness timeout');
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const api = launch(
    'bash',
    ['e2e/max238-collect-now.sh'],
    {
      ...process.env,
      MAX238_UNBIND_FLOW: '1',
      MAX238_API_PORT: '51976',
      MAX238_HANDLE_FILE: resolve(out, 'handle.json'),
    },
    'api',
  );
  await ready(base + '/__health', api);
  const expected = JSON.parse(await readFile(resolve(out, 'handle.json'), 'utf8'));
  const owner = await request('/__test/handle');
  assert.equal(owner.nonce, expected.nonce);
  assert.equal(owner.container, expected.container);
  assert.equal(owner.cwd, front);
  evidence.owner = owner;
  const server = launch(
    process.execPath,
    [
      resolve(front, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      '51977',
      '--strictPort',
    ],
    { ...process.env, VITE_API_PROXY_TARGET: base },
    'vite',
  );
  await ready(ui, server);
  const listening = spawnSync('lsof', ['-t', '-iTCP:51977', '-sTCP:LISTEN'], { encoding: 'utf8' });
  assert.equal(listening.stdout.trim(), String(server.pid));
  const path = '/api/metrics/template-bindings/instance/1';
  const original = await request(path);
  evidence.original = original;
  // Production formalization accepts real evidence from the first batch;
  // the next batch then publishes through that accepted semantic source.
  await request(path + '/collect', { expected_revision: 1, caller_key: 'unbind-bootstrap' });
  for (let i = 0; i < 100; i++) {
    const v = await request('/__test/task?key=unbind-bootstrap');
    if (v.task?.state === 'completed') { evidence.bootstrap = v; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(evidence.bootstrap?.formal.length);
  await request(path + '/collect', { expected_revision: 1, caller_key: 'unbind-before' });
  for (let i = 0; i < 100; i++) {
    const v = await request('/__test/task?key=unbind-before');
    if (v.task?.state === 'completed') {
      evidence.formal = v;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(evidence.formal?.formal.length, 'real formal sample required');
  const applied = await request(path);
  assert.equal(applied.application.applied_revision, 1);
  evidence.applied = applied;
  evidence.historyBefore = await request('/api/metrics/configuration-history/instance/1/1');
  const sample = evidence.formal.formal.find((row: any) => row.observation.metric.id === 'mysql.processlist.count');
  assert(sample);
  const historyQuery = {
    resource: { type: 'instance', id: 1 }, metric: sample.observation.metric, dimensions: {},
    from: new Date(Date.parse(sample.observation.observed_at) - 1000).toISOString(),
    to: new Date(Date.parse(sample.observation.observed_at) + 1).toISOString(),
  };
  evidence.samplesBefore = await request('/api/metrics/observations', historyQuery);
  assert(evidence.samplesBefore.observations.some((row: any) => row.id === sample.id));
  const episodes = await request('/__test/episodes');
  assert(episodes.length);
  const eventPath = '/api/metrics/template-events/' + episodes[0].event_id;
  evidence.eventBefore = await request(eventPath);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(ui + '/e2e/fixtures/max238-collect-now.html');
  evidence.browserErrors = [];
  page.on('pageerror', (error) => evidence.browserErrors.push(error.message));
  const host = page.locator('native-template-configuration');
  const section = host.locator('app-card').filter({ hasText: '预览移除模板的影响' });
  const removable = original.template_pins.findIndex((pin: any) => pin.version === 1);
  await section.locator('input[type=checkbox]').nth(removable).check();
  await section.getByRole('button', { name: '查看影响', exact: true }).click();
  await section.getByRole('button', { name: '将移除结果带入配置' }).waitFor();
  const beforeCancel = await request('/__test/writes');
  await section.getByRole('button', { name: '取消预览', exact: true }).click();
  assert.deepEqual(await request('/__test/writes'), beforeCancel);
  await section.locator('input[type=checkbox]').nth(removable).check();
  await section.getByRole('button', { name: '查看影响', exact: true }).click();
  await section.getByRole('button', { name: '将移除结果带入配置' }).click();
  await host.getByRole('button', { name: '检查配置', exact: true }).click();
  await host.getByRole('button', { name: '试采', exact: true }).click();
  await host.getByRole('button', { name: '应用并启用', exact: true }).click();
  for (let i = 0; i < 50; i++) {
    const v = await request(path);
    if (v.revision === 2) {
      evidence.partial = v;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(evidence.partial.template_pins.length, 1);
  await request(path + '/collect', { expected_revision: 2, caller_key: 'partial-formal' });
  for (let i = 0; i < 100; i++) {
    const v = await request('/__test/task?key=partial-formal');
    if (v.task?.state === 'completed') {
      evidence.partialFormal = v;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(evidence.partialFormal?.formal.length);
  assert.equal((await request('/__test/episodes')).length, episodes.length);
  evidence.partialEvent = await request(eventPath);
  assert.equal(evidence.partialEvent.evaluation.state, 'active');
  await page.reload();
  await section.locator('input[type=checkbox]').check();
  await section.getByRole('button', { name: '查看影响', exact: true }).click();
  await section.getByRole('button', { name: '将移除结果带入配置' }).click();
  await host.getByRole('button', { name: '检查配置', exact: true }).click();
  await host.getByRole('button', { name: '试采', exact: true }).click();
  let reloadRecovery = false,
    lostKey = '';
  const lookups: string[] = [];
  await page.route('**/api/metrics/template-bindings/instance/1/operations/*', async (route) => {
    lookups.push(route.request().url());
    if (reloadRecovery) await route.continue();
    else await route.abort('failed');
  });
  await page.route(
    '**/api/metrics/template-bindings/instance/1/apply',
    async (route) => {
      lostKey = route.request().postDataJSON().caller_key;
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await host.getByRole('button', { name: '确认移除全部模板并停止采集', exact: true }).click();
  for (let i = 0; i < 50; i++) {
    const v = await request(path);
    if (v.revision === 3) {
      evidence.stopped = v;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  reloadRecovery = true;
  await page.reload();
  await host.getByRole('button', { name: '重新加载配置', exact: true }).waitFor();
  for (let i = 0; i < 50; i++) {
    const pending = await page.evaluate(() =>
      Object.values(sessionStorage).some((v) => String(v).includes('\"pending\":true')),
    );
    if (!pending) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(lostKey);
  assert(lookups.some((url) => url.endsWith('/operations/' + lostKey)));
  evidence.recovery = { lostKey, lookups, storage: await page.evaluate(() => ({ ...sessionStorage })) };
  assert(!Object.values(evidence.recovery.storage).some((v) => String(v).includes('\"pending\":true')));
  assert.equal(evidence.stopped?.application.applied_revision, 3);
  assert.equal(evidence.stopped?.effective?.revision, 3);
  await host.getByText('历史正式采集', { exact: true }).waitFor();
  await host.getByText('当前配置已停止采集；历史正式采集保留停止前采集代次的状态，不代表当前配置等待应用或产生了新样本。', { exact: true }).waitFor();
  evidence.stoppedPresentation = { historicalCollectionExplicit: true, stoppedRevision: 3 };
  evidence.historyAfter = await request('/api/metrics/configuration-history/instance/1/1');
  assert.deepEqual(evidence.historyAfter, evidence.historyBefore);
  evidence.samplesAfter = await request('/api/metrics/observations', historyQuery);
  assert.deepEqual(evidence.samplesAfter, evidence.samplesBefore);
  evidence.stopHistory = await request('/api/metrics/configuration-history/instance/1/3');
  assert.equal(evidence.stopHistory.state, 'effective');
  evidence.eventStopped = await request(eventPath);
  assert.equal(evidence.eventStopped.evaluation.state, 'stopped');
  await request('/__test/clock', {});
  const clockEvent = await request(eventPath);
  assert.deepEqual(clockEvent.episode, evidence.eventStopped.episode);
  assert.equal(clockEvent.episode.state, 'open');
  assert.equal((await request('/__test/episodes')).length, episodes.length);
  await request('/__test/session/2', {});
  const revoked = await fetch(base + '/api/metrics/configuration-history/instance/1/1');
  evidence.revoked = revoked.status;
  assert.equal(revoked.status, 401);
  const deniedSamples = await fetch(base + '/api/metrics/observations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(historyQuery),
  });
  evidence.samplesRevoked = deniedSamples.status;
  assert.equal(deniedSamples.status, 401);
  await request('/__test/session/1', {});
  for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: resolve(out, 'stopped-' + width + '.png'), fullPage: true });
  }
  assert.deepEqual(evidence.browserErrors, []);
  await page.reload();
  await host.getByRole('checkbox', { name: '选择模板 MAX238 collect now', exact: true }).check();
  await host.getByRole('checkbox', { name: '选择模板 MAX238 connection capacity provider', exact: true }).check();
  await host.getByRole('switch', { name: '启用此对象采集', exact: true }).check();
  const rebindPreview = page.waitForResponse(r => r.url().endsWith(path + '/preview'));
  await host.getByRole('button', { name: '检查配置', exact: true }).click();
  evidence.rebindPreview = await (await rebindPreview).json();
  await host.getByRole('button', { name: '试采', exact: true }).click();
  const rebindResponse = page.waitForResponse(r => r.url().endsWith(path + '/apply'));
  await host.getByRole('button', { name: '应用并启用', exact: true }).click();
  const response = await rebindResponse;
  assert.equal(response.status(), 200);
  const body = response.request().postDataJSON();
  evidence.rebind = await response.json();
  assert.equal(evidence.rebind.kind, 'committed');
  evidence.replay = await request(path + '/apply', body);
  assert.equal(evidence.replay.kind, 'replay');
  await request(path + '/collect', { expected_revision: 4, caller_key: 'unbind-after' });
  for (let i = 0; i < 100; i++) {
    const v = await request('/__test/task?key=unbind-after');
    if (v.task?.state === 'completed') {
      evidence.reboundFormal = v;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(evidence.reboundFormal?.formal.length);
  evidence.final = await request(path);
  assert.equal(evidence.final.application.applied_revision, 4);
  evidence.reboundEpisodes = await request('/__test/episodes');
  assert.equal(evidence.reboundEpisodes.length, episodes.length + 1);
  const collision = await fetch(base + path + '/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, overrides: { enabled: 'disable' } }),
  });
  evidence.collision = collision.status;
  assert.equal(collision.status, 409);
  const stopA = {
    expected_revision: 4,
    template_pins: [],
    overrides: { enabled: 'disable' },
    receipt_id: 'cas-a',
  };
  const stopB = { ...stopA, receipt_id: 'cas-b' };
  await request(path + '/trial', stopA);
  await request(path + '/trial', stopB);
  evidence.beforeLate = await request('/__test/writes');
  await request('/__test/collector-hold', {});
  await request(path + '/collect', { expected_revision: 4, caller_key: 'late-before-unbind' });
  for (let i = 0; i < 50; i++) {
    if ((await request('/__test/collector-status')).waiting) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal((await request('/__test/collector-status')).waiting, true);
  const attempts = await Promise.all(
    [stopA, stopB].map((v, i) =>
      fetch(base + path + '/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...v, caller_key: 'cas-' + i }),
      }).then(async (r) => ({ status: r.status, data: await r.json() })),
    ),
  );
  evidence.cas = attempts;
  assert.equal(attempts.filter((v) => v.status === 200 && v.data.kind === 'committed').length, 1);
  assert.equal(attempts.filter((v) => v.status === 409).length, 1);
  await request('/__test/collector-release', {});
  for (let i = 0; i < 100; i++) {
    const v = await request('/__test/task?key=late-before-unbind');
    if (v.task && !['accepted', 'running'].includes(v.task.state)) {
      evidence.late = v;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(evidence.late);
  assert.equal(evidence.late.formal.length, 0);
  assert.notEqual(evidence.late.task.state, 'completed');
  evidence.afterLate = await request('/__test/writes');
  assert.deepEqual(evidence.afterLate.formal, evidence.beforeLate.formal);
  const same = {
    expected_revision: 5,
    template_pins: [],
    overrides: { enabled: 'disable' },
    receipt_id: 'same-key-trial',
  };
  await request(path + '/trial', same);
  evidence.sameKey = await Promise.all(
    [0, 1].map(() => request(path + '/apply', { ...same, caller_key: 'same-key' })),
  );
  assert.deepEqual(evidence.sameKey.map((v: any) => v.kind).sort(), ['committed', 'replay']);
  const lockBody = { ...same, expected_revision: 6, receipt_id: 'lock-trial' };
  await request(path + '/trial', lockBody);
  await request('/__test/policy-lock', {});
  let settled = false;
  const locked = fetch(base + path + '/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...lockBody, caller_key: 'lock-revoked' }),
  }).then(async (r) => {
    settled = true;
    return { status: r.status, data: await r.json() };
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(settled, false);
  await request('/__test/session/2', {});
  await request('/__test/policy-release', {});
  evidence.lockRevoked = await locked;
  assert.equal(evidence.lockRevoked.status, 401);
  await request('/__test/session/1', {});
  const foreign = await fetch(base + '/api/metrics/template-bindings/instance/2/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  evidence.foreignResource = { status: foreign.status, data: await foreign.json() };
  assert.notEqual(evidence.foreignResource.status, 200);
  const foreignActor = await fetch(base + path + '/operations/same-key', {
    headers: { 'x-max238-actor': '2' },
  });
  evidence.foreignActor = { status: foreignActor.status, data: await foreignActor.json() };
  assert.equal(foreignActor.status, 403);
  const actorReplay = await fetch(base + path + '/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-max238-actor': '2' },
    body: JSON.stringify({ ...same, caller_key: 'same-key' }),
  });
  evidence.actorReplay = { status: actorReplay.status, data: await actorReplay.json() };
  assert.equal(actorReplay.status, 403);
  evidence.writes = await request('/__test/writes');
  assert.equal(evidence.writes.operations.filter((v: any) => v.caller_key === 'same-key').length, 1);
  assert.equal(evidence.writes.operations.filter((v: any) => v.caller_key === 'lock-revoked').length, 0);
  assert.equal((await request(path)).revision, 6);
} catch (error) {
  evidence.failure = String(error);
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    evidence.failureText = await page.locator('body').innerText();
    await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true });
  }
  throw error;
} finally {
  await browser?.close();
  try {
    if (evidence.owner) {
      const current = await request('/__test/handle');
      assert.equal(current.nonce, evidence.owner.nonce);
      evidence.shutdown = await request('/__test/shutdown', {});
    }
  } catch (e) {
    evidence.shutdownError = String(e);
  }
  for (const p of children.reverse())
    if (p.exitCode === null) {
      if (children.indexOf(p) === 0) p.kill('SIGTERM');
      await new Promise<void>((r, j) => {
        p.once('exit', () => r());
        setTimeout(() => j(Error('owned process cleanup timeout ' + p.pid)), 30000).unref();
      });
    }
  if (existsSync(resolve(out, 'handle.json'))) {
    const cleanup = spawnSync(
      'bash',
      [resolve(front, 'e2e/max238-collect-now.sh'), '--cleanup-handle', resolve(out, 'handle.json')],
      { encoding: 'utf8' },
    );
    evidence.cleanup = { status: cleanup.status, stdout: cleanup.stdout, stderr: cleanup.stderr };
    await writeFile(resolve(out, 'result.json'), JSON.stringify(evidence, null, 2));
    assert.equal(cleanup.status, 0, 'exact fixture cleanup failed; handle retained');
  }
  await writeFile(resolve(out, 'result.json'), JSON.stringify(evidence, null, 2));
}
