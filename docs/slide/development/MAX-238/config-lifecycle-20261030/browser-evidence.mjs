/**
 * MAX238-NATIVE-CONFIGURATION-FLOW-R1 — browser evidence.
 *
 * Drives the real Lit components against the real Fastify API and the one-off
 * platform database. Run from `frontend/` so `@playwright/test` resolves.
 *
 * Scenarios:
 *   A  a legacy package resource: the legacy editor is the default, an explicit
 *      control enters the native flow, and the stored overrides are seeded and
 *      sent back unchanged by the preview request.
 *   B  cancel: selecting then deselecting a template issues no write request.
 *   C  unknown apply: the response is dropped with a real aborted request; the
 *      unconfirmed intent survives a page reload and is recovered by querying
 *      the native journal, without a second revision.
 *   D  a delayed preview for a resource the operator leaves never lands on the
 *      resource they switched to.
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
const require = createRequire(`${REPO_ROOT}/apps/db-ops-api/package.json`);
const { chromium } = createRequire(`${REPO_ROOT}/frontend/package.json`)('@playwright/test');
const mysql = require('mysql2/promise');
const db = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MAX238_DBPORT),
  user: 'root', password: process.env.MAX238_DBPW, database: process.env.MAX238_DB, timezone: 'Z' });
const one = async (sql, params = []) => (await db.query(sql, params))[0][0];

const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'life-admin', password: process.env.MAX238_ADMIN_PASSWORD }) });
const session = await login.json();
const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
const api = async (method, path, body) => {
  const response = await fetch(`${API}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json().catch(() => null) };
};

const UI_RESOURCE = Number(process.env.MAX238_UI_RESOURCE || 3);
const UNBOUND_RESOURCE = Number(process.env.MAX238_UNBOUND_RESOURCE || 1);
const evidence = { started_at: new Date().toISOString(), viewports: {} };
const browser = await chromium.launch();

const collectText = () => {
  const out = [];
  const visit = node => {
    if (node.nodeType === Node.TEXT_NODE) { const text = (node.textContent || '').trim(); if (text) out.push(text); return; }
    if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'STYLE' || node.tagName === 'SCRIPT') return;
    if (node.shadowRoot) visit(node.shadowRoot);
    for (const child of node.childNodes) visit(child);
  };
  visit(document);
  return out.join('\n').replace(/\n{2,}/g, '\n');
};
const pageText = page => page.evaluate(collectText);
/** True only when the control exists and is enabled right now. */
const enabled = async (page, name) => {
  const button = page.getByRole('button', { name });
  try { return (await button.count()) > 0 && await button.first().isEnabled({ timeout: 1000 }); } catch { return false; }
};
/** Click a control once it exists and is enabled; returns false when it never is. */
const clickEnabled = async (page, name, timeout = 30000) => {
  const button = page.getByRole('button', { name });
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await button.count() && await button.first().isEnabled()) { await button.first().click(); return true; }
    await page.waitForTimeout(500);
  }
  return false;
};
const waitFor = async (page, predicate, timeout = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate(await pageText(page))) return true;
    await page.waitForTimeout(400);
  }
  return false;
};
const newPage = async (viewport = { width: 1440, height: 900 }) => {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(payload => {
    localStorage.setItem('token', payload.token);
    localStorage.setItem('refreshToken', payload.refreshToken);
    localStorage.setItem('user', JSON.stringify(payload.user));
  }, session);
  return page;
};
const openCollection = async (page, id) => {
  await page.goto(`${PAGE}/`, { waitUntil: 'networkidle' });
  await page.getByText('Databases', { exact: true }).first().click();
  await page.locator(`[data-resource-edit-id="${id}"]`).first().waitFor({ timeout: 20000 });
  await page.locator(`[data-resource-edit-id="${id}"]`).first().click();
  await page.locator('#resource-edit-tab-collection').waitFor({ timeout: 20000 });
  await page.locator('#resource-edit-tab-collection').click();
  await page.waitForTimeout(2500);
};
const nativeState = page => page.evaluate(() => {
  // The editor is nested inside the wrapper's shadow root; walk every root.
  const find = root => {
    for (const element of root.querySelectorAll('*')) {
      if (element.tagName === 'NATIVE-TEMPLATE-CONFIGURATION') return element;
      if (element.shadowRoot) { const found = find(element.shadowRoot); if (found) return found; }
    }
    return null;
  };
  const host = find(document);
  if (!host) return null;
  const state = {};
  for (const key of ['loaded', 'canManage', 'selected', 'settings', 'metricToggles', 'parameters', 'groupId',
    'preview', 'trial', 'dirty', 'unresolved', 'applyResult', 'step', 'error', 'binding']) {
    state[key] = host[key];
  }
  return JSON.parse(JSON.stringify(state));
});

