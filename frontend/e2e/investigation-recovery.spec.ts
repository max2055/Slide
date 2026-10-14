import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

let env: Awaited<ReturnType<typeof startInvestigationServer>>;
test.beforeAll(async () => { env = await startInvestigationServer({ systemPilot: true }); });
test.afterAll(async () => { if (env) try { expect(env.workerErrors).toEqual([]); } finally { await env.close(); } });

async function login(page: Page) {
  await page.addInitScript(({ token, actor }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify({ id: actor.userId, username: actor.username }));
    localStorage.setItem('permissions', JSON.stringify(actor.permissions));
    localStorage.setItem('slide.control.settings.v1', JSON.stringify({ locale: 'zh-CN', navCollapsed: true }));
  }, { token: env.token(), actor: env.owner });
}
async function create(title: string) {
  return env.bridge.create(env.owner, { title, goal: '再次读取合成指标，根因待验证', profileId: 'ops', profileVersion: 1,
    resources: [{ type: 'instance', id: 101, role: 'primary' }], idempotencyKey: crypto.randomUUID() },
  { message: '再次读取合成指标', idempotencyKey: crypto.randomUUID() });
}
async function ready(id: string) {
  await expect.poll(async () => (await env.pool.query('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?', [id]))[0][0].n).toBe(1);
}
async function receipt(name: string, id: string, extra: unknown = {}) {
  const [runs] = await env.pool.query('SELECT id,state,error_json FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?)', [id]);
  const [results] = await env.pool.query('SELECT version,result_json FROM investigation_results WHERE investigation_id=?', [id]);
  const [messages] = await env.pool.query('SELECT message_id FROM chat_messages WHERE session_id=(SELECT session_id FROM investigations WHERE id=?) ORDER BY id', [id]);
  await writeFile(test.info().outputPath(`${name}.json`), JSON.stringify({ mode: 'controlled-provider', investigationId: id, runs, results, messages, counts: env.counts(), extra }, null, 2));
}

test('all browser contexts closed: durable completion survives and fresh UI does not replay', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage();
  await login(page); await page.goto(`${env.url}/investigations`);
  const { investigation } = await create('无浏览器后台持久完成');
  await context.close();
  expect(browser.contexts()).toHaveLength(0);
  await ready(investigation.id);
  const before = env.counts();
  const fresh = await browser.newContext(), restored = await fresh.newPage();
  try {
    await login(restored); await restored.goto(`${env.url}/investigations?investigation=${investigation.id}`);
    await expect(restored.locator('.investigation-states')).toContainText('执行完成');
    await expect(restored.locator('.investigation-states')).toContainText('未确认');
    await restored.reload(); await expect(restored.locator('.investigation-states')).toContainText('执行完成');
    expect(env.counts()).toEqual(before);
    await receipt('background-completion', investigation.id);
  } finally { await fresh.close(); }
});

test('lost WS plus pruned replay: snapshot keeps canonical message IDs and Run count', async ({ page }) => {
  const { investigation } = await create('回放保留期恢复'); await ready(investigation.id);
  await login(page); await page.goto(`${env.url}/investigations?investigation=${investigation.id}`);
  await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any)?.controller?.online)).toBe(true);
  const [before] = await env.pool.query('SELECT message_id FROM chat_messages WHERE session_id=? ORDER BY id', [investigation.sessionId]);
  const counts = env.counts();
  await env.pool.query('DELETE FROM investigation_stream_events WHERE investigation_id=?', [investigation.id]);
  env.disconnectObservers();
  await expect(page.getByRole('alert')).toContainText('连接中断');
  await expect(page.locator('.investigation-states')).toContainText('执行完成', { timeout: 15_000 });
  await page.reload(); await expect(page.locator('.investigation-states')).toContainText('执行完成');
  const [after] = await env.pool.query('SELECT message_id FROM chat_messages WHERE session_id=? ORDER BY id', [investigation.sessionId]);
  expect(after).toEqual(before); expect(env.counts()).toEqual(counts);
  await expect.poll(() => page.evaluate(() => {
    const ids = (document.querySelector('investigations-page') as any)?.controller?.snapshot?.documents?.map((d: any) => d.id) ?? [];
    return ids.length > 0 && new Set(ids).size === ids.length;
  })).toBe(true);
  await receipt('replay-retention-recovery', investigation.id);
});

test('expired evidence raw is 410; metadata, result and narrow UI retain unknown status', async ({ page }) => {
  const { investigation } = await create('证据保留期训练'); await ready(investigation.id);
  const [evidence] = await env.pool.query('SELECT id,content_hash FROM investigation_evidence WHERE investigation_id=?', [investigation.id]);
  expect(evidence.length).toBeGreaterThan(0);
  await env.pool.query('UPDATE investigation_evidence SET expires_at=DATE_SUB(NOW(3),INTERVAL 8 DAY) WHERE investigation_id=?', [investigation.id]);
  await login(page);
  const response = await page.request.get(`${env.url}/api/investigations/${investigation.id}/evidence/${evidence[0].id}?raw=true`, { headers: { authorization: `Bearer ${env.token()}` } });
  expect(response.status()).toBe(410);
  const [purged] = await env.pool.query('SELECT raw_json,content_hash FROM investigation_evidence WHERE id=?', [evidence[0].id]);
  expect(purged[0].raw_json).toBeNull(); expect(purged[0].content_hash).toBe(evidence[0].content_hash);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${env.url}/investigations?investigation=${investigation.id}`);
  await expect(page.locator('.investigation-states')).toContainText('未确认');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('expired-evidence-390.png'), fullPage: true });
  await receipt('expired-evidence', investigation.id, { rawStatus: response.status(), contentHash: purged[0].content_hash });
});

test('AI unavailable: original system event remains readable and never triggers itself', async ({ page }) => {
  env.failProvider(true);
  try {
    const sourceEventId = crypto.randomUUID();
    const original = await env.system!.bridge.record({ component: 'api', sourceEventId, occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(), stableErrorCode: 'T12_FAILURE_INJECTION', callsite: 't12:readonly', origin: 'user_operation', httpStatus: 503 });
    const event = await env.system!.bridge.deliver(original.jobId);
    expect(event.investigationId).toBeTruthy();
    const id = event.investigationId!;
    await env.pool.query("INSERT INTO investigation_members(investigation_id,user_id,role,granted_by) VALUES (?,101,'viewer',?)", [id, env.systemServiceId]);
    await expect.poll(async () => (await env.pool.query('SELECT state FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?)', [id]))[0][0]?.state, { timeout: 30_000 }).toMatch(/^(failed|partial)$/);
    const [raw] = await env.pool.query('SELECT payload FROM workflow_jobs WHERE id=?', [original.jobId]);
    expect(raw[0].payload.event.sourceEventId).toBe(sourceEventId);
    await login(page); await page.goto(`${env.url}/investigations?investigation=${id}`);
    await expect(page.locator('.investigation-states')).toContainText('未确认');
    const before = env.counts(); await page.reload();
    await expect(page.locator('.investigation-states')).toContainText('未确认'); expect(env.counts()).toEqual(before);
    const internal = await env.system!.bridge.record({ component: 'agent', sourceEventId: crypto.randomUUID(), occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(), stableErrorCode: 'PROVIDER_DOWN', callsite: 't12:agent', origin: 'workflow' });
    const suppressed = await env.system!.bridge.deliver(internal.jobId);
    expect(suppressed.disposition).toBe('suppressed'); expect(suppressed.investigationId).toBeNull();
    await receipt('provider-failure-no-loop', id, { original, event, suppressed });
  } finally { env.failProvider(false); }
});
