import { test, expect, type Page } from '@playwright/test';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

test.describe.configure({ mode: 'default' });
let env: Awaited<ReturnType<typeof startInvestigationServer>>;
let investigationId = '';
test.beforeAll(async () => {
  // The controlled provider reports a fixed 20-token prompt for every request.
  // Match its counter so pagination exercises completed Runs, not context exhaustion.
  env = await startInvestigationServer({ syntheticPromptTokens: 20 });
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
test.afterEach(() => { env.hold(false); env.holdChat(false); env.exhaustProviderSteps(false); expect(env.observationErrors.slice(observationStart), 'Authorized observation must not fail storage/revoke the owner').toEqual([]); });

async function login(page: Page, viewer = false) {
  const actor = viewer ? env.viewer : env.owner;
  await page.addInitScript(({ token, actor }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify({ id: actor.userId, username: actor.username }));
    localStorage.setItem('permissions', JSON.stringify(actor.permissions));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', navCollapsed: true }));
  }, { token: env.token(actor), actor });
}
async function observed(page: Page) {
  // HTTP history can render before WS authentication/watch establishment.
  await expect.poll(() => page.evaluate(() => {
    const c = (document.querySelector('investigations-page') as any)?.controller;
    return c?.online === true && c.refreshing === undefined;
  })).toBe(true);
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
    await page.screenshot({ path: test.info().outputPath(`workspace-${width}.png`), fullPage: true });
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
  await observed(page);
  const counts = env.counts();
  env.disconnectObservers(); await expect(page.getByRole('alert')).toContainText('连接中断');
  await expect(page.locator('.investigation-messages')).toContainText('普通对话合成回答', { timeout: 15000 });
  const [refreshed] = await env.pool.query('SELECT message_id FROM chat_messages WHERE session_id=? ORDER BY id', [session.session_id]);
  expect(refreshed).toEqual(after); expect(env.counts()).toEqual(counts);
  for (const row of messages) {
    const [bindings] = await env.pool.query('SELECT session_id FROM chat_messages WHERE message_id=?', [row.message_id]);
    expect(bindings).toEqual([{ session_id: session.session_id }]);
  }
});

test('real WS disconnect hides content, snapshot restores without creating a Run', async ({ page }) => {
  await login(page); await page.goto(`${env.url}/investigations?investigation=${investigationId}`);
  await expect(page.locator('.investigation-messages')).toContainText('再次读取合成指标');
  await observed(page);
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
  await page.getByRole('textbox', { name: '继续调查', exact: true }).fill('未知结果不能继续');
  await expect(page.getByRole('button', { name: '提交新 Run', exact: true })).toBeDisabled();
  expect(env.counts()).toEqual(before);
});

