import { expect, test } from '@playwright/test';

// Real production assets; unavailable HTTP endpoints are controlled samples.
// No authentication, shared database, WS service or model call is needed.
const scenarios = [
  { name: 'browser-Chinese', browser: 'zh-CN', saved: null, label: '用户名', width: 1440, height: 900 },
  { name: 'saved-Chinese-reload', browser: 'en-US', saved: 'zh-CN', label: '用户名', width: 1366, height: 768 },
  { name: 'saved-English', browser: 'zh-CN', saved: 'en', label: 'Username', width: 1920, height: 1080 },
  { name: 'browser-English', browser: 'en-US', saved: null, label: 'Username', width: 1440, height: 900 },
];

for (const scenario of scenarios) {
  test(scenario.name, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      locale: scenario.browser,
      viewport: { width: scenario.width, height: scenario.height },
    });
    try {
      await context.addInitScript(({ saved }) => {
        if (saved) localStorage.setItem('slide.i18n.locale', saved);
        const snapshots: string[] = [];
        Object.assign(window, { startupLabels: snapshots });
        new MutationObserver(() => {
          const form = document.querySelector('.login-gate__form');
          if (form) snapshots.push(form.textContent ?? '');
        }).observe(document, { childList: true, subtree: true, characterData: true });
      }, { saved: scenario.saved });
      let separateLocaleRequests = 0;
      // A failed standalone locale download cannot change the initial language.
      // The production build must supply Chinese through its normal module graph.
      await context.route(/zh[-_]CN/i, route => {
        separateLocaleRequests++;
        return route.abort('failed');
      });
      await context.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'CONTROLLED_UNAVAILABLE' } }));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const navigation of ['open', 'reload']) {
        if (navigation === 'open') await page.goto('/');
        else await page.reload();
        await expect(page.getByLabel(scenario.label, { exact: true })).toBeVisible();
        const labels = await page.evaluate(() => (window as unknown as { startupLabels: string[] }).startupLabels);
        expect(labels.length).toBeGreaterThan(0);
        for (const label of labels) {
          expect(label).toContain(scenario.label);
          expect(label).not.toContain(scenario.label === '用户名' ? 'Username' : '用户名');
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await testInfo.attach(`${navigation}-labels`, { body: JSON.stringify(labels), contentType: 'application/json' });
        await testInfo.attach(`${navigation}-screen`, { body: await page.screenshot(), contentType: 'image/png' });
      }
      expect(separateLocaleRequests).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
