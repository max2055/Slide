import { test, expect } from '@playwright/test';

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`MAX-462 #405/#406/#702 chat cards and policy helpers ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/branding/config', route => route.fulfill({ json: {} }));
    await page.goto('/e2e/fixtures/chat-history.html');
    await page.waitForFunction(() => Boolean((window as any).historyFixture));
    const commands = ['git constructor', 'git __proto__', 'npm constructor', 'npm __proto__',
      'git constructor | npm __proto__; git status && npm install',
      'env -u FOO git status', 'env -C /work npm install', 'env -S "git status"', 'head -n -5 file'];
    await page.evaluate(async commands => {
      const { handleDirectAdapterEvent } = await import('/src/app/ui/direct-gateway.ts');
      const { flushToolStreamSync } = await import('/src/app/ui/app-tool-stream.ts');
      const fixture = (window as any).historyFixture;
      const host: any = { chatRunId: 'summary-run', sessionKey: fixture.props.sessionKey,
        chatStream: '', chatMessages: [], chatSending: true, chatQueue: [], chatThinkingText: '',
        settings: {}, applySettings() {}, chatToolMessages: [], chatStreamSegments: [],
        toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null };
      for (const [index, command] of commands.entries()) {
        handleDirectAdapterEvent(host, { type: 'tool_start', runId: 'summary-run',
          toolCallId: `summary-${index}`, toolName: 'exec', occurredAt: index + 1, args: { command } });
      }
      flushToolStreamSync(host);
      Object.assign(fixture.props, { messages: [], sending: true, stream: '',
        streamSegments: host.chatStreamSegments, toolMessages: host.chatToolMessages });
      fixture.update();
    }, commands);
    const cards = page.locator('.chat-tool-msg-collapse--manual');
    await expect(cards).toHaveCount(commands.length);
    for (let index = 0; index < commands.length; index++) {
      const button = cards.nth(index).locator('button').first();
      await button.focus();
      await button.press('Enter');
      await expect(button).toBeFocused();
      await expect(cards.nth(index).locator('.chat-tool-card__detail')).toBeVisible();
    }
    const details = await page.locator('.chat-tool-card__detail').allTextContents();
    expect(details.slice(0, 4).every(detail => /run (git|npm) (constructor|__proto__)/.test(detail))).toBe(true);
    expect(details[4]).toContain('run git constructor -> run npm __proto__ → check git status → install dependencies');
    expect(details[5]).toContain('check git status');
    expect(details[6]).toContain('install dependencies');
    expect(details[7]).toContain('check git status');
    expect(details[8]).toContain('show first -5 lines of file');
    // DirectAdapter's tools panel is unavailable; exercise its actual helpers.
    const policy = await page.evaluate(async () => {
      const { isAllowedByPolicy, matchesList } = await import('/src/app/ui/views/agents-utils.ts');
      const { normalizeToolName, expandToolGroups } = await import('/src/app/src/agents/tool-policy-shared.ts');
      return {
        names: ['constructor', '__proto__', 'BASH', 'Apply-Patch'].map(normalizeToolName),
        groups: expandToolGroups(['constructor', '__proto__', 'group:runtime']),
        unlisted: ['constructor', '__proto__', ' '].map(name => isAllowedByPolicy('fixture-unlisted', { allow: [name] })),
        aliases: matchesList('apply-patch', ['BASH']),
        denied: isAllowedByPolicy('exec', { allow: ['group:runtime'], deny: ['BASH'] }),
      };
    });
    expect(policy.names).toEqual(['constructor', '__proto__', 'exec', 'apply_patch']);
    expect(policy.groups).toEqual(['constructor', '__proto__', 'exec', 'process', 'code_execution']);
    expect(policy.unlisted).toEqual([false, false, false]);
    expect(policy.aliases).toBe(true);
    expect(policy.denied).toBe(false);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('tool-summaries.png'), fullPage: true });
  });
}
