import { expect, test } from '@playwright/test';

// MAX-413: deterministic browser regression; API fixtures are not database evidence.
test('creates the first Cron job, cancels, retains failures and recreates after deletion', async ({ page }) => {
  let jobs: any[] = []; let fail = false;
  await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['cron:manage', 'cron:view'])));
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/cron/jobs' && request.method() === 'POST') {
      if (fail) return route.fulfill({ status: 403, json: { error: '权限已撤销' } });
      jobs = [{ ...request.postDataJSON(), id: 42 }]; return route.fulfill({ status: 201, json: { id: 42 } });
    }
    if (request.method() === 'DELETE') { jobs = []; return route.fulfill({ json: {} }); }
    return route.fulfill({ json: path === '/api/cron/jobs' ? jobs : [] });
  });
  await page.route('**/cron-create-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <cron-jobs-settings></cron-jobs-settings><script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/cron-jobs-settings.ts';</script></body></html>` }));
  await page.goto('/cron-create-fixture');
  const create = page.getByRole('button', { name: '+ 新建任务', exact: true });
  await expect(page.getByText('暂无定时任务', { exact: true })).toBeVisible();
  await create.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('任务名称', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(create).toBeFocused();
  await create.click();
  await page.getByLabel('任务名称', { exact: true }).fill('首次创建');
  await page.getByLabel('任务内容（自然语言）', { exact: true }).fill('检查数据库实例的运行状态并输出报告');
  fail = true; await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByText('权限已撤销', { exact: true })).toBeVisible();
  fail = false; await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.locator('.table-row')).toContainText('首次创建');
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByText('暂无定时任务', { exact: true })).toBeVisible();
  await create.click(); await expect(page.getByLabel('任务名称', { exact: true })).toBeVisible();
});

test('keeps legacy Agent tasks in the Agent filter and renders coverage severity', async ({ page }) => {
  const jobs = [
    { id: 1, name: '旧 Agent', cron_expr: '* * * * *', enabled: false },
    { id: 2, name: '脚本任务', task_type: 'script', cron_expr: '* * * * *', enabled: false },
  ];
  await page.route('**/api/cron/**', route => route.fulfill({ json: route.request().url().endsWith('/logs?limit=20&offset=0') ? { logs: [] } : jobs }));
  await page.route('**/cron-display-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><cron-jobs-settings></cron-jobs-settings><script type="module">import "/src/app/styles.css";import "/src/app/ui/views/cron-jobs-settings.ts";</script></body></html>' }));
  await page.goto('/cron-display-fixture');
  await expect(page.locator('.table-row')).toHaveCount(2);
  await page.locator('select').selectOption('agent');
  await expect(page.locator('.table-row')).toHaveCount(1);
  await expect(page.locator('.table-row')).toContainText('旧 Agent');
  await page.locator('select').selectOption('script');
  await expect(page.locator('.table-row')).toContainText('脚本任务');
  for (const [coverage, severity, label] of [[0.3, 'danger', '30%'], [0.5, 'warn', '50%'], [0.8, 'ok', '80%'], [null, '', '未知']] as const) {
    await page.locator('cron-jobs-settings').evaluate((element, value) => {
      const view = element as any;
      view.logViewerJob = { name: '覆盖率验证' };
      view.viewerLogs = [{ id: 1, status: 'success', started_at: '2026-11-13T00:00:00Z', structured_result: { instances: {}, coverage_rate: value } }];
    }, coverage);
    const stat = page.locator('.sr-stat').filter({ hasText: '覆盖率' });
    await expect(stat).toContainText(label);
    if (severity) await expect(stat).toHaveClass(`sr-stat ${severity}`);
    else await expect(stat).not.toHaveClass(/ok|warn|danger/);
  }
});
