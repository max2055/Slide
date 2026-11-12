import { expect, test } from '@playwright/test';

// Real renderChat entry and production styles; controlled history, no model/backend calls.
for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`MAX-636 #635/#638/#710 text presentation at ${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: {} }));
    await page.goto('/e2e/fixtures/chat-history.html');
    const token = 'https://example.com/' + 'abcdef0123456789'.repeat(80);
    const thinking = 'field_name __raw__ *stars* `ticks`\n\n  保留缩进\n```sql\nselect a_b;\n```';
    await page.evaluate(({ token, thinking }) => {
      const fixture = (window as any).historyFixture;
      fixture.props.showThinking = true;
      fixture.props.messages = [
        { id: 'user', role: 'user', content: '中文正常换行。'.repeat(30) + '\n\n`' + token + '`' },
        { id: 'assistant', role: 'assistant', content: [
          { type: 'thinking', thinking },
          { type: 'text', text: '<think>外层<think>内层</think>禁止泄露</think>**正常粗体**\n\n`' + token + '`\n\n```text\n<think>标签字面量</think>\n' + token + '\n```' },
        ] },
        { id: 'unclosed', role: 'assistant', content: '前文<think>未闭合正文' },
      ];
      fixture.props.stream = null;
      fixture.update();
    }, { token, thinking });
    const body = page.locator('.chat-thinking-disclosure__body').first();
    const summary = page.locator('.chat-thinking-disclosure summary').first();
    await summary.focus();
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('思考过程');
    await page.keyboard.press('Enter');
    await expect(body).toBeVisible();
    expect((await body.textContent())?.trim()).toBe(thinking);
    await expect(body.locator('em, strong, code')).toHaveCount(0);
    const thread = page.locator('.chat-thread');
    expect((await thread.locator('.chat-text').allTextContents()).join('')).not.toContain('禁止泄露');
    await expect(thread).toContainText('未闭合正文');
    await expect(thread.locator('strong')).toHaveText('正常粗体');
    await expect(thread.locator('pre code')).toContainText('<think>标签字面量</think>');
    const inline = thread.locator('.chat-text :not(pre) > code');
    await expect(inline).toHaveCount(2);
    for (const element of await inline.all()) {
      expect(await element.evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        return range.getClientRects().length;
      })).toBeGreaterThan(1);
    }
    const metrics = await thread.evaluate(el => ({
      threadOverflow: el.scrollWidth - el.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      blocks: [...el.querySelectorAll('pre')].map(pre => ({ overflow: pre.scrollWidth > pre.clientWidth, mode: getComputedStyle(pre).overflowX })),
    }));
    expect(metrics.threadOverflow).toBeLessThanOrEqual(1);
    expect(metrics.pageOverflow).toBeLessThanOrEqual(1);
    expect(metrics.blocks).toEqual([{ overflow: true, mode: 'auto' }]);
    await page.locator('textarea').focus();
    await expect(page.locator('textarea')).toBeFocused();
    await expect(page.getByRole('button', { name: /发送|Send/ })).toBeVisible();
    await test.info().attach('layout.json', { body: JSON.stringify(metrics), contentType: 'application/json' });
    await page.screenshot({ path: test.info().outputPath(`text-${width}.png`), fullPage: true });
    await thread.locator('pre').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`answer-${width}.png`), fullPage: true });
    await page.evaluate(thinking => {
      const fixture = (window as any).historyFixture;
      fixture.props.messages = [];
      fixture.props.stream = '**流式正文**';
      fixture.props.thinkingText = thinking;
      fixture.props.thinkingComplete = false;
      fixture.update();
    }, thinking);
    await expect(page.locator('.chat-thinking-disclosure')).toHaveAttribute('open', '');
    expect((await page.locator('.chat-thinking-disclosure__body').textContent())?.trim()).toBe(thinking);
    await expect(page.locator('.chat-text strong')).toHaveText('流式正文');
    expect(errors).toEqual([]);
  });
}
