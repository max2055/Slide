/**
 * MAX238-NATIVE-CONFIGURATION-FLOW-R4 — real browser evidence.
 *
 * Real Chromium → real Vite → real Fastify → one-off MySQL 8.4 (non-3306) with a
 * real read-only target. Three cases:
 *
 * A. The signed session is valid but the cached `user` profile is unreadable.
 *    The apply reaches the server and its answer is lost. After a full page
 *    refresh the intent is recovered by the key derived from the signed token.
 *    While that recovery query is in flight the operator edits the interval;
 *    the committed answer must settle only the old intent and must not clear
 *    the new draft. The database keeps exactly one binding, operation and audit.
 * B. sessionStorage cannot store the intent: the write is refused before it is
 *    sent, the draft stays and no operation/audit/binding is written.
 * C. The session disappears between the trial and the apply: no reliable
 *    principal exists, so the write is refused and the draft is kept.
 *
 * Run from the repository root with `node docs/.../r4-browser/flow.mjs`.
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = process.env.MAX238_EVIDENCE_DIR;
if (!OUT) throw new Error('MAX238_EVIDENCE_DIR is required');
mkdirSync(OUT, { recursive: true });
const PAGE = process.env.MAX238_PAGE || 'http://127.0.0.1:5173';
const API = process.env.MAX238_API || 'http://127.0.0.1:3001';
const RESOURCE = Number(process.env.MAX238_UNBOUND_RESOURCE || 1);
const RESOURCE2 = Number(process.env.MAX238_UNBOUND2_RESOURCE || 2);
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
if (!session?.token || !session?.user) throw new Error('login failed');
const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
const api = async (method, path) => {
  const response = await fetch(`${API}${path}`, { method, headers: auth });
  return { status: response.status, data: await response.json().catch(() => null) };
};
const counts = async () => ({
  bindings: Number((await one('SELECT COUNT(*) c FROM metric_policy_bindings'))?.c ?? 0),
  operations: Number((await one('SELECT COUNT(*) c FROM metric_policy_operations'))?.c ?? 0),
  audits: Number((await one('SELECT COUNT(*) c FROM metric_policy_audit'))?.c ?? 0),
});
const evidence = { started_at: new Date().toISOString(), viewport: { width: 1440, height: 900 },
  resources: { A: RESOURCE, B: RESOURCE2 }, signed_user: { id: session.user.id, username: session.user.username },
  counts: { before: await counts() } };

const collectText = () => {
  const out = [];
  const visit = node => {
    if (node.nodeType === Node.TEXT_NODE) { const text = (node.textContent || '').trim(); if (text) out.push(text); return; }
    if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.childNodes) visit(child); return;
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
const clickEnabled = async (page, name, timeout = 30000) => {
  const button = page.getByRole('button', { name });
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await button.count() && await button.first().isEnabled()) { await button.first().click(); return true; }
    await page.waitForTimeout(400);
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
const nativeState = page => page.evaluate(() => {
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
  for (const key of ['loaded', 'canManage', 'selected', 'settings', 'parameters', 'metricToggles', 'groupId',
    'dirty', 'unresolved', 'applyResult', 'step', 'error', 'intentStorageLimited', 'intentStorageError',
    'binding', 'trial', 'preview']) {
    state[key] = host[key];
  }
  return JSON.parse(JSON.stringify(state));
});
const intentsOf = page => page.evaluate(() => {
  const out = [];
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (!key || !key.startsWith('slide.metric.native.apply.')) continue;
    try { out.push({ key, records: JSON.parse(sessionStorage.getItem(key)) }); } catch { out.push({ key, records: null }); }
  }
  return out;
});
const openCollection = async (page, resource) => {
  // The app's own cross-view URL contract opens the instance editor directly;
  // clicking through the nav is locale/`exact` dependent.
  await page.goto(`${PAGE}/?tab=instances-db`, { waitUntil: 'domcontentloaded' });
  await page.locator(`[data-resource-edit-id="${resource}"]`).first().waitFor({ timeout: 30000 });
  await page.locator(`[data-resource-edit-id="${resource}"]`).first().click();
  await page.locator('#resource-edit-tab-collection').waitFor({ timeout: 30000 });
  await page.locator('#resource-edit-tab-collection').click();
  return waitFor(page, text => text.includes('选择适合此对象的模板'), 30000);
};
const selectTemplateAndTrial = async (page) => {
  const catalog = (await api('GET', '/api/metrics/templates')).data;
  const template = catalog.templates.find(entry => entry.name === 'MAX238 lifecycle template') ?? catalog.templates[0];
  await page.getByRole('checkbox', { name: `选择模板 ${template.name}` }).first().check();
  await page.waitForTimeout(800);
  const checked = await clickEnabled(page, '检查配置');
  const previewShown = await waitFor(page, text => text.includes('可试采') || text.includes('不可执行'), 30000);
  const trialClicked = await clickEnabled(page, '试采', 30000);
  const trialPassed = trialClicked && await waitFor(page, text => text.includes('试采通过'), 40000);
  return { checked, previewShown, trialClicked, trialPassed };
};
/** A real operator edit: switch the interval override on and type a new value. */
const editIntervalSeconds = async (page, seconds) => {
  await page.getByLabel('采集间隔（秒）覆盖方式').first().selectOption('set');
  const input = page.getByLabel('采集间隔（秒）', { exact: true }).first();
  await input.waitFor({ timeout: 10000 });
  await input.fill(String(seconds));
  await input.dispatchEvent('input');
  await page.waitForTimeout(300);
};

