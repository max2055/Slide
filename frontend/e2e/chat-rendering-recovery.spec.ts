import { expect, test } from '@playwright/test';

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`#711/#713 actual chat recovery and tool sidebar ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: {} }));
    await page.goto('/e2e/fixtures/chat-notices.html');
    await expect(page.locator('notice-fixture .chat')).toBeVisible();
    await page.evaluate(() => (window as any).noticeFixture.error('', 'cold'));
    await page.evaluate(() => (window as any).noticeFixture.repeatSnapshot());
    await expect(page.locator('app-notice')).toContainText('未保存的流尾部可能丢失');
    const close = page.locator('app-notice').getByRole('button', { name: /关闭/ });
    await close.focus();
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('app-notice')).toHaveCount(0);
    await page.evaluate(() => (window as any).noticeFixture.repeatSnapshot());
    await expect(page.locator('app-notice')).toContainText('完整已保存内容');
    await page.screenshot({ path: test.info().outputPath(`recovery-${width}.png`) });

    // Start a fresh receiver: recovery snapshots select the native-parts protocol.
    await page.reload();
    await expect(page.locator('notice-fixture .chat')).toBeVisible();
    for (const [sampleIndex, value] of [{ message: '```', tail: '尾部完整' }, ['``````', '```', '尾部完整'], { ok: true }, '普通文本输出'].entries()) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      await page.evaluate(async text => {
        const { handleDirectAdapterEvent } = await import('/src/app/ui/direct-gateway.ts');
        const { flushToolStreamSync } = await import('/src/app/ui/app-tool-stream.ts');
        const app = (window as any).noticeFixture.app;
        app.chatRunId = 'tools'; app.chatSending = true;
        const id = 'tool-' + Math.random();
        handleDirectAdapterEvent(app, { type: 'tool_start', runId: 'tools', sessionKey: 'one', toolCallId: id, toolName: 'query', args: {}, occurredAt: 1 });
        handleDirectAdapterEvent(app, { type: 'tool_result', runId: 'tools', sessionKey: 'one', toolCallId: id, toolName: 'query', result: text, occurredAt: 2 });
        flushToolStreamSync(app);
        await app.updateComplete;
      }, text);
      const summary = page.locator('.chat-tool-msg-summary').last();
      await summary.focus();
      await expect(summary).toBeFocused();
      await page.keyboard.press('Enter');
      const details = page.getByRole('button', { name: 'Open tool details in side panel' }).last();
      await details.focus();
      await expect(details).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('.sidebar-markdown')).toBeVisible();
      for (const toggle of await page.locator('.sidebar-markdown details > summary').all()) await toggle.click();
      const output = page.locator('.sidebar-markdown pre code').last();
      if (typeof value === 'string') {
        await expect(page.locator('.sidebar-markdown')).toContainText(value);
        await expect(page.locator('.sidebar-markdown pre')).toHaveCount(1);
      } else {
        await expect(output).toBeVisible();
        await expect(output).toHaveText(JSON.stringify(value, null, 2) + '\n');
        await expect(page.locator('.sidebar-markdown pre')).toHaveCount(2); // input + output
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: test.info().outputPath(`sidebar-${width}-${sampleIndex}.png`) });
      await page.getByRole('button', { name: 'Close sidebar' }).click();
      await expect(page.locator('.sidebar-panel')).toHaveCount(0);
    }
  });
}
