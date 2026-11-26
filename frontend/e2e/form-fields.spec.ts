import { test, expect, type Locator, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function harness(page: import('@playwright/test').Page, body: string, modules = 'components/app-form-field') {
  await page.route('**/form-field-harness', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/app/styles/tokens.css"></head><body>${body}<script type="module">import '/src/app/ui/${modules}.ts';</script></body></html>` }));
  await page.goto('/form-field-harness');
}

test('native accessible names, isolated labels, keyboard and changing error descriptions', async ({ page }, info) => {
  await harness(page, '<app-form-field label="用户名" hint="输入登录名"><input></app-form-field><app-form-field label="用户名"><input></app-form-field>');
  const fields = page.locator('app-form-field');
  const first = fields.nth(0).getByRole('textbox', { name: '用户名', exact: true });
  const second = fields.nth(1).getByRole('textbox', { name: '用户名', exact: true });
  await expect(first).toHaveAccessibleDescription('输入登录名');
  await fields.nth(1).locator('label.form-label').click(); await expect(second).toBeFocused();
  await fields.nth(0).locator('label.form-label').click(); await expect(first).toBeFocused();
  await page.keyboard.press('Tab'); await expect(second).toBeFocused();
  await fields.nth(0).evaluate((field: any) => { field.error = '用户名不能为空'; });
  await expect(first).toHaveAttribute('aria-invalid', 'true');
  await expect(first).toHaveAccessibleDescription('用户名不能为空');
  expect(await first.ariaSnapshot()).toContain('textbox "用户名"');
  const cdp = await page.context().newCDPSession(page);
  const tree = await cdp.send('Accessibility.getFullAXTree');
  const input = tree.nodes.find(node => node.role?.value === 'textbox' && node.name?.value === '用户名' && node.description?.value === '用户名不能为空');
  expect(input?.properties).toContainEqual(expect.objectContaining({ name: 'invalid', value: expect.objectContaining({ value: 'true' }) }));
  await info.attach('browser-accessibility-tree.json', { body: JSON.stringify(tree, null, 2), contentType: 'application/json' });
  await writeFile(info.outputPath('browser-accessibility-tree.json'), JSON.stringify(tree, null, 2));
  await page.screenshot({ path: info.outputPath('field-error.png') });
  await fields.nth(0).evaluate((field: any) => { field.error = ''; });
  await expect(first).not.toHaveAttribute('aria-invalid');
  await expect(first).toHaveAccessibleDescription('输入登录名');
});

test('caller labels and descriptions survive, and replaced controls acquire associations', async ({ page }) => {
  await harness(page, '<span id="caller-description">现有说明</span><app-form-field label="容器标签" hint="补充说明"><input id="caller-control" aria-label="调用方名称" aria-describedby="caller-description" aria-invalid="grammar"></app-form-field>');
  const field = page.locator('app-form-field');
  let input = field.getByRole('textbox', { name: '调用方名称' });
  await expect(input).toHaveAccessibleDescription('现有说明 补充说明');
  await field.evaluate((el: any) => { el.error = '字段错误'; });
  await expect(input).toHaveAccessibleDescription('现有说明 字段错误');
  await field.evaluate((el: any) => { el.error = ''; });
  await expect(input).toHaveAttribute('aria-invalid', 'grammar');
  await field.evaluate(el => el.querySelector('input')!.replaceWith(document.createElement('textarea')));
  input = field.getByRole('textbox', { name: '容器标签' });
  await expect(input).toHaveAccessibleDescription('补充说明');
  await field.locator('label.form-label').click(); await expect(input).toBeFocused();
});

for (const status of [200, 403, 500]) {
  test(`audit filter names remain available during loading and response ${status} (controlled API)`, async ({ page }, info) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    await page.route('**/api/audit/logs?**', async route => {
      await pending;
      await route.fulfill({ status, json: status === 200 ? { items: [], total: 0 } : { error: status === 403 ? '无权限' : '加载失败' } });
    });
    await harness(page, '<system-audit-page></system-audit-page>', 'views/system-audit');
    const view = page.locator('system-audit-page');
    await expect(view.getByRole('searchbox', { name: '关键字', exact: true })).toBeVisible();
    await expect(view.getByRole('combobox', { name: '操作类型', exact: true })).toBeVisible();
    for (const name of ['开始时间', '结束时间']) {
      const control = view.getByLabel(name, { exact: true });
      await expect(control).toHaveAccessibleName(name);
      await view.locator('label.form-label').filter({ hasText: name }).click(); await expect(control).toBeFocused();
    }
    finish();
    await expect(view.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await expect(view.getByRole('searchbox', { name: '关键字', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`audit-${status}.png`), fullPage: true });
  });
}

for (const state of ['failed', 'forbidden', 'unknown']) {
  test(`scoring ${state} keeps names and loading state honest (controlled API)`, async ({ page }) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    await page.route('**/api/scoring/config', async route => {
      await pending;
      if (route.request().method() === 'PUT') return route.fulfill({ status: state === 'forbidden' ? 403 : 500, json: { error: '受控保存失败' } });
      return route.fulfill({ json: state === 'unknown' ? null : { availability: .4, performance: .3, capacity: .2, security: .1 } });
    });
    await harness(page, '<scoring-settings-page></scoring-settings-page>', 'views/scoring-settings');
    await expect(page.getByRole('status', { name: '正在加载评分权重' })).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);
    finish();
    if (state === 'unknown') {
      await expect(page.getByRole('alert')).toContainText('未读取到评分权重配置');
      await expect(page.getByRole('slider')).toHaveCount(0);
    } else {
      await expect(page.getByRole('slider', { name: '可用性', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '保存配置' }).click();
      await expect(page.getByText('受控保存失败')).toBeVisible();
      await expect(page.getByRole('slider', { name: '可用性', exact: true })).toHaveAccessibleName('可用性');
    }
  });
}

test('scoring sliders have names, native click focus and percentage values', async ({ page }) => {
  await page.route('**/api/scoring/config', route => route.fulfill({ json: { availability: .4, performance: .3, capacity: .2, security: .1 } }));
  await harness(page, '<scoring-settings-page></scoring-settings-page>', 'views/scoring-settings');
  for (const name of ['可用性', '性能', '容量', '安全性']) {
    const slider = page.getByRole('slider', { name, exact: true });
    await expect(slider).toBeVisible();
    await page.locator('label').filter({ hasText: name }).click(); await expect(slider).toBeFocused();
  }
  const slider = page.getByRole('slider', { name: '可用性', exact: true });
  await slider.focus(); await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('0.45');
  await expect(slider).toHaveAttribute('aria-valuetext', '45%');
  await expect(slider).toHaveAccessibleDescription('实例在线时长与连接成功率 权重总和超过 100%，请减少 5%');
});

test('scoring total uses percent and keyboard errors remain associated until corrected', async ({ page }, info) => {
  const weights = { availability: .35, performance: .35, capacity: .2, security: .1 };
  let saved: unknown;
  let finishSave!: () => void;
  const pendingSave = new Promise<void>(resolve => { finishSave = resolve; });
  await page.route('**/api/scoring/config', async route => {
    if (route.request().method() === 'PUT') {
      await pendingSave;
      saved = route.request().postDataJSON();
    }
    await route.fulfill({ json: route.request().method() === 'PUT' ? { success: true } : weights });
  });
  await harness(page, '<scoring-settings-page></scoring-settings-page>', 'views/scoring-settings');
  const view = page.locator('scoring-settings-page');
  const available = view.getByRole('slider', { name: '可用性', exact: true });
  const performance = view.getByRole('slider', { name: '性能', exact: true });
  const save = view.getByRole('button', { name: '保存配置' });
  await page.screenshot({ path: info.outputPath('scoring-loaded.png'), fullPage: true });
  await expect(view.locator('.total-value')).toHaveText('100% ✓');
  await view.locator('label').filter({ hasText: '可用性' }).click();
  await expect(available).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(view.locator('.total-value')).toHaveText('105%');
  await expect(available).toHaveAccessibleDescription('实例在线时长与连接成功率 权重总和超过 100%，请减少 5%');
  await expect(available).toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();
  await page.screenshot({ path: info.outputPath('scoring-over.png'), fullPage: true });
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  await expect(view.locator('.total-value')).toHaveText('95%');
  await expect(available).toHaveAccessibleDescription('实例在线时长与连接成功率 权重总和不足 100%，请增加 5%');
  await page.screenshot({ path: info.outputPath('scoring-under.png'), fullPage: true });
  await page.keyboard.press('Tab'); await expect(performance).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(view.locator('.total-value')).toHaveText('100% ✓');
  await expect(available).not.toHaveAttribute('aria-invalid');
  await expect(available).toHaveAccessibleDescription('实例在线时长与连接成功率');
  await save.click();
  // #904 CI regression: click completion does not imply the asynchronous save settled.
  try {
    await expect(view.getByRole('button', { name: '保存中...', exact: true })).toBeDisabled();
  } finally { finishSave(); }
  await expect(view.getByRole('status').filter({ hasText: '权重配置已保存' })).toBeVisible();
  expect(saved).toEqual({ ...weights, availability: .3, performance: .4 });
});

for (const scenario of ['empty', 'partial', 'invalid', 'forbidden', 'failed']) {
  test(`scoring ${scenario} response never fabricates valid weights (controlled API)`, async ({ page }, info) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    await page.route('**/api/scoring/config', async route => {
      await pending;
      const status = scenario === 'forbidden' ? 403 : scenario === 'failed' ? 500 : 200;
      const json = scenario === 'empty' ? null : scenario === 'partial' ? {} : scenario === 'invalid'
        ? { availability: .4, performance: .3, capacity: .2, security: '0.1' }
        : { error: scenario === 'forbidden' ? '无权限查看评分权重' : '加载评分权重失败' };
      await route.fulfill({ status, json });
    });
    await harness(page, '<scoring-settings-page></scoring-settings-page>', 'views/scoring-settings');
    await expect(page.getByRole('status', { name: '正在加载评分权重' })).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);
    finish();
    await expect(page.getByRole('alert')).toContainText(scenario === 'empty' ? '未读取到评分权重配置'
      : scenario === 'forbidden' ? '无权限查看评分权重' : scenario === 'failed' ? '加载评分权重失败' : '评分权重配置不完整或无效');
    await expect(page.getByRole('slider')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存配置' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`scoring-${scenario}.png`), fullPage: true });
  });
}