const browser = await chromium.launch();

/* --- Case A: corrupt profile cache, lost answer, refresh + live edit -------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(payload => {
    localStorage.setItem('token', payload.token);
    localStorage.setItem('refreshToken', payload.refreshToken);
    localStorage.setItem('user', JSON.stringify(payload.user));
    // The cached profile is not the session: corrupt it on purpose.
    localStorage.setItem('user', '{corrupt-profile');
  }, session);
  const applies = [];
  let blockLookup = true;
  await page.route('**/apply', async route => {
    if (!route.request().url().includes('/template-bindings/')) return route.continue();
    applies.push(route.request().postData());
    await route.fetch();                              // the server really executes it
    await route.abort('failed').catch(() => undefined); // the page never sees the answer
  });
  await page.route('**/operations/**', route => blockLookup ? route.abort('failed').catch(() => undefined) : route.continue());

  const opened = await openCollection(page, RESOURCE);
  const flow = await selectTemplateAndTrial(page);
  const clicked = await clickEnabled(page, /首次绑定并启用/, 30000);
  for (let i = 0; i < 60 && !applies.length; i += 1) await page.waitForTimeout(250);
  await page.waitForTimeout(1500);
  const beforeReload = await nativeState(page);
  const intentsBefore = await intentsOf(page);
  const stored = intentsBefore.flatMap(entry => entry.records ?? []);
  evidence.caseA = { opened, ...flow, clicked, applies: applies.length,
    corrupt_profile: await page.evaluate(() => localStorage.getItem('user')),
    stored_intent: stored[0] ? { key: stored[0].key, pending: stored[0].pending } : null,
    state_before_reload: { dirty: beforeReload?.dirty, unresolved: beforeReload?.unresolved?.length ?? 0 } };

  blockLookup = false;
  await page.unroute('**/operations/**');
  // The recovery answer is real but slow: it arrives while the operator edits.
  const operationTimeline = [];
  const reloadStarted = Date.now();
  page.on('request', request => {
    if (request.url().includes('/operations/')) operationTimeline.push({ at_ms: Date.now() - reloadStarted, url: request.url() });
  });
  await page.route('**/operations/**', async route => {
    await new Promise(resolve => setTimeout(resolve, 15000));
    operationTimeline.push({ at_ms: Date.now() - reloadStarted, continued: route.request().url() });
    await route.continue();
  });
  // A real full page refresh: module memory is gone, only sessionStorage remains.
  const openedAgain = await openCollection(page, RESOURCE);
  const beforeEdit = await nativeState(page);
  const editApplied = await editIntervalSeconds(page, 70).then(() => true).catch(() => false);
  const duringLookup = await nativeState(page);
  const settled = await waitFor(page, text => text.includes('已确认上次发布已提交') || text.includes('已确认上次发布提交'), 20000);
  await page.waitForTimeout(2500);
  const afterReload = { state: await nativeState(page), intents: await intentsOf(page), counts: await counts() };
  await page.screenshot({ path: `${OUT}/a-refresh-edit-1440.png`, fullPage: true });
  const afterRecords = afterReload.intents.flatMap(entry => entry.records ?? []);
  evidence.caseA.after_refresh = {
    opened_again: openedAgain,
    operation_timeline: operationTimeline,
    edit_applied: editApplied,
    state_before_edit: { dirty: beforeEdit?.dirty, unresolved: beforeEdit?.unresolved?.length ?? 0,
      interval: beforeEdit?.settings?.interval_ms ?? null },
    state_during_lookup: { dirty: duringLookup?.dirty, interval: duringLookup?.settings?.interval_ms ?? null,
      unresolved: duringLookup?.unresolved?.length ?? 0 },
    committed_toast: settled,
    settings_after: afterReload.state?.settings ?? null,
    dirty_after: afterReload.state?.dirty === true,
    apply_result_after: afterReload.state?.applyResult ?? null,
    unresolved_after: afterReload.state?.unresolved?.length ?? 0,
    intent_keys: afterReload.intents.map(entry => entry.key),
    intents: afterRecords.map(record => ({ key: record.key, pending: record.pending })),
    binding: { source: afterReload.state?.binding?.source, revision: afterReload.state?.binding?.revision },
    counts: afterReload.counts,
  };
  await page.close();
}

