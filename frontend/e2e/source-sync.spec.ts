import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) test(`HTTP repository sync shows partial/unbound results and clears credentials at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['admin:*'])));
  let config = { provider: 'gitlab', baseUrl: 'http://gitlab.internal', repositoryPath: 'group/repo', ref: '', allowedPaths: ['src/'], allowModelContent: false };
  let synced = false;
  const manifest = { releaseId: 'source-fixture', commitSha: 'a'.repeat(40), treeDigest: 'b'.repeat(64), signature: 'signed-fixture',
    completeness: 'partial', files: [{ path: 'src/a.ts', bytes: 30 }], skippedFiles: [{ path: 'src/private.json', reason: 'SOURCE_SENSITIVE_CONTENT' }],
    repository: { ref: 'release' }, verification: { status: 'repository-unbound', reason: 'SOURCE_DEPLOYMENT_UNKNOWN' } };
  await page.route('**/api/platform/source/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/config')) {
      if (route.request().method() === 'PUT') { config = route.request().postDataJSON(); synced = false; }
      return route.fulfill({ json: { config } });
    }
    if (path.endsWith('/sync')) {
      expect(route.request().postDataJSON()).toEqual({ token: 'single-use-fixture' });
      expect(config.ref).toBe('release');
      synced = true; return route.fulfill({ json: manifest });
    }
    return route.fulfill(synced ? { json: manifest } : { status: 409, json: { error: 'SOURCE_NOT_SYNCED' } });
  });
  await page.route('**/source-sync-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <source-settings></source-settings>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/source-settings.ts';</script>
    </body></html>` }));
  await page.goto('/source-sync-fixture');
  await expect(page.getByLabel('GitLab URL')).toHaveValue('http://gitlab.internal');
  await page.getByLabel('分支、标签或 Commit').fill('release');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.locator('source-settings')).toContainText('配置已保存');
  await page.getByLabel('单次同步令牌').fill('single-use-fixture');
  await page.getByRole('button', { name: '同步源码', exact: true }).click();
  await expect(page.getByLabel('单次同步令牌')).toHaveValue('');
  await expect(page.locator('source-manifest')).toContainText('未验证部署一致性');
  await expect(page.locator('source-manifest')).toContainText('部分同步');
  await expect(page.locator('source-manifest')).toContainText('src/private.json');
  await expect(page.locator('source-manifest')).toContainText('含疑似敏感信息');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('single-use-fixture');
  await page.getByLabel('分支、标签或 Commit').fill('main');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.locator('source-manifest')).toContainText('当前仓库和分支尚未同步');
  await expect(page.locator('source-manifest')).not.toContainText('source-fixture');
  expect(errors).toEqual([]);
});