for (const mode of [{ theme: 'light', width: 1280 }, { theme: 'dark', width: 390 }]) {
  test(`scoring percentages and validation remain readable ${mode.theme} ${mode.width}`, async ({ page }, info) => {
    await page.setViewportSize({ width: mode.width, height: 800 });
    await page.route('**/api/scoring/config', route => route.fulfill({ json: { availability: .345, performance: .35, capacity: .2, security: .1 } }));
    await harness(page, '<scoring-settings-page></scoring-settings-page>', 'views/scoring-settings');
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, mode.theme);
    await expect(page.locator('.total-value')).toHaveText('99.5%');
    await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('scoring-theme.png'), fullPage: true });
  });
}

test('same-name scoring forms remain isolated in their existing shadow roots', async ({ page }) => {
  await page.route('**/api/scoring/config', route => route.fulfill({ json: { availability: .4, performance: .3, capacity: .2, security: .1 } }));
  await harness(page, '<scoring-settings-page></scoring-settings-page><scoring-settings-page></scoring-settings-page>', 'views/scoring-settings');
  const forms = page.locator('scoring-settings-page');
  await forms.nth(1).locator('label').filter({ hasText: '可用性' }).click();
  await expect(forms.nth(1).getByRole('slider', { name: '可用性', exact: true })).toBeFocused();
  await expect(forms.nth(0).getByRole('slider', { name: '可用性', exact: true })).not.toBeFocused();
});

