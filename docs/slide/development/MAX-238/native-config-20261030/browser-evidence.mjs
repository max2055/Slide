/**
 * MAX238-NATIVE-CONFIGURATION-FLOW — browser evidence.
 *
 * Drives the real Lit components against the real Fastify API and a one-off
 * platform database. Run from `frontend/` so `@playwright/test` resolves:
 *
 *   MAX238_EVIDENCE_DIR=... MAX238_DBPORT=... MAX238_DBPW=... MAX238_DB=... \
 *   MAX238_ADMIN_PASSWORD=... node ../../docs/slide/development/MAX-238/native-config-20261030/browser-evidence.mjs
 *
 * Scenarios: A select/cancel/search/pagination + real preview/trial + one
 * committed apply whose HTTP response is dropped, recovered through the native
 * operation journal; B a concurrent revision bump is refused and reload
 * recovers; C a permission revocation is refused at the apply boundary with no
 * write. Nothing here is a route stub.
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const OUT = process.env.MAX238_EVIDENCE_DIR;
if (!OUT) throw new Error('MAX238_EVIDENCE_DIR is required');
mkdirSync(OUT, { recursive: true });
const PAGE = process.env.MAX238_PAGE || 'http://127.0.0.1:5173';
const API = process.env.MAX238_API || 'http://127.0.0.1:3001';
const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const API_DIR = process.env.MAX238_API_DIR || `${REPO_ROOT}/apps/db-ops-api`;
const require = createRequire(`${API_DIR}/package.json`);
const { chromium } = createRequire(`${REPO_ROOT}/frontend/package.json`)('@playwright/test');
const mysql = require('mysql2/promise');
const db = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MAX238_DBPORT), user: 'root',
  password: process.env.MAX238_DBPW, database: process.env.MAX238_DB });
const one = async (sql, params = []) => (await db.query(sql, params))[0][0];
const rows = async (sql, params = []) => (await db.query(sql, params))[0];

const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: process.env.MAX238_ADMIN_USER || 'e2e-admin',
    password: process.env.MAX238_ADMIN_PASSWORD || '' }) });
const session = await login.json();
const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
const api = async (method, path, body) => {
  const response = await fetch(`${API}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json().catch(() => null) };
};

const evidence = { started_at: new Date().toISOString(), scenarios: {} };
const requests = [];
const capture = (page, label) => {
  page.on('request', request => { const url = request.url(); if (url.includes('/api/metrics/')) requests.push({ label, method: request.method(), path: url.replace(PAGE, '') }); });
  page.on('response', async response => {
    const url = response.url();
    if (!/\/api\/metrics\/(templates|template-bindings|config\/resources)/.test(url)) return;
    if (!['preview', 'trial', 'apply', 'operations'].some(k => url.includes(k)) && !url.includes('/template-bindings/instance/1')) return;
    try { requests.push({ label, kind: 'response', status: response.status(), path: url.replace(PAGE, '') }); } catch { /* body not evidence */ }
  });
};
const collectText = () => {
  const out = [];
  const visit = node => {
    if (node.nodeType === Node.TEXT_NODE) { const text = (node.textContent || '').trim(); if (text) out.push(text); return; }
    if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (element.tagName === 'STYLE' || element.tagName === 'SCRIPT') return;
    if (element.shadowRoot) visit(element.shadowRoot);
    for (const child of element.childNodes) visit(child);
  };
  visit(document);
  return out.join('\n').replace(/\n{2,}/g, '\n');
};
const deepText = (page, tag) => page.evaluate(tagName => {
  const found = [];
  const walk = root => {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) walk(element.shadowRoot);
      if (element.tagName === tagName) found.push(element);
    }
  };
  walk(document);
  if (!found.length) return '';
  const out = [];
  const visit = node => {
    if (node.nodeType === Node.TEXT_NODE) { const text = (node.textContent || '').trim(); if (text) out.push(text); return; }
    if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (element.tagName === 'STYLE' || element.tagName === 'SCRIPT') return;
    if (element.shadowRoot) visit(element.shadowRoot);
    for (const child of element.childNodes) visit(child);
  };
  const host = found[found.length - 1];
  visit(host.shadowRoot ?? host);
  return out.join('\n').replace(/\n{2,}/g, '\n');
}, tag);
const pageText = page => page.evaluate(collectText);
const waitFor = async (page, predicate, timeout = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate(await pageText(page))) return true;
    await page.waitForTimeout(400);
  }
  return false;
};
const openConfig = async page => {
  await page.goto(`${PAGE}/`, { waitUntil: 'networkidle' });
  await page.getByText('Databases', { exact: true }).first().click();
  await page.locator('[data-resource-edit-id="1"]').first().waitFor({ timeout: 20000 });
  await page.locator('[data-resource-edit-id="1"]').first().click();
  await page.locator('#resource-edit-tab-collection').waitFor({ timeout: 20000 });
  await page.locator('#resource-edit-tab-collection').click();
  for (let i = 0; i < 40; i++) {
    if (await page.getByRole('button', { name: '检查配置' }).count()) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
};
const newPage = async (browser, viewport = { width: 1440, height: 900 }) => {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(payload => {
    localStorage.setItem('token', payload.token);
    localStorage.setItem('refreshToken', payload.refreshToken);
    localStorage.setItem('user', JSON.stringify(payload.user));
  }, session);
  return page;
};
const runBrowserTrial = async page => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const button = page.getByRole('button', { name: '试采' });
    if (await button.isEnabled()) {
      await button.click();
      await waitFor(page, text => text.includes('试用凭证') || text.includes('试采未满足'), 12000);
      if ((await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION')).includes('试用凭证')) return true;
    }
    await page.waitForTimeout(3000);
  }
  return false;
};
const writeCount = label => requests.filter(entry => entry.label === label && entry.kind !== 'response' && entry.method !== 'GET').length;
const ensureCapabilities = async () => {
  for (let i = 0; i < 60; i++) {
    const row = await one("SELECT capabilities FROM metric_policy_bindings WHERE resource_key='instance:1'");
    const caps = typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities;
    const latest = (caps ?? []).map(capability => capability.valid_until).sort().at(-1);
    if (latest && Date.parse(latest) - Date.now() > 60000) return latest;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return null;
};
const bindingRow = () => one("SELECT JSON_EXTRACT(payload,'$.binding.revision') revision, JSON_EXTRACT(payload,'$.pending.target_revision') target, JSON_EXTRACT(payload,'$.application.status') application, JSON_EXTRACT(payload,'$.application.applied_revision') applied FROM metric_policy_bindings WHERE resource_key='instance:1'");
const operationRows = () => rows('SELECT caller_key, resource_key, target_revision, status FROM metric_policy_operations ORDER BY id');
const auditRows = () => rows("SELECT target, JSON_EXTRACT(payload,'$.revision') revision FROM metric_policy_audit WHERE target LIKE '%instance:1%' ORDER BY id");

const browser = await chromium.launch();

/* ---- A: select/cancel/search/pagination, real preview/trial, lost response recovery ---- */
{
  const page = await newPage(browser); capture(page, 'A');
  const before = await bindingRow();
  await openConfig(page);
  evidence.scenarios.A = { before, initial_text: (await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION')).slice(0, 1500) };
  evidence.scenarios.A.initial_selected = (await pageText(page)).includes('已选 1 个');
  // cancel the selection: no write may leave the page
  const writesBeforeCancel = writeCount('A');
  await page.getByRole('button', { name: /移除 MySQL by ODBC/ }).click();
  await page.waitForTimeout(1200);
  evidence.scenarios.A.cancel = { unselected: (await pageText(page)).includes('未选择'), writes: writeCount('A') - writesBeforeCancel };
  // search the full catalog and pick the exact published version
  await page.getByLabel('搜索模板名称').fill('MySQL');
  await page.waitForTimeout(900);
  const searchText = await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION');
  evidence.scenarios.A.search = { has_mysql: searchText.includes('MySQL by ODBC'), has_dummy: searchText.includes('分页测试模板') };
  await page.getByLabel('选择模板 MySQL by ODBC').check();
  await page.waitForTimeout(800);
  // clear search and page the rest of the catalog
  await page.getByLabel('搜索模板名称').fill('');
  await page.waitForTimeout(600);
  const more = page.getByRole('button', { name: '加载更多模板' });
  await more.waitFor({ timeout: 8000 }).catch(() => {});
  evidence.scenarios.A.pagination = { has_more: await more.count() > 0 };
  if (await more.count()) { await more.click(); await page.waitForTimeout(1200); }
  const pagedText = await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION');
  evidence.scenarios.A.pagination.draft_reason = pagedText.includes('模板为草稿，未发布');
  evidence.scenarios.A.pagination.all_loaded = (await page.getByRole('button', { name: '加载更多模板' }).count()) === 0;
  evidence.scenarios.A.pagination.dummy_visible = pagedText.includes('分页测试模板');
  await page.screenshot({ path: `${OUT}/a-1440-select.png`, fullPage: true });
  // preview (wait for the real scheduled run to refresh capability evidence)
  evidence.scenarios.A.capability_valid_until = await ensureCapabilities();
  await page.getByRole('button', { name: '检查配置' }).click();
  await waitFor(page, text => text.includes('可试采') || text.includes('不可执行'));
  evidence.scenarios.A.preview_text = (await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION')).slice(0, 2000);
  // trial (real read-only read against mysql3306); the schedule may be busy
  evidence.scenarios.A.trial_started = await runBrowserTrial(page);
  await page.waitForTimeout(1000);
  const uiAfterTrial = await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION');
  evidence.scenarios.A.trial = { passed: uiAfterTrial.includes('试采通过'), sample_text: uiAfterTrial.match(/值 [^\n]*/)?.[0] ?? null };
  await page.screenshot({ path: `${OUT}/a-1440-trial.png`, fullPage: true });
  // one successful submit, but drop the HTTP response (the server is allowed to commit)
  let applyFetches = 0; let applyRequestBody = null;
  await page.route('**/api/metrics/template-bindings/instance/1/apply', async route => {
    applyFetches += 1;
    try { applyRequestBody = JSON.parse(route.request().postData() || 'null'); } catch { applyRequestBody = null; }
    const response = await route.fetch();
    evidence.scenarios.A.apply_response = { status: response.status(), body: await response.json().catch(() => null) };
    await route.abort('failed');
  });
  const operationsBefore = (await operationRows()).length;
  const aApply = page.getByRole('button', { name: '应用并启用' });
  const aApplyEnabled = await aApply.isEnabled();
  if (aApplyEnabled) await aApply.click();
  await waitFor(page, text => text.includes('配置已提交') || text.includes('已确认上次发布提交') || text.includes('上次发布结果尚未确认'), 30000);
  await page.waitForTimeout(4000);
  const afterApplyText = await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION');
  const operationsAfter = await operationRows();
  evidence.scenarios.A.apply = {
    apply_enabled: aApplyEnabled, fetches: applyFetches, caller_key: applyRequestBody?.caller_key ?? null,
    recovered: afterApplyText.includes('配置已提交') || afterApplyText.includes('已确认上次发布提交'),
    pending_prompt: afterApplyText.includes('上次发布结果尚未确认'),
    operations_added: operationsAfter.length - operationsBefore,
    operation_lookup_requests: requests.filter(entry => entry.label === 'A' && entry.path?.includes('/operations/')).length,
    binding: await bindingRow(), audits: await auditRows(),
  };
  await page.screenshot({ path: `${OUT}/a-1440-after-apply.png`, fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/a-1366.png`, fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/a-1920.png`, fullPage: true });
  // reload: the committed intent must not reappear as a blind retry
  await page.unroute('**/api/metrics/template-bindings/instance/1/apply');
  await page.reload({ waitUntil: 'networkidle' });
  await openConfig(page);
  await ensureCapabilities();
  const reloadText = await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION');
  evidence.scenarios.A.reload = { published: /发布（已提交）\s*\d+/.test(reloadText), pending_prompt: reloadText.includes('上次发布结果尚未确认'),
    target: reloadText.match(/目标版本 (\d+)/)?.[1] ?? null, text: reloadText.slice(0, 1200) };
  await page.close();
}

/* ---- B: concurrent revision change is refused, reload recovers ---- */
{
  const page = await newPage(browser); capture(page, 'B');
  await openConfig(page);
  evidence.scenarios.B = { capability_valid_until: await ensureCapabilities() };
  await page.getByRole('button', { name: '检查配置' }).click();
  await waitFor(page, text => text.includes('可试采') || text.includes('不可执行'));
  evidence.scenarios.B.trial_started = await runBrowserTrial(page);
  const current = await bindingRow();
  const pin = (await api('GET', '/api/metrics/template-bindings/instance/1')).data.template_pins[0];
  const overrides = { interval_ms: { mode: 'set', value: 120000 } };
  let trial = null, receipt = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    receipt = `conflict-trial-${Date.now().toString(36)}-${attempt}`;
    trial = await api('POST', '/api/metrics/template-bindings/instance/1/trial', { expected_revision: Number(current.revision),
      template_pins: [pin], overrides, receipt_id: receipt });
    if (trial.status !== 409) break;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  const apply = trial?.status === 200
    ? await api('POST', '/api/metrics/template-bindings/instance/1/apply', { expected_revision: Number(current.revision),
      template_pins: [pin], overrides, receipt_id: receipt, caller_key: `conflict-apply-${Date.now().toString(36)}` })
    : { status: 0, data: { skipped: 'trial busy' } };
  const bumped = await bindingRow();
  const bApply = page.getByRole('button', { name: '应用并启用' });
  const bApplyEnabled = await bApply.isEnabled();
  let conflictText = '';
  if (bApplyEnabled) {
    await bApply.click();
    await waitFor(page, text => text.includes('配置版本已被他人更新') || text.includes('无法确认'), 20000);
    await page.waitForTimeout(1000);
    conflictText = await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION');
  }
  evidence.scenarios.B = { ...evidence.scenarios.B, direct_trial: trial?.status ?? null, direct_apply: apply.status, direct_apply_kind: apply.data?.kind,
    apply_enabled: bApplyEnabled, revision_after_direct: bumped.revision, conflict_shown: conflictText.includes('配置版本已被他人更新'),
    text: conflictText.slice(0, 1200) };
  await page.screenshot({ path: `${OUT}/b-conflict.png`, fullPage: true });
  await page.getByRole('button', { name: '重新加载配置' }).click();
  await page.waitForTimeout(2500);
  if (await page.getByRole('button', { name: '放弃修改并继续' }).count()) await page.getByRole('button', { name: '放弃修改并继续' }).click();
  await page.waitForTimeout(3000);
  const reloadText = await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION');
  evidence.scenarios.B.after_reload_target = reloadText.match(/目标版本 (\d+)/)?.[1] ?? null;
  await page.close();
}

/* ---- C: permission revocation during apply is refused, no write ---- */
{
  const page = await newPage(browser); capture(page, 'C');
  await openConfig(page);
  evidence.scenarios.C = { capability_valid_until: await ensureCapabilities() };
  await page.getByRole('button', { name: '检查配置' }).click();
  await waitFor(page, text => text.includes('可试采') || text.includes('不可执行'));
  evidence.scenarios.C.trial_started = await runBrowserTrial(page);
  const before = await bindingRow();
  const operationsBefore = (await operationRows()).length;
  const cApply = page.getByRole('button', { name: '应用并启用' });
  let applyEnabled = false;
  for (let i = 0; i < 30; i++) { if (await cApply.isEnabled()) { applyEnabled = true; break; } await page.waitForTimeout(500); }
  // Act before the background status poll observes the revocation: the click
  // itself must be refused, not merely the later poll.
  await page.evaluate(() => {
    const found = [];
    const walk = root => { for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) walk(element.shadowRoot);
      if (element.tagName === 'NATIVE-TEMPLATE-CONFIGURATION') found.push(element);
    } };
    walk(document);
    found.at(-1)?.stopPolling?.();
  });
  // Permission revocation, not session expiry: reading/status polling stays
  // authorized while the write boundary must refuse the apply.
  const userId = (await rows("SELECT id FROM users WHERE username='e2e-admin'"))[0].id;
  const roleId = (await rows("SELECT id FROM roles WHERE name='admin'"))[0].id;
  // Drop the wildcard role and leave only the read-only instance grant: reads
  // (status polling) stay allowed, while the write boundary must refuse.
  await db.query('DELETE FROM user_roles WHERE user_id=? AND role_id=?', [userId, roleId]);
  await db.query("UPDATE instance_permissions SET access_level='read-only' WHERE user_id=? AND instance_id=1", [userId]);
  try {
    const applyStatus = page.waitForResponse(response => response.url().endsWith('/template-bindings/instance/1/apply')
      && response.request().method() === 'POST', { timeout: 20000 }).then(response => response.status()).catch(() => null);
    if (applyEnabled) await cApply.click();
    const status = await applyStatus;
    await waitFor(page, text => text.includes('没有此资源的操作权限') || text.includes('登录已失效'), 20000);
    await page.waitForTimeout(1000);
    const text = await deepText(page, 'NATIVE-TEMPLATE-CONFIGURATION');
    evidence.scenarios.C = { ...evidence.scenarios.C, apply_enabled_before_revoke: applyEnabled, apply_status: status,
      refused: status === 403 || text.includes('没有此资源的操作权限') || text.includes('登录已失效'),
      text: text.slice(0, 800), binding_unchanged: JSON.stringify(await bindingRow()) === JSON.stringify(before),
      operations_unchanged: (await operationRows()).length === operationsBefore };
    await page.screenshot({ path: `${OUT}/c-revoked.png`, fullPage: true });
  } finally {
    await db.query('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, roleId]);
    await db.query("UPDATE instance_permissions SET access_level='admin' WHERE user_id=? AND instance_id=1", [userId]);
  }
  await page.close();
}

evidence.finished_at = new Date().toISOString();
evidence.requests = requests;
writeFileSync(`${OUT}/evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({
  A: { initial_selected: evidence.scenarios.A.initial_selected, cancel: evidence.scenarios.A.cancel, search: evidence.scenarios.A.search,
    pagination: evidence.scenarios.A.pagination, trial: evidence.scenarios.A.trial, apply: evidence.scenarios.A.apply, reload: evidence.scenarios.A.reload?.pending_prompt },
  B: { direct_apply: evidence.scenarios.B.direct_apply, kind: evidence.scenarios.B.direct_apply_kind, revision: evidence.scenarios.B.revision_after_direct,
    conflict: evidence.scenarios.B.conflict_shown, after_reload_target: evidence.scenarios.B.after_reload_target },
  C: { refused: evidence.scenarios.C.refused, binding_unchanged: evidence.scenarios.C.binding_unchanged, operations_unchanged: evidence.scenarios.C.operations_unchanged },
}, null, 2));
await browser.close(); await db.end();
