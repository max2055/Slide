import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * MAX238-NATIVE-COLLECT-NOW browser evidence.
 *
 * The real Lit component is served by Vite and its requests reach a real Fastify
 * server whose platform schema, journal, queue, worker and formal writer are
 * real MySQL 8.4 on a disposable non-3306 container. The target is a real
 * MySQL read-only account. Nothing is routed or fulfilled by the test.
 */
const api = `http://127.0.0.1:${process.env.MAX238_API_PORT ?? 51849}`;
const handleFile = process.env.MAX238_HANDLE_FILE
  ?? fileURLToPath(new URL(`.max238-cn-handle-${process.env.MAX238_API_PORT ?? 51849}.json`, import.meta.url));

test.afterAll(async () => {
  const response = await fetch(`${api}/__test/shutdown`, { method: 'POST' });
  expect(response.ok).toBe(true);
  await expect.poll(() => existsSync(handleFile), { timeout: 30_000 }).toBe(false);
});

type TaskView = {
  task: { caller_key: string; revision: number; state: string; outcome: string | null;
    samples: Array<{ id: string; metric: { id: string }; unit: string; value: unknown; observed_at: string }> } | null;
  formal: Array<{ id: string; observation: { id: string; value: unknown; unit: string; observed_at: string; quality: { status: string } } }>;
};

test('real browser: 立即采集 shows the task and the sample this task committed', async ({ page }) => {
  await page.goto('/e2e/fixtures/max238-collect-now.html');
  const host = page.locator('native-template-configuration');
  await expect(host.getByText('立即采集（本次任务与样本）')).toBeVisible();
  const collect = host.getByRole('button', { name: '立即采集' });
  await expect(collect).toBeEnabled();
  await expect(host.getByText('尚未建立原生模板配置')).toHaveCount(0);

  await collect.click();
  await expect(host.getByText('任务已完成', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(host.getByText('已写入本次正式样本')).toBeVisible();
  await expect(host.getByText('本次样本')).toBeVisible();

  const view = await (await fetch(`${api}/__test/latest`)).json() as TaskView;
  expect(view.task, JSON.stringify(view)).not.toBeNull();
  expect(view.task!.state).toBe('completed');
  expect(view.task!.outcome).toBe('sampled');
  expect(view.task!.revision).toBe(1);
  expect(view.formal.length).toBeGreaterThan(0);

  const sample = view.task!.samples[0]!;
  const formal = view.formal.find(entry => entry.id === sample.id);
  expect(formal, 'the task sample must be the formal observation row').toBeDefined();
  // Same identity, value, unit and observed_at across the task, the formal row and the page.
  expect(formal!.observation.id).toBe(sample.id);
  expect(formal!.observation.unit).toBe(sample.unit);
  expect(formal!.observation.observed_at).toBe(sample.observed_at);
  expect(formal!.observation.value).toEqual(sample.value);
  const displayed = (sample.value as { value?: unknown })?.value ?? sample.value;
  // Lit renders into the shadow root; textContent of the host element is empty.
  const pageText = await host.evaluate(element => (element as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot.textContent ?? '');
  expect(pageText).toContain(String(displayed));
  expect(pageText).toContain(sample.unit);
  expect(pageText).toContain(sample.observed_at);
  expect(pageText).toContain(sample.id);

  // The signed-up task samples belong to this resource's binding revision.
  expect(pageText).toContain('目标版本');
});

test('lost HTTP response and page reload recover the original collection task', async ({ page }) => {
  let key = '';
  await page.route('**/api/metrics/template-bindings/instance/1/collect', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    key = route.request().postDataJSON().caller_key;
    await route.fetch(); // the real Fastify service has received the request
    await route.abort('connectionreset'); // discard only its response
  });
  await page.goto('/e2e/fixtures/max238-collect-now.html');
  const host = page.locator('native-template-configuration');
  await host.getByRole('button', { name: '立即采集' }).click();
  await expect.poll(() => key).not.toBe('');
  await page.reload();
  await expect(host.getByText('任务已完成', { exact: true })).toBeVisible({ timeout: 60_000 });
  const view = await (await fetch(`${api}/__test/task?key=${encodeURIComponent(key)}`)).json() as TaskView;
  expect(view.task?.caller_key).toBe(key);
  expect(view.task?.outcome).toBe('sampled');
  const sample = view.task!.samples[0]!;
  expect(view.formal.some(entry => entry.id === sample.id)).toBe(true);
  await host.getByText('样本身份（不可变 ID）').click();
  await expect(host.getByText(sample.id, { exact: false })).toBeVisible();
});

test('collection action remains reachable at the supported desktop sizes', async ({ page }) => {
  await page.goto('/e2e/fixtures/max238-collect-now.html');
  const collect = page.locator('native-template-configuration').getByRole('button', { name: '立即采集' });
  for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await collect.scrollIntoViewIfNeeded();
    await expect(collect).toBeEnabled();
    const rect = await collect.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
  }
});
