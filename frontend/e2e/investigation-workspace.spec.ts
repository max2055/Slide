import { test, expect, type Page } from '@playwright/test';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

test.describe.configure({ mode: 'default' });
let env: Awaited<ReturnType<typeof startInvestigationServer>>;
let investigationId = '';
test.beforeAll(async () => {
  env = await startInvestigationServer();
  const created = await env.bridge.create(env.owner, { title: '共享浏览器场景', goal: '再次读取合成指标', profileId: 'ops', profileVersion: 1,
    resources: [{ type: 'instance', id: 101, role: 'primary' }], context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } }, idempotencyKey: crypto.randomUUID() },
    { message: '再次读取合成指标', idempotencyKey: crypto.randomUUID() });
  investigationId = created.investigation.id;
  await expect.poll(async () => { const [rows] = await env.pool.query('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?', [investigationId]); return Number(rows[0].n); }).toBe(1);
});
test.afterAll(async () => { if (env) { try { expect(env.workerErrors).toEqual([]);  } finally { await env.close(); } } });
test.setTimeout(60_000);
let observationStart = 0;
test.beforeEach(() => { observationStart = env.observationErrors.length; });
test.afterEach(() => { env.hold(false); env.holdChat(false); expect(env.observationErrors.slice(observationStart), 'Authorized observation must not fail storage/revoke the owner').toEqual([]); });

async function login(page: Page, viewer = false) {
  const actor = viewer ? env.viewer : env.owner;
  await page.addInitScript(({ token, actor }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify({ id: actor.userId, username: actor.username }));
    localStorage.setItem('permissions', JSON.stringify(actor.permissions));
    localStorage.setItem('slide.control.settings.v1', JSON.stringify({ locale: 'zh-CN', navCollapsed: true }));
  }, { token: env.token(actor), actor });
}
async function create(page: Page, title: string) {
  await page.getByRole('button', { name: '创建手动调查' }).click();
  await page.getByRole('textbox', { name: '调查标题', exact: true }).fill(title);
  await page.getByRole('textbox', { name: '调查目标', exact: true }).fill('读取合成只读指标，根因待验证');
  await page.getByRole('textbox', { name: '资源 ID', exact: true }).fill('101');
  await page.getByRole('button', { name: '提交调查', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '继续调查', exact: true })).toBeVisible();
  return new URL(page.url()).searchParams.get('investigation')!;
}

test('create → real tool process → cancel → different Run → versions and refresh', async ({ page }) => {
  await login(page); await page.goto(`${env.url}/investigations`);
  await expect(page.getByText('共享浏览器场景', { exact: false })).toBeVisible();
  env.hold(true); const manualId = await create(page, '手动只读调查');
  await expect.poll(() => env.counts().toolCalls).toBeGreaterThan(0);
  await expect(page.locator('investigations-page .investigation-messages')).toContainText('get_instance_summary');
  const [before] = await env.pool.query('SELECT id FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?)', [manualId]);
  await page.getByRole('button', { name: '取消本次执行', exact: true }).click();
  await expect(page.getByRole('button', { name: '等待取消确认', exact: true })).toBeVisible();
  await expect(page.locator('.investigation-states')).toContainText('已取消');
  await expect(page.locator('.investigation-states')).toContainText('未确认');
  env.hold(false);
  await page.getByRole('textbox', { name: '继续调查', exact: true }).fill('再次读取合成指标');
  await page.getByRole('button', { name: '提交新 Run', exact: true }).click();
  await expect(page.locator('.investigation-states')).toContainText('执行完成');
  await expect.poll(async () => {
    const [runs] = await env.pool.query('SELECT id,state FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?) ORDER BY created_at', [manualId]);
    return runs.map((r: any) => r.state).sort();
  }).toEqual(['cancelled', 'completed']);
  const [after] = await env.pool.query('SELECT id FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?)', [manualId]);
  expect(after).toHaveLength(2); expect(after.map((r: any) => r.id)).toContain(before[0].id);
  // Cancelled output is withdrawn, so only completed executions produce versions.
  await page.getByRole('textbox', { name: '继续调查', exact: true }).fill('补充调查以保留第二版结果');
  await page.getByRole('button', { name: '提交新 Run', exact: true }).click();
  await expect.poll(async () => {
    const [rows] = await env.pool.query('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?', [manualId]);
    return Number(rows[0].n);
  }).toBe(2);
  const [versions] = await env.pool.query('SELECT version FROM investigation_results WHERE investigation_id=? ORDER BY version', [manualId]);
  expect(versions.map((v: any) => v.version)).toEqual([1, 2]);
  await page.reload();
  await expect(page.locator('.investigation-states')).toContainText('执行完成');
  await expect(page.locator('.investigation-messages')).toContainText('再次读取合成指标');
  await expect(page.getByRole('button', { name: '提交新 Run' })).toBeDisabled();
  await expect(page.locator('.workspace-context investigation-context')).toContainText('根因待验证');
});

