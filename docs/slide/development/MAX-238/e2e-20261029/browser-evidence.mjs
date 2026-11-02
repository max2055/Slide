/**
 * MAX238-COLLECTION-DISPLAY-E2E-R1 — page evidence.
 *
 * Opens the real Vite app, authenticates with a session token obtained from the
 * real API, visits Databases → mysql3306 → Metrics & Trends, captures the page's
 * own /api/metrics/query request/response, reads the rendered text across shadow
 * DOM roots, and writes the screenshots plus a JSON comparison.
 *
 * Run from `frontend/` so `@playwright/test` resolves:
 *   MAX238_PAGE=http://127.0.0.1:5173 MAX238_API=http://127.0.0.1:3001 \
 *   MAX238_ADMIN_PASSWORD=... MAX238_EVIDENCE_DIR=... node <this file>
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const PAGE = process.env.MAX238_PAGE || 'http://127.0.0.1:5173';
const API = process.env.MAX238_API || 'http://127.0.0.1:3001';
const OUT = process.env.MAX238_EVIDENCE_DIR || '.';
mkdirSync(OUT, { recursive: true });

const shadowText = page => page.evaluate(() => {
  const out = [];
  const walk = root => {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) walk(element.shadowRoot);
      if (element.children.length === 0) {
        const text = (element.textContent || '').trim();
        if (text) out.push(text);
      }
    }
  };
  walk(document);
  return out.join('\n');
});

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.MAX238_ADMIN_USER || 'admin', password: process.env.MAX238_ADMIN_PASSWORD || '' }),
  });
  const session = await login.json();
  if (!session.token) throw new Error(`login failed: ${login.status}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const captured = [];
  page.on('response', async response => {
    if (!response.url().includes('/api/metrics/query') || response.request().method() !== 'POST') return;
    try { captured.push({ request: response.request().postDataJSON?.(), status: response.status(), body: await response.json() }); }
    catch { /* non-JSON responses are not evidence */ }
  });
  await page.addInitScript(payload => {
    window.localStorage.setItem('token', payload.token);
    if (payload.refreshToken) window.localStorage.setItem('refreshToken', payload.refreshToken);
    if (payload.user) window.localStorage.setItem('user', JSON.stringify(payload.user));
  }, { token: session.token, refreshToken: session.refreshToken, user: session.user });

  await page.goto(`${PAGE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.getByText(/^Databases$/).first().click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/max238-r1-databases.png`, fullPage: true });
  const row = page.getByText(/mysql3306/).first();
  await row.waitFor({ timeout: 20000 });
  await row.click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/max238-r1-instance.png`, fullPage: true });
  const metricsTab = page.getByText(/Metrics & Trends|指标与趋势|Metrics/i).first();
  if (await metricsTab.count()) { await metricsTab.click(); await page.waitForTimeout(5000); }
  await page.screenshot({ path: `${OUT}/max238-r1-metrics.png`, fullPage: true });

  const text = await shadowText(page);
  writeFileSync(`${OUT}/max238-r1-metrics.txt`, text);
  const rendered = text.match(/数据库运行时长/);
  writeFileSync(`${OUT}/max238-r1-query-responses.json`, JSON.stringify(captured, null, 2));
  console.log(JSON.stringify({ captured_queries: captured.length, rendered_uptime_label: Boolean(rendered) }));
  await browser.close();
}
main().catch(error => { console.error('BROWSER_FAIL', error.message); process.exit(1); });