for (const mode of [{ theme: 'light', width: 1280 }, { theme: 'dark', width: 390 }]) {
  test(`existing field layout remains usable ${mode.theme} ${mode.width}`, async ({ page }, info) => {
    await page.setViewportSize({ width: mode.width, height: 800 });
    await harness(page, '<app-form-field label="资源名称" hint="保留现有名称" inline><input value="业务数据库"></app-form-field>');
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, mode.theme);
    const input = page.getByRole('textbox', { name: '资源名称' });
    await expect(input).toBeVisible();
    await page.locator('label.form-label').click(); await expect(input).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('field-theme-viewport.png'), fullPage: true });
  });
}

test.describe('MAX-710: accessible names on application routes (controlled HTTP)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  async function openPage(page: Page, path: string, responses: Record<string, unknown> = {}) {
    await page.addInitScript(() => {
      localStorage.setItem('token', 'controlled-form-fields');
      localStorage.setItem('slide.control.session_token.v1', 'controlled-form-fields');
      localStorage.setItem('slide.i18n.locale', 'zh-CN');
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({
        locale: 'zh-CN', themeMode: 'light', accentColor: '#409eff', autoRefreshEnabled: false,
      }));
    });
    await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
      if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
    }));
    await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (!pathname.startsWith('/api/')) return route.fallback();
      return route.fulfill({ json: responses[pathname] ?? {} });
    });
    await page.route('**/api/auth/permissions', route => route.fulfill({ json: ['*'] }));
    await page.route('**/api/user/preferences', route => route.fulfill({ json: { preferences: {} } }));
    await page.goto(path);
  }

  async function expectTabFocus(page: Page, control: Locator) {
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    await expect(control).toBeInViewport();
    await expect.poll(() => control.evaluate(el => el.matches(':focus-visible'))).toBe(true);
  }

  function appDialog(page: Page, name: string) {
    // The shared dialog projects form fields through a slot.
    return page.locator('app-dialog').filter({ has: page.getByRole('dialog', { name, exact: true }) });
  }

  async function closeWithEscape(page: Page, dialog: Locator, trigger: Locator) {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  }

  test('appearance names stay stable as values change and refresh becomes available', async ({ page }, info) => {
    await openPage(page, '/settings/platform/appearance');
    const appearance = page.locator('appearance-settings');
    await expect(appearance.getByRole('combobox', { name: '语言', exact: true })).toHaveValue('zh-CN');
    const landing = appearance.getByRole('combobox', { name: '默认首页', exact: true });
    await landing.focus();
    await landing.selectOption('servers');
    await expect(landing).toHaveValue('servers');
    const width = appearance.getByRole('slider', { name: '侧边栏宽度', exact: true });
    await expectTabFocus(page, width);
    await page.keyboard.press('End');
    await expect(width).toHaveValue('400');

    await expect(appearance.getByRole('button', { name: '减少动画', exact: true })).toBeVisible();
    await expect(appearance.getByRole('button', { name: '数据库', exact: true })).toBeVisible();
    await expect(appearance.getByRole('combobox', { name: '默认每页条数', exact: true })).toBeVisible();
    await expect(appearance.getByRole('combobox', { name: '日期格式', exact: true })).toBeVisible();
    await expect(appearance.getByRole('combobox', { name: '时区', exact: true })).toBeVisible();
    await expect(appearance.getByRole('button', { name: '启用通知', exact: true })).toBeVisible();

    const refresh = appearance.getByRole('combobox', { name: '刷新间隔', exact: true });
    await expect(refresh).toHaveCount(0);
    const toggle = appearance.getByRole('button', { name: '启用自动刷新', exact: true, pressed: false });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expectTabFocus(page, refresh);
    await refresh.selectOption('10');
    await expect(refresh).toHaveValue('10');
    await expect(refresh).toHaveAccessibleName('刷新间隔');
    await page.screenshot({ path: info.outputPath('appearance-refresh-focus.png') });

    const model = appearance.getByRole('textbox', { name: '默认聊天模型', exact: true });
    await model.fill('sample-model');
    await expect(model).toHaveValue('sample-model');
    await expect(model).toHaveAccessibleName('默认聊天模型');
  });

  test('active and aggregate alert filters retain names across selection and input', async ({ page }, info) => {
    await openPage(page, '/events', {
      '/api/alerts': { items: [], total: 0, level_counts: {} },
      '/api/ai/analysis': [],
      '/api/servers': [{ id: 7, host: 'server-test' }],
      '/api/alerts/events': { items: [], total: 0 },
    });
    const list = page.locator('alert-list');
    const severity = list.getByRole('combobox', { name: '告警等级', exact: true });
    const target = list.getByRole('combobox', { name: '目标类型', exact: true });
    const server = list.getByRole('combobox', { name: '服务器', exact: true });
    const search = list.getByRole('textbox', { name: '搜索告警', exact: true });
    await expect(server).toHaveCount(0);
    await severity.focus();
    await expectTabFocus(page, target);
    await target.selectOption('server');
    await expectTabFocus(page, server);
    await server.selectOption('7');
    await expect(server).toHaveValue('7');
    await expectTabFocus(page, search);
    await page.keyboard.type('CPU');
    await expect(search).toHaveValue('CPU');
    await expect(search).toHaveAccessibleName('搜索告警');
    await page.screenshot({ path: info.outputPath('alert-filters-focus.png') });

    await page.getByRole('tab', { name: '聚合事件', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '搜索本页事件', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '本页严重度', exact: true })).toBeVisible();
  });

  for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
    test(`cron task switches and MySQL script fields are keyboard accessible at ${width}×${height}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await openPage(page, '/cron-jobs', {
        '/api/cron/jobs': [
          { id: 1, name: '巡检', enabled: true, task_type: 'agent', cron_expr: '0 * * * *' },
          { id: 2, name: '汇总', enabled: false, task_type: 'script', cron_expr: '0 * * * *' },
        ],
        '/api/cron/jobs/1/toggle': { success: true },
        '/api/cron/scripts': [],
        '/api/database/instances': [{ id: 7, name: '测试实例', db_type: 'mysql' }],
      });
      const cron = page.locator('cron-jobs-settings');
      const create = cron.getByRole('button', { name: '+ 新建任务', exact: true });
      const filter = cron.getByRole('combobox', { name: '筛选模式', exact: true });
      const first = cron.getByRole('button', { name: '启用任务：巡检', exact: true });
      const second = cron.getByRole('button', { name: '启用任务：汇总', exact: true });
      const table = cron.getByRole('region', { name: '定时任务表格，可横向滚动' });
      await create.focus();
      await expectTabFocus(page, filter);
      await filter.selectOption('script');
      await expect(first).toHaveCount(0);
      await expectTabFocus(page, table);
      await expectTabFocus(page, cron.getByRole('button', { name: '查看执行记录：汇总', exact: true }));
      await expectTabFocus(page, second);
      await expect(second).toHaveAttribute('aria-pressed', 'false');
      await filter.focus();
      await filter.selectOption('all');
      await expectTabFocus(page, table);
      await expectTabFocus(page, cron.getByRole('button', { name: '查看执行记录：巡检', exact: true }));
      await expectTabFocus(page, first);
      await page.keyboard.press('Space');
      await expect(first).toHaveAttribute('aria-pressed', 'false');

      await create.focus();
      await page.keyboard.press('Enter');
      const dialog = appDialog(page, '新建任务');
      await expect(dialog.getByRole('textbox', { name: '任务名称', exact: true })).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: '任务内容（自然语言）', exact: true })).toBeVisible();
      const mode = dialog.getByRole('combobox', { name: '执行模式', exact: true });
      await mode.focus();
      await mode.selectOption('script');
      const editor = dialog.getByRole('textbox', { name: 'SQL 脚本', exact: true });
      await expectTabFocus(page, editor);
      await page.keyboard.type('select 1');
      await expect(editor).toHaveText('select 1');
      await expect(editor).toHaveAttribute('contenteditable', 'true');
      await expect(editor).toHaveAccessibleName('SQL 脚本');
      await expect(dialog.locator('script-editor .editor-wrapper')).toHaveCSS('outline-style', 'solid');
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const axEditor = nodes.find(node => node.role?.value === 'textbox' && node.name?.value === 'SQL 脚本');
      expect(axEditor?.properties).toContainEqual(expect.objectContaining({
        name: 'focused', value: expect.objectContaining({ value: true }),
      }));
      await cdp.detach();
      await page.screenshot({ path: info.outputPath('cron-editor-focus.png') });

      const instance = dialog.getByRole('combobox', { name: '目标实例', exact: true });
      await expectTabFocus(page, instance);
      const database = dialog.getByRole('textbox', { name: '目标数据库', exact: true });
      await expect(database).toHaveCount(0);
      await instance.selectOption('7');
      await expectTabFocus(page, dialog.getByRole('button', { name: '测试执行', exact: true }));
      await expectTabFocus(page, database);
      await expect(database).toHaveAccessibleDescription('（未填写时使用实例默认库，或在 SQL 中写明库名）');
      await page.keyboard.type('information_schema');
      await expect(database).toHaveValue('information_schema');
      await expect(database).toHaveAccessibleName('目标数据库');
      await expect(dialog.getByRole('textbox', { name: 'Cron 表达式', exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath('cron-database-focus.png') });
      await closeWithEscape(page, dialog, create);
    });
  }

  test('role creation and user editing keep field names and restore trigger focus', async ({ page }, info) => {
    await openPage(page, '/settings/access/users?view=roles', {
      '/api/v1/rbac/roles': [{ id: 1, name: 'viewer', description: null }],
      '/api/users': [{ id: 7, username: 'fixture-user', email: 'user@example.test', status: 'inactive', created_at: '2026-11-01T00:00:00Z' }],
    });
    const create = page.getByRole('button', { name: '新建角色', exact: true });
    await create.focus();
    await page.keyboard.press('Enter');
    const role = appDialog(page, '新建角色');
    const name = role.getByRole('textbox', { name: '角色名称', exact: true });
    const description = role.getByRole('textbox', { name: '描述', exact: true });
    await expectTabFocus(page, name);
    await page.keyboard.type('DBA');
    await expect(name).toHaveValue('DBA');
    await expectTabFocus(page, description);
    await page.keyboard.type('Role details');
    await expect(description).toHaveValue('Role details');
    await page.screenshot({ path: info.outputPath('role-form-focus.png') });
    await closeWithEscape(page, role, create);

    await page.goto('/settings/access/users');
    const edit = page.getByRole('row', { name: /fixture-user/ }).getByRole('button', { name: '编辑', exact: true });
    await edit.focus();
    await page.keyboard.press('Enter');
    const user = appDialog(page, '编辑用户');
    await expect(user.getByRole('textbox', { name: '用户名', exact: true })).toBeDisabled();
    await expectTabFocus(page, user.getByRole('textbox', { name: '邮箱', exact: true }));
    await expectTabFocus(page, user.getByRole('checkbox', { name: '观察者', exact: true }));
    const status = user.getByRole('combobox', { name: '状态', exact: true });
    await expectTabFocus(page, status);
    await expect(status).toHaveValue('inactive');
    await status.selectOption('locked');
    await expect(status).toHaveValue('locked');
    await page.screenshot({ path: info.outputPath('user-status-focus.png') });
    await closeWithEscape(page, user, edit);
  });
});
