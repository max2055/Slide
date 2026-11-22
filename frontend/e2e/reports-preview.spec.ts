import { expect, test, type Page, type Route } from '@playwright/test';

const databaseReports = Array.from({ length: 30 }, (_, index) => ({
  id: index + 1,
  name: `合成数据库报告 ${index + 1}`,
  type: 'health',
  format: 'pdf',
  instance_name: '测试实例',
  status: 'completed',
  created_at: '2026-11-01T00:00:00Z',
}));
const serverReport = {
  ...databaseReports[0], id: 31, name: '合成全量巡检', type: 'server_health',
  format: 'html', instance_name: null, server_id: null,
};
const reports = [...databaseReports, serverReport];

async function openReports(
  page: Page,
  reportRoute: (route: Route) => Promise<void>,
  serverRoute = (route: Route) => route.fulfill({ json: { servers: [{ id: 8, host: '测试服务器' }] } }),
) {
  const calls: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('token', 'reports-browser-fixture');
    localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.session_token.v1', 'reports-browser-fixture');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', theme: 'light' }));
  });
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    switch (path) {
      case '/api/auth/permissions': return route.fulfill({ json: ['*'] });
      case '/api/user/preferences': return route.fulfill({ json: { preferences: { locale: 'zh-CN' } } });
      case '/api/database/instances':
        calls.push(path);
        return route.fulfill({ json: [{ id: 7, name: '测试实例' }] });
      case '/api/servers':
        calls.push(path);
        return serverRoute(route);
      case '/api/notification/channels':
        calls.push(path);
        return route.fulfill({ json: [] });
      default:
        if (path.startsWith('/api/reports') || path.startsWith('/api/servers/reports')) {
          calls.push(`${route.request().method()} ${path}`);
          return reportRoute(route);
        }
        return route.fulfill({ json: {} });
    }
  });
  await page.goto('/feedback');
  await page.locator('.shell-nav').getByRole('link', { name: '报表中心', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/reports');
  return { view: page.locator('reports-page'), calls };
}

const previewResponses = [
  { json: { content: null } },
  { json: { content: '' } },
  { status: 200, contentType: 'application/json', body: '' },
  { status: 404, json: { error: 'invisible fixture' } },
  { status: 404, json: { error: 'missing fixture' } },
  { status: 503, json: { error: 'REPORT_DETAIL_UNAVAILABLE' } },
  { json: { content: '<!doctype html><html><head><style>h1{color:navy}</style></head><body><h1>合成报表正文</h1></body></html>' } },
];

test('报告详情区分空正文和读取失败，预览关闭后回到筛选后的原记录', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The deployed page inherits frame-src from default-src 'self'.
  await page.route('**/feedback', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': "frame-src 'self'" } });
  });
  let detailReads = 0;
  const { view, calls } = await openReports(page, route => {
    switch (new URL(route.request().url()).pathname) {
      case '/api/reports': return route.fulfill({ json: reports });
      case '/api/reports/stats': return route.fulfill({ json: { total: reports.length } });
      case '/api/reports/configs': return route.fulfill({ json: [] });
      case '/api/reports/29': return route.fulfill(previewResponses[detailReads++]);
      case '/api/reports/29/download':
        return route.fulfill({
          headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="synthetic.pdf"' },
          body: '%PDF-synthetic',
        });
      default: return route.fulfill({ status: 404 });
    }
  });
  const search = view.getByRole('searchbox', { name: '搜索报表历史' });
  await search.fill('合成数据库');
  await view.getByRole('button', { name: '报表历史：下一页' }).click();
  const row = view.getByRole('row').filter({ has: page.getByRole('cell', { name: '合成数据库报告 29', exact: true }) });
  const read = row.getByRole('button', { name: /^(重试)?查看$/ });
  await read.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const rowTop = () => row.evaluate(element => element.getBoundingClientRect().top);

  for (const message of [
    /未保存正文/, /未保存正文/, /服务返回了空响应/, /不存在或当前不可查看/,
    /不存在或当前不可查看/, /暂时无法读取这份报表/,
  ]) {
    const before = await rowTop();
    await read.press('Enter');
    await expect(row.getByText(message)).toBeVisible();
    await expect(read).toBeFocused();
    await expect(search).toHaveValue('合成数据库');
    await expect(view.getByText('第 2 / 2 页')).toBeVisible();
    expect(await rowTop()).toBeCloseTo(before, 0);
  }

  const before = await rowTop();
  await read.press('Enter');
  const preview = view.locator('app-dialog');
  await expect(preview.getByRole('dialog', { name: '合成数据库报告 29' })).toBeVisible();
  const frame = preview.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame.contentFrame().getByRole('heading', { name: '合成报表正文' })).toHaveCSS('color', 'rgb(0, 0, 128)');
  const downloaded = page.waitForEvent('download');
  await preview.getByRole('button', { name: '下载', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('synthetic.pdf');
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(read).toBeFocused();
  await expect(search).toHaveValue('合成数据库');
  await expect(view.getByText('第 2 / 2 页')).toBeVisible();
  expect(await rowTop()).toBeCloseTo(before, 0);
  expect(calls.filter(call => call === 'GET /api/reports/29')).toHaveLength(previewResponses.length);
  expect(calls.filter(call => /^(POST|PUT|DELETE) /.test(call))).toEqual([]);
});

