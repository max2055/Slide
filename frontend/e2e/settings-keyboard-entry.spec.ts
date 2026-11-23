import { expect, test, type Locator, type Page } from '@playwright/test';

test.skip(process.env.PLAYWRIGHT_MANAGED_ENV !== '1', 'Requires the isolated Fastify/MySQL qualification service');
test.use({ viewport: { width: 1366, height: 768 } });

async function tabTo(page: Page, target: Locator, key = 'Tab') {
  await expect(target).toBeVisible();
  for (let step = 0; step < 45; step += 1) {
    if (await target.evaluate(el => el.matches(':focus'))) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

async function expectFocusRing(target: Locator) {
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
  await expect(target).toHaveCSS('outline-style', 'solid');
  await expect(target).toHaveCSS('outline-width', '2px');
}

function observeWrites(page: Page, paths: RegExp) {
  const requests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && paths.test(path)) requests.push(`${request.method()} ${path}`);
  });
  return requests;
}

test.beforeEach(async ({ page }) => {
  const password = process.env.QUALIFICATION_ADMIN_PASSWORD;
  if (!password) throw new Error('QUALIFICATION_ADMIN_PASSWORD is required for isolated settings qualification');
  const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password } });
  expect(login.ok()).toBe(true);
  const session = await login.json();
  const permissions = await page.request.get('/api/auth/permissions', { headers: { Authorization: `Bearer ${session.token}` } });
  expect(permissions.ok()).toBe(true);
  await page.addInitScript(({ session, permissions }) => {
    localStorage.setItem('token', session.token);
    localStorage.setItem('refreshToken', session.refreshToken);
    localStorage.setItem('user', JSON.stringify(session.user));
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  }, { session, permissions: await permissions.json() });
  await page.goto('/dashboard');
  await page.locator('.sidebar-utility-group').getByRole('link', { name: '设置', exact: true }).click();
});

test('提示词类型支持展开、版本编辑取消与收起回焦', async ({ page }, info) => {
  const requests = observeWrites(page, /^\/api\/ai\/prompts\b/);
  const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/prompts');
  await page.getByRole('navigation', { name: '设置导航' }).getByRole('button', { name: '提示词管理', exact: true }).click();
  const response = await read;
  expect(response.ok()).toBe(true);
  const { types } = await response.json();
  expect(types.length).toBeGreaterThan(0);

  const view = page.locator('prompt-settings-page');
  const headers = view.getByRole('button').and(view.locator('.type-header'));
  await expect(headers).toHaveCount(types.length);
  await tabTo(page, view.getByRole('button', { name: '刷新', exact: true }));
  for (let index = 0; index < types.length; index += 1) {
    const header = headers.nth(index);
    await page.keyboard.press('Tab');
    await expectFocusRing(header);
    const id = await header.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    const versions = view.locator(`[id="${id}"]`);
    await expect(versions).toHaveCount(1);
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(versions).toBeHidden();
    await page.keyboard.press(index % 2 ? 'Space' : 'Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(versions).toBeVisible();
    if (index === 0) await page.screenshot({ path: info.outputPath('prompt-header-focus.png') });

    const edit = versions.getByRole('button', { name: '编辑', exact: true }).first();
    await tabTo(page, edit);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /^编辑提示词/ });
    const editor = view.locator('app-dialog[title^="编辑提示词"]');
    await expect(dialog).toBeVisible();
    await tabTo(page, editor.getByRole('textbox', { name: '提示词内容', exact: true }));
    await tabTo(page, editor.getByRole('button', { name: '取消', exact: true }));
    await page.keyboard.press('Space');
    await expect(dialog).toBeHidden();
    await expect(edit).toBeFocused();

    await tabTo(page, header, 'Shift+Tab');
    await page.keyboard.press(index % 2 ? 'Enter' : 'Space');
    await expect(header).toBeFocused();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(versions).toBeHidden();
  }
  expect(requests).toEqual([]);
});

