import { expect, test, type Locator, type Page } from '@playwright/test';

const weights = { availability: 0.35, performance: 0.35, capacity: 0.2, security: 0.1 };
const job = { id: 7, name: '巡检任务', task_type: 'agent', cron_expr: '0 0 * * *', enabled: false };
const approval = (status: string) => ({
  id: 5, kind: 'sql', instance_id: 7, sql_text: 'SELECT 1', risk_level: 'low',
  status, created_at: '2026-11-22T00:00:00.000Z',
});

async function mount(page: Page, tag: string, module: string) {
  await page.route('**/settings-read-states', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="zh-CN" data-theme-mode="light"><head><meta charset="utf-8">
      <style>main { margin: 24px; }</style></head><body><main><${tag}></${tag}></main>
      <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/${module}.ts';</script></body></html>`,
  }));
  await page.goto('/settings-read-states');
  return page.locator(tag);
}

async function expectSkeleton(skeleton: Locator) {
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveCSS('background-image', /linear-gradient/);
}

test.use({ viewport: { width: 1440, height: 900 } });

test('scoring retries missing, invalid and failed reads without exposing a fallback form', async ({ page }) => {
  let response = { json: null as unknown, status: 200 };
  let release!: () => void;
  const firstRead = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/scoring/config', async route => {
    expect(route.request().method()).toBe('GET');
    await firstRead;
    await route.fulfill(response);
  });
  const view = await mount(page, 'scoring-settings-page', 'scoring-settings');
  const save = view.getByRole('button', { name: '保存配置' });
  const alert = view.getByRole('alert');
  const retry = view.getByRole('button', { name: '重试', exact: true });
  await expectSkeleton(view.getByRole('status', { name: '正在加载评分权重' }));
  await expect(save).toHaveCount(0);
  release();
  await expect(alert).toContainText('未读取到评分权重配置');
  await expect(view.getByRole('slider')).toHaveCount(0);

  response = { json: { ...weights, security: '0.1' }, status: 200 };
  await retry.press('Enter');
  await expect(alert).toContainText('不完整或无效');
  await expect(save).toHaveCount(0);

  response = { json: { error: '读取暂不可用' }, status: 503 };
  await retry.click();
  await expect(alert).toContainText('读取暂不可用');
  await expect(save).toHaveCount(0);

  response = { json: weights, status: 200 };
  await retry.click();
  await expect(view.getByRole('slider', { name: '可用性' })).toHaveAttribute('aria-valuetext', '35%');
  await expect(save).toBeEnabled();
  await expect(alert).toHaveCount(0);
});

test('cron distinguishes an empty list from a filter with no matches and restores focus', async ({ page }) => {
  let response = { status: 503, json: {} as unknown };
  let release!: () => void;
  const firstRead = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/cron/jobs', async route => {
    expect(route.request().method()).toBe('GET');
    await firstRead;
    await route.fulfill(response);
  });
  const view = await mount(page, 'cron-jobs-settings', 'cron-jobs-settings');
  const empty = view.getByText('暂无定时任务', { exact: true });
  const alert = view.getByRole('alert');
  const retry = view.getByRole('button', { name: '重试', exact: true });
  await expectSkeleton(view.getByRole('status', { name: '正在加载定时任务' }));
  release();
  await expect(alert).toContainText('加载定时任务失败');
  await expect(empty).toHaveCount(0);

  response = { status: 200, json: [job] };
  await retry.press('Enter');
  await expect(view.getByText(job.name, { exact: true })).toBeVisible();
  await expect(alert).toHaveCount(0);

  const filter = view.getByRole('combobox', { name: '筛选模式' });
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await filter.selectOption('script');
    await expect(view.getByText('当前模式下没有匹配的定时任务', { exact: true })).toBeVisible();
    await expect(view.getByText('任务名称', { exact: true })).toHaveCount(0);
    await expect(empty).toHaveCount(0);
    const reset = view.getByRole('button', { name: '查看全部任务' });
    await expect(reset).toBeInViewport();
    await reset.press('Enter');
    await expect(filter).toBeFocused();
    await expect(filter).toHaveValue('all');
    await expect(view.getByText(job.name, { exact: true })).toBeVisible();
  }
  response = { status: 200, json: [] };
  await page.reload();
  await expect(empty).toBeVisible();
  await expect(view.getByRole('button', { name: '查看全部任务' })).toHaveCount(0);
});

test('approval retries the current tab and shows empty results only after a valid read', async ({ page }) => {
  let pending = { status: 503, json: {} as unknown };
  let processed = { status: 200, json: { items: [approval('approved')] } as unknown };
  let release!: () => void;
  const firstRead = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/approval/unified?status=*', async route => {
    expect(route.request().method()).toBe('GET');
    await firstRead;
    const status = new URL(route.request().url()).searchParams.get('status');
    await route.fulfill(status === 'pending' ? pending : processed);
  });
  const view = await mount(page, 'approval-dashboard', 'approval-dashboard');
  const pendingEmpty = view.getByText('暂无待审批请求', { exact: true });
  const alert = view.getByRole('alert');
  const retry = view.getByRole('button', { name: '重试', exact: true });
  await expectSkeleton(view.getByRole('status', { name: '正在加载待审批请求' }));
  release();
  await expect(alert).toContainText('审批表不可用');
  await expect(pendingEmpty).toHaveCount(0);

  pending = { status: 200, json: { items: [approval('pending')] } };
  await retry.press('Enter');
  await expect(view.getByText('SELECT 1', { exact: true })).toBeVisible();
  await expect(alert).toHaveCount(0);

  pending = { status: 200, json: { items: [] } };
  await view.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(pendingEmpty).toBeVisible();
  await view.getByRole('button', { name: '审批历史', exact: true }).click();
  await expect(view.getByRole('cell', { name: /^SELECT 1/ })).toBeVisible();
  await view.getByRole('searchbox', { name: '查找摘要或目标' }).fill('无匹配');
  await expect(view.getByText('没有符合条件的审批记录', { exact: true })).toBeVisible();

  processed = { status: 200, json: {} };
  await view.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(alert).toContainText('审批列表加载失败');
  await expect(view.getByText('没有符合条件的审批记录', { exact: true })).toHaveCount(0);
  await expect(view.getByText('暂无已审批记录', { exact: true })).toHaveCount(0);

  processed = { status: 200, json: { items: [] } };
  await retry.click();
  await expect(view.getByText('暂无已审批记录', { exact: true })).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(view.getByRole('searchbox', { name: '查找摘要或目标' })).toHaveValue('无匹配');
});
