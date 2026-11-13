import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Controlled history fixture, real renderChat / extraction / Markdown / attachments.
// No backend, database or model generation is simulated as a successful E2E call.
for (const width of [1366, 1440, 1920]) {
  test(`MAX-624 content preservation at ${width}px`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1920 ? 1080 : 900 });
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: {} }));
    await page.goto('/e2e/fixtures/chat-history.html');
    const messages = [
      { id: 'date', role: 'user', content: '[会议 2024-01-01 12:00 提醒] 保留正文' },
      { id: 'tokens', role: 'assistant', content: '前<|assistant|>后\n\n前文 <|这是未闭合示例\n第一行重要正文\n第二行重要正文 |> 后文' },
      { id: 'media', role: 'assistant', content: '```text\n```js\nMEDIA: https://example.com/literal.png\n```\n\n围栏后的正文' },
      { id: 'memory', role: 'assistant', content: 'hello <relevant_memories>\n```xml\n</relevant_memories>\n```\nworld' },
      { id: 'paired', role: 'assistant', content: '开始 <relevant_memories>隐藏的记忆内容</relevant_memories> 结束' },
    ];
    await page.evaluate(messages => {
      const fixture = (window as any).historyFixture;
      fixture.props.messages = messages;
      fixture.props.stream = null;
      fixture.update();
    }, messages);
    const thread = page.locator('.chat-thread');
    await expect(thread).toContainText('[会议 2024-01-01 12:00 提醒] 保留正文');
    await expect(thread).toContainText('第一行重要正文');
    await expect(thread).toContainText('第二行重要正文');
    await expect(thread).toContainText('world');
    await expect(thread).toContainText('结束');
    const blocks = await thread.locator('pre code').allTextContents();
    expect(blocks.some(text => text.includes('```js\nMEDIA: https://example.com/literal.png'))).toBe(true);
    expect(blocks.some(text => text.includes('</relevant_memories>'))).toBe(true);
    await expect(thread.locator('img[src="https://example.com/literal.png"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).historyFixture.props.messages)).toEqual(messages);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export chat', exact: true }).click();
    const download = await downloadEvent;
    const exportPath = test.info().outputPath('chat-export.md');
    await download.saveAs(exportPath);
    const markdown = await readFile(exportPath, 'utf8');
    expect(markdown).toContain('[会议 2024-01-01 12:00 提醒] 保留正文');
    expect(markdown).toContain('前 后');
    expect(markdown).toContain('第一行重要正文');
    expect(markdown).toContain('第二行重要正文');
    expect(markdown).toContain('</relevant_memories>');
    expect(markdown).toContain('world');
    expect(markdown).not.toContain('隐藏的记忆内容');
    expect(await page.evaluate(() => (window as any).historyFixture.props.messages)).toEqual(messages);
    await test.info().attach('export.md', { body: markdown, contentType: 'text/markdown' });
    const composer = page.locator('textarea');
    await composer.focus();
    await expect(composer).toBeFocused();
    await expect(page.getByRole('button', { name: /发送|Send/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`content-${width}.png`), fullPage: true });
    expect(pageErrors).toEqual([]);
  });
}