/* --- A. explicit entry, lossless seeding, real preview/trial/apply -------- */
{
  const page = await newPage();
  const posted = [];
  const replies = [];
  page.on('request', request => {
    if (request.method() === 'GET') return;
    if (!request.url().includes('/api/metrics/')) return;
    posted.push({ method: request.method(), path: request.url().replace(PAGE, ''), body: request.postData() });
  });
  page.on('response', response => {
    const url = response.url();
    if (/\/api\/metrics\/(template-bindings|templates)/.test(url)) replies.push({ status: response.status(), path: url.replace(PAGE, '') });
  });
  await openCollection(page, UI_RESOURCE);
  const legacyText = await pageText(page);
  const entry = page.getByRole('button', { name: '改用固定版本模板配置' });
  const entryVisible = await entry.count() > 0;
  if (entryVisible) await entry.click();
  await waitFor(page, text => text.includes('选择适合此对象的模板'), 20000);
  const seeded = await nativeState(page);
  const catalog = (await api('GET', '/api/metrics/templates')).data;
  const template = catalog.templates[0];
  const checkbox = page.getByRole('checkbox', { name: `选择模板 ${template.name}` });
  if (await checkbox.count()) await checkbox.first().check();
  await page.waitForTimeout(800);
  await clickEnabled(page, '检查配置');
  await waitFor(page, text => text.includes('监控项') || text.includes('不可执行'), 20000);
  const previewBody = posted.filter(entry => entry.path.endsWith('/preview')).at(-1);
  let trial = 'skipped';
  if (await clickEnabled(page, '试采', 20000)) {
    if (await waitFor(page, text => text.includes('试用凭证') || text.includes('试采未满足'), 25000)) trial = 'attempted';
  } else trial = 'not_ready';
  let applied = null;
  if (await clickEnabled(page, /应用并启用|首次绑定并启用/, 20000)) {
    if (await waitFor(page, text => text.includes('配置已提交') || text.includes('上次发布已提交'), 30000)) {
      applied = (await nativeState(page))?.applyResult ?? null;
    }
  }
  const after = (await api('GET', `/api/metrics/template-bindings/instance/${UI_RESOURCE}`)).data;
  evidence.scenarios = evidence.scenarios || {};
  evidence.scenarios.entry_and_lossless = {
    legacy_editor_default: legacyText.includes('旧版单包') || legacyText.includes('推荐模板'),
    explicit_entry_visible: entryVisible,
    seeded: seeded ? { selected: seeded.selected, settings: seeded.settings, metricToggles: seeded.metricToggles,
      parameters: seeded.parameters, groupId: seeded.groupId, binding_source: seeded.binding?.source } : null,
    preview_request: previewBody ? JSON.parse(previewBody.body) : null,
    trial,
    applied,
    binding_after: { source: after.source, revision: after.revision, configuration: after.configuration },
    replies: replies.filter(reply => reply.path.includes('/template-bindings/')),
  };
  await page.close();
}

