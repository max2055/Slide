import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from '../../../../../frontend/node_modules/vite/dist/node/index.js';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, pin, capabilities, testResources } from '../policy/test-support.js';
import { sample, identify } from '../../contracts/metrics-v2/fixtures.js';
import { MetricConsumerService } from './service.js';
import { registerMetricConsumerRoutes } from './routes.js';
import { createQueryMetricsTool } from '../../tools/ops/query_metrics.js';

describe.skipIf(process.env.METRICS_V2_BROWSER !== '1')('MAX-75 browser / actual HTTP / semantic reducer', () => {
  let app: ReturnType<typeof Fastify>, vite: ViteDevServer, browser: Browser, base: string, web: string, service: MetricConsumerService;
  const from = '2026-09-18T00:01:00.000Z', to = '2026-09-18T00:02:00.000Z';
  let denied = false, failed = false;
  beforeAll(async () => {
    const registry = createConfigurationRegistry(), store = new MemoryPolicyStore();
    const policy = new PolicyService(store, registry, testResources, () => to);
    await policy.changeBinding(admin, { type: 'instance', id: 1 }, { expected_revision: 0, package: pin }, true);
    store.caps.set('instance:1', capabilities());
    const point = identify({ ...sample('db.uptime_seconds'), resource_id: '1', observed_at: from, collected_at: from, stored_at: from });
    service = new MetricConsumerService(policy, registry, {
      queryWindow: async s => { if (failed) throw new Error('fixture unavailable'); return s.metric.id === point.metric.id ? [point] : []; },
      inventory: async () => testResources.inventory({ type: 'instance', id: 1 }), dimensions: async () => [{}], attempts: async () => [],
    }, () => to);
    app = Fastify(); await registerMetricConsumerRoutes(app, async r => { (r as any).user = denied ? { ...admin, permissions: ['instance:view'], instanceScopes: {} } : admin; }, service);
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../../../frontend', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': base } }, logLevel: 'error' });
    await vite.listen(); web = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
  }, 120000);
  afterAll(async () => { await browser?.close(); await vite?.close(); await app?.close(); });
  it('desktop/mobile show actual API value and quality; temporary failures retain cards, forbidden clears data', async () => {
    const payload = { resource: { type: 'instance', id: 1 }, from, to };
    const response = await fetch(`${base}/api/metrics-v2/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(200); const api = await response.json() as any;
    const agent = await createQueryMetricsTool(service).handler({ instance_id: 1, from, to }, { actor: admin });
    expect((agent.data as any).metrics).toEqual(api.metrics);
    const artifacts = fileURLToPath(new URL('../../../../../docs/slide/metrics-v2/consumers/screenshots', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 375]) {
      denied = false; failed = false;
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        // Mount the production component; no mocked browser response or fake consumer implementation.
        await page.goto(`${web}/src/app/ui/components/semantic-metrics.ts`);
        await page.addScriptTag({ type: 'module', content: 'import "/src/app/styles.css";' });
        await page.addScriptTag({ type: 'module', url: `${web}/src/app/ui/components/semantic-metrics.ts` });
        await page.waitForFunction(() => !!(globalThis as any).customElements.get('semantic-metrics'));
        await page.evaluate(({ from, to }) => {
          (globalThis as any).document.body.innerHTML = '';
          const el = (globalThis as any).document.createElement('semantic-metrics') as any; el.resourceId = 1; el.from = from; el.to = to; (globalThis as any).document.body.append(el);
        }, { from, to });
        await browserExpect(page.locator('semantic-metrics')).toContainText('3600');
        await browserExpect(page.locator('semantic-metrics')).toContainText('覆盖率 100%');
        await browserExpect(page.locator('semantic-metrics')).toContainText('mysql.queries.per_second');
        await page.screenshot({ path: `${artifacts}/${width}.png`, fullPage: true });
        failed = true; await page.getByRole('button', { name: '刷新标准指标' }).click();
        await browserExpect(page.getByRole('alert')).toContainText('查询暂时失败');
        await browserExpect(page.locator('semantic-metrics')).toContainText('3600');
        failed = false; denied = true; await page.getByRole('button', { name: '刷新标准指标' }).click();
        await browserExpect(page.getByRole('alert')).toContainText('查看权限');
        await browserExpect(page.locator('semantic-metrics')).not.toContainText('3600');
      } finally { await page.close(); }
    }
  }, 60000);
});
