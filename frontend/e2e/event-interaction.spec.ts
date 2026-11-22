import { expect, test, type Page, type Route } from '@playwright/test';

const aggregateUrl = '/events?view=aggregate';
const activeScope = 'open,investigating,handled';
const resolvedScope = 'resolved,closed';
const emptyList = { items: [], total: 0 };
const sampleEvent = {
  id: '51',
  title: '连接数告警',
  status: 'open',
  severity: 'warning',
  alert_count: 1,
  instance_name: '验收实例',
  created_at: '2026-11-22T00:00:00.000Z',
};

async function setupAggregate(
  page: Page,
  list: (route: Route, query: URLSearchParams) => Promise<void>,
  open = 0,
  accentColor?: string,
) {
  await page.addInitScript(color => {
    localStorage.setItem('token', 'event-browser-fixture');
    localStorage.setItem('slide.control.session_token.v1', 'event-browser-fixture');
    const settingsKey = 'slide.control.settings.v1:default';
    if (!localStorage.getItem(settingsKey)) localStorage.setItem(settingsKey, JSON.stringify({ locale: 'zh-CN', theme: 'light', accentColor: color }));
  }, accentColor);
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (!pathname.startsWith('/api/')) return route.fallback();
    switch (pathname) {
      case '/api/auth/permissions':
        return route.fulfill({ json: ['alert:view'] });
      case '/api/user/preferences':
        return route.fulfill({ json: { preferences: { locale: 'zh-CN' } } });
      case '/api/alerts/events':
        return list(route, searchParams);
      case '/api/alerts/events/stats':
        return route.fulfill({ json: { total: open, open, investigating: 0, handled: 0, resolved: 0, closed: 0 } });
      case '/api/alerts/events/mttr':
        return route.fulfill({ status: 404, json: {} });
      default:
        return route.fulfill({ status: 503, json: {} });
    }
  });
}

