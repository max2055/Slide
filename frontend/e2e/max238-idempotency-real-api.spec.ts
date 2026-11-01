import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * MAX238-APPLY-IDEMPOTENCY-R3/R4 browser evidence against a REAL API.
 *
 * The real metric-configuration component is served by Vite and its requests go
 * through the Vite proxy to a real Fastify server (apps/db-ops-api/e2e/) whose
 * operation journal is a real disposable MySQL schema. Only the trial boundary
 * is a fixture: it never connects to a target. The activate response is dropped
 * after the server has recorded its outcome, which is exactly what a client
 * cannot observe; the assertions read the server journal back over HTTP.
 */
const api = `http://127.0.0.1:${process.env.MAX238_API_PORT ?? 51839}`;
const fixture = '/e2e/fixtures/max238-idempotency-recovery.html';

// Playwright stops its webServers after the tests; the disposable MySQL
// container belongs to this fixture and is removed here regardless of how the
// launcher was terminated. The handle this run wrote before creating the
// container names the resource — the live API is only cross-checked, so
// teardown still finds its own container after the API is gone. Any failure
// propagates instead of being reported as cleaned up.
const handleFile = process.env.MAX238_HANDLE_FILE
  ?? fileURLToPath(new URL(`.max238-handle-${process.env.MAX238_API_PORT ?? 51839}.json`, import.meta.url));
test.afterAll(() => {
  execFileSync('bash', ['e2e/max238-real-api.sh', '--cleanup-handle', handleFile, '--api-url', api], { stdio: 'inherit' });
});

type State = { trials: number; journal: { state: string; target_revision: number; committed_at: string | null } | null; revision: number | null };
const serverState = async (key: string): Promise<State> => (await fetch(`${api}/__test/state?key=${encodeURIComponent(key)}`)).json() as Promise<State>;
const control = (action: string) => fetch(`${api}/__test/trial/${action}`, { method: 'POST' }).then(r => r.json());

async function prove(page: Page) {
  const host = page.locator('metric-configuration');
  await expect(host.getByText('选择适合此对象的采集模板')).toBeVisible();
  await host.getByRole('button', { name: '检查并启用' }).click();
  await host.getByRole('button', { name: '预检与影响预览' }).click();
  await expect(host.getByRole('button', { name: '试采' })).toBeEnabled();
  await host.getByRole('button', { name: '试采' }).click();
  await expect(host.getByRole('button', { name: '发布' })).toBeEnabled();
  return host;
}

test('real API: a committed publish whose response was lost is recovered from the journal', async ({ page }) => {
  await page.goto(fixture);
  const host = await prove(page);
  const keys: string[] = [];
  let activates = 0;
  await page.route('**/api/metrics/**/activate', async route => {
    activates++;
    keys.push((route.request().postDataJSON() as { operation_key: string }).operation_key);
    // The server processes and commits; the browser never sees the response.
    await route.fetch();
    await route.abort();
  });
  await host.getByRole('button', { name: '发布' }).click();
  await expect(page.locator('app-toast-container')).toContainText('已确认上次发布已完成');
  const state = await serverState(keys[0]!);
  expect(state.journal?.state).toBe('committed');
  expect(state.revision).toBe(1);
  expect(activates).toBe(1);
  // The unknown state was resolved, never reported as a retryable pending one.
  await expect(host.getByText('尚未确认')).toHaveCount(0);
  await expect(host.getByText('上次发布的结果尚未确认')).toHaveCount(0);
});

test('real API: an in-flight intent stays pending across a reload and only offers a query', async ({ page }) => {
  await page.goto(fixture);
  const host = await prove(page);
  await control('gate');
  const keys: string[] = [];
  let activates = 0;
  await page.route('**/api/metrics/**/activate', async route => {
    activates++;
    const key = (route.request().postDataJSON() as { operation_key: string }).operation_key;
    keys.push(key);
    const forwarded = route.fetch();
    // Wait until the server journal holds the claim, then drop the response.
    await expect.poll(async () => (await serverState(key)).journal?.state, { timeout: 15_000 }).toBe('pending');
    await route.abort();
    await forwarded.catch(() => undefined);
  });
  const trialsBefore = (await serverState('')).trials;
  await host.getByRole('button', { name: '发布' }).click();
  await expect(host.getByText('上次发布的结果尚未确认')).toBeVisible();
  expect(activates).toBe(1);
  expect((await serverState(keys[0]!)).trials).toBe(trialsBefore + 1);

  // A page reload on the same resource restores the recorded intent; it must not
  // become a new intent with a new key.
  await page.reload();
  const reloaded = page.locator('metric-configuration');
  await expect(reloaded.getByText('请在“检查并启用”中查询发布结果')).toBeVisible();
  await reloaded.getByRole('button', { name: '检查并启用' }).click();
  const query = reloaded.getByRole('button', { name: '查询发布结果' });
  await expect(query).toBeEnabled();
  await query.click();
  await expect(reloaded.getByText('上次发布的结果尚未确认')).toBeVisible();
  expect(activates).toBe(1);
  expect(keys).toHaveLength(1);

  await control('release');
});