test('known partial continues through the product HTTP path without changing its predecessor', async ({ page }) => {
  env.exhaustProviderSteps(true);
  let id: string, requestId: string;
  try {
    const created = await env.bridge.create(env.owner, { title: '显式接续部分结果', goal: '保留旧结果继续调查', profileId: 'ops', profileVersion: 1,
      resources: [{ type: 'instance', id: 101, role: 'primary' }], context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } },
      idempotencyKey: crypto.randomUUID() }, { message: '合成模型耗尽本次执行步数，保留已知部分结果', idempotencyKey: crypto.randomUUID() });
    id = created.investigation.id; requestId = created.acceptance!.requestId;
    await expect.poll(async () => {
      const [jobs] = await env.pool.query('SELECT state,lease_owner,lease_expires_at FROM workflow_jobs WHERE id=?', [created.acceptance!.jobId]);
      return jobs[0]?.state === 'completed' && jobs[0].lease_owner === null && jobs[0].lease_expires_at === null;
    }).toBe(true);
  } finally { env.exhaustProviderSteps(false); }
  const oldFacts = async () => {
    const [requests] = await env.pool.query('SELECT * FROM investigation_requests WHERE id=?', [requestId]);
    const [runs] = await env.pool.query('SELECT * FROM agent_runs WHERE idempotency_key=?', [`investigation:${requestId}`]);
    const [results] = await env.pool.query('SELECT * FROM investigation_results WHERE request_id=?', [requestId]);
    const [evidence] = await env.pool.query('SELECT * FROM investigation_evidence WHERE request_id=? ORDER BY id', [requestId]);
    const [ledger] = await env.pool.query('SELECT * FROM investigation_budget_ledger WHERE request_id=?', [requestId]);
    return { requests, runs, results, evidence, ledger };
  };
  const before = await oldFacts();
  expect(before.runs[0].state).toBe('partial'); expect(before.ledger[0].state).toBe('settled');
  await login(page); await page.goto(`${env.url}/investigations?investigation=${id}`);
  await observed(page);
  await page.getByRole('textbox', { name: '继续调查', exact: true }).fill('显式继续读取合成指标');
  const button = page.getByRole('button', { name: '从部分结果继续', exact: true });
  await expect(button).toBeEnabled();
  const accepted = page.waitForResponse(r => r.url() === `${env.url}/api/investigations/${id}/runs` && r.request().method() === 'POST');
  await button.focus(); await expect(button).toBeFocused();
  await page.keyboard.press('Enter'); const response = await accepted;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON().continuationOf).toEqual({ requestId, runId: before.runs[0].id, resultVersion: Number(before.results[0].version) });
  const successor = await response.json();
  await expect.poll(async () => {
    const [runs] = await env.pool.query('SELECT state FROM agent_runs WHERE idempotency_key=?', [`investigation:${successor.requestId}`]);
    return runs[0]?.state;
  }).toBe('completed');
  expect(await oldFacts()).toEqual(before);
  const [current] = await env.pool.query('SELECT version FROM investigations WHERE id=?', [id]);
  const reused = await page.request.post(`${env.url}/api/investigations/${id}/runs`, {
    headers: { Authorization: `Bearer ${env.token()}`, 'Idempotency-Key': crypto.randomUUID() },
    data: { message: '不得重用旧部分结果', expectedVersion: Number(current[0].version),
      continuationOf: response.request().postDataJSON().continuationOf },
  });
  expect(reused.status()).toBe(409);
  expect(await oldFacts()).toEqual(before);
  const [requests] = await env.pool.query('SELECT COUNT(*) AS n FROM investigation_requests WHERE investigation_id=?', [id]);
  expect(Number(requests[0].n)).toBe(2);
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
    const view = document.querySelector('investigations-page') as any;
    return { history: c?.history.length ?? 0, results: c?.results.items.length ?? 0, evidence: c?.evidence.length ?? 0, draft: view?.draft ?? '', evidenceOpen: view?.evidenceOpen ?? false };
  })).toEqual({ history: 0, results: 0, evidence: 0, draft: '', evidenceOpen: false });
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