const resultMessages = /^(暂无活跃事件|没有已解决事件|暂无匹配的事件|系统运行正常)$/;

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`#1036 successful aggregate empty states at ${width}×${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const initial = Promise.withResolvers<void>();
    await setupAggregate(page, async (route, query) => {
      expect(query.get('limit')).toBe('50');
      expect(query.get('offset')).toBe('0');
      const status = query.get('status');
      expect([activeScope, resolvedScope]).toContain(status);
      if (status === activeScope) await initial.promise;
      await route.fulfill({ json: emptyList });
    });
    const list = page.locator('event-management-page');
    try {
      await page.goto(aggregateUrl);
      await expect(list.getByText('正在加载事件', { exact: true })).toBeVisible();
      await expect(list.getByText(resultMessages)).toHaveCount(0);
      if (width === 1440) await page.screenshot({ path: info.outputPath('initial-loading.png') });
    } finally {
      initial.resolve();
    }

    await expect(list.getByText('暂无活跃事件', { exact: true })).toBeVisible();
    await expect(list.getByText('系统运行正常', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`active-empty-${width}.png`) });
    if (width !== 1440) return;

    const resolvedRequest = page.waitForRequest(request =>
      new URL(request.url()).searchParams.get('status') === resolvedScope);
    await list.getByRole('button', { name: /^已解决/ }).click();
    await resolvedRequest;
    await expect(list.getByText('没有已解决事件', { exact: true })).toBeVisible();
    await expect(list.getByText('暂无活跃事件', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('resolved-empty.png') });
  });
}

test('#1036 page filters preserve query scope and pagination', async ({ page }, info) => {
  const nextPage = Promise.withResolvers<void>();
  const offsets: string[] = [];
  await setupAggregate(page, async (route, query) => {
    expect(query.get('limit')).toBe('50');
    expect(query.get('status')).toBe(activeScope);
    const offset = query.get('offset');
    expect(['0', '50']).toContain(offset);
    offsets.push(offset!);
    if (offset === '50') await nextPage.promise;
    const items = offset === '50' ? [sampleEvent] : Array.from({ length: 50 }, (_, index) => ({
      ...sampleEvent, id: String(index + 1),
    }));
    await route.fulfill({ json: { items, total: 51 } });
  }, 51);
  const list = page.locator('event-management-page');
  const noMatch = list.getByText('暂无匹配的事件', { exact: true });
  const search = list.getByRole('textbox', { name: '搜索本页事件' });
  const severity = list.getByRole('combobox', { name: '本页严重度' });

  try {
    await page.goto(aggregateUrl);
    await expect(list.getByText('第 1/2 页，共 51 条')).toBeVisible();
    const stats = list.locator('stat-card');
    await expect(stats).toHaveCount(6);
    await expect(stats.filter({ has: page.getByText('开放', { exact: true }) }).locator('[part="value"]')).toHaveText('51');
    await expect(stats.filter({ has: page.getByText('平均 MTTR (分钟)', { exact: true }) }).locator('[part="value"]')).toHaveText('—');
    await expect(page.locator('html')).toHaveCSS('--accent', '#265f99');
    await search.fill('无匹配标题');
    await expect(noMatch).toBeVisible();
    await search.fill('连接数');
    await expect(noMatch).toHaveCount(0);
    await severity.selectOption('critical');
    await expect(noMatch).toBeVisible();
    expect(new Set(offsets)).toEqual(new Set(['0']));
    await page.screenshot({ path: info.outputPath('filter-no-match.png') });

    const request = page.waitForRequest(request =>
      new URL(request.url()).searchParams.get('offset') === '50');
    await list.getByRole('button', { name: /下一页/ }).click();
    await request;
    await expect(list.getByRole('button', { name: '刷新事件' })).toBeDisabled();
    await expect(list.getByText(resultMessages)).toHaveCount(0);
  } finally {
    nextPage.resolve();
  }
  await expect(list.getByRole('button', { name: '刷新事件' })).toBeEnabled();
  await expect(noMatch).toBeVisible();
  await expect(search).toHaveValue('连接数');
  await expect(severity).toHaveValue('critical');
  await expect(list.getByText('第 2/2 页，共 51 条')).toBeVisible();
  await severity.selectOption('warning');
  await expect(list.getByRole('button', { name: /查看事件 #51 详情/ })).toBeVisible();
});

test('#1036 forbidden event reads show permission feedback', async ({ page }, info) => {
  await setupAggregate(page, route => route.fulfill({ status: 403, json: {} }));
  await page.goto(aggregateUrl);
  const list = page.locator('event-management-page');
  await expect(list.getByRole('alert')).toContainText('无权访问事件');
  await expect(list.getByText(resultMessages)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('permission-denied.png') });
});

for (const withData of [false, true]) {
  test(`#1036 failed event reads recover to ${withData ? 'rows' : 'empty'}`, async ({ page }, info) => {
    const retry = Promise.withResolvers<void>();
    let fail = true;
    await setupAggregate(page, async (route, query) => {
      expect(query.get('status')).toBe(activeScope);
      if (fail) return route.fulfill({ status: 500, json: {} });
      await retry.promise;
      await route.fulfill({ json: withData ? { items: [sampleEvent], total: 1 } : emptyList });
    }, withData ? 1 : 0);
    const list = page.locator('event-management-page');
    const error = list.getByRole('alert');
    try {
      await page.goto(aggregateUrl);
      await expect(error).toContainText('事件加载失败: 500');
      await expect(list.getByText(resultMessages)).toHaveCount(0);
      if (!withData) await page.screenshot({ path: info.outputPath('load-failed.png') });

      fail = false;
      const retryButton = error.getByRole('button', { name: '重试加载' });
      await retryButton.focus();
      await expect(retryButton).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(error.getByRole('button', { name: '重试中...' })).toBeDisabled();
      await expect(list.getByText(resultMessages)).toHaveCount(0);
      if (!withData) await page.screenshot({ path: info.outputPath('retry-pending.png') });
    } finally {
      retry.resolve();
    }

    await expect(error).toHaveCount(0);
    if (withData) {
      await expect(list.getByText(sampleEvent.title, { exact: true })).toBeVisible();
      await expect(list.getByText(resultMessages)).toHaveCount(0);
    } else {
      await expect(list.getByText('暂无活跃事件', { exact: true })).toBeVisible();
      await expect(list.getByText('系统运行正常', { exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: info.outputPath(withData ? 'retry-rows.png' : 'retry-empty.png') });
  });
}

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

test('late browser detail and save responses cannot overwrite a newly selected event draft', async ({page})=>{
 let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(!path.startsWith('/api/'))return route.continue();
  if(path.includes('/events/1'))await gate;
  await route.fulfill({json:path.endsWith('/logs')?[]:path.endsWith('/note')?{success:true}:{id:'2',title:'current',alerts:[],items:[],total:0}});
 });
 await page.goto('/');
 await page.evaluate(async()=>{
  await import('/src/app/ui/views/event-management.ts');
  const el=document.createElement('event-management-page') as any;
  document.body.replaceChildren(el);
  el._selectEvent({id:'1',title:'old',severity:'warning'});
  await el._selectEvent({id:'2',title:'current',severity:'warning'});
  el.selectedEvent={id:'1'}; el.noteText='same';
  (window as any).save=el._addNote();
  el.selectedEvent={id:'2',title:'current',severity:'warning'};el.noteText='same';
 });
 release();
 await page.evaluate(async()=>{
  await (window as any).save;
  const el=document.querySelector('event-management-page') as any;
  if(el.noteText!=='same'||el.selectedEvent.id!=='2')throw Error('old response changed current event');
 });
});

test('#1038 saved appearance is applied on reload', async ({ page }) => {
  await setupAggregate(page, route => route.fulfill({ json: emptyList }), 0, '#6366f1');
  await page.goto(aggregateUrl);
  const root = page.locator('html');
  await expect(root).toHaveCSS('--accent', '#6366f1');
  await page.reload();
  await expect(root).toHaveCSS('--accent', '#6366f1');
});
