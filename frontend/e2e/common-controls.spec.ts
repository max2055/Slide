import { test, expect, type Page, type Locator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function mount(page: Page, markup: string, modules: string[] = []) {
  await page.route('**/common-controls-harness', route => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN" data-theme-mode="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/app/styles/tokens.css"><style>body{margin:24px;font-family:var(--font-sans);color:var(--text);background:var(--bg)}main{max-width:1100px;margin:auto}input{box-sizing:border-box;width:100%;padding:10px}section{margin-bottom:24px}app-toggle{margin-right:24px}</style></head><body><main>${markup}</main><script type="module">
      import {html,render} from '/node_modules/lit/index.js';
      import '/src/app/ui/components/app-form-field.ts';
      import '/src/app/ui/components/app-badge.ts';
      import '/src/app/ui/components/app-toggle.ts';
      import '/src/components/stat-card.ts';
      ${modules.map(module => `import '/src/app/ui/views/${module}.ts';`).join('\n')}
      window.controlTemplates = {html,render}; window.controlsReady = true;
    </script></body></html>`,
  }));
  await page.goto('/common-controls-harness');
  await page.waitForFunction(() => (window as any).controlsReady);
}

async function errorStyle(field: Locator) {
  return field.evaluate(el => ({
    label: getComputedStyle(el.shadowRoot!.querySelector('.form-label')!).color,
    shadow: getComputedStyle(el.shadowRoot!.querySelector('.form-control')!).boxShadow,
  }));
}

test('#418 property/attribute errors style and clear with descriptions intact', async ({ page }, info) => {
  await mount(page, '<div id="binding"></div>');
  await page.evaluate(() => {
    const { html, render } = (window as any).controlTemplates;
    render(html`<app-form-field label="资源名称" hint="输入资源名称" .error=${'名称不能为空'}><input></app-form-field>`, document.querySelector('#binding'));
  });
  const field = page.locator('app-form-field');
  const input = field.getByRole('textbox', { name: '资源名称' });
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAccessibleDescription('名称不能为空');
  expect((await errorStyle(field)).shadow).not.toBe('none');
  await page.screenshot({ path: info.outputPath('property-error.png'), animations: 'disabled' });
  await field.evaluate((el: any) => { el.error = ''; });
  await expect(input).not.toHaveAttribute('aria-invalid');
  await expect(input).toHaveAccessibleDescription('输入资源名称');
  const normal = await errorStyle(field); expect(normal.shadow).toBe('none');
  await field.evaluate(el => el.setAttribute('error', '格式错误'));
  await expect(input).toHaveAccessibleDescription('格式错误');
  expect((await errorStyle(field)).shadow).not.toBe('none');
  expect((await errorStyle(field)).label).not.toBe(normal.label);
  await field.evaluate(el => el.setAttribute('error', ''));
  await expect(input).not.toHaveAttribute('aria-invalid');
  expect(await errorStyle(field)).toEqual(normal);
  // Existing attributes cannot override the actual property state (#418).
  await field.evaluate((el: any) => { el.setAttribute('error', 'old'); el.error = ''; });
  await expect.poll(() => errorStyle(field)).toEqual(normal);
  for (const empty of [false, null, undefined]) {
    await field.evaluate((el: any, value) => { el.error = value; }, empty);
    await expect.poll(() => errorStyle(field)).toEqual(normal);
    await expect(input).not.toHaveAttribute('aria-invalid');
    await expect(field.getByRole('alert')).toHaveCount(0);
  }
  await field.locator('.form-label').click(); await expect(input).toBeFocused();
});

test('#445 string hints and template hints retain text and markup', async ({ page }) => {
  await mount(page, '<stat-card hint="已存快照 &lt;表&gt;"></stat-card><div id="binding"></div>');
  await expect(page.locator('stat-card').locator('[part=hint]')).toHaveText('已存快照 <表>');
  await page.evaluate(() => {
    const { html, render } = (window as any).controlTemplates;
    render(html`<stat-card .hint=${html`<span>正常 <b>2</b></span>`}></stat-card>`, document.querySelector('#binding'));
  });
  await expect(page.locator('#binding stat-card b')).toHaveText('2');
  await expect(page.locator('stat-card').first().locator('[part=hint] > *')).toHaveCount(0);
});

test('#646 default and all attribute/property variants color host and dot', async ({ page }, info) => {
  await mount(page, '<app-badge>默认状态</app-badge><app-badge id="attribute">属性状态</app-badge><div id="binding"></div>');
  const colors = (badge: Locator) => badge.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color, dot: getComputedStyle(el, '::before').backgroundColor }));
  const defaultBadge = page.locator('app-badge').first();
  const initial = await colors(defaultBadge);
  expect(initial.bg).not.toBe('rgba(0, 0, 0, 0)'); expect(initial.dot).not.toBe('rgba(0, 0, 0, 0)');
  for (const variant of ['ok', 'danger', 'warn', 'info', 'muted']) {
    await page.locator('#attribute').evaluate((el, value) => el.setAttribute('variant', value), variant);
    await page.evaluate(value => {
      const { html, render } = (window as any).controlTemplates;
      render(html`<app-badge .variant=${value}>绑定状态</app-badge>`, document.querySelector('#binding'));
    }, variant);
    const attribute = await colors(page.locator('#attribute'));
    await expect.poll(() => colors(page.locator('#binding app-badge'))).toEqual(attribute);
    const expected = await defaultBadge.evaluate((el, value) => {
      const probe = document.createElement('span'); probe.style.color = `var(--${value})`; el.append(probe);
      const color = getComputedStyle(probe).color; probe.remove(); return color;
    }, variant);
    expect(attribute.text).toBe(expected); expect(attribute.dot).toBe(expected);
    expect(attribute.bg).not.toBe('rgba(0, 0, 0, 0)');
    if (variant === 'muted') expect(attribute).toEqual(initial);
  }
  await page.screenshot({ path: info.outputPath('badge-muted.png'), animations: 'disabled' });
});

test('#715 text/slider, keyboard and disabled inputs produce exactly one change', async ({ page }) => {
  await mount(page, '<app-toggle>启用通知</app-toggle><app-toggle disabled>禁用通知</app-toggle>');
  const toggle = page.locator('app-toggle').first();
  await toggle.evaluate(el => { (window as any).changes = []; el.addEventListener('change', (e: any) => (window as any).changes.push(e.detail)); });
  await toggle.locator('.label').click();
  await expect(toggle.locator('button')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).changes)).toEqual([true]);
  await toggle.locator('button').click();
  await expect(toggle.locator('button')).toHaveAttribute('aria-pressed', 'false');
  await toggle.locator('button').focus();
  await page.keyboard.press('Space'); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).changes)).toEqual([true, false, true, false]);
  await expect(toggle.locator('button')).toHaveAccessibleName('启用通知');
  for (const disabled of [toggle, page.locator('app-toggle').nth(1)]) {
    await disabled.evaluate((el: any) => { el.disabled = true; });
    await expect(disabled.locator('button')).toBeDisabled();
    // Coordinates exercise real pointer behavior even when the host blocks pointer events.
    for (const target of [disabled.locator('.label'), disabled.locator('button')]) {
      const box = (await target.boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await target.dispatchEvent('click');
    }
    await expect(disabled.locator('button')).toHaveAttribute('aria-pressed', 'false');
  }
  expect(await page.evaluate(() => (window as any).changes)).toEqual([true, false, true, false]);
  await toggle.evaluate((el: any) => { el.disabled = false; });
  await expect(toggle.locator('button')).toBeEnabled();
  await toggle.locator('.label').click();
  await expect(toggle.locator('button')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).changes)).toEqual([true, false, true, false, true]);
});

for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`real callers at ${width}x${height} (production components, controlled HTTP samples)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('slide.i18n.locale', 'zh-CN'));
    const reads: string[] = [];
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      reads.push(path);
      if (route.request().method() !== 'GET') return route.fulfill({ status: 405, json: { error: '本用例仅允许读取受控样本' } });
      if (path === '/api/branding/config') return route.fulfill({ json: { cli_name: 'slide', product_name: 'Slide', env_prefix: 'SLIDE', state_dir: '.slide' } });
      if (path === '/api/database/instances') return route.fulfill({ json: [{ id: 655, name: '控件验收数据库', db_type: 'mysql', host: 'sample.invalid', port: 3306, database_name: 'sample', status: 'online', health_status: 'healthy' }] });
      if (path === '/api/schema/snapshot/655') return route.fulfill({ json: { tables: [] } });
      if (path === '/api/schema/snapshots/655') return route.fulfill({ json: [] });
      if (path === '/api/schema/changes/655') return route.fulfill({ json: { changes: [] } });
      if (path === '/api/platform/system-events') return route.fulfill({ json: { items: [{ eventId: 'controls-655', summary: '控件验收异常样本', component: '采集器', occurredAt: '2026-11-13T00:00:00Z', disposition: 'suppressed', investigationId: null }], truncated: false } });
      return route.fulfill({ status: 404, json: { error: `未定义样本 ${path}` } });
    });
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await mount(page, '<branding-settings></branding-settings>', ['branding-settings']);
    const cli = page.getByRole('textbox', { name: 'CLI 命令名称', exact: true });
    await cli.fill('Invalid');
    const field = page.locator('app-form-field[label="CLI 命令名称"]');
    await expect(cli).toHaveAttribute('aria-invalid', 'true');
    expect((await errorStyle(field)).shadow).not.toBe('none');
    await expect(field.getByRole('alert')).toHaveText('仅允许小写字母开头，包含小写字母、数字和连字符');
    await noOverflow(); await page.screenshot({ path: info.outputPath('branding-error.png'), fullPage: true, animations: 'disabled' });
    await cli.fill('slide'); await expect(cli).not.toHaveAttribute('aria-invalid');
    expect((await errorStyle(field)).shadow).toBe('none');
    await field.locator('.form-label').click(); await expect(cli).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByRole('textbox', { name: '环境变量前缀', exact: true })).toBeFocused();

    await mount(page, '<schema-management-page></schema-management-page>', ['schema-management']);
    await expect(page.locator('stat-card')).toHaveCount(4);
    await expect(page.locator('stat-card').locator('[part=hint]')).toHaveText(['已存快照', '历史记录', '新增表/列', '删除表/列']);
    await noOverflow(); await page.screenshot({ path: info.outputPath('schema-hints.png'), fullPage: true, animations: 'disabled' });

    await mount(page, '<system-events-page></system-events-page>', ['system-events']);
    const badge = page.locator('system-events-page app-badge');
    await expect(badge).toHaveText('自动调查未派发');
    await expect(badge).toHaveAttribute('variant', 'muted');
    const badgeColors = await badge.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, dot: getComputedStyle(el, '::before').backgroundColor }));
    expect(badgeColors.background).not.toBe('rgba(0, 0, 0, 0)'); expect(badgeColors.dot).not.toBe('rgba(0, 0, 0, 0)');
    await noOverflow(); await page.screenshot({ path: info.outputPath('system-event-badge.png'), fullPage: true, animations: 'disabled' });

    await mount(page, '<appearance-settings></appearance-settings>', ['appearance-settings', '../components/app-select-field', '../components/app-option-group']);
    const toggle = page.locator('appearance-settings app-toggle').first();
    await expect(toggle.locator('button')).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => {
      (window as any).settingChanges = [];
      window.addEventListener('slide-settings-change', (event: any) => (window as any).settingChanges.push(event.detail));
    });
    await toggle.locator('.label').click();
    await expect(toggle.locator('button')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => (window as any).settingChanges)).toEqual([{ reduceAnimations: true }]);
    await toggle.locator('button').focus(); await page.keyboard.press('Space');
    await expect(toggle.locator('button')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => (window as any).settingChanges)).toEqual([{ reduceAnimations: true }, { reduceAnimations: false }]);
    await expect(toggle.locator('button')).toHaveAccessibleName('减少动画');
    await noOverflow(); await page.screenshot({ path: info.outputPath('appearance-toggle.png'), fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]);
    const evidencePath = info.outputPath('caller-evidence.json');
    await writeFile(evidencePath, JSON.stringify({ viewport: { width, height }, reads, badgeColors, errors }, null, 2));
    await info.attach('caller-evidence.json', { path: evidencePath, contentType: 'application/json' });
  });
}