for (const entry of ['creation', 'conversion'] as const) {
  test(`HTTP-only resource revocation clears ${entry} drafts without a watch`, async ({ page }) => {
    await login(page);
    const service = (await import('../../apps/db-ops-api/src/chat-database-service.js')).chatDatabaseService;
    const session = entry === 'conversion' ? await service.createSession(env.owner, { title: 'HTTP撤权转换' }) : undefined;
    const messageId = crypto.randomUUID();
    if (session) await service.addMessage(env.owner, session.session_id, { messageId, role: 'user', content: '撤权前的原消息' });
    await page.goto(`${env.url}/${session ? `chat?session=${session.session_id}` : 'investigations'}`);
    await page.getByRole('button', { name: session ? '转为调查' : '创建手动调查', exact: true }).click();
    for (const [name, value] of [['调查标题', 'HTTP sensitive title'], ['调查目标', 'HTTP sensitive goal'], ['资源 ID', '101']]) {
      await page.getByRole('textbox', { name, exact: true }).fill(value);
    }
    await page.getByLabel('观察开始时间', { exact: true }).fill('2026-10-12T00:00');
    await page.getByLabel('观察结束时间', { exact: true }).fill('2026-10-12T00:10');
    await page.evaluate(() => (window as any).httpForm = document.querySelector('investigation-create'));
    try {
      const [before] = await env.pool.query('SELECT COUNT(*) n FROM investigations');
      await env.pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
      const rejected = page.waitForResponse(r => r.url().endsWith('/api/investigations') && r.request().method() === 'POST');
      await page.getByRole('button', { name: '提交调查', exact: true }).click();
      const response = await rejected; expect(response.status()).toBe(404);
      expect((await response.json()).error).toBe('INVESTIGATION_NOT_FOUND');
      await expect.poll(() => page.evaluate(() => (window as any).httpForm.controller.busy)).toBe(false);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate(() => {
        const f = (window as any).httpForm;
        return [f.open, f.investigationTitle, f.goal, f.ids, f.from, f.to, f.validation, f.controller.acceptanceUnknown];
      })).toEqual([false, '', '', '', '', '', '', false]);
      const [after] = await env.pool.query('SELECT COUNT(*) n FROM investigations'); expect(after).toEqual(before);
      if (session) {
        await expect(page).toHaveURL(new RegExp(`session=${session.session_id}`));
        const [messages] = await env.pool.query('SELECT message_id,content FROM chat_messages WHERE session_id=?', [session.session_id]);
        expect(messages).toEqual([{ message_id: messageId, content: '撤权前的原消息' }]);
      } else await expect(page).toHaveURL(`${env.url}/investigations`);
    } finally { await env.pool.query("INSERT IGNORE INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-only')"); }
  });
}

