import { test, expect, type Page } from '@playwright/test';

// Real production component and tokens; only the event source is controlled.
async function harness(page: Page) {
  await page.route('**/toast-lifecycle-harness', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <link rel="stylesheet" href="/src/app/styles/tokens.css"></head>
      <body><button id="notify">显示操作结果</button><script type="module">
      import { showToast } from '/src/app/ui/components/app-toast-container.ts';
      window.showToast = showToast;
      window.containers = {};
      document.querySelector('#notify').onclick = () => showToast('操作成功，配置已保存', 'success');
      </script></body></html>`,
  }));
  await page.goto('/toast-lifecycle-harness');
  await page.waitForFunction(() => typeof (window as any).showToast === 'function');
}

async function mount(page: Page, id: string) {
  await page.evaluate(async id => {
    const el = document.createElement('app-toast-container') as any;
    el.id = id;
    (window as any).containers[id] = el;
    document.body.append(el);
    await el.updateComplete;
  }, id);
}

test('MAX-656 / #419 real component disconnect, reconnect, replacement and alternating owners', async ({ page }, info) => {
  const warnings: string[] = [];
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'warning') warnings.push(msg.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await harness(page);
  await page.clock.install();
  await page.evaluate(() => (window as any).showToast('挂载前'));
  expect(warnings.filter(msg => msg.includes('not yet mounted'))).toHaveLength(1);
  await mount(page, 'first');
  await page.locator('#notify').click();
  await expect(page.locator('#first').getByText('操作成功，配置已保存')).toBeVisible();
  await page.evaluate(() => (window as any).containers.first.remove());
  await page.evaluate(() => (window as any).showToast('卸载后不能投递'));
  expect(warnings.filter(msg => msg.includes('not yet mounted'))).toHaveLength(2);
  await page.evaluate(() => document.body.append((window as any).containers.first));
  await page.locator('#notify').click();
  await expect(page.locator('#first .toast')).toHaveCount(1);
  await mount(page, 'second');
  await page.evaluate(() => (window as any).containers.first.remove());
  await page.evaluate(() => (window as any).showToast('新容器提示', 'warning'));
  await expect(page.locator('#second').getByText('新容器提示')).toBeVisible();
  await page.evaluate(() => {
    document.body.append((window as any).containers.first);
    (window as any).showToast('重新成为活动容器');
  });
  await expect(page.locator('#first').getByText('重新成为活动容器')).toBeVisible();
  await page.evaluate(() => {
    (window as any).containers.first.remove();
    (window as any).showToast('恢复到仍连接的容器');
  });
  await expect(page.locator('#second').getByText('恢复到仍连接的容器')).toBeVisible();
  await page.clock.fastForward(3000);
  await expect(page.locator('#second .toast--exit')).toHaveCount(2);
  await page.evaluate(() => (window as any).containers.second.remove());
  await page.clock.fastForward(200);
  await mount(page, 'rebuilt');
  await page.evaluate(() => (window as any).showToast('重建后正常提示', 'info'));
  await expect(page.locator('#rebuilt').getByText('重建后正常提示')).toBeVisible();
  await page.screenshot({ path: info.outputPath('rebuilt.png') });
  await page.clock.fastForward(3000);
  await expect(page.locator('#rebuilt .toast--exit')).toHaveCount(1);
  await page.clock.fastForward(200);
  await expect(page.locator('#rebuilt .toast')).toHaveCount(0);
  expect(errors).toEqual([]);
  await info.attach('lifecycle-observations.json', { body: JSON.stringify({ warnings, errors, source: 'production Lit component; controlled notifications; no backend/LLM' }, null, 2), contentType: 'application/json' });
});

for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`desktop light Chinese toast visible and keyboard dismissible ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await harness(page);
    await mount(page, 'desktop');
    const trigger = page.getByRole('button', { name: '显示操作结果' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const toast = page.locator('#desktop .toast');
    await expect(toast).toBeVisible();
    await expect(page.getByRole('status')).toContainText('操作成功，配置已保存');
    const box = (await toast.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(await toast.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '关闭提示' })).toBeFocused();
    await page.screenshot({ path: info.outputPath(`toast-${width}x${height}.png`) });
    await page.keyboard.press('Enter');
    await expect(toast).toHaveCount(0);
  });
}