test('MAX-718：键盘可读到长报表末尾，关闭后回到历史原位', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const paragraphs = Array.from({ length: 120 }, (_, index) => `<p>合成报表段落 ${index + 1}</p>`).join('');
  const content = `<!doctype html><html><body>${paragraphs}<p>合成报表末尾</p></body></html>`;
  const { view, calls } = await openReports(page, route => {
    switch (new URL(route.request().url()).pathname) {
      case '/api/reports': return route.fulfill({ json: reports });
      case '/api/reports/stats': return route.fulfill({ json: { total: reports.length } });
      case '/api/reports/configs': return route.fulfill({ json: [] });
      case '/api/reports/29': return route.fulfill({ json: { content } });
      default: return route.fulfill({ status: 404 });
    }
  });
  const search = view.getByRole('searchbox', { name: '搜索报表历史' });
  await search.fill('合成数据库');
  await view.getByRole('button', { name: '报表历史：下一页' }).click();
  const pageNumber = view.getByText('第 2 / 2 页');
  await expect(pageNumber).toBeVisible();
  const row = view.getByRole('row').filter({ has: page.getByRole('cell', { name: '合成数据库报告 29', exact: true }) });
  const trigger = row.getByRole('button', { name: '查看', exact: true });
  await trigger.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const rowTop = () => row.evaluate(element => element.getBoundingClientRect().top);
  const originalTop = await rowTop();

  await trigger.press('Enter');
  const preview = view.locator('app-dialog');
  const dialog = preview.getByRole('dialog', { name: '合成数据库报告 29' });
  await expect(dialog).toBeVisible();
  const frame = preview.locator('iframe[title="报表正文"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame).toHaveCSS('outline-style', 'none');
  const documentBody = frame.contentFrame().locator('body');
  const end = documentBody.getByText('合成报表末尾', { exact: true });
  await expect(end).not.toBeInViewport();
  const scrollTop = () => documentBody.evaluate(body => body.ownerDocument.scrollingElement!.scrollTop);
  expect(await scrollTop()).toBe(0);

  await page.keyboard.press('Tab');
  await expect(frame).toBeFocused();
  await expect(frame).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('PageDown');
  await expect.poll(scrollTop).toBeGreaterThan(0);
  await page.keyboard.press('End');
  await expect(end).toBeInViewport();
  await expect.poll(() => documentBody.evaluate(body => {
    const scroll = body.ownerDocument.scrollingElement!;
    return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
  })).toBeLessThanOrEqual(1);

  await page.keyboard.press('Shift+Tab');
  await expect(preview.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(frame).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(preview.getByRole('button', { name: '下载' })).toBeFocused();
  await expect(frame).toHaveCSS('outline-style', 'none');
  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(search).toHaveValue('合成数据库');
  await expect(pageNumber).toBeVisible();
  expect(await rowTop()).toBeCloseTo(originalTop, 0);
  expect(calls.filter(call => call.endsWith('/api/reports/29'))).toEqual(['GET /api/reports/29']);
});

test('历史 503 只影响历史，恢复后可核对计划和数据库、服务器范围', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  let failHistory = true;
  const { view, calls } = await openReports(page, route => {
    switch (new URL(route.request().url()).pathname) {
      case '/api/reports':
        return failHistory
          ? route.fulfill({ status: 503, json: { error: 'REPORT_LIST_UNAVAILABLE' } })
          : route.fulfill({ json: reports });
      case '/api/reports/stats': return route.fulfill({ json: { total: reports.length } });
      case '/api/reports/configs':
        return route.fulfill({ json: [{ id: 1, name: '合成计划', cron: '@daily', type: 'health', instance_id: 7 }] });
      case '/api/reports/31': return route.fulfill({ json: { content: '# 合成巡检\n正文 <原文>' } });
      default: return route.fulfill({ status: 404 });
    }
  });
  await expect(view.getByRole('alert')).toHaveText('暂时无法读取报表历史，请重试。');
  await expect(view.getByRole('cell', { name: '合成计划' })).toBeVisible();
  const target = view.getByRole('combobox', { name: '生成报表的数据库实例' });
  await target.selectOption('7');
  await expect(view.getByRole('button', { name: '生成健康检查报告' })).toBeEnabled();
  await expect(view.getByRole('button', { name: '生成服务器巡检报告' })).toHaveCount(0);
  await view.getByRole('button', { name: '新建计划' }).click();
  const config = view.locator('app-dialog');
  await expect(config.getByRole('dialog', { name: '新建定时报表' })).toBeVisible();
  await expect(config.getByRole('status')).toContainText('通知通道可不选，可到「设置 → 平台设置 → 通知通道」配置。');
  await config.getByRole('button', { name: '取消' }).click();

  failHistory = false;
  const beforeRetry = calls.length;
  await view.getByRole('button', { name: '重试历史' }).click();
  await expect(view.getByRole('cell', { name: '合成数据库报告 1', exact: true })).toBeVisible();
  await expect(view.getByRole('button', { name: '刷新历史' })).toBeEnabled();
  expect(calls.slice(beforeRetry)).toEqual(['GET /api/reports', 'GET /api/reports/stats']);
  await expect(view.getByRole('cell', { name: '合成全量巡检' })).toHaveCount(0);

  const types = view.getByRole('group', { name: '报表目标类型' });
  await types.getByRole('button', { name: '服务器', exact: true }).click();
  await expect(view.getByRole('cell', { name: '合成数据库报告 1', exact: true })).toHaveCount(0);
  await expect(view.getByRole('cell', { name: '合成全量巡检' })).toBeVisible();
  await expect(view.getByRole('button', { name: '生成慢查询报告' })).toHaveCount(0);
  const servers = view.getByRole('combobox', { name: '生成报表的服务器' });
  await expect(servers).toHaveValue('');
  await expect(servers.getByRole('option', { name: /全量巡检/ })).toHaveCount(1);
  await servers.selectOption('8');
  await expect(view.getByRole('button', { name: '生成服务器巡检报告' })).toBeEnabled();

  await view.getByRole('button', { name: '查看', exact: true }).click();
  const preview = view.locator('app-dialog');
  await expect(preview.getByRole('dialog', { name: '合成全量巡检' })).toBeVisible();
  await expect(preview.locator('pre')).toHaveText('# 合成巡检 正文 <原文>');
  await preview.getByRole('button', { name: '关闭' }).click();
  await types.getByRole('button', { name: '数据库实例', exact: true }).click();
  await expect(target).toHaveValue('');
  await types.getByRole('button', { name: '服务器', exact: true }).click();
  await expect(servers).toHaveValue('');
});