test('Profiles settings consumes readonly facts, responds to live SQL rejection and fits all widths', async ({ page }) => {
  await env.pool.query("INSERT IGNORE INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code='ai:view'");
  const actor = await env.contexts.loadActiveActor(101);
  await login(page);
  await page.addInitScript(permissions => localStorage.setItem('permissions', JSON.stringify(permissions)), actor.permissions);
  try {
    await page.goto(`${env.url}/settings/ai/profiles`);
    const profiles = page.locator('investigation-profiles-page');
    await expect(profiles.getByRole('heading', { name: '调查 Profiles', exact: true })).toBeVisible();
    const response = await page.request.get(`${env.url}/api/investigation-profiles`, { headers: { Authorization: `Bearer ${env.token(actor)}` } });
    expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
    const facts = await response.json();
    for (const item of facts.items) {
      const row = profiles.getByRole('row').filter({ has: page.locator(`[data-profile="${item.profile.id}"]`) });
      await expect(row).toContainText(item.profile.responsibility);
      const details = row.getByRole('button');
      await details.click();
      const dialog = profiles.locator('app-dialog').filter({ has: page.locator('dialog[open]') });
      await dialog.getByText('版本与技术标识', { exact: true }).click();
      await expect(dialog).toContainText(item.profileHash);
      await expect(dialog).toContainText(item.profile.prompt.hash);
      for (const identifier of await dialog.getByText('原始标识', { exact: true }).all()) await identifier.click();
      for (const tool of item.profile.toolAllowlist) await expect(dialog.getByText(tool, { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(details).toBeFocused();
    }
    await expect(profiles).toContainText('尚未评估'); await expect(profiles).toContainText('执行上限不代表剩余额度');
    for (const width of [1600, 1024, 390]) {
      await page.setViewportSize({ width, height: 950 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/t06-profiles-${width}.png`, fullPage: true });
    }
    await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='ai:view'");
    const denied = page.waitForResponse(r => r.url().endsWith('/api/investigation-profiles'));
    await profiles.getByRole('button', { name: '刷新 Profiles', exact: true }).click();
    expect((await denied).status()).toBe(403);
    await expect(profiles).toContainText('无权访问');
    await expect(profiles.locator('[data-profile]')).toHaveCount(0);
    expect(await profiles.evaluate((element: any) => element.facts)).toBeNull();
    await page.reload(); await expect(page.locator('[data-profile]')).toHaveCount(0);
  } finally { await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='ai:view'"); }
});

test('a late authorized Profiles HTTP response cannot restore facts after live SQL denial', async ({ page }) => {
  await env.pool.query("INSERT IGNORE INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code='ai:view'");
  const actor = await env.contexts.loadActiveActor(101);
  await login(page);
  await page.addInitScript(permissions => localStorage.setItem('permissions', JSON.stringify(permissions)), actor.permissions);
  let release!: () => void, arrived!: () => void, delivered!: () => void;
  const held = new Promise<void>(resolve => release = resolve), fetched = new Promise<void>(resolve => arrived = resolve), settled = new Promise<void>(resolve => delivered = resolve);
  let first = true;
  await page.goto(`${env.url}/settings/ai/profiles`);
  const profiles = page.locator('investigation-profiles-page');
  await expect(profiles.locator('[data-profile]')).toHaveCount(2);
  await page.route('**/api/investigation-profiles', async route => {
    if (!first) { await route.continue(); return; }
    first = false;
    const response = await route.fetch(); expect(response.status()).toBe(200); arrived(); await held;
    try { await route.fulfill({ response }); } finally { delivered(); }
  });
  try {
    await profiles.evaluate((element: any) => { (window as any).pendingProfileRead = element.load(); }); await fetched;
    await expect(profiles.getByRole('status')).toContainText('正在加载');
    await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='ai:view'");
    const rejected = page.waitForResponse(r => r.url().endsWith('/api/investigation-profiles') && r.status() === 403);
    await profiles.evaluate((element: any) => { void element.load(); }); await rejected;
    await expect(profiles).toContainText('无权访问');
    release(); await settled;
    await page.evaluate(() => (window as any).pendingProfileRead);
    expect(await profiles.evaluate((element: any) => element.facts)).toBeNull();
    await expect(profiles.locator('[data-profile]')).toHaveCount(0);
  } finally {
    release();
    await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='ai:view'");
  }
});

test('Profiles deep link without ai:view sends no fact reads', async ({ page }) => {
  await login(page); const reads: string[] = [];
  page.on('request', r => { if (r.url().endsWith('/api/investigation-profiles')) reads.push(r.url()); });
  await page.goto(`${env.url}/settings/ai/profiles`);
  await expect(page.getByText('当前账号无权访问此设置页面。', { exact: true })).toBeVisible();
  await expect(page.locator('investigation-profiles-page')).toHaveCount(0); expect(reads).toEqual([]);
});

test('Profiles loading, unavailable and unconfigured states do not retain facts', async ({ page }) => {
  await env.pool.query("INSERT IGNORE INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code='ai:view'");
  const actor = await env.contexts.loadActiveActor(101);
  await login(page); await page.addInitScript(permissions => localStorage.setItem('permissions', JSON.stringify(permissions)), actor.permissions);
  try {
    await page.route('**/api/investigation-profiles', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.goto(`${env.url}/settings/ai/profiles`);
    const profiles = page.locator('investigation-profiles-page');
    await expect(profiles).toContainText('加载失败'); await expect(profiles.locator('[data-profile]')).toHaveCount(0);
    await page.unroute('**/api/investigation-profiles');
    await page.route('**/api/investigation-profiles', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, source: 'repository', allowlistSemantics: 'authority_ceiling', items: [] }) }));
    await profiles.getByRole('button', { name: '刷新 Profiles', exact: true }).click();
    await expect(profiles).toContainText('尚未配置 Profiles');
    expect(await profiles.evaluate((element: any) => element.facts.items)).toEqual([]);
  } finally { await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='ai:view'"); }
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
  await loadAll();
  await observed(page);
  env.disconnectObservers();
  await expect(page.getByRole('alert')).toContainText('连接中断');
  await expect(page.locator('.investigation-messages')).toContainText('分页事实 204', { timeout: 15000 });
  await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toBeVisible();
  await loadAll();
  const text = await page.locator('.investigation-messages').innerText();
  expect(text.indexOf('分页事实 000')).toBeLessThan(text.indexOf('分页事实 204'));
  await page.reload(); await expect(page.locator('.investigation-messages')).toContainText('分页事实 204'); await loadAll();
  const [rows] = await env.pool.query('SELECT COUNT(*) AS n,COUNT(DISTINCT message_id) AS distinct_n FROM chat_messages WHERE session_id=?', [session.session_id]);
  expect(Number(rows[0].n)).toBe(Number(rows[0].distinct_n));
});

async function pagedInvestigation() {
  const service = (await import('../../apps/db-ops-api/src/chat-database-service.js')).chatDatabaseService;
  const session = await service.createSession(env.owner, { title: '确定性分页' });
  for (let i = 0; i < 205; i++) await service.addMessage(env.owner, session.session_id, {
    messageId: crypto.randomUUID(), role: 'user', content: `延迟分页 ${String(i).padStart(3, '0')}` });
  const created = await env.bridge.create(env.owner, { title: '确定性分页调查', goal: '验证快照分页', sessionId: session.session_id,
    profileId: 'ops', profileVersion: 1, resources: [{ type: 'instance', id: 101, role: 'primary' }],
    context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } }, idempotencyKey: crypto.randomUUID() });
  return created.investigation.id;
}

for (const phase of ['initial', 'reconnect'] as const) {
  test(`${phase} snapshot between old-page HTTP read and delivery keeps canonical history`, async ({ page }) => {
    const id = await pagedInvestigation(); await login(page);
    const initial = phase === 'initial' ? env.delaySnapshot(id) : undefined;
    let releasePage!: () => void;
    let pageRead!: () => void;
    const fetched = new Promise<void>(resolve => pageRead = resolve);
    const deliver = new Promise<void>(resolve => releasePage = resolve);
    let snapshotCount = 0;
    page.on('websocket', socket => socket.on('framereceived', frame => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === 'investigation.snapshot' && value.investigationId === id) snapshotCount++;
    }));
    await page.route(`**/api/investigations/${id}/facts?before=*`, async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200);
      expect((await response.json()).documents.length).toBeGreaterThan(0);
      pageRead(); await deliver; await route.fulfill({ response });
    });
    try {
      await page.goto(`${env.url}/investigations?investigation=${id}`);
      await expect(page.locator('.investigation-messages')).toContainText('延迟分页 204');
      if (phase === 'reconnect') {
        await observed(page);
        env.disconnectObservers(); await expect(page.getByRole('alert')).toContainText('连接中断');
        await expect(page.locator('.investigation-messages')).toContainText('延迟分页 204', { timeout: 15000 });
      } else await initial!.started;
      await page.getByRole('button', { name: '加载更早消息', exact: true }).click(); await fetched;
      const beforeSnapshot = snapshotCount;
      if (initial) initial.release();
      else await page.evaluate(id => (document.querySelector('investigations-page') as any).client.refreshInvestigation(id), id);
      await expect.poll(() => snapshotCount).toBeGreaterThan(beforeSnapshot);
      await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any).controller.online)).toBe(true);
      releasePage();
      await expect(page.locator('.investigation-messages')).toContainText('延迟分页 000');
      await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0);
      const text = await page.locator('.investigation-messages').innerText();
      expect(text.indexOf('延迟分页 000')).toBeLessThan(text.indexOf('延迟分页 204'));
      await page.reload(); await expect(page.locator('.investigation-messages')).toContainText('延迟分页 204');
      await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
      await expect(page.locator('.investigation-messages')).toContainText('延迟分页 000');
    } finally { initial?.release(); releasePage(); }
  });
}

test('expired evidence retains tombstone/hash, raw HTTP 410 and unverified result', async ({ page }) => {
  const [rows] = await env.pool.query('SELECT id,content_hash FROM investigation_evidence WHERE investigation_id=?', [investigationId]);
  expect(rows.length).toBeGreaterThan(0);
  const evidence = rows[0];
  await env.pool.query('UPDATE investigation_evidence SET expires_at=DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id=?', [evidence.id]);
  await login(page); await page.goto(`${env.url}/investigations?investigation=${investigationId}`);
  await page.setViewportSize({ width: 1600, height: 950 });
  const context = page.locator('.workspace-context investigation-context');
  await expect(context.locator(`[data-evidence="${evidence.id}"]`)).toContainText('原文已过期');
  await expect(context).toContainText(evidence.content_hash);
  await expect(context).toContainText('根因待验证');
  const response = await page.request.get(`${env.url}/api/investigations/${investigationId}/evidence/${evidence.id}?raw=true`, {
    headers: { Authorization: `Bearer ${env.token()}` },
  });
  expect(response.status()).toBe(410);
  const tombstone = await response.json();
  expect(tombstone.error).toBe('EVIDENCE_EXPIRED'); expect(tombstone.evidence.contentHash).toBe(evidence.content_hash);
  expect(tombstone.evidence.raw).toBeUndefined(); expect(tombstone.evidence.status).toBe('expired');
  const [stored] = await env.pool.query('SELECT raw_json,expired_at,content_hash FROM investigation_evidence WHERE id=?', [evidence.id]);
  expect(stored[0].raw_json).toBeNull(); expect(stored[0].expired_at).not.toBeNull(); expect(stored[0].content_hash).toBe(evidence.content_hash);
  await page.reload(); await expect(context).toContainText('原文已过期'); await expect(context).toContainText('根因待验证');
});

test('more than 20 durable result versions page, remain after snapshot, and reconnect', async ({ page }) => {
  test.setTimeout(120_000);
  const created = await env.bridge.create(env.owner, { title: '成果版本分页', goal: '只读多版本', profileId: 'ops', profileVersion: 1,
    resources: [{ type: 'instance', id: 101, role: 'primary' }], context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } },
    idempotencyKey: crypto.randomUUID() }, { message: '合成版本 1', idempotencyKey: crypto.randomUUID() });
  const id = created.investigation.id;
  for (let version = 1; version <= 22; version++) {
    await expect.poll(async () => { const [rows] = await env.pool.query('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?', [id]); return Number(rows[0].n); }).toBe(version);
    if (version < 22) {
      const [rows] = await env.pool.query('SELECT version FROM investigations WHERE id=?', [id]);
      await env.bridge.admit(env.owner, { investigationId: id, expectedVersion: Number(rows[0].version), message: `合成版本 ${version + 1}`, idempotencyKey: crypto.randomUUID() });
    }
  }
  await login(page); await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto(`${env.url}/investigations?investigation=${id}`);
  const context = page.locator('.workspace-context investigation-context'), select = context.getByRole('combobox', { name: '结果版本' });
  await expect(select.locator('option')).toHaveCount(20);
  await context.getByRole('button', { name: '加载更早结果版本', exact: true }).click();
  await expect(select.locator('option')).toHaveCount(22);
  const labels = await select.locator('option').allTextContents(); expect(labels.map(s => Number(s.match(/^V(\d+)/)![1]))).toEqual(Array.from({ length: 22 }, (_, i) => 22 - i));
  const [versions] = await env.pool.query('SELECT id,run_id FROM investigation_results WHERE investigation_id=? ORDER BY version DESC', [id]);
  expect(await select.locator('option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).toEqual(versions.map((v: any) => v.id));
  expect(new Set(versions.map((v: any) => v.run_id)).size).toBe(22);
  const [runs] = await env.pool.query(`SELECT state FROM agent_runs
    WHERE id IN (SELECT run_id FROM investigation_results WHERE investigation_id=?)`, [id]);
  expect(runs).toHaveLength(22);
  expect(runs.every((run: any) => run.state === 'completed')).toBe(true);
  await select.selectOption(versions.at(-1).id);
  // Await actual snapshot refresh HTTP delivery before asserting retained pages.
  const refreshed = page.waitForResponse(response => response.url() === `${env.url}/api/investigations/${id}/results` && response.status() === 200);
  await page.evaluate(id => (document.querySelector('investigations-page') as any).client.refreshInvestigation(id), id);
  await refreshed;
  await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any).controller.refreshing === undefined)).toBe(true);
  await expect(select.locator('option')).toHaveCount(22); await expect(select).toHaveValue(versions.at(-1).id);
  await observed(page);
  env.disconnectObservers(); await expect(page.getByRole('alert')).toContainText('连接中断');
  await expect(select.locator('option')).toHaveCount(20, { timeout: 15000 });
  await context.getByRole('button', { name: '加载更早结果版本', exact: true }).click(); await expect(select.locator('option')).toHaveCount(22);
  await page.reload(); await expect(select.locator('option')).toHaveCount(20);
  await context.getByRole('button', { name: '加载更早结果版本', exact: true }).click(); await expect(select.locator('option')).toHaveCount(22);
});

for (const action of ['revocation', 'selection'] as const) {
  test(`${action} cannot restore a delayed real HTTP history page`, async ({ page }) => {
    const id = await pagedInvestigation(), other = action === 'selection' ? await pagedInvestigation() : '';
    await login(page); await page.goto(`${env.url}/investigations?investigation=${id}`);
    await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any).controller.online)).toBe(true);
    await observed(page);
    let release!: () => void, arrived!: () => void, delivered!: () => void;
    const held = new Promise<void>(resolve => release = resolve), fetched = new Promise<void>(resolve => arrived = resolve), settled = new Promise<void>(resolve => delivered = resolve);
    await page.evaluate(() => {
      const c = (document.querySelector('investigations-page') as any).controller;
      const load = c.loadHistory.bind(c);
      (window as any).t06Page = { controller: c, settled: false };
      c.loadHistory = async () => { try { await load(); } finally { (window as any).t06Page.settled = true; } };
    });
    await page.route(`**/api/investigations/${id}/facts?before=*`, async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200); arrived(); await held;
      try { await route.fulfill({ response }); } finally { delivered(); }
    });
    try {
      await page.getByRole('button', { name: '加载更早消息', exact: true }).click(); await fetched;
      if (action === 'revocation') {
        await page.getByRole('button', { name: '创建手动调查', exact: true }).click();
        await page.getByRole('textbox', { name: '调查目标', exact: true }).fill('需随撤权清空的创建草稿');
        await page.evaluate(() => (window as any).t06Page.form = document.querySelector('investigation-create'));
        await env.pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
        await expect(page.locator('.investigation-messages')).toHaveCount(0);
        // Either the HTTP live recheck or WS revocation may close authority first.
        await expect(page.getByRole('alert')).toContainText(/访问权限|登录已失效/);
      } else {
        const button = page.locator('.investigation-list button').filter({ hasText: '确定性分页调查' });
        // Both records are recent; use the list's newest row for the other ID.
        await button.first().click();
        await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any).controller.detail?.id)).toBe(other);
      }
      release(); await settled;
      await expect.poll(() => page.evaluate(() => (window as any).t06Page.settled)).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const c = (window as any).t06Page.controller;
        return c.history.some((m: any) => m.content === '延迟分页 000');
      })).toBe(false);
      if (action === 'revocation') {
        await expect(page.locator('.investigation-messages')).toHaveCount(0);
        expect(await page.evaluate(() => { const c = (window as any).t06Page.controller; return [c.history.length, c.results.items.length, c.evidence.length]; })).toEqual([0, 0, 0]);
        expect(await page.evaluate(() => {
          const form = (window as any).t06Page.form;
          return { open: form.open, goal: form.goal, title: form.investigationTitle, ids: form.ids };
        })).toEqual({ open: false, goal: '', title: '', ids: '' });
      } else await expect(page).toHaveURL(new RegExp(`investigation=${other}`));
    } finally {
      release();
      if (action === 'revocation') await env.pool.query("INSERT IGNORE INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-only')");
    }
  });
}
