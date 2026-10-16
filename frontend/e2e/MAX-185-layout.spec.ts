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
  for (const state of ['empty', 'loading', 'error', 'forbidden']) {
    for (const width of [1280, 1440, 768, 390]) for (const theme of ['light', 'dark']) {
      let release: (() => void) | undefined;
      await page.route('**/api/llm/configs', async route => {
        if (state === 'loading') await new Promise<void>(resolve => { release = resolve; });
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
      else await expect(view.getByRole('alert')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${out}/controlled-${state}-${width}-${theme}.png`, animations: 'disabled' });
      release?.(); await page.unroute('**/api/llm/configs');
    }
  }

});
