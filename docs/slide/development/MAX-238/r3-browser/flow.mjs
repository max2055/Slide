/**
 * MAX238-NATIVE-CONFIGURATION-FLOW-R3 — real browser evidence.
 *
 * Real Chromium → real Vite → real Fastify → one-off MySQL 8.4 (non-3306) with a
 * real read-only target. Two cases:
 *
 * A. The apply reaches the server but its HTTP response is lost, and the
 *    recovery journal read is unavailable too. The intent must already be
 *    durable (sessionStorage) before the request was sent; a full page refresh
 *    then recovers the query and the database holds exactly one revision,
 *    operation and audit row.
 * B. sessionStorage cannot store the intent. The write must be refused before
 *    it is sent, the draft stays on screen and no operation/audit/binding is
 *    written.
 *
 * Run from the repository root with `node docs/.../r3-browser/flow.mjs`.
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
const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
const api = async (method, path) => {
  const response = await fetch(`${API}${path}`, { method, headers: auth });
  return { status: response.status, data: await response.json().catch(() => null) };
};
const counts = async () => ({
  bindings: Number((await one('SELECT COUNT(*) c FROM metric_policy_bindings'))?.c ?? 0),
  evidence: Number((await one('SELECT COUNT(*) c FROM metric_capability_evidence'))?.c ?? 0),
  operations: Number((await one('SELECT COUNT(*) c FROM metric_policy_operations'))?.c ?? 0),
  audits: Number((await one('SELECT COUNT(*) c FROM metric_policy_audit'))?.c ?? 0),
});
const evidence = { started_at: new Date().toISOString(), viewport: { width: 1440, height: 900 },
  resources: { A: RESOURCE, B: RESOURCE2 }, counts: { before: await counts() } };

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
  for (const key of ['loaded', 'canManage', 'selected', 'settings', 'dirty', 'unresolved', 'applyResult',
    'step', 'error', 'intentStorageLimited', 'intentStorageError', 'binding', 'trial', 'preview']) {
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
  await page.goto(`${PAGE}/?tab=instances-db`, { waitUntil: 'networkidle' });
  try {
    await page.locator(`[data-resource-edit-id="${resource}"]`).first().waitFor({ timeout: 30000 });
    await page.locator(`[data-resource-edit-id="${resource}"]`).first().click();
    await page.locator('#resource-edit-tab-collection').waitFor({ timeout: 30000 });
    await page.locator('#resource-edit-tab-collection').click();
  } catch (error) {
    await page.screenshot({ path: `${OUT}/open-failed-${resource}.png`, fullPage: true });
    writeFileSync(`${OUT}/open-failed-${resource}.txt`, await pageText(page));
    throw error;
  }
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

const browser = await chromium.launch();

/* --- Case A: durable intent, lost response, full page refresh -------------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(payload => {
    localStorage.setItem('token', payload.token);
    localStorage.setItem('refreshToken', payload.refreshToken);
    localStorage.setItem('user', JSON.stringify(payload.user));
  }, session);
  const applies = [];
  let blockLookup = true;
  await page.route('**/apply', async route => {
    if (!route.request().url().includes('/template-bindings/')) return route.continue();
    applies.push(route.request().postData());
    const response = await route.fetch();   // the server really executes it
    void response;
    await route.abort('failed').catch(() => undefined); // the page never sees the answer
  });
  await page.route('**/operations/**', route => blockLookup ? route.abort('failed').catch(() => undefined) : route.continue());

  const opened = await openCollection(page, RESOURCE);
  const flow = await selectTemplateAndTrial(page);
  const clicked = await clickEnabled(page, /首次绑定并启用/, 30000);
  for (let i = 0; i < 60 && !applies.length; i += 1) await page.waitForTimeout(250);
  await page.waitForTimeout(1500);
  const beforeReload = { state: await nativeState(page), intents: await intentsOf(page), applies: applies.length };
  const stored = JSON.parse(beforeReload.intents[0]?.records ? JSON.stringify(beforeReload.intents[0].records) : '[]');
  evidence.caseA = { opened, ...flow, clicked, applies: applies.length,
    stored_intent: stored[0] ? { key: stored[0].key, pending: stored[0].pending, has_draft: typeof stored[0].draft === 'number' } : null,
    state_before_reload: { dirty: beforeReload.state?.dirty, unresolved: beforeReload.state?.unresolved?.length ?? 0 } };

  blockLookup = false;
  await page.unroute('**/operations/**');
  // A real page refresh: module memory is gone, only sessionStorage remains.
  await openCollection(page, RESOURCE);
  const settled = await waitFor(page, text => text.includes('发布（已提交）'), 30000);
  for (let i = 0; i < 20; i += 1) {
    const intents = await intentsOf(page);
    const records = intents.flatMap(entry => entry.records ?? []);
    if (records.length && records.every(record => record.pending === false)) break;
    await page.waitForTimeout(500);
  }
  const afterReload = { state: await nativeState(page), intents: await intentsOf(page), counts: await counts() };
  await page.screenshot({ path: `${OUT}/a-durable-refresh-1440.png`, fullPage: true });
  evidence.caseA.after_reload = {
    settled_text: settled,
    unresolved: afterReload.state?.unresolved?.length ?? 0,
    binding: { source: afterReload.state?.binding?.source, revision: afterReload.state?.binding?.revision },
    intents: afterReload.intents.flatMap(entry => entry.records ?? []).map(record => ({ key: record.key, pending: record.pending })),
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
    settings: state?.settings ?? null,
    counts: await counts() };
  await page.close();
}

writeFileSync(`${OUT}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
await browser.close();
await db.end();