test('1600 / 1024 / 390 layout and evidence dialog keyboard focus', async ({ page }) => {
  await login(page);
  await page.goto(`${env.url}/investigations?investigation=${investigationId}`);
  for (const width of [1600, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await expect(page.getByRole('textbox', { name: '继续调查', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => { const rect = document.querySelector('investigations-page')!.getBoundingClientRect(); const nav = document.querySelector('.shell-nav')!.getBoundingClientRect(); return rect.left >= nav.right && rect.right <= innerWidth; })).toBe(true);
    if (width === 1600) await expect(page.locator('.workspace-context')).toBeVisible();
    else {
      const trigger = page.getByRole('button', { name: '查看证据与成果' });
      await trigger.click(); await expect(page.getByRole('dialog', { name: '证据与成果' })).toBeVisible();
      await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    }
    await page.screenshot({ path: `test-results/t06-workspace-${width}.png`, fullPage: true });
  }
});

test('ordinary Chat sends directly; conversion preserves Session and message IDs', async ({ page }) => {
  await login(page);
  const session = await (await import('../../apps/db-ops-api/src/chat-database-service.js')).chatDatabaseService.createSession(env.owner, { title: '普通对话' });
  await page.goto(`${env.url}/chat?session=${session.session_id}`);
  await expect(page.locator('.agent-chat__input textarea')).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.agent-chat__input textarea').fill('不填调查表，直接提问');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('普通对话合成回答');
  await expect(page.getByRole('button', { name: '转为调查', exact: true })).toBeEnabled();
  const [messages] = await env.pool.query('SELECT message_id FROM chat_messages WHERE session_id=? ORDER BY id', [session.session_id]);
  expect(messages.length).toBeGreaterThan(1);
  await page.getByRole('button', { name: '转为调查', exact: true }).click();
  await page.getByRole('textbox', { name: '调查标题', exact: true }).fill('对话关联调查');
  await page.getByRole('textbox', { name: '调查目标', exact: true }).fill('关联原消息，再读取指标');
  await page.getByRole('textbox', { name: '资源 ID', exact: true }).fill('101');
  await page.getByRole('button', { name: '提交调查', exact: true }).click();
  await expect(page.locator('.investigation-messages')).toContainText('不填调查表，直接提问');
  await expect(page.locator('.investigation-states')).toContainText('执行完成');
  const id = new URL(page.url()).searchParams.get('investigation');
  const [record] = await env.pool.query('SELECT session_id FROM investigations WHERE id=?', [id]);
  expect(record[0].session_id).toBe(session.session_id);
  const [after] = await env.pool.query('SELECT message_id FROM chat_messages WHERE session_id=? ORDER BY id', [session.session_id]);
  for (const row of messages) expect(after.filter((m: any) => m.message_id === row.message_id)).toHaveLength(1);
  await page.reload(); await expect(page.locator('.investigation-messages')).toContainText('普通对话合成回答');
});

test('real WS disconnect hides content, snapshot restores without creating a Run', async ({ page }) => {
  await login(page); await page.goto(`${env.url}/investigations?investigation=${investigationId}`);
  await expect(page.locator('.investigation-messages')).toContainText('再次读取合成指标');
  const counts = env.counts();
  env.disconnectObservers();
  await expect(page.getByRole('alert')).toContainText('连接中断');
  await expect(page.locator('.investigation-messages')).toHaveCount(0);
  await expect(page.locator('.investigation-messages')).toContainText('再次读取合成指标', { timeout: 15000 });
  const ids = await page.evaluate(() => { const c = (document.querySelector('investigations-page') as any).controller; return c.snapshot.documents.map((d: any) => d.id); });
  expect(new Set(ids).size).toBe(ids.length); expect(env.counts()).toEqual(counts);
});

test('unknown is partial/outcome_unknown; no automatic rerun or recovery claim', async ({ page }) => {
  const id = await env.unknown(), before = env.counts();
  await login(page); await page.goto(`${env.url}/investigations?investigation=${id}`);
  await expect(page.locator('.investigation-states')).toContainText('结果未知');
  await expect(page.locator('.investigation-states')).toContainText('未确认');
  await page.reload(); await expect(page.locator('.investigation-states')).toContainText('结果未知');
  expect(env.counts()).toEqual(before);
});

test('viewer cannot append; same-JWT live resource revocation hides content and caches', async ({ page }) => {
  await env.pool.query("INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,102,'viewer',101)", [investigationId]);
  await login(page, true); await page.goto(`${env.url}/investigations?investigation=${investigationId}`);
  await expect(page.locator('.investigation-messages')).toContainText('再次读取合成指标');
  const [before] = await env.pool.query('SELECT COUNT(*) AS n FROM investigation_requests WHERE investigation_id=?', [investigationId]);
  await page.getByRole('textbox', { name: '继续调查', exact: true }).fill('viewer 请求');
  await page.getByRole('button', { name: '提交新 Run' }).click();
  await expect(page.getByRole('alert')).toContainText('没有调查操作权限');
  const [after] = await env.pool.query('SELECT COUNT(*) AS n FROM investigation_requests WHERE investigation_id=?', [investigationId]);
  expect(after[0].n).toBe(before[0].n);
  await page.reload(); await expect(page.locator('.investigation-messages')).toContainText('再次读取合成指标');
  await env.pool.query('DELETE FROM instance_permissions WHERE user_id=102 AND instance_id=101');
  await expect(page.locator('.investigation-messages')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const c = (document.querySelector('investigations-page') as any)?.controller;
    return c ? { history: c.history.length, results: c.results.items.length, evidence: c.evidence.length } : { history: 0, results: 0, evidence: 0 };
  })).toEqual({ history: 0, results: 0, evidence: 0 });
  await page.reload(); await expect(page.getByText('调查不存在或已无访问权限。', { exact: false })).toBeVisible();
});

