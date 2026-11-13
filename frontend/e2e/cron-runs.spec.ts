import { expect, test } from '@playwright/test';

test('tracks concurrent exact Cron runs, keeps queued distinct from legacy success, restores after refresh and cleans up on navigation', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const jobs = [1, 2].map(id => ({ id, name: `任务${id}`, cron_expr: '* * * * *', enabled: true, last_result: 'success' }));
  const states = new Map([[1, 'queued'], [2, 'running']]);
  const posts: string[] = []; const polls: string[] = []; let offline = false;
  await page.route('**/api/cron/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/cron/jobs') return route.fulfill({ json: jobs });
    const id = Number(url.pathname.split('/')[4]);
    if (url.pathname.endsWith('/run')) {
      posts.push(route.request().headers()['idempotency-key']);
      return route.fulfill({ status: 202, json: { jobId: id, runId: `current-${id}`, status: 'queued' } });
    }
    if (url.pathname.includes('/runs/')) {
      polls.push(url.pathname);
      if (offline) return route.abort('internetdisconnected');
      return route.fulfill({ json: { jobId: id, runId: `current-${id}`, status: states.get(id), completion: states.get(id) === 'failed' ? { summary: '本次业务失败' } : null } });
    }
    // Historical logs must never be consulted to finish a new run.
    return route.fulfill({ json: { logs: [{ status: 'success' }] } });
  });
  await page.route('**/cron-runs-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <cron-jobs-settings></cron-jobs-settings>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/cron-jobs-settings.ts';</script>
    </body></html>` }));
  await page.goto('/cron-runs-fixture');
  const rows = page.locator('.table-row').filter({ has: page.getByRole('button', { name: '执行', exact: true }) });
  await rows.nth(0).getByRole('button', { name: '执行', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(rows.nth(0)).toContainText('排队中');
  await rows.nth(1).getByRole('button', { name: '执行', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect.poll(() => polls.length).toBeGreaterThanOrEqual(2);
  await expect(rows.nth(0)).toContainText('排队中');
  await expect(rows.nth(1)).toContainText('运行中');
  offline = true;
  await expect(rows.nth(0)).toContainText('状态待确认');
  offline = false; states.set(1, 'failed');
  await page.reload();
  await expect(rows.nth(0)).toContainText('本次业务失败');
  await expect(rows.nth(1)).toContainText('运行中');
  expect(posts).toHaveLength(2);
  expect(polls.every(url => /runs\/current-[12]$/.test(url))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cron-current-runs.png'), fullPage: true });
  await page.evaluate(() => document.querySelector('cron-jobs-settings')!.remove());
  const count = polls.length;
  // Advance browser timers after unmount without a fixed wall-clock sleep.
  await page.clock.install(); await page.clock.fastForward(10000);
  expect(polls).toHaveLength(count);
  expect(errors).toEqual([]);
});

// #422: real HTTP transport with an isolated protocol endpoint; no business DB/executor.
test('aborts a pending trigger without cancelling server execution and reconciles its original request key', async ({ page }) => {
  const { createServer } = await import('vite');
  const posts: string[] = []; const gets: string[] = [];
  let postDisconnected = false;
  const pendingResponses = new Set<import('node:http').ServerResponse>();
  const server = await createServer({
    configFile: false, root: process.cwd(), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'cron-ownership-endpoint', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url === '/ownership-fixture') {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><html><body><script type="module">import { CronRunTracker } from "/src/app/ui/controllers/cron-run-tracker.ts"; window.CronRunTracker = CronRunTracker;</script></body></html>');
        } else if (req.url === '/api/cron/jobs/42/run') {
          posts.push(String(req.headers['idempotency-key']));
          // Server accepted this key; deliberately leave the response pending.
          pendingResponses.add(res);
          res.on('close', () => { postDisconnected = !res.writableEnded; pendingResponses.delete(res); });
        } else if (req.url?.startsWith('/api/cron/jobs/42/runs?')) {
          gets.push(req.url);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ jobId: 42, runId: 'accepted-before-disconnect', status: 'succeeded', completion: { summary: '服务端已完成' } }));
        } else next();
      });
    } }],
  });
  try {
    await server.listen();
    const address = server.httpServer!.address() as import('node:net').AddressInfo;
    await page.goto(`http://127.0.0.1:${address.port}/ownership-fixture`);
    await page.waitForFunction(() => Boolean((window as any).CronRunTracker));
    await page.clock.install();
    await page.evaluate(() => {
      const w = window as any;
      localStorage.setItem('slide:cron-runs:session', JSON.stringify([{ jobId: 42, requestKey: 'http-original-key', status: 'unconfirmed' }]));
      w.tracker = new w.CronRunTracker(() => {}); w.tracker.start();
      w.pending = w.tracker.trigger(42).catch((error: Error) => { w.observationError = error.name; });
    });
    await expect.poll(() => posts.length).toBe(1);
    await page.clock.fastForward(3500);
    expect(gets).toEqual([]);
    await page.evaluate(async () => { const w = window as any; w.tracker.stop(); await w.pending; });
    await expect.poll(() => postDisconnected).toBe(true);
    expect(await page.evaluate(() => (window as any).observationError)).toBe('AbortError');
    expect(await page.evaluate(() => (window as any).tracker.runs.get(42))).toMatchObject({ requestKey: 'http-original-key', status: 'unconfirmed' });
    await page.evaluate(() => (window as any).tracker.start());
    await page.clock.fastForward(3000);
    await expect.poll(() => page.evaluate(() => (window as any).tracker.runs.get(42)?.status)).toBe('succeeded');
    expect(gets).toEqual(['/api/cron/jobs/42/runs?requestKey=http-original-key']);
    expect(posts).toEqual(['http-original-key']);
  } finally {
    try { await page.close(); }
    finally {
      for (const res of pendingResponses) res.destroy();
      await server.close();
    }
  }
});
