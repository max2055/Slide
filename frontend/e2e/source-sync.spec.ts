import { expect, test } from '@playwright/test';

for (const width of [1280, 390]) for (const status of [200, 403, 503]) {
  test(`MAX-157 invalidation: sync with old details open then manifest ${status} at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await page.addInitScript(() => localStorage.setItem('permissions', '["admin:*"]'));
    const old = { releaseId: 'old-snapshot', commitSha: 'a'.repeat(40), files: [{ path: 'src/private-old.ts', digest: 'private-old-digest', bytes: 20 }], repository: { ref: 'main' } };
    let synced = false, requested = false, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/platform/source/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/config')) return route.fulfill({ json: { config: { provider: 'github', baseUrl: 'https://github.com', repositoryPath: 'group/repo', allowedPaths: [], allowModelContent: false } } });
      if (path.endsWith('/sync')) { requested = true; await pending; synced = true; return route.fulfill({ json: { releaseId: 'new' } }); }
      return route.fulfill(synced ? { status, json: status === 200 ? { ...old, releaseId: 'new-snapshot', files: [{ path: 'src/new.ts', digest: 'new-digest', bytes: 21 }] } : { error: status === 403 ? 'SOURCE_READ_FORBIDDEN' : 'SOURCE_STORAGE_UNAVAILABLE' } } : { json: old });
    });
    await page.route('**/invalidation-source-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><source-settings></source-settings><script type="module">import "/src/app/styles.css"; import "/src/app/ui/views/source-settings.ts";</script></body></html>' }));
    await page.goto('/invalidation-source-fixture');
    await page.getByText('仓库配置与同步', { exact: true }).click();
    await page.getByLabel('同步令牌', { exact: true }).fill('controlled-single-use');
    await page.getByRole('button', { name: '同步源码', exact: true }).click(); await expect.poll(() => requested).toBe(true);
    await page.getByRole('button', { name: '浏览快照 →' }).click();
    await page.getByRole('button', { name: '查看', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '快照条目详情' })).toBeVisible();
    await expect(page.locator('source-manifest')).toContainText('private-old-digest');
    release();
    await expect(page.getByRole('dialog', { name: '快照条目详情' })).toHaveCount(0);
    await expect(page.locator('source-manifest')).not.toContainText('private-old');
    await expect(page.locator('source-manifest')).toBeFocused();
    if (status === 200) {
      await expect(page.locator('source-manifest')).toContainText('new-snapshot');
      const detail = page.getByRole('button', { name: '查看', exact: true }); await detail.click();
      await expect(page.locator('source-manifest')).toContainText('new-digest');
      await page.keyboard.press('Escape'); await expect(detail).toBeFocused();
    } else await expect(page.locator('source-manifest').getByRole('alert')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sync-details-${status}-${width}.png`), fullPage: true });
  });
}

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
  await page.goto('/source-sync-fixture'); await page.getByText('仓库配置与同步', { exact: true }).click();
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
  await expect(page.locator('source-manifest')).toContainText('文件已保留');
  await page.getByRole('button', { name: '查看提示 →' }).click();
  await expect(page.locator('source-manifest')).toContainText('src/private.json');
  await expect(page.locator('source-manifest')).toContainText('含疑似敏感信息');
  await expect(page.locator('source-manifest')).toContainText('较大文件，已保留');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('single-use-fixture');
  await page.getByRole('button', { name: '返回源码仓库' }).click();
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
  await page.goto('/saved-source-fixture'); await page.getByText('仓库配置与同步', { exact: true }).click();
  const sync = page.getByRole('button', { name: '同步源码', exact: true });
  await expect(sync).toBeDisabled();
  await page.getByLabel('同步令牌', { exact: true }).fill('saved-fixture');
  await page.getByLabel('保留同步令牌', { exact: true }).check();
  await sync.click(); await expect(page.getByLabel('同步令牌', { exact: true })).toHaveValue('');
  await expect(page.locator('source-settings')).toContainText('当前仓库已保存令牌'); expect(saved).toBe('saved-fixture');
  await page.reload(); await page.getByText('仓库配置与同步', { exact: true }).click(); await expect(sync).toBeEnabled();
  await expect(page.getByLabel('保留同步令牌', { exact: true })).not.toBeChecked();
  await sync.click(); await expect(page.locator('source-settings')).toContainText('源码同步完成');
  await page.getByLabel('同步令牌', { exact: true }).fill('override-fixture'); await sync.click();
  await expect(page.getByLabel('同步令牌', { exact: true })).toHaveValue(''); expect(saved).toBe('saved-fixture');
  await page.getByLabel('同步令牌', { exact: true }).fill('expired-fixture'); await sync.click();
  await expect(page.locator('[role="alert"]')).toContainText('可能已过期、被撤销或缺少仓库读取权限');
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

