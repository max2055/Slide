import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
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

test.afterAll(() => {
  execFileSync('bash', ['e2e/max238-collect-now.sh', '--cleanup-handle', handleFile, '--api-url', api], { stdio: 'inherit' });
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
