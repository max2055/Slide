/** Controlled HTTP failure-envelope browser acceptance; no live credentials or model calls. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const base = server.resolvedUrls!.local[0];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let failed = false;
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({
    status: failed ? 500 : 200, contentType: 'application/json',
    body: JSON.stringify(failed ? { error: '索引存储暂不可用' } : []),
  }));
  // Empty HTML avoids starting unrelated application flows.
  await page.route('**/max3-fixture', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto(base + 'max3-fixture');
  await page.evaluate(async () => {
    await import('/src/app/ui/views/index-management.ts');
    const view = document.createElement('index-management-page') as any;
    view.instanceId = 1;
    document.body.append(view);
    (window as any).indexView = view;
    await view.updateComplete;
  });
  for (const width of [1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
    failed = true;
    const result = await page.evaluate(async () => {
      const v = (window as any).indexView;
      await v.loadIndexes(); await v.updateComplete;
      return { error: v.indexError, text: v.shadowRoot.textContent };
    });
    assert.match(result.error, /HTTP 500/);
    assert.match(result.text, /索引加载失败/);
    await page.evaluate(async () => {
      const v = (window as any).indexView;
      await v.detectRedundancy(); await v.updateComplete;
    });
    assert.match(await page.evaluate(() => (window as any).indexView.shadowRoot.textContent), /索引存储暂不可用/);
    failed = false;
    const recovered = await page.evaluate(async () => {
      const v = (window as any).indexView;
      await v.loadIndexes(); await v.detectRedundancy(); await v.updateComplete;
      return { error: v.indexError, message: v.message, report: v.redundancyReport };
    });
    assert.equal(recovered.error, null);
    assert.match(recovered.message, /发现 0 个冗余索引/);
    assert.deepEqual(recovered.report, []);
  }
  console.log('browser: HTTP read/detection failure visible, recovery and empty report passed at 3 desktop sizes');
  await page.close();
} finally {
  await browser.close();
  await server.close();
}