test('提供商模板可逐卡聚焦且键盘和鼠标带入相同配置', async ({ page }, info) => {
  const requests = observeWrites(page, /^\/api\/(?:llm\b|ai\/prompts\b|.*(?:generat|completions))/);
  const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/llm/configs');
  await page.getByRole('navigation', { name: '设置导航' }).getByRole('button', { name: '模型配置', exact: true }).click();
  expect((await read).ok()).toBe(true);

  const view = page.locator('llm-config-page');
  await tabTo(page, view.getByRole('button', { name: /添加提供商/ }));
  await page.keyboard.press('Enter');
  const cards = view.locator('.template-grid .template-card');
  const choices = view.getByRole('button').and(cards);
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  expect(count).toBeGreaterThan(1);
  await expect(choices).toHaveCount(count);
  const name = view.getByRole('textbox', { name: /^标识名/ });
  const draft = async () => ({
    name: await name.inputValue(),
    display: await view.getByRole('textbox', { name: '显示名称', exact: true }).inputValue(),
    baseUrl: await view.getByRole('textbox', { name: 'Base URL', exact: true }).inputValue(),
    defaultModel: await view.getByLabel('手动模型 ID', { exact: true }).inputValue(),
  });
  const returnToTemplate = async (choice: Locator) => {
    await tabTo(page, view.getByRole('button', { name: '返回模板', exact: true }));
    await page.keyboard.press('Enter');
    const discard = page.getByRole('dialog', { name: '放弃未保存修改？' });
    await expect(discard).toBeVisible();
    await tabTo(page, view.getByRole('button', { name: '放弃并离开', exact: true }));
    await page.keyboard.press('Space');
    await expect(discard).toBeHidden();
    await expectFocusRing(choice);
  };

  for (let index = 0; index < count; index += 1) {
    const choice = choices.nth(index);
    await page.keyboard.press('Tab');
    await expectFocusRing(choice);
    if (index === 1) await page.screenshot({ path: info.outputPath('provider-template-focus.png') });
    await page.keyboard.press(index % 2 ? 'Space' : 'Enter');
    await expect(name).toBeFocused();
    const keyboardDraft = await draft();
    await returnToTemplate(choice);
    await choice.click();
    await expect(name).toBeFocused();
    expect(await draft()).toEqual(keyboardDraft);
    await returnToTemplate(choice);
  }
  await page.keyboard.press('Shift+Tab');
  await expectFocusRing(choices.nth(count - 2));
  expect(requests).toEqual([]);
});

test('新建权限标签聚焦对应字段并保留校验与取消回焦', async ({ page }, info) => {
  const requests = observeWrites(page, /^\/api\/v1\/rbac\/permissions\b/);
  await page.getByRole('navigation', { name: '设置导航' }).getByRole('button', { name: '用户与权限', exact: true }).click();
  const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/rbac/permissions');
  await page.getByRole('tab', { name: '权限', exact: true }).click();
  expect((await read).ok()).toBe(true);

  const view = page.locator('permission-management-tab');
  await expect(view.getByRole('heading', { name: '权限管理', exact: true })).toBeVisible();
  const open = view.getByRole('button', { name: /新建权限/ });
  await tabTo(page, open);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '新建权限', exact: true });
  const form = view.locator('app-dialog[title="新建权限"]');
  await expect(dialog).toBeVisible();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByText('权限码不能为空', { exact: true })).toBeVisible();
  for (const [label, value] of [['权限码', 'invalid'], ['名称', '浏览器验收'], ['描述', '取消后丢弃本次草稿']]) {
    const field = form.getByRole('textbox', { name: label, exact: true });
    await form.locator('label').and(form.getByText(label, { exact: true })).click();
    await expect(field).toBeFocused();
    await page.keyboard.insertText(value);
    await expect(field).toHaveValue(value);
    await expect(field).toHaveAccessibleName(label);
  }
  await expect(form.getByText(/权限码格式错误/)).toBeVisible();
  const cancel = form.getByRole('button', { name: '取消', exact: true });
  await tabTo(page, cancel);
  await expectFocusRing(cancel);
  await page.screenshot({ path: info.outputPath('permission-cancel-focus.png') });
  await page.keyboard.press('Space');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  expect(requests).toEqual([]);
});