/* --- Case B: storage cannot record the intent → refuse before sending ------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(payload => {
    localStorage.setItem('token', payload.token);
    localStorage.setItem('refreshToken', payload.refreshToken);
    localStorage.setItem('user', JSON.stringify(payload.user));
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).includes('slide.metric.native.apply.')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  }, session);
  const applies = [];
  await page.route('**/apply', route => {
    if (route.request().url().includes('/template-bindings/')) applies.push(route.request().postData());
    return route.continue();
  });
  const opened = await openCollection(page, RESOURCE2);
  const flow = await selectTemplateAndTrial(page);
  const clicked = await clickEnabled(page, /首次绑定并启用/, 30000);
  await page.waitForTimeout(2500);
  const state = await nativeState(page);
  const text = await pageText(page);
  await page.screenshot({ path: `${OUT}/b-storage-refusal-1440.png`, fullPage: true });
  evidence.caseB = { opened, ...flow, clicked, applies: applies.length,
    refused_text: /拒绝本次发布/.test(text),
    storage_limited: state?.intentStorageLimited === true,
    dirty: state?.dirty === true,
    interval: state?.settings?.interval_ms ?? null,
    counts: await counts() };
  await page.close();
}

/* --- Case C: the session is gone between trial and apply -------------------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(payload => {
    localStorage.setItem('token', payload.token);
    localStorage.setItem('refreshToken', payload.refreshToken);
    localStorage.setItem('user', JSON.stringify(payload.user));
  }, session);
  const applies = [];
  await page.route('**/apply', route => {
    if (route.request().url().includes('/template-bindings/')) applies.push(route.request().postData());
    return route.continue();
  });
  const opened = await openCollection(page, RESOURCE);
  // A real operator edit before the trial, so the trial and the apply carry it.
  await editIntervalSeconds(page, 65).catch(() => undefined);
  const flow = await selectTemplateAndTrial(page);
  // A controlled session loss: the signed token disappears before the write.
  const before = await nativeState(page);
  await page.evaluate(() => localStorage.removeItem('token'));
  const clicked = await clickEnabled(page, /应用并启用|首次绑定并启用/, 30000);
  await page.waitForTimeout(1500);
  const state = await nativeState(page);
  const text = await pageText(page);
  await page.screenshot({ path: `${OUT}/c-no-session-1440.png`, fullPage: true });
  evidence.caseC = { opened, ...flow, clicked, applies: applies.length,
    identity_refused: /无法确认当前登录主体/.test(text),
    dirty_before: before?.dirty === true,
    interval: state?.settings?.interval_ms ?? null,
    dirty_after: state?.dirty === true,
    counts: await counts() };
  await page.close();
}

writeFileSync(`${OUT}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
await browser.close();
await db.end();
