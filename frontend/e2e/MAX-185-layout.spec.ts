import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const testingRequire = createRequire(require.resolve('@open-wc/testing'));
const axeRequire = createRequire(testingRequire.resolve('chai-a11y-axe'));

test.skip(!process.env.MAX178_ISOLATED_MYSQL, 'Use scripts/qualification/run-MAX-185.sh');
const out = 'test-results/MAX-185-evidence';

test('representative application shell: full-width connection, first model, selection and deep links', async ({ page, request }) => {
  await mkdir(out, { recursive: true });
  const login = await request.post('/api/auth/login', { data: { username: 'admin', password: process.env.QUALIFICATION_ADMIN_PASSWORD } });
  expect(login.ok()).toBe(true);
  const { token, user } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const created = await request.post('/api/llm/configs', { headers, data: {
    name: 'max185-isolated', displayName: '运维模型（隔离验收）', deploymentType: 'api', apiFormat: 'openai-completions',
    baseURL: 'http://127.0.0.1:1/v1', enabled: false, model: 'deepseek-flash',
    modelsSupported: [
      { id: 'deepseek-flash', name: '运维快速分析', contextWindow: 128000 },
      { id: 'reasoning-model', name: '复杂诊断推理', contextWindow: 64000 },
      { id: 'local-model', name: '本地离线模型', parameterSource: 'unknown' },
    ], contextWindow: 128000, maxTokens: 4096,
  } });
  const result = await created.json(); expect(result.success).toBe(true);
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  }, { token, user });
  const measurements = [];
  for (const width of [1280, 1440, 768, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/settings/ai/models?view=providers');
    const view = page.locator('llm-config-page');
    await view.getByLabel('提供商', { exact: true }).selectOption(String(result.providerId));
    await page.evaluate(theme => document.documentElement.dataset.themeMode = theme, theme);
    await expect(view.locator('.model-row')).toHaveCount(3);
    const geometry = await view.evaluate(el => {
      const root = el.shadowRoot!;
      const rect = (selector: string) => {
        const r = root.querySelector(selector)!.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, bottom: r.bottom };
      };
      return { url: rect('[aria-label="Base URL"]'), key: rect('#provider-key'), firstModel: rect('.model-row'),
        title: getComputedStyle(root.querySelector('h1')!).fontSize,
        accent: getComputedStyle(el).getPropertyValue('--accent').trim(),
        overflow: [...root.querySelectorAll('.section-body,.model-list,.detail-inner,.provider-selector')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className),
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        pageInsideViewport: el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth,
      };
    });
    measurements.push({ width, height: 720, theme, density: 'default', source: 'real API / task-owned MySQL', ...geometry });
    await page.screenshot({ path: `${out}/actual-${width}-${theme}.png`, animations: 'disabled' });
    expect(geometry.overflow).toEqual([]); expect(geometry.documentOverflow).toBe(false); expect(geometry.pageInsideViewport).toBe(true);
    expect(geometry.title).toBe('24px');
    if (width >= 1280) {
      expect(geometry.url.width).toBeGreaterThan(600);
      expect(geometry.key.width).toBe(geometry.url.width);
      expect(geometry.firstModel.bottom).toBeLessThan(720);
    }
    await page.addScriptTag({ path: axeRequire.resolve('axe-core/axe.min.js') });
    const accessibility = await view.evaluate(async el => (await (window as any).axe.run(el)).violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => n.target) })));
    await writeFile(`${out}/a11y-${width}-${theme}.json`, JSON.stringify(accessibility, null, 2));
    expect(accessibility).toEqual([]);
    // Single-model dialog retains Escape and focus restoration in the real shell.
    const edit = view.getByRole('button', { name: '编辑模型 运维快速分析', exact: true });
    await edit.click(); await expect(view.getByLabel('模型 ID', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/editor-${width}-${theme}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape'); await expect(edit).toBeFocused();
  }
  await writeFile(`${out}/measurements.json`, JSON.stringify({
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceSha256: createHash('sha256').update(await readFile('src/app/ui/views/llm-config.ts')).digest('hex'), measurements,
    productModelCalls: 0, sharedProviderWrites: 0,
  }, null, 2));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/settings/ai/models?view=providers');
  const view = page.locator('llm-config-page');
  const select = view.getByLabel('提供商', { exact: true });
  await select.selectOption(String(result.providerId));
  await view.getByLabel('显示名称', { exact: true }).fill('未保存的连接草稿');
  const other = await select.locator('option').evaluateAll((options, id) => options.map(o => (o as HTMLOptionElement).value).find(value => value && value !== id), String(result.providerId));
  await select.focus(); await select.selectOption(other!);
  await expect(view.getByText('放弃未保存修改？', { exact: true })).toBeVisible();
  await expect(select).toHaveValue(String(result.providerId));
  await view.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(select).toBeFocused();
  await expect(view.getByLabel('显示名称', { exact: true })).toHaveValue('未保存的连接草稿');
  await select.focus(); await select.selectOption(other!);
  await view.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(select).toHaveValue(other!);
  await page.getByRole('tab', { name: '场景分配', exact: true }).click();
  await expect(page).toHaveURL(/view=scenes/);
  await expect(view.getByRole('heading', { name: '场景分配', exact: true })).toBeVisible();
  await page.goBack(); await expect(select).toBeVisible();
  await page.goForward(); await expect(page).toHaveURL(/view=scenes/);
  // A single saved Provider/model is read through the same real API and full shell.
  expect((await request.put(`/api/llm/configs/${result.providerId}`, { headers, data: { modelsSupported: [{ id: 'deepseek-flash', name: '运维快速分析', contextWindow: 128000 }] } })).ok()).toBe(true);
  await page.goto('/settings/ai/models?view=providers');
  await select.selectOption(String(result.providerId));
  await expect(view.locator('.model-row')).toHaveCount(1);
  await page.screenshot({ path: `${out}/single-real-1280-light.png`, animations: 'disabled' });
  const providers = await (await request.get('/api/llm/configs', { headers })).json();
  const fixture = providers.find((provider: any) => provider.id === result.providerId);
  for (const state of ['single-provider', 'long-provider', 'empty', 'loading', 'error', 'forbidden']) {
    for (const width of [1280, 1440, 768, 390]) for (const theme of ['light', 'dark']) {
      let release: (() => void) | undefined;
      await page.route('**/api/llm/configs', async route => {
        if (state === 'loading') await new Promise<void>(resolve => { release = resolve; });
        if (state === 'single-provider' || state === 'long-provider') {
          await route.fulfill({ json: [{ ...fixture, display_name: state === 'long-provider' ? '隔离验收的长名称提供商_'.repeat(12) : fixture.display_name }] }); return;
        }
        await route.fulfill(state === 'empty' || state === 'loading' ? { json: [] } : {
          status: state === 'forbidden' ? 403 : 503,
          json: { error: state === 'forbidden' ? '当前没有查看权限（受控验收）' : '读取失败，请重试（受控验收）' },
        }).catch(() => {});
      });
      await page.setViewportSize({ width, height: 720 });
      await page.goto('/settings/ai/models?view=providers');
      await page.evaluate(theme => document.documentElement.dataset.themeMode = theme, theme);
      if (state === 'loading') await expect(view.locator('.loading')).toBeVisible();
      else if (state === 'empty') await expect(view).toContainText('新建提供商');
      else if (state.endsWith('provider')) {
        await expect(view.locator('.provider-count')).toHaveText('共 1 个');
        await expect(view.locator('.model-row')).toHaveCount(1);
      }
      else await expect(view.getByRole('alert')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${out}/controlled-${state}-${width}-${theme}.png`, animations: 'disabled' });
      release?.(); await page.unroute('**/api/llm/configs');
    }
  }

});

test('density typography in real application shell preserves wide fields and model editing', async ({ page, request }) => {
  const output = 'test-results/MAX-185-density';
  await mkdir(output, { recursive: true });
  const login = await request.post('/api/auth/login', { data: { username: 'admin', password: process.env.QUALIFICATION_ADMIN_PASSWORD } });
  expect(login.ok()).toBe(true);
  const { token, user } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const created = await request.post('/api/llm/configs', { headers, data: {
    name: 'max185-density', displayName: '密度验收的长名称提供商_'.repeat(4),
    deploymentType: 'api', apiFormat: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', enabled: false,
    model: 'density-first', contextWindow: 128000, maxTokens: 4096,
    modelsSupported: [
      { id: 'density-first', name: '运维快速分析', contextWindow: 128000 },
      { id: 'density-long', name: '长模型名称_诊断推理_'.repeat(12), contextWindow: 64000 },
      { id: 'density-unknown', name: '本地模型', parameterSource: 'unknown' },
    ],
  } });
  const result = await created.json(); expect(result.success).toBe(true);
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  }, { token, user });
  const measurements = [];
  for (const width of [1280, 390, 768]) for (const theme of ['light', 'dark']) for (const density of ['compact', 'standard', 'comfortable'] as const) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/settings/ai/models?view=providers');
    const view = page.locator('llm-config-page');
    await view.getByLabel('提供商', { exact: true }).selectOption(String(result.providerId));
    await expect(view.locator('.model-row')).toHaveCount(3);
    await page.evaluate(async ({ theme, density }) => {
      // Exercise the product's density utility rather than duplicating its token values.
      const densityModule = '/src/app/ui/density.ts';
      const { applyDensity } = await import(/* @vite-ignore */ densityModule);
      applyDensity(density);
      document.documentElement.dataset.themeMode = theme;
    }, { theme, density });
    const geometry = await view.evaluate(el => {
      const root = el.shadowRoot!;
      const font = (selector: string) => parseFloat(getComputedStyle(root.querySelector(selector)!).fontSize);
      const rect = (selector: string) => {
        const r = root.querySelector(selector)!.getBoundingClientRect();
        return { x: r.x, width: r.width, top: r.top, bottom: r.bottom };
      };
      const style = getComputedStyle(el);
      return {
        fonts: { title: font('h1'), section: font('.section-intro h2'), description: font('.page-header p'),
          input: font('[aria-label="Base URL"]'), label: font('.section-body .form-label'),
          model: font('.model-summary strong'), auxiliary: font('.provider-count'),
          summary: font('.advanced summary') },
        tokens: { body: parseFloat(style.getPropertyValue('--text-md')), section: parseFloat(style.getPropertyValue('--text-lg')), auxiliary: parseFloat(style.getPropertyValue('--text-sm')) },
        url: rect('[aria-label="Base URL"]'), key: rect('#provider-key'), firstModel: rect('.model-row'),
        modelHeading: rect('.model-toolbar h2'), accent: style.getPropertyValue('--accent').trim(),
        overflow: [...root.querySelectorAll('.section-body,.model-list,.detail-inner,.provider-selector,.model-summary')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className),
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        pageInsideViewport: el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth,
      };
    });
    const mobileHeading = await page.locator('settings-shell').evaluate(el => parseFloat(getComputedStyle(el.shadowRoot!.querySelector('.mobile-heading__title')!).fontSize));
    const name = `${width}-${theme}-${density}`;
    measurements.push({ width, height: 720, theme, density, source: 'real API / task-owned MySQL; product applyDensity', mobileHeading, ...geometry });
    await writeFile(`${output}/measurements.json`, JSON.stringify({
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceSha256: createHash('sha256').update(await readFile('src/app/ui/views/llm-config.ts')).digest('hex'), measurements,
      productModelCalls: 0, sharedProviderWrites: 0,
    }, null, 2));
    await page.screenshot({ path: `${output}/page-${name}.png`, animations: 'disabled' });
    expect(geometry.fonts.title).toBeCloseTo(geometry.tokens.section * 1.5, 1);
    expect(geometry.fonts.section).toBe(geometry.tokens.section);
    for (const key of ['description', 'input', 'label', 'model', 'summary'] as const) expect(geometry.fonts[key]).toBe(geometry.tokens.body);
    expect(geometry.fonts.auxiliary).toBe(geometry.tokens.auxiliary);
    if (width <= 768) expect(mobileHeading).toBe(geometry.tokens.section);
    expect(geometry.overflow).toEqual([]); expect(geometry.documentOverflow).toBe(false); expect(geometry.pageInsideViewport).toBe(true);
    expect(geometry.key.width).toBe(geometry.url.width);
    if (width === 1280) {
      expect(geometry.url.width).toBeGreaterThan(600);
      if (density !== 'comfortable') expect(geometry.firstModel.bottom).toBeLessThan(720);
    }
    await page.addScriptTag({ path: axeRequire.resolve('axe-core/axe.min.js') });
    const violations = await view.evaluate(async el => (await (window as any).axe.run(el)).violations.map((v: any) => ({ id: v.id, impact: v.impact })));
    await writeFile(`${output}/axe-${name}.json`, JSON.stringify(violations, null, 2));
    expect(violations).toEqual([]);
    const edit = view.getByRole('button', { name: '编辑模型 运维快速分析', exact: true });
    await edit.click(); await expect(view.getByLabel('模型 ID', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${output}/editor-${name}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape'); await expect(edit).toBeFocused();
    const longEdit = view.locator('.model-row').nth(1).getByRole('button');
    await longEdit.click(); await expect(view.getByLabel('模型显示名称', { exact: true })).toHaveValue('长模型名称_诊断推理_'.repeat(12));
    await view.locator('.model-advanced > summary').click();
    await page.screenshot({ path: `${output}/long-editor-${name}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape'); await expect(longEdit).toBeFocused();
    await view.locator('.advanced summary').click();
    await expect(view.locator('.advanced[open]')).toBeVisible();
    await view.locator('.advanced summary').click();
  }
});
