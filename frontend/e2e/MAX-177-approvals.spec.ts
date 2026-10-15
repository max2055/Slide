import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
test.describe.configure({ mode: 'serial' });
test.skip(!process.env.MAX177_ISOLATED_MYSQL, 'Use scripts/qualification/run-MAX-177.sh');
let pool: any, token: string, user: any;
let pendingId: number, rejectId: number, failedId: number;
const longSql = 'SELECT /* MAX177 完整 SQL ' + '长内容字段_'.repeat(600) + ' */ 1;';
const longReason = 'MAX177 风险依据：核对业务范围。'.repeat(300);
const longError = 'MAX177 完整错误：连接在执行前中断。'.repeat(300);
const output = 'test-results/MAX-177-evidence';
test.beforeAll(async ({ request }) => {
  pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', password: '', database: 'db_ops_ai_qualification' });
  await mkdir(output, { recursive: true });
  const login = await request.post('/api/auth/login', { data: { username: 'admin', password: process.env.QUALIFICATION_ADMIN_PASSWORD } });
  expect(login.status()).toBe(200); ({ token, user } = await login.json());
  const [instance] = await pool.query("INSERT INTO database_instances (name,host,port,username,password_encrypted,environment) VALUES ('MAX177隔离目标','fixture.invalid',3306,'fixture','unused','testing')");
  const instanceId = instance.insertId;
  for (let i = 0; i < 17; i++) {
    const status = i === 0 ? 'rejected' : i === 1 ? 'execution_failed' : i === 2 ? 'approved' : i === 3 ? 'rejected' : 'executed';
    const result = i === 0 || i === 2 ? null : i === 1 ? { success: false, error: longError } : { success: true, rowCount: 1, duration_ms: 5 };
    const [insert] = await pool.query('INSERT INTO approval_requests (instance_id,sql_text,sql_hash,risk_level,ai_recommendation,status,submitted_by,reviewed_by,review_notes,execution_result,target_database,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [instanceId, i === 1 ? longSql : `SELECT /* MAX177 历史 ${i} */ 1`, `max177-${i}`, i === 1 ? 'high' : 'low', JSON.stringify({ recommendation: 'approve', reasoning: longReason }), status, user.id, user.id, 'MAX177 审批备注', result && JSON.stringify(result), 'max177_sandbox', new Date(Date.UTC(2026, 9, 15, 8, 0, 17 - i))]);
    if (i === 1) { failedId = insert.insertId; await pool.query("INSERT INTO approval_events (request_id,event_type,event_data,created_by) VALUES (?,'execution_failed',?,?)", [failedId, JSON.stringify({ error: longError, opaque_evidence: 'MAX177_EVENT_RAW' }), user.id]); }
  }
  for (let i = 0; i < 2; i++) {
    const [insert] = await pool.query("INSERT INTO approval_requests (instance_id,sql_text,sql_hash,risk_level,ai_recommendation,status,submitted_by,target_database) VALUES (?,?,?,'high',?,'pending',?,'max177_sandbox')", [instanceId, longSql, `max177-pending-${i}`, JSON.stringify({ recommendation: 'reject', reasoning: longReason }), user.id]);
    if (i === 0) pendingId = insert.insertId; else rejectId = insert.insertId;
  }
  await pool.query("INSERT INTO agent_tool_approvals (tool_name,requester_id,binding_hash,args_redacted,resource_json,policy_snapshot,status,used_count,expires_at) VALUES ('MAX177_agent',?,?,?,?,'{}','consumed',1,DATE_ADD(NOW(), INTERVAL 1 DAY))", [user.id, 'a'.repeat(64), JSON.stringify({ note: longReason }), JSON.stringify({ type: 'instance', id: instanceId })]);
  await writeFile(`${output}/metadata.json`, JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceSha256: createHash('sha256').update(await readFile('src/app/ui/views/approval-dashboard.ts')).digest('hex'), data: 'Isolated MySQL persisted fixtures; current production server.ts, real password login/JWT/live permission checks. No production targets or model calls.', widths: [1440, 768, 390], themes: ['light', 'dark'], longSqlLength: longSql.length, longReasonLength: longReason.length, longErrorLength: longError.length }, null, 2));
});
test.afterAll(async () => { await pool?.end(); });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  }, { token, user });
});
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' });
  await writeFile(`${output}/${name}.json`, JSON.stringify({ viewport: page.viewportSize(), theme: await page.evaluate(() => document.documentElement.dataset.themeMode || 'default'), url: page.url(), source: name.startsWith('controlled-') ? 'HTTP interception supplemental state' : 'real service / isolated MySQL', measurement: await page.locator('approval-dashboard').evaluate(element => ({ rowHeights: Array.from(element.shadowRoot!.querySelectorAll('tbody tr')).map(row => row.getBoundingClientRect().height), pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, tableWidth: element.shadowRoot!.querySelector('.table-scroll')?.clientWidth, tableScrollWidth: element.shadowRoot!.querySelector('.table-scroll')?.scrollWidth })), at: new Date().toISOString() }, null, 2));
}
async function history(page: Page) {
  // Document-only harness for precise component viewport measurements; API is never mocked here.
  await page.route('**/MAX-177-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/app/styles/tokens.css"><style>body{margin:0;background:var(--bg);font:14px system-ui}</style><body><script type="module">import '/src/app/ui/views/approval-dashboard.ts';document.body.append(document.createElement('approval-dashboard'));</script></body></html>` }));
  await page.goto('/MAX-177-harness');
  const view = page.locator('approval-dashboard');
  await view.getByRole('button', { name: '审批历史', exact: true }).click();
  await expect(view.locator('tbody tr')).toHaveCount(6); return view;
}
test('real history representative: compact long data, independent filters, evidence, keyboard and responsive themes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const view = await history(page);
  for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
    const heights = await view.locator('tbody tr').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(3);
    await capture(page, `history-${width}-${theme}`);
  }
  const scroll = view.getByRole('region', { name: '审批历史，可横向滚动' });
  await scroll.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await view.getByRole('button', { name: '下一页' }).click();
  await expect(view.locator('.pagination')).toContainText('第 2 / 3 页');
  await view.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(view.locator('.pagination')).toContainText('第 2 / 3 页');
  await expect(view.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  const stored = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('slide.approval-history')).map(([key,value]) => ({ key, value: JSON.parse(value) })));
  await writeFile(`${output}/reload-before.json`, JSON.stringify(stored, null, 2));
  expect(stored[0].value.page).toBe(1);
  await page.reload();
  await writeFile(`${output}/reload-after.json`, JSON.stringify(await view.evaluate((element: any) => ({ stored: Object.entries(sessionStorage), page: element.historyPage, key: element.historyContextKey })), null, 2));
  await expect(view.locator('.pagination')).toContainText('第 2 / 3 页');
  await view.getByRole('combobox', { name: '审批结果', exact: true }).selectOption('approved');
  await expect(view.locator('.pagination')).toContainText('第 1 /');
  await view.getByRole('combobox', { name: '执行结果', exact: true }).selectOption('failed');
  await expect(view.locator('tbody tr')).toHaveCount(1); await expect(view.locator('tbody')).toContainText('已通过');
  const trigger = view.getByRole('button', { name: /^查看证据/ }); await trigger.focus(); await page.keyboard.press('Enter');
  const dialog = view.locator('app-dialog'); await expect(dialog.getByRole('heading', { name: '完整 SQL', exact: true })).toBeVisible();
  await expect(dialog.locator('pre').nth(0)).toHaveText(longSql); await expect(dialog).toContainText(longReason); await expect(dialog).toContainText(longError);
  await capture(page, 'detail-full-evidence-desktop');
  await dialog.locator('summary').click(); await expect(dialog).toContainText('MAX177_EVENT_RAW');
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().focus(); await page.keyboard.press('Tab');
  expect(await dialog.evaluate(element => { let active: Element | null = document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement; return element.shadowRoot?.contains(active) || element.contains(active); })).toBe(true);
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 900 }); await dialog.locator('.dialog-body').evaluate(element => { element.scrollTop = 0; }); await capture(page, `detail-${width}`);
    const bounds = await dialog.locator('.dialog').boundingBox(); expect(bounds!.width).toBeLessThan(width);
  }
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await view.getByRole('combobox', { name: '审批结果', exact: true }).selectOption('rejected');
  await view.getByRole('combobox', { name: '执行结果', exact: true }).selectOption('all');
  await expect(view.locator('tbody')).not.toContainText('执行成功'); await expect(view.locator('tbody')).toContainText('证据冲突');
  await capture(page, 'conflict');
  await view.getByRole('combobox', { name: '审批结果', exact: true }).selectOption('all');
  await view.getByRole('combobox', { name: '执行结果', exact: true }).selectOption('unknown');
  await expect(view.locator('tbody')).toContainText('MAX177_agent');
  await view.getByRole('button', { name: /^查看证据/ }).click(); await expect(dialog).toContainText('未提供工具执行回执');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
