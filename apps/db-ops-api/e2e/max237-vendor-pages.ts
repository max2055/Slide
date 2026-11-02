/** Real product components against the same isolated authenticated HTTP server.
 * No API interception, response fixtures, trace/HAR, or credential form capture. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

export async function captureVendorPages(app: FastifyInstance, token: string, deniedToken: string,
  resourceId: number, engine: string, directory: string) {
  const frontend = resolve('../../frontend');
  const require = createRequire(join(frontend, 'package.json'));
  const { chromium, expect } = require('@playwright/test');
  const { createServer } = await import(pathToFileURL(join(dirname(require.resolve('vite')), 'dist/node/index.js')).href);
  const api = app.server.listening ? `http://127.0.0.1:${(app.server.address() as any).port}` : await app.listen({ host: '127.0.0.1', port: 0 });
  const vite = await createServer({ root: frontend, configFile: join(frontend, 'vite.config.js'),
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api } } },
    plugins: [{ name: 'max237-live-component-page', configureServer(server: any) {
      server.middlewares.use('/vendor-qualification', (_request: unknown, response: any) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><html lang="zh-CN"><head><title>MAX237 ${engine} 实库资格</title></head>
          <body style="margin:24px;font-family:system-ui"><h1>${engine} 实库指标</h1><semantic-metrics></semantic-metrics>
          <script type="module">import '/src/app/styles.css'; import '/src/app/ui/components/semantic-metrics.ts';
          const element = document.querySelector('semantic-metrics'); element.resourceType = 'instance'; element.resourceId = ${resourceId};</script></body></html>`);
      });
    } }],
  });
  let browser: any;
  try {
    await vite.listen();
    const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}/vendor-qualification`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((value: string) => { localStorage.setItem('token', value); localStorage.setItem('permissions', '["*"]'); }, token);
    const page = await context.newPage();
    const responses: unknown[] = [];
    page.on('response', async (response: any) => {
      if (new URL(response.url()).pathname !== '/api/metrics/query') return;
      responses.push({ path: '/api/metrics/query', status: response.status(), request: response.request().postDataJSON(), response: await response.json() });
    });
    await page.goto(url);
    const metrics = page.locator('semantic-metrics');
    await expect(metrics.getByRole('heading', { name: '最新数据', exact: true })).toBeVisible();
    await expect.poll(() => metrics.evaluate((e: any) => e.result?.metrics.some((m: any) => m.definition.id.endsWith('commit_total')
      && m.series.some((s: any) => s.buckets.some((b: any) => b.value !== null && b.unit === 'count/s'))))).toBe(true);
    const actual = await metrics.evaluate((e: any) => e.result);
    assert(actual.metrics.some((m: any) => m.definition.id.endsWith('commit_total') && m.series.some((s: any) => s.buckets.some((b: any) => b.value !== null))), 'PAGE_COUNTER_PERMANENT_BASELINE');
    await page.screenshot({ path: join(directory, engine + '-latest.png'), fullPage: true });
    await metrics.getByRole('combobox', { name: '指标', exact: true }).selectOption(`${engine}.transactions.commit_total`);
    await metrics.getByText(/查看时间桶、定义与来源/).last().click();
    await expect(metrics.getByText('此维度趋势', { exact: true })).toBeVisible();
    await metrics.getByText('此维度趋势', { exact: true }).click();
    await page.screenshot({ path: join(directory, engine + '-history.png'), fullPage: true });
    // A fresh authenticated page under a real no-access actor; no response override.
    const denied = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await denied.addInitScript((value: string) => localStorage.setItem('token', value), deniedToken);
    const deniedPage = await denied.newPage();
    await deniedPage.goto(url);
    await expect(deniedPage.locator('semantic-metrics').getByText('没有此资源的查看权限', { exact: true }).first()).toBeVisible();
    assert.equal(await deniedPage.locator('semantic-metrics').evaluate((e: any) => e.result), null);
    await deniedPage.screenshot({ path: join(directory, engine + '-forbidden.png'), fullPage: true });
    await denied.close();
    writeFileSync(join(directory, engine + '-page-requests.json'), JSON.stringify(responses, null, 2));
    return { component: 'semantic-metrics (same component used by resource details)', real_http: true,
      latest: true, history: true, finite_counter_rate: true, resource_denied: true, viewport: '1440x900', response_count: responses.length };
  } catch (error) {
    // The browser never receives target credentials; strip its two bearer tokens
    // as well before retaining a bounded diagnostic (no trace/HAR is recorded).
    writeFileSync(join(directory, engine + '-page-error.json'), JSON.stringify({
      name: error instanceof Error ? error.name : typeof error,
      message: (error instanceof Error ? error.message : 'browser failure').replaceAll(token, '[redacted]').replaceAll(deniedToken, '[redacted]').slice(0, 6000),
    }, null, 2));
    throw error;
  } finally { await browser?.close(); await vite.close(); }
}
