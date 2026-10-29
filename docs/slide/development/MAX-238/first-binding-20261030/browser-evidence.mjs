/**
 * MAX238-NATIVE-CONFIGURATION-FLOW-R2 — real browser evidence for the first
 * configuration of a completely unbound resource.
 *
 * Drives the real Lit `metric-configuration` wrapper → `native-template-configuration`
 * against the real Fastify API and the one-off platform database, with no binding
 * row and no capability fact at the start. The browser performs the explicit
 * "检查配置" action, which issues the real read-only bootstrap probe before the
 * preview, then the real trial and the host's first-binding transaction.
 *
 * Run from `frontend/` so `@playwright/test` resolves.
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
const evidence = { started_at: new Date().toISOString(), viewport: { width: 1440, height: 900 } };
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
  for (const key of ['loaded', 'canManage', 'selected', 'settings', 'metricToggles', 'parameters', 'groupId',
    'preview', 'trial', 'dirty', 'unresolved', 'applyResult', 'step', 'error', 'binding']) state[key] = host[key];
  return JSON.parse(JSON.stringify(state));
});
const counts = async () => ({
  bindings: Number((await one('SELECT COUNT(*) c FROM metric_policy_bindings'))?.c ?? 0),
  evidence: Number((await one('SELECT COUNT(*) c FROM metric_capability_evidence'))?.c ?? 0),
  operations: Number((await one('SELECT COUNT(*) c FROM metric_policy_operations'))?.c ?? 0),
  audits: Number((await one('SELECT COUNT(*) c FROM metric_policy_audit'))?.c ?? 0),
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(payload => {
  localStorage.setItem('token', payload.token);
  localStorage.setItem('refreshToken', payload.refreshToken);
  localStorage.setItem('user', JSON.stringify(payload.user));
}, session);
const posted = [];
page.on('request', request => {
  if (request.method() === 'GET' || !request.url().includes('/api/metrics/')) return;
  posted.push({ method: request.method(), path: request.url().replace(PAGE, ''), body: request.postData() });
});
const replies = [];
page.on('response', response => {
  const url = response.url();
  if (/\/api\/metrics\/(template-bindings|templates)/.test(url)) replies.push({ status: response.status(), path: url.replace(PAGE, '') });
});

evidence.before = {
  binding_status: (await api('GET', `/api/metrics/template-bindings/instance/${RESOURCE}`)).data,
  counts: await counts(),
};

await page.goto(`${PAGE}/`, { waitUntil: 'networkidle' });
await page.getByText('Databases', { exact: true }).first().click();
await page.locator(`[data-resource-edit-id="${RESOURCE}"]`).first().waitFor({ timeout: 20000 });
await page.locator(`[data-resource-edit-id="${RESOURCE}"]`).first().click();
await page.locator('#resource-edit-tab-collection').waitFor({ timeout: 20000 });
await page.locator('#resource-edit-tab-collection').click();
await waitFor(page, text => text.includes('选择适合此对象的模板'), 30000);

const catalog = (await api('GET', '/api/metrics/templates')).data;
const template = catalog.templates.find(entry => entry.name === 'MAX238 lifecycle template') ?? catalog.templates[0];
const checkbox = page.getByRole('checkbox', { name: `选择模板 ${template.name}` });
await checkbox.first().check();
await page.waitForTimeout(800);

const checked = await clickEnabled(page, '检查配置');
const previewShown = await waitFor(page, text => text.includes('可试采') || text.includes('不可执行'), 30000);
const afterPreview = { state: await nativeState(page), counts: await counts() };
const probeCall = posted.find(entry => entry.path.endsWith('/probe'));
const previewCall = posted.find(entry => entry.path.endsWith('/preview'));

const trialClicked = await clickEnabled(page, '试采', 30000);
const trialPassed = trialClicked && await waitFor(page, text => text.includes('试采通过') || text.includes('试采未满足'), 40000);

const applyClicked = await clickEnabled(page, /首次绑定并启用/, 30000);
const applyShown = applyClicked && await waitFor(page, text => text.includes('配置已提交') || text.includes('无法确认'), 40000);
const afterApply = { state: await nativeState(page), counts: await counts() };
const binding = (await api('GET', `/api/metrics/template-bindings/instance/${RESOURCE}`)).data;

await page.screenshot({ path: `${OUT}/first-binding-1440.png`, fullPage: true });

evidence.after = {
  checked,
  preview_shown: previewShown,
  probe_request: probeCall ? JSON.parse(probeCall.body) : null,
  preview_request: previewCall ? JSON.parse(previewCall.body) : null,
  preview: afterPreview.state?.preview ? {
    executable: afterPreview.state.preview.executable,
    revision: afterPreview.state.preview.revision,
    items: afterPreview.state.preview.items.map(item => ({ metric: item.canonical_metric.id, decision: item.decision, capability: item.capability })),
  } : null,
  evidence_after_probe: afterPreview.counts.evidence,
  trial_clicked: trialClicked,
  trial_passed: trialPassed,
  trial: afterApply.state?.trial ? { decision: afterApply.state.trial.decision, receipt_id: afterApply.state.trial.receipt_id } : null,
  apply_clicked: applyClicked,
  apply_shown: applyShown,
  apply_result: afterApply.state?.applyResult ?? null,
  binding_status: { source: binding.source, revision: binding.revision, configuration: binding.configuration,
    template_pins: binding.template_pins },
  counts: { before: evidence.before.counts, after_probe: afterPreview.counts, after_apply: afterApply.counts },
  replies,
};
writeFileSync(`${OUT}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence.after, null, 2));
await browser.close();
await db.end();