test('计划读取失败保持防重复创建，目标读取也能独立恢复', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  let failConfigs = true;
  let failServers = true;
  const { view, calls } = await openReports(page, route => {
    switch (new URL(route.request().url()).pathname) {
      case '/api/reports': return route.fulfill({ json: reports });
      case '/api/reports/stats': return route.fulfill({ json: { total: reports.length } });
      case '/api/reports/configs':
        return failConfigs
          ? route.fulfill({ status: 503, json: { error: 'REPORT_CONFIG_LIST_UNAVAILABLE' } })
          : route.fulfill({ json: [] });
      default: return route.fulfill({ status: 404 });
    }
  }, route => failServers ? route.fulfill({ status: 503 }) : route.fulfill({ json: [{ id: 8, host: '测试服务器' }] }));
  await expect(view.getByText(/勿重复创建/)).toBeVisible();
  await expect(view.getByRole('button', { name: '新建计划' })).toBeDisabled();
  await expect(view.getByRole('searchbox')).toBeVisible();
  failConfigs = false;
  await view.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(view.getByRole('button', { name: '新建计划' })).toBeEnabled();
  expect(calls.filter(call => call.endsWith('/api/reports/configs'))).toEqual([
    'GET /api/reports/configs', 'GET /api/reports/configs',
  ]);
  await view.getByRole('group', { name: '报表目标类型' }).getByRole('button', { name: '服务器', exact: true }).click();
  await expect(view.getByText('暂时无法读取服务器。')).toBeVisible();
  await expect(view.getByRole('cell', { name: '合成全量巡检' })).toBeVisible();
  failServers = false;
  const beforeRetry = calls.length;
  await view.getByRole('button', { name: '重新读取目标' }).click();
  await expect(view.getByRole('combobox', { name: '生成报表的服务器' })).toBeVisible();
  expect(calls.slice(beforeRetry)).toEqual(['/api/servers']);
});
