import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) test(`HTTP repository sync retains warned files and clears credentials at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['admin:*'])));
  let config = { provider: 'gitlab', baseUrl: 'http://gitlab.internal', repositoryPath: 'group/repo', ref: '', allowedPaths: ['src/'], allowModelContent: false };
  let synced = false;
  const manifest = { releaseId: 'source-fixture', commitSha: 'a'.repeat(40), treeDigest: 'b'.repeat(64), signature: 'signed-fixture',
    completeness: 'complete', files: [{ path: 'src/a.ts', bytes: 30 }, { path: 'src/private.json', bytes: 40 }, { path: 'src/large.ts', bytes: 700000 }], skippedFiles: [],
    warnings: [{ path: 'src/private.json', reason: 'SOURCE_SENSITIVE_CONTENT' }, { path: 'src/large.ts', reason: 'SOURCE_LARGE_FILE' }],
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
  await page.getByLabel('同步令牌', { exact: true }).fill('single-use-fixture');
  await page.getByRole('button', { name: '同步源码', exact: true }).click();
  await expect(page.getByLabel('同步令牌', { exact: true })).toHaveValue('');
  await expect(page.locator('source-manifest')).toContainText('未验证部署一致性');
  await expect(page.locator('source-manifest')).toContainText('同步完成');
  await expect(page.locator('source-manifest')).not.toContainText('部分同步');
  await expect(page.locator('source-manifest')).toContainText('提示（文件已保留，2 项）');
  await expect(page.locator('source-manifest')).toContainText('src/private.json');
  await expect(page.locator('source-manifest')).toContainText('含疑似敏感信息');
  await expect(page.locator('source-manifest')).toContainText('较大文件，已保留');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('single-use-fixture');
  await page.getByLabel('分支、标签或 Commit').fill('main');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.locator('source-manifest')).toContainText('当前仓库和分支尚未同步');
  await expect(page.locator('source-manifest')).not.toContainText('source-fixture');
  expect(errors).toEqual([]);
});

for (const provider of ['gitlab', 'github']) for (const width of [390, 1440]) test(`${provider} saves, reloads, overrides and deletes sync token at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['admin:*'])));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let config = { provider, baseUrl: provider === 'github' ? 'https://github.com' : 'https://gitlab.example.test', repositoryPath: 'group/repo', allowedPaths: [], allowModelContent: false };
  let identity = 'a'.repeat(64); let saved = ''; let synced = false;
  const manifest = { releaseId: 'fixture', commitSha: 'a'.repeat(40), treeDigest: 'b'.repeat(64), files: [], completeness: 'complete', verification: { status: 'repository-unbound' } };
  await page.route('**/api/platform/source/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path.endsWith('/config')) {
      if (request.method() === 'PUT') { config = request.postDataJSON(); identity = 'b'.repeat(64); saved = ''; }
      return route.fulfill({ json: { config, credential: { identity, hasSavedToken: Boolean(saved) } } });
    }
    if (path.endsWith('/credential')) {
      const body = request.postDataJSON(); expect(body.expectedIdentity).toBe(identity);
      if (request.method() === 'DELETE') saved = ''; else saved = body.token || saved;
      return route.fulfill({ json: { identity, hasSavedToken: Boolean(saved) } });
    }
    if (path.endsWith('/sync')) {
      const body = request.postDataJSON(); expect(body.expectedIdentity).toBe(identity);
      if ((body.token || saved) === 'expired-fixture') return route.fulfill({ status: 400, json: { error: 'SOURCE_CREDENTIAL_INVALID' } });
      expect(body.token || saved).toBeTruthy();
      if (body.retainToken) saved = body.token;
      synced = true; return route.fulfill({ json: manifest });
    }
    return route.fulfill(synced ? { json: manifest } : { status: 409, json: { error: 'SOURCE_NOT_SYNCED' } });
  });
  await page.route('**/saved-source-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><source-settings></source-settings><script type="module">import "/src/app/styles.css"; import "/src/app/ui/views/source-settings.ts";</script></body></html>' }));
  await page.goto('/saved-source-fixture');
  const sync = page.getByRole('button', { name: '同步源码', exact: true });
  await expect(sync).toBeDisabled();
  await page.getByLabel('同步令牌', { exact: true }).fill('saved-fixture');
  await page.getByLabel('保留同步令牌', { exact: true }).check();
  await sync.click(); await expect(page.getByLabel('同步令牌', { exact: true })).toHaveValue('');
  await expect(page.locator('source-settings')).toContainText('当前仓库已保存令牌'); expect(saved).toBe('saved-fixture');
  await page.reload(); await expect(sync).toBeEnabled();
  await expect(page.getByLabel('保留同步令牌', { exact: true })).not.toBeChecked();
  await sync.click(); await expect(page.locator('source-settings')).toContainText('源码同步完成');
  await page.getByLabel('同步令牌', { exact: true }).fill('override-fixture'); await sync.click();
  await expect(page.getByLabel('同步令牌', { exact: true })).toHaveValue(''); expect(saved).toBe('saved-fixture');
  await page.getByLabel('同步令牌', { exact: true }).fill('expired-fixture'); await sync.click();
  await expect(page.locator('[role="alert"]')).toContainText('已过期或缺少仓库读取权限');
  await page.getByLabel('同步令牌', { exact: true }).fill('replacement-fixture');
  await page.getByRole('button', { name: '替换已保存令牌', exact: true }).click();
  await expect(page.getByLabel('同步令牌', { exact: true })).toHaveValue(''); expect(saved).toBe('replacement-fixture');
  await expect(sync).toBeEnabled();
  await page.screenshot({ path: `test-results-audit/MAX-133-${provider}-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: '删除已保存令牌', exact: true }).click(); await expect(sync).toBeDisabled();
  await page.getByLabel('同步令牌', { exact: true }).fill('next-fixture');
  await page.getByLabel('仓库路径', { exact: true }).fill('group/other'); await expect(sync).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存令牌', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(sync).toBeEnabled();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fixture');
  expect(await page.locator('source-settings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});