for (const code of ['SOURCE_SIGNING_KEY_INVALID', 'SOURCE_CREDENTIAL_INVALID', 'UNKNOWN_UPSTREAM', 'HTML_RESPONSE']) test(`safe source error and successful recovery: ${code}`, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['admin:*'])));
  const config = { provider: 'github', baseUrl: 'https://github.com', repositoryPath: 'owner/repo', allowedPaths: [], allowModelContent: false };
  let fail = true; let saved = 'original-fixture'; let syncCalls = 0;
  const identity = 'a'.repeat(64);
  const manifest = { releaseId: 'last-good', commitSha: 'a'.repeat(40), files: [], verification: { status: 'repository-unbound' } };
  await page.route('**/api/platform/source/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/config')) return route.fulfill({ json: { config, credential: { identity, hasSavedToken: true } } });
    if (path.endsWith('/credential')) { saved = route.request().postDataJSON().token; return route.fulfill({ json: { identity, hasSavedToken: true } }); }
    if (path.endsWith('/sync')) {
      syncCalls++;
      if (fail) return code === 'HTML_RESPONSE' ? route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Authorization: fixture-secret https://user:fixture-secret@host</html>' }) : route.fulfill({ status: 503, json: { error: code === 'UNKNOWN_UPSTREAM' ? 'upstream fixture-secret' : code } });
      expect(saved).toBe('replacement-fixture'); return route.fulfill({ json: { ...manifest, releaseId: 'fresh-snapshot' } });
    }
    if (fail && code === 'SOURCE_SIGNING_KEY_INVALID') return route.fulfill({ status: 503, json: { error: code } });
    return route.fulfill({ json: fail ? manifest : { ...manifest, releaseId: 'fresh-snapshot' } });
  });
  await page.route('**/source-error-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><source-settings></source-settings><script type="module">import "/src/app/styles.css"; import "/src/app/ui/views/source-settings.ts";</script></body></html>' }));
  await page.goto('/source-error-fixture'); await page.getByText('仓库配置与同步', { exact: true }).click();
  const sync = page.getByRole('button', { name: '同步源码', exact: true });
  await expect(sync).toBeEnabled(); await sync.click();
  // Locators pierce Lit shadow roots; scope the form alert to exclude the snapshot alert.
  await expect(page.locator('source-settings').getByRole('alert').first()).toBeVisible();
  const formAlert = page.locator('source-settings').getByRole('alert').first();
  await expect(formAlert).not.toContainText(/SOURCE_|Error:|fixture-secret/);
  expect(saved).toBe('original-fixture'); expect(syncCalls).toBe(1);
  if (code === 'SOURCE_SIGNING_KEY_INVALID') {
    await expect(formAlert).toContainText('服务端源码快照签名配置不完整');
    await expect(page.locator('source-manifest').getByRole('alert')).toContainText('服务端源码快照签名配置不完整');
    await expect(page.getByRole('button', { name: '输入新令牌' })).toHaveCount(0);
  } else if (code === 'SOURCE_CREDENTIAL_INVALID') {
    await expect(formAlert).toContainText('GitHub'); await expect(formAlert).toContainText('可能已过期');
    await page.getByRole('button', { name: '输入新令牌' }).click();
    await expect(page.getByLabel('同步令牌', { exact: true })).toBeFocused();
    await expect(page.locator('source-manifest')).toContainText('last-good');
  }
  await page.screenshot({ path: `test-results-audit/MAX-139-${code}.png`, fullPage: true });
  await expect(page.locator('source-settings')).not.toContainText('fixture-secret');
  fail = false;
  await page.getByLabel('同步令牌', { exact: true }).fill('replacement-fixture');
  await page.getByRole('button', { name: '替换已保存令牌', exact: true }).click();
  await expect(page.getByLabel('同步令牌', { exact: true })).toHaveValue('');
  await sync.click(); await expect(page.locator('source-settings')).toContainText('源码同步完成');
  await expect(page.locator('source-settings').getByRole('alert')).toHaveCount(0);
  await expect(page.locator('source-manifest')).toContainText('fresh-snapshot');
});