/* --- B. cancel writes nothing -------------------------------------------- */
{
  const page = await newPage();
  const writes = [];
  const otherPosts = [];
  page.on('request', request => {
    if (request.method() === 'GET' || !request.url().includes('/api/metrics/')) return;
    const path = request.url().replace(PAGE, '');
    // Only a configuration write could change the resource; page queries are not.
    if (/\/template-bindings\/|\/config\/resources\//.test(path)) writes.push({ method: request.method(), path });
    else otherPosts.push({ method: request.method(), path });
  });
  await openCollection(page, UNBOUND_RESOURCE);
  await waitFor(page, text => text.includes('选择适合此对象的模板'), 20000);
  const catalog = (await api('GET', '/api/metrics/templates')).data;
  const checkbox = page.getByRole('checkbox', { name: `选择模板 ${catalog.templates[0].name}` });
  if (await checkbox.count()) {
    await checkbox.first().check();
    await checkbox.first().uncheck();
  }
  await page.waitForTimeout(1200);
  const state = await nativeState(page);
  evidence.scenarios.cancel = { selected: state?.selected, config_writes: writes,
    other_posts: otherPosts.length, config_writes_count: writes.length,
    binding: (await api('GET', `/api/metrics/template-bindings/instance/${UNBOUND_RESOURCE}`)).data.source };
  await page.close();
}

/* --- C. unknown apply, reload, journal recovery -------------------------- */
{
  const page = await newPage();
  const before = (await api('GET', `/api/metrics/template-bindings/instance/${UI_RESOURCE}`)).data;
  const journalQueries = [];
  await page.route('**/api/metrics/template-bindings/**/apply', async route => {
    // Let the real request reach the server, then drop the response.
    const response = await route.fetch();
    await response.body().catch(() => null);
    await route.abort('failed');
  });
  page.on('request', request => {
    if (request.url().includes('/operations/')) journalQueries.push(request.url().replace(PAGE, ''));
  });
  await openCollection(page, UI_RESOURCE);
  await waitFor(page, text => text.includes('选择适合此对象的模板'), 20000);
  // Re-preview and trial from the seeded configuration, then apply.
  await clickEnabled(page, '检查配置');
  await waitFor(page, text => text.includes('监控项') || text.includes('不可执行'), 20000);
  await clickEnabled(page, '试采', 20000);
  await waitFor(page, text => text.includes('试用凭证') || text.includes('试采未满足'), 25000);
  let unknownShown = false;
  if (await clickEnabled(page, /应用并启用/, 20000)) {
    unknownShown = await waitFor(page, text => text.includes('上次发布结果尚未确认'), 25000);
  }
  const storedBeforeReload = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(entry => entry.startsWith('slide.metric.native.apply.'));
    return key ? { key, value: JSON.parse(sessionStorage.getItem(key)) } : null;
  });
  const afterApply = (await api('GET', `/api/metrics/template-bindings/instance/${UI_RESOURCE}`)).data;
  // Reload the page: the intent must be restored and the journal re-queried.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Databases', { exact: true }).first().click();
  await page.locator(`[data-resource-edit-id="${UI_RESOURCE}"]`).first().click();
  await page.locator('#resource-edit-tab-collection').click();
  await waitFor(page, text => text.includes('选择适合此对象的模板'), 20000);
  await page.waitForTimeout(2500);
  const afterReload = await nativeState(page);
  const storedAfterReload = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(entry => entry.startsWith('slide.metric.native.apply.'));
    return key ? { key, value: JSON.parse(sessionStorage.getItem(key)) } : null;
  });
  const bindingAfterReload = (await api('GET', `/api/metrics/template-bindings/instance/${UI_RESOURCE}`)).data;
  evidence.scenarios.unknown = {
    revision_before: before.revision,
    unknown_shown: unknownShown,
    stored_before_reload: storedBeforeReload,
    revision_after_apply: afterApply.revision,
    stored_after_reload: storedAfterReload,
    unresolved_after_reload: afterReload?.unresolved,
    journal_queries: journalQueries,
    revision_after_reload: bindingAfterReload.revision,
  };
  await page.unroute('**/api/metrics/template-bindings/**/apply');
  await page.close();
}

/* --- D. a delayed preview never lands on the resource switched to -------- */
{
  const page = await newPage();
  await page.route('**/api/metrics/template-bindings/instance/*/preview', async route => {
    await new Promise(resolve => setTimeout(resolve, 6000));
    await route.continue();
  });
  await openCollection(page, UI_RESOURCE);
  await waitFor(page, text => text.includes('选择适合此对象的模板'), 20000);
  const catalog = (await api('GET', '/api/metrics/templates')).data;
  const checkbox = page.getByRole('checkbox', { name: `选择模板 ${catalog.templates[0].name}` });
  if (await checkbox.count() && await checkbox.first().isEnabled()) await checkbox.first().check();
  await page.waitForTimeout(500);
  await clickEnabled(page, '检查配置');
  // Leave the resource while the preview is still in flight.
  await page.goto(`${PAGE}/`, { waitUntil: 'networkidle' });
  await page.getByText('Databases', { exact: true }).first().click();
  await page.locator(`[data-resource-edit-id="${UNBOUND_RESOURCE}"]`).first().click();
  await page.locator('#resource-edit-tab-collection').click();
  await waitFor(page, text => text.includes('选择适合此对象的模板'), 20000);
  await page.waitForTimeout(8000);
  const state = await nativeState(page);
  evidence.scenarios.late_response = { preview_on_new_resource: state?.preview ?? null, error: state?.error ?? null,
    selected: state?.selected ?? null };
  await page.unroute('**/api/metrics/template-bindings/instance/*/preview');
  await page.close();
}

/* --- viewports ------------------------------------------------------------ */
for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  const page = await newPage(viewport);
  await openCollection(page, UI_RESOURCE);
  await waitFor(page, text => text.includes('选择适合此对象的模板'), 20000);
  await page.screenshot({ path: `${OUT}/ui-${viewport.width}.png` });
  evidence.viewports[viewport.width] = { text_ok: (await pageText(page)).includes('选择适合此对象的模板') };
  await page.close();
}

await browser.close();
writeFileSync(`${OUT}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 1));
await db.end();
