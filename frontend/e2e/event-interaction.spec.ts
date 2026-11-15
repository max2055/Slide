import { expect, test } from '@playwright/test';

// Browser interaction evidence with controlled HTTP responses; not real backend acceptance.
test('failed saves keep visible drafts; successful retry sends postmortem; filters state their scope', async ({ page }) => {
  let fail = true;
  let payload: unknown;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.startsWith('/api/metrics/template-events/')) return route.fulfill({ status: 404, json: {} });
    if (route.request().method() === 'POST') {
      payload = route.request().postDataJSON();
      await route.fulfill({ status: fail ? 500 : 200, json: {} });
    } else if (url.pathname.endsWith('/logs')) await route.fulfill({ json: [] });
    else if (url.pathname.endsWith('/1')) await route.fulfill({ json: { id: '1', title: '事件一', status: 'resolved', severity: 'warning', alerts: [] } });
    else await route.fulfill({ json: { items: [{ id: '1', title: '事件一', status: 'resolved', severity: 'warning' }], total: 100 } });
  });
  await page.goto('/');
  await page.evaluate(async () => {
    await import('/src/app/ui/views/event-management.ts');
    const el = document.createElement('event-management-page');
    document.body.replaceChildren(el);
    Object.assign(el, { loading: false, selectedEvent: { id: '1', title: '事件一', status: 'resolved', severity: 'warning' }, showPostmortemForm: true });
  });
  const review = page.locator('event-management-page textarea').last();
  await review.fill('完整复盘内容');
  await page.getByRole('button', { name: '提交复盘' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toContainText('500');
  await expect(review).toHaveValue('完整复盘内容');
  fail = false;
  await page.getByRole('button', { name: '提交复盘' }).click();
  await expect(page.getByRole('button', { name: '提交复盘' })).toHaveCount(0);
  expect(payload).toEqual({ postmortem: '完整复盘内容' });
  await expect(page.getByText('搜索和严重度仅筛选本页；分页总数为当前状态的全部事件数。')).toBeVisible();
});

test('browser back restores missing-view default', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await import('/src/app/ui/views/event-center.ts');
    history.replaceState({}, '', '/events');
    document.body.replaceChildren(document.createElement('event-center-page'));
  });
  await page.getByRole('tab', { name: '通知投递' }).click();
  await page.goBack();
  await expect(page.getByRole('tab', { name: '活动告警' })).toHaveAttribute('aria-selected', 'true');
});