test('real pending approve without execute and reject persist correct states; current authorization still applies', async ({ page, request }) => {
  const view = await history(page); await view.getByRole('button', { name: '待审批', exact: true }).click();
  await expect(view).toContainText(longReason);
  await expect(view.locator('.pending-preview').first()).toHaveText(longSql);
  await page.setViewportSize({ width: 390, height: 900 }); await capture(page, 'pending-390');
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = view.locator('.card').filter({ has: page.locator(`#exec-${pendingId}`) });
  await card.getByLabel('审批后自动执行').uncheck();
  await card.getByRole('button', { name: '通过', exact: true }).click();
  await view.locator('app-dialog').getByRole('textbox', { name: '审批备注' }).fill('MAX177 approve without execution');
  const result = page.waitForResponse(r => r.url().endsWith('/api/approval/batch-review') && r.request().method() === 'POST');
  await view.locator('app-dialog').getByRole('button', { name: '确认通过' }).click();
  expect(await (await result).json()).toMatchObject([{ id: pendingId, success: true }]);
  const reject = view.locator('.card').filter({ has: page.locator(`#exec-${rejectId}`) });
  await reject.getByRole('button', { name: '驳回', exact: true }).click();
  await view.locator('app-dialog').getByRole('button', { name: '确认驳回' }).click(); await expect(view.locator('app-dialog')).toHaveCount(0);
  const [stored] = await pool.query('SELECT id,status,execution_result FROM approval_requests WHERE id IN (?,?) ORDER BY id', [pendingId, rejectId]);
  expect(stored).toEqual([{ id: pendingId, status: 'approved', execution_result: null }, { id: rejectId, status: 'rejected', execution_result: null }]);
  const unauthorized = await request.post('/api/approval/batch-review', { data: { ids: [pendingId], action: 'approve', execute_ids: [] } });
  expect(unauthorized.status()).toBe(401);
  await page.goto('/approval'); await expect(page.locator('approval-dashboard')).toBeVisible();
  await page.locator('approval-dashboard').getByRole('button', { name: '审批历史', exact: true }).click();
  await expect(page.locator('approval-dashboard tbody tr')).toHaveCount(6);
  await capture(page, 'actual-app-shell');
  for (const width of [768, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
    await capture(page, `app-shell-${width}-${theme}`);
  }
});
test('real permission revoked after dialog opens blocks review with visible feedback', async ({ page, request }) => {
  const [[source]] = await pool.query('SELECT instance_id FROM approval_requests WHERE id=?', [pendingId]);
  const [reviewer] = await pool.query("INSERT INTO users (username,password_hash,status) SELECT 'max177-reviewer',password_hash,'active' FROM users WHERE id=?", [user.id]);
  const [role] = await pool.query("INSERT INTO roles (name) VALUES ('max177-reviewer')");
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [reviewer.insertId, role.insertId]);
  await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('approval:view','approval:approve')", [role.insertId]);
  await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (?,?,'read-write')", [reviewer.insertId, source.instance_id]);
  const [approval] = await pool.query("INSERT INTO approval_requests (instance_id,sql_text,sql_hash,risk_level,status,submitted_by) VALUES (?,'SELECT 1','max177-revocation','high','pending',?)", [source.instance_id, user.id]);
  const login = await request.post('/api/auth/login', { data: { username: 'max177-reviewer', password: process.env.QUALIFICATION_ADMIN_PASSWORD } });
  expect(login.status()).toBe(200); const session = await login.json();
  await history(page);
  await page.evaluate(session => { localStorage.setItem('token', session.token); localStorage.setItem('user', JSON.stringify(session.user)); }, session);
  await page.locator('approval-dashboard').evaluate(element => { element.remove(); document.body.append(document.createElement('approval-dashboard')); });
  const view = page.locator('approval-dashboard');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('user')!).id)).toBe(reviewer.insertId);
  await view.getByRole('button', { name: '待审批', exact: true }).click();
  const card = view.locator('.card').filter({ has: page.locator(`#exec-${approval.insertId}`) });
  await card.getByLabel('审批后自动执行').uncheck(); await card.getByRole('button', { name: '通过', exact: true }).click();
  await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code='approval:approve'", [role.insertId]);
  const review = page.waitForResponse(r => r.url().endsWith('/api/approval/batch-review'));
  await view.locator('app-dialog').getByRole('button', { name: '确认通过' }).click(); expect((await review).status()).toBe(403);
  await expect(view.locator('app-dialog').getByRole('alert')).toBeVisible();
  const [[saved]] = await pool.query('SELECT status,execution_result FROM approval_requests WHERE id=?', [approval.insertId]);
  expect(saved).toEqual({ status: 'pending', execution_result: null });
  await capture(page, 'real-revoked-permission');
});
test('controlled loading, empty, failure, permission and partial evidence are distinct', async ({ page }) => {
  const view = await history(page);
  await view.getByRole('searchbox').fill('no-matching-record'); await capture(page, 'filtered-empty');
  await view.getByRole('searchbox').fill('');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/approval/unified?*', async route => { await gate; await route.continue(); });
  await view.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(view.locator('.pagination')).toContainText('正在读取历史'); await capture(page, 'controlled-loading');
  release(); await expect(view.locator('.pagination')).toContainText('已读取'); await page.unroute('**/api/approval/unified?*');
  for (const status of [503, 403]) {
    await page.route('**/api/approval/unified?*', route => route.fulfill({ status, json: {} }));
    await view.getByRole('button', { name: '刷新', exact: true }).click(); await expect(view.getByRole('alert')).toBeVisible();
    await expect(view.locator('app-data-table')).toHaveCount(0); await capture(page, `controlled-${status}`);
    await page.unroute('**/api/approval/unified?*');
  }
  await view.getByRole('button', { name: '刷新', exact: true }).click(); await expect(view.locator('tbody tr')).toHaveCount(6);
  await page.route(`**/api/approval/${failedId}/events`, route => route.fulfill({ status: 503, json: {} }));
  await view.getByRole('combobox', { name: '执行结果', exact: true }).selectOption('failed');
  await view.getByRole('button', { name: /^查看证据/ }).click(); await expect(view.locator('app-dialog')).toContainText('证据不完整');
  await capture(page, 'controlled-partial'); await page.keyboard.press('Escape');
  await page.route('**/api/approval/unified?*', route => route.fulfill({ json: { items: [] } }));
  await view.getByRole('button', { name: '刷新', exact: true }).click(); await expect(view).toContainText('没有符合条件的审批记录');
  await capture(page, 'controlled-empty');
});
