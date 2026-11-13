import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// #421: real production Lit/dialog components; controlled properties, no backend/model calls.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`diagnosis states, isolation and keyboard at ${width}×${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto('/e2e/fixtures/instance-diagnosis.html');
    await page.waitForFunction(() => customElements.get('instance-diagnosis-modal'));
    const modal = page.locator('instance-diagnosis-modal');
    const outside = page.locator('#outside');
    const outsideStyles = () => outside.evaluate(el => [...el.querySelectorAll('*')].map(node => {
      const s = getComputedStyle(node);
      return [s.padding, s.margin, s.display, s.color, s.fontSize, s.borderTop, s.animationName, s.width];
    }));
    // Capture while component exists; also assert defaults to detect already leaked CSS.
    const baseline = await outsideStyles();
    await expect(outside.locator('.empty-state')).toHaveCSS('padding', '0px');
    await expect(outside.locator('.spinner')).toHaveCSS('animation-name', 'none');
    await page.locator('#trigger').click();
    await expect(modal.getByText('开始诊断', { exact: true })).toBeVisible();
    await expect(modal.locator('.empty-state')).toHaveCSS('padding', '40px');
    await expect(modal.locator('.empty-title')).toHaveCSS('font-weight', '600');
    await modal.getByRole('button', { name: '运行诊断', exact: true }).click();
    expect(await page.evaluate(() => (window as any).events)).toEqual([
      { type: 'request-diagnosis', detail: { instanceId: 650 } },
    ]);
    await page.screenshot({ path: info.outputPath('empty.png') });

    await modal.evaluate((el: any) => { el.loading = true; });
    await expect(modal.getByText('等待 Agent 开始工作...')).toBeVisible();
    await expect(modal.locator('.spinner')).toHaveCSS('width', '18px');
    await expect(modal.locator('.spinner')).toHaveCSS('animation-name', 'instance-diagnosis-spin');
    await modal.evaluate((el: any) => {
      el.diagnosisRecord = { id: 421 };
      el.executionTrace = { tool_events: [
        { name: '读取指标', status: 'ok', detail: '受控成功样本' },
        { name: '检查慢查询', status: 'error', detail: '受控失败样本' },
        { name: '汇总分析', status: 'running' },
      ] };
    });
    await expect(modal.getByText('AI 诊断执行中', { exact: true })).toBeVisible();
    await expect(modal.locator('.trace-item')).toHaveCount(3);
    await expect(modal.locator('.trace-item').first()).toHaveCSS('display', 'flex');
    await expect(modal.locator('.trace-dot.ok')).toHaveCSS('width', '6px');
    await expect(modal.locator('.trace-dot.running')).toHaveCSS('animation-name', 'instance-diagnosis-pulse');
    const colors = await modal.evaluate(el => ['ok', 'error'].map(status => ({
      actual: getComputedStyle(el.querySelector(`.trace-item.${status}`)!).color,
      dot: getComputedStyle(el.querySelector(`.trace-dot.${status}`)!).backgroundColor,
    })));
    expect(colors[0].actual).toBe(colors[0].dot);
    expect(colors[1].actual).toBe(colors[1].dot);
    expect(colors[0].actual).not.toBe(colors[1].actual);
    await page.screenshot({ path: info.outputPath('trace.png') });

    await modal.evaluate((el: any) => { el.loading = false; el.error = '受控连接超时'; });
    await expect(modal.getByText('诊断失败', { exact: true })).toBeVisible();
    await expect(modal.locator('.empty-state')).toHaveCSS('text-align', 'center');
    await page.screenshot({ path: info.outputPath('error.png') });
    await modal.evaluate((el: any) => {
      el.error = null;
      el.diagnosis = { id: 421, status: 'completed', result: '受控诊断结果：请检查慢查询。' };
    });
    const continuation = modal.locator('.continue-section');
    await expect(continuation).toHaveCSS('border-top-style', 'solid');
    await expect(continuation).toHaveCSS('border-top-width', '1px');
    const button = modal.getByRole('button', { name: '在 Chat 中继续分析 →' });
    await expect(button).toBeVisible();
    await button.focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as any).events.at(-1))).toEqual({
      type: 'continue-in-chat', detail: { instanceId: 650, instanceName: '样本 MySQL', analysisId: 421, diagnosisSummary: '受控诊断结果：请检查慢查询。' },
    });
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    expect(await outsideStyles()).toEqual(baseline);
    await page.screenshot({ path: info.outputPath('continue.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('#trigger')).toBeFocused();
    const evidence = info.outputPath('observations.json');
    await writeFile(evidence, JSON.stringify({
      viewport: { width, height }, browser: page.context().browser()?.version(),
      traceColors: colors, continueButton: box,
      externalStylesBefore: baseline, externalStylesAfter: await outsideStyles(),
      events: await page.evaluate(() => (window as any).events),
      focusRestored: await page.locator('#trigger').evaluate(el => document.activeElement === el),
    }, null, 2));
    await info.attach('observations', { path: evidence, contentType: 'application/json' });
  });
}
