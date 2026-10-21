/** Read-only SQL/HTTP evidence. Test administrator identity; no worker, model, target I/O or writes. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const backendRequire = createRequire(resolve(root, 'apps/db-ops-api/package.json'));
const frontendRequire = createRequire(resolve(root, 'frontend/package.json'));
if (!process.env.MAX215_READONLY_ENV) throw new Error('Set MAX215_READONLY_ENV to the protected API environment file');
backendRequire('dotenv').config({ path: process.env.MAX215_READONLY_ENV, quiet: true });
const out = resolve('/Users/max/Coding/40-Slide/outputs', process.env.MAX215_EVIDENCE_NAME ?? 'MAX-215-live-20261021');
await mkdir(out, { recursive: true });
const { dbConnection } = await import('../../apps/db-ops-api/src/db-connection.js');
const { registerMetricConfigurationRoutes } = await import('../../apps/db-ops-api/src/metrics/config/routes.js');
const { policyService } = await import('../../apps/db-ops-api/src/metrics/policy/service.js');
const { chromium, expect } = frontendRequire('@playwright/test');
const { createServer } = frontendRequire('vite');
const app = backendRequire('fastify')({ logger: false });
const requests: Array<{ method: string; path: string; status: number }> = [];
const actor = { userId: 0, username: 'MAX-215 read-only test administrator', roles: ['admin'], permissions: ['*'], sessionVersion: 0, instanceScopes: {}, requestId: 'MAX-215-readonly' };
let vite: any, browser: any;
const fingerprint = async () => {
  const [rows] = await dbConnection.getPool()!.query("SELECT resource_key, JSON_EXTRACT(payload, '$.binding') AS binding FROM metric_policy_bindings ORDER BY resource_key");
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
};
try {
  if (!await dbConnection.initialize()) throw new Error('Platform database unavailable');
  const before = await fingerprint();
  const [resources] = await dbConnection.getPool()!.query<any[]>("SELECT id,name,db_type,db_version FROM database_instances ORDER BY id");
  const target = resources.find((r: any) => r.db_type === 'mysql' && r.db_version);
  if (!target) throw new Error('No real MySQL resource with version metadata');
  app.addHook('onRequest', async (request: any, reply: any) => {
    if (request.method !== 'GET') return reply.code(405).send({ error: 'READ_ONLY_EVIDENCE' });
  });
  app.addHook('onResponse', async (request: any, reply: any) => { requests.push({ method: request.method, path: request.url, status: reply.statusCode }); });
  const verify = async (request: any) => { request.user = actor; };
  await registerMetricConfigurationRoutes(app, verify);
  app.get('/api/resources', async () => ({ items: resources.map((r: any) => ({ resource: { type: 'instance', id: r.id }, label: r.name })) }));
  app.get('/api/metrics/policy/groups', async () => policyService.groups(actor));
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  vite = await createServer({ root: resolve(root, 'frontend'), configFile: resolve(root, 'frontend/vite.config.js'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: api, changeOrigin: true } } } });
  await vite.listen();
  const address = vite.httpServer.address(), url = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
  const catalog = await (await fetch(`${api}/api/metrics/config/catalog`)).json() as any;
  const recommendation = await (await fetch(`${api}/api/metrics/config/resources/instance/${target.id}/recommendations`)).json() as any;
  const preferred = recommendation.packages.find((p: any) => p.recommended && p.compatibility === 'compatible');
  if (!preferred) throw new Error('No compatible recommendation in real service response');
  const scenarios = [];
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.route('**/max215-live', (route: any) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN" data-theme="claw" data-theme-mode="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px;background:var(--bg);color:var(--text)"><main style="max-width:1180px;margin:auto"><metric-settings view="packages"></metric-settings></main><app-toast-container></app-toast-container><script type="module">localStorage.setItem('permissions','["*"]');import '/src/app/styles.css';import '/src/app/ui/views/metric-settings.ts';import '/src/app/ui/components/app-toast-container.ts';</script></body></html>` }));
    await page.goto(`${url}/max215-live`);
    const rows = page.locator('metric-settings app-data-table tbody tr');
    await expect(rows).toHaveCount(new Set(catalog.packages.map((p: any) => p.package.id)).size);
    await page.screenshot({ path: resolve(out, `global-${width}-${theme}.png`), fullPage: true });
    await page.getByLabel('兼容性参考资源', { exact: true }).selectOption(`instance:${target.id}`);
    const recommendedRow = rows.filter({ hasText: '此资源推荐 · 已验证兼容' });
    await expect(recommendedRow).toHaveCount(1);
    await expect(recommendedRow.locator('td').nth(1)).toContainText(`v${preferred.release.package.version}`);
    await page.screenshot({ path: resolve(out, `resource-${width}-${theme}.png`), fullPage: true });
    await recommendedRow.getByRole('button', { name: '查看模板', exact: true }).click();
    const detail = page.locator('app-dialog[title="采集模板详情"]');
    await expect(detail).toContainText('此资源推荐 · 已验证兼容');
    await page.screenshot({ path: resolve(out, `detail-${width}-${theme}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(recommendedRow.getByRole('button', { name: '查看模板', exact: true })).toBeFocused();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || errors.length) throw new Error(`Browser failure ${JSON.stringify({ overflow, errors })}`);
    scenarios.push({ width, theme, overflow, errors }); await page.close();
  }
  const after = await fingerprint();
  if (before !== after) throw new Error('Bindings changed during read-only evidence; investigate concurrent changes');
  const result = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source: 'production registry/routes/recommendations, real platform MySQL inventory; isolated component host and test admin identity',
    api, url, packageVersions: catalog.packages.length, templates: new Set(catalog.packages.map((p: any) => p.package.id)).size,
    resource: { id: target.id, engine: target.db_type, version: target.db_version },
    recommended: preferred.release.package, bindingBefore: before, bindingAfter: after, requests, scenarios,
    limits: ['Not complete production JWT navigation or worker acceptance', 'No trial/activation, DB mutation, model or remote-target calls'],
  };
  await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2));
  await writeFile(resolve(out, 'catalog.json'), JSON.stringify(catalog, null, 2));
  await writeFile(resolve(out, 'recommendations.json'), JSON.stringify(recommendation, null, 2));
  console.log(JSON.stringify({ versions: result.packageVersions, templates: result.templates, scenarios: scenarios.length, unchangedBindings: before === after }));
} finally {
  await browser?.close(); await vite?.close(); await app.close(); await dbConnection.close();
}