test('list loading, read error, search empty and inaccessible deep link are explicit', async ({ page }) => {
  await login(page);
  await page.route('**/api/investigations?*', async route => { await new Promise(r => setTimeout(r, 500)); await route.continue(); });
  await page.goto(`${env.url}/investigations`);
  await expect(page.getByText('正在加载调查…', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索调查', exact: true }).fill('不存在的合成目标');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByText('暂无匹配调查', { exact: true })).toBeVisible();
  await page.unroute('**/api/investigations?*');
  await page.route('**/api/investigations?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'INVESTIGATION_QUEUE_UNAVAILABLE' }) }));
  await page.getByRole('button', { name: '筛选', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('暂不可用');
  await page.unroute('**/api/investigations?*');
  await page.goto(`${env.url}/investigations?investigation=00000000-0000-0000-0000-000000000000`);
  await expect(page.getByRole('alert')).toContainText('不存在或已无访问权限');
});

test('ordinary Chat cancel works for bare and agent-prefixed Session routes', async ({ page }) => {
  await login(page);
  const service = (await import('../../apps/db-ops-api/src/chat-database-service.js')).chatDatabaseService;
  try {
    for (const prefix of ['', 'agent:main:']) {
      const session = await service.createSession(env.owner, { title: '取消浏览器验证' });
      env.holdChat(true);
      await page.goto(`${env.url}/chat?session=${encodeURIComponent(prefix + session.session_id)}`);
      await expect(page.locator('.agent-chat__input textarea')).toBeEnabled();
      await page.locator('.agent-chat__input textarea').fill('取消受控等待');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(async () => { const [rows] = await env.pool.query('SELECT state FROM agent_runs WHERE session_id=?', [session.session_id]); return rows[0]?.state; }).toBe('running');
      await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
      await expect.poll(async () => { const [rows] = await env.pool.query('SELECT state FROM agent_runs WHERE session_id=?', [session.session_id]); return rows[0]?.state; }).toBe('cancelled');
    }
  } finally { env.holdChat(false); }
});

test('ordinary authorized observation has no idempotency storage errors', async () => {
  expect(env.observationErrors).toEqual([]);
});

test('no chat:view deep link performs no investigation reads', async ({ page }) => {
  await login(page);
  await page.route('**/api/auth/permissions', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.addInitScript(() => localStorage.setItem('permissions', '[]'));
  const reads: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/investigations')) reads.push(request.url()); });
  await page.goto(`${env.url}/investigations?investigation=${investigationId}`);
  await expect(page.locator('.investigation-messages')).toHaveCount(0);
  await expect(page.locator('a[href="/investigations"]')).toHaveCount(0);
  expect(reads).toEqual([]);
});

test('canonical recapture A → B → A remains idempotent (backend blocker probe)', async () => {
  const { captureCanonicalDocument } = await import('../../apps/db-ops-api/src/investigations/stream.js');
  const snapshot = await env.stream.snapshot(env.owner, investigationId);
  const [request] = await env.pool.query('SELECT id FROM investigation_requests WHERE investigation_id=?', [investigationId]);
  const doc = structuredClone(snapshot.documents.find(d => d.role === 'assistant')!); doc.id = crypto.randomUUID();
  await env.stream.transaction(env.owner, investigationId, async c => {
    await captureCanonicalDocument(c, investigationId, request[0].id, doc, '2026-10-13T00:00:00.000Z');
    await captureCanonicalDocument(c, investigationId, request[0].id, doc, '2026-10-13T00:00:01.000Z');
    await captureCanonicalDocument(c, investigationId, request[0].id, doc, '2026-10-13T00:00:00.000Z');
  });
});

test('history over 200 canonical facts loads older pages and survives reload', async ({ page }) => {
  const service = (await import('../../apps/db-ops-api/src/chat-database-service.js')).chatDatabaseService;
  const session = await service.createSession(env.owner, { title: '分页历史' });
  for (let i = 0; i < 205; i++) await service.addMessage(env.owner, session.session_id, { messageId: crypto.randomUUID(), role: 'user', content: `分页事实 ${String(i).padStart(3, '0')}` });
  const created = await env.bridge.create(env.owner, { title: '分页关联调查', goal: '只读分页验证', sessionId: session.session_id, profileId: 'ops', profileVersion: 1,
    resources: [{ type: 'instance', id: 101, role: 'primary' }], context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } }, idempotencyKey: crypto.randomUUID() },
    { message: '读取合成指标', idempotencyKey: crypto.randomUUID() });
  const id = created.investigation.id;
  await expect.poll(async () => { const [rows] = await env.pool.query('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?', [id]); return Number(rows[0].n); }).toBe(1);
  await login(page); await page.goto(`${env.url}/investigations?investigation=${id}`);
  await expect(page.locator('.investigation-messages')).toContainText('分页事实 204');
  const loadAll = async () => {
    for (let i = 0; i < 8; i++) {
      const before = await page.evaluate(() => (document.querySelector('investigations-page') as any).controller.historyBefore);
      if (!before) break;
      await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any).controller.historyBefore)).not.toBe(before);
    }
    await expect(page.locator('.investigation-messages')).toContainText('分页事实 000');
    await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0);
  };
  await loadAll(); await page.reload(); await expect(page.locator('.investigation-messages')).toContainText('分页事实 204'); await loadAll();
  const [rows] = await env.pool.query('SELECT COUNT(*) AS n,COUNT(DISTINCT message_id) AS distinct_n FROM chat_messages WHERE session_id=?', [session.session_id]);
  expect(Number(rows[0].n)).toBe(Number(rows[0].distinct_n));
});
