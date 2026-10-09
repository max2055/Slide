import { expect, test, type Page } from '@playwright/test';

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  test(`resource evidence deep links and missing evidence at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/agent-ws', socket => {
      socket.onMessage(message => { if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' })); });
    });
    await page.addInitScript(() => {
      localStorage.setItem('token', 'fixture-token');
      localStorage.setItem('refreshToken', 'fixture-refresh');
      localStorage.setItem('permissions', JSON.stringify(['*']));
      localStorage.setItem('slide.control.session_token.v1', 'fixture-token');
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    });
    const resource = { type: 'instance', id: 1 };
    const related = { type: 'network_device', id: 3 };
    const evidenceId = 'a'.repeat(64);
    const item = { schemaVersion: 1, id: evidenceId, kind: 'observation', status: 'fact', subject: { resource }, quality: 'good', observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 300_000).toISOString(), source: 'metrics', correlationId: 'corr-1', provenance: { adapter: 'collector' }, payload: { metricId: 'cpu', value: 0 } };
    let diagnosed = false;
    let savedConfig: Record<string, unknown> | null = null;
    let synced = false;
    let ruleVersion = 3;
    let rules: unknown[] = [];
    let decisions: Record<string, unknown>[] = [];
    let recoveryPolicy: Record<string, unknown> = { schemaVersion: 1, version: 0, enabled: false, commandTypes: [], metricId: '', source: '', windowSeconds: 60, maxSampleGapSeconds: 30 };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      let body: unknown = {};
      if (path === '/api/auth/permissions') body = ['*'];
      if (path === '/api/user/preferences') body = { preferences: { locale: 'zh-CN' } };
      if (path === '/api/version') body = { version: 'test' };
      if (path.endsWith('/recovery-policy')) {
        if (route.request().method() === 'PUT') {
          const { expectedVersion, ...submitted } = route.request().postDataJSON();
          expect(expectedVersion).toBe(recoveryPolicy.version);
          recoveryPolicy = { schemaVersion: 1, version: Number(expectedVersion) + 1, ...submitted };
        }
        body = recoveryPolicy;
      }
      if (path.endsWith('/recovery/op-e2e')) {
        expect(route.request().method()).toBe('GET');
        body = { schemaVersion: 1, status: 'not-recovered', reason: 'RECOVERY_BOUND_VIOLATED', operationId: 'op-e2e', operationState: 'succeeded', evidenceRefs: [evidenceId], verifiedBy: 'evidence-window-v1', policyVersion: 1, metricId: 'cpu', source: 'metrics', startedAt: item.observedAt, windowSeconds: 60 };
      }
      if (path === '/api/platform/source/manifest') body = { releaseId: 'release-e2e', commitSha: 'a'.repeat(40), treeDigest: 'b'.repeat(64), signature: 'c'.repeat(64), files: [{ path: 'apps/api.ts', digest: 'd'.repeat(64), bytes: 1024 }] };
      if (path === '/api/platform/source/config') {
        if (route.request().method() === 'PUT') savedConfig = route.request().postDataJSON();
        body = { config: savedConfig };
      }
      if (path === '/api/platform/source/sync') {
        expect(route.request().postDataJSON()).toEqual({ token: 'single-use-e2e' }); synced = true; body = { success: true };
      }
      if (path.endsWith('/evaluation')) body = { schemaVersion: 1, generatedAt: item.observedAt, rulesVersion: ruleVersion, invariants: [{ ruleId: 'cpu-bounds', version: 1, status: 'unknown', reason: 'MISSING_INPUT', evidenceRefs: [evidenceId] }], expectations: [{ metricId: 'cpu', status: 'unknown', reason: 'BASELINE_SHORT', mean: null, deviation: null, sampleCount: 2, evidenceRefs: [] }], gaps: ['BASELINE_SHORT'] };
      if (path.endsWith('/invariants')) {
        if (route.request().method() === 'PUT') {
          const submitted = route.request().postDataJSON(); expect(submitted.expectedVersion).toBe(ruleVersion);
          rules = submitted.rules; ruleVersion++;
        }
        body = { schemaVersion: 1, version: ruleVersion, rules };
      }
      if (path.endsWith('/decisions')) {
        if (route.request().method() === 'POST') {
          const submitted = route.request().postDataJSON();
          expect(submitted).toEqual({ statement: 'CPU pressure may explain latency', status: 'hypothesis', evidenceRefs: [evidenceId], from: item.observedAt, to: item.observedAt });
          body = { id: 'decision-e2e', ...submitted, createdAt: item.observedAt }; decisions = [body as Record<string, unknown>];
        } else body = { schemaVersion: 1, resource, items: path.includes('/instance/') ? decisions : [], truncated: false, gaps: [] };
      }
      if (path === '/api/resources') body = { items: [
        { resource, label: 'Orders database', status: 'online', attributes: {} },
        { resource: { type: 'server', id: 2 }, label: 'Host', status: 'online', attributes: {} },
        { resource: related, label: 'Edge switch', status: 'unknown', attributes: {} },
      ] };
      if (path.endsWith('/evidence')) body = { schemaVersion: 1, resource: path.includes('network_device') ? related : resource, generatedAt: item.observedAt, facts: path.includes('network_device') ? [] : [item], inferences: [], hypotheses: [], gaps: path.includes('network_device') ? ['OBSERVATIONS_EMPTY'] : [], truncated: false };
      if (path.endsWith('/diagnose')) {
        expect(route.request().method()).toBe('POST');
        body = { relations: [{ source: resource, target: related, relationType: 'depends_on', provenance: 'operator' }], relatedEvidence: [{ resource: { resource: related, label: 'Edge switch', status: 'unknown', attributes: {} } }], gaps: [], truncated: false };
      }
      if (path.endsWith('/diagnose-agent')) { diagnosed = true; body = { success: true, analysisId: 42, status: 'queued' }; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/resource-diagnosis?resourceType=instance&resourceId=1');
    const view = page.locator('resource-diagnosis-page');
    await expect(view.getByRole('heading', { name: '跨资源诊断' })).toBeVisible();
    await expect(view.getByRole('combobox', { name: '资源', exact: true })).toHaveValue('instance:1');
    await expect(view.locator('resource-evaluation')).toContainText('cpu-bounds');
    await expect(view.locator('resource-evaluation')).toContainText('规则集 3');
    await expect(view.locator('resource-evaluation')).toContainText('BASELINE_SHORT');
    await expect(view.locator('source-manifest')).toContainText('release-e2e');
    await view.locator(`[data-evidence-id="${evidenceId}"] summary`).click();
    await expect(view.locator(`[data-evidence-id="${evidenceId}"]`)).toContainText('corr-1');
    await expect(view.locator(`[data-evidence-id="${evidenceId}"]`)).toContainText('新鲜');
    const ruleEditor = view.locator('resource-invariants');
    await ruleEditor.getByLabel('规则 ID', { exact: true }).fill('cpu-limit');
    await ruleEditor.getByLabel('指标 ID', { exact: true }).fill('cpu');
    await ruleEditor.getByLabel('下界', { exact: true }).fill('0');
    await ruleEditor.getByLabel('上界', { exact: true }).fill('100');
    await ruleEditor.getByLabel('维度 JSON', { exact: true }).fill('{"core":"all"}');
    await ruleEditor.getByRole('button', { name: '保存规则' }).click();
    await expect(view.locator('resource-evaluation')).toContainText('规则集 4');
    expect(rules).toEqual([{ id: 'cpu-limit', version: 1, metricId: 'cpu', min: 0, max: 100, dimensions: { core: 'all' } }]);
    const decisionEditor = view.locator('resource-decisions');
    await decisionEditor.getByLabel('记录类型', { exact: true }).selectOption('hypothesis');
    await decisionEditor.getByLabel('判断内容', { exact: true }).fill('CPU pressure may explain latency');
    await decisionEditor.getByRole('checkbox', { name: `引用 ${evidenceId}`, exact: true }).check();
    await decisionEditor.getByRole('button', { name: '保存判断' }).click();
    await expect(decisionEditor.locator('article')).toContainText('CPU pressure may explain latency');
    await decisionEditor.getByRole('button', { name: '刷新决策记录', exact: true }).click();
    await expect(decisionEditor.locator('article')).toContainText('decision-e2e');
    await ruleEditor.getByRole('button', { name: '编辑 cpu-limit' }).click();
    await ruleEditor.getByLabel('上界', { exact: true }).fill('90');
    await ruleEditor.getByRole('button', { name: '保存规则' }).click();
    await expect(view.locator('resource-evaluation')).toContainText('规则集 5');
    await page.screenshot({ path: testInfo.outputPath(`resource-editors-${viewport.width}.png`), fullPage: true });
    await ruleEditor.getByRole('button', { name: '删除 cpu-limit' }).click();
    await expect(view.locator('resource-evaluation')).toContainText('规则集 6');
    const recovery = view.locator('resource-recovery');
    await expect(recovery.getByRole('checkbox', { name: '启用恢复策略' })).not.toBeChecked();
    await recovery.getByRole('checkbox', { name: '启用恢复策略' }).check();
    await recovery.getByLabel('命令类型', { exact: true }).fill('test-observation-command');
    await recovery.getByLabel('恢复指标 ID', { exact: true }).fill('cpu');
    await recovery.getByLabel('证据来源', { exact: true }).fill('metrics');
    await recovery.getByLabel('恢复下界', { exact: true }).fill('0');
    await recovery.getByLabel('恢复上界', { exact: true }).fill('80');
    await recovery.getByLabel('恢复维度 JSON', { exact: true }).fill('{"core":"all"}');
    await recovery.getByRole('button', { name: '保存恢复策略' }).click();
    await expect(recovery).toContainText('恢复策略已保存');
    expect(recoveryPolicy).toEqual({ schemaVersion: 1, version: 1, enabled: true, commandTypes: ['test-observation-command'], metricId: 'cpu', source: 'metrics', min: 0, max: 80, dimensions: { core: 'all' }, windowSeconds: 60, maxSampleGapSeconds: 30 });
    await recovery.getByLabel('操作 ID', { exact: true }).fill('op-e2e');
    await recovery.getByRole('button', { name: '查询恢复状态' }).click();
    await expect(recovery.locator('[data-recovery-result]')).toContainText('not-recovered');
    await expect(recovery.locator('[data-recovery-result]')).toContainText('RECOVERY_BOUND_VIOLATED');
    await expect(recovery.locator('[data-recovery-result]')).toContainText(evidenceId);
    await recovery.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`resource-recovery-${viewport.width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await view.getByRole('button', { name: '开始只读诊断', exact: true }).click();
    await expect.poll(() => diagnosed).toBe(true);
    await view.getByRole('button', { name: '获取关联证据' }).click();
    await view.getByRole('link', { name: '网络设备 · Edge switch' }).click();
    await expect(page).toHaveURL(/resourceType=network_device.*returnResource=instance%3A1/);
    await expect(view).toContainText('OBSERVATIONS_EMPTY');
    await expect(view.getByRole('combobox', { name: '资源', exact: true })).toHaveValue('network_device:3');
    await expect(view.locator('[data-kind="facts"] app-empty-state')).toBeVisible();
    await expect(view.locator('[data-evidence-id]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`resource-diagnosis-${viewport.width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await view.getByRole('button', { name: '返回 Orders database' }).click();
    await expect(view.locator(`[data-evidence-id="${evidenceId}"]`)).toBeVisible();
    await view.getByRole('combobox', { name: '资源', exact: true }).selectOption('server:2');
    await expect(page).toHaveURL(/resourceType=server&resourceId=2/);
    await page.goto('/settings/platform/source');
    const source = page.locator('source-settings');
    await expect(source.getByRole('heading', { name: '源码仓库', exact: true })).toBeVisible();
    if (viewport.width < 640) await expect(page.getByRole('combobox', { name: '选择设置页面' })).toHaveValue('source');
    await expect(source.getByRole('checkbox', { name: '允许模型读取源码内容' })).not.toBeChecked();
    await source.getByRole('textbox', { name: 'GitLab URL' }).fill('https://gitlab.example.com');
    await source.getByRole('textbox', { name: '仓库路径' }).fill('group/project');
    await source.getByRole('textbox', { name: '允许的源码路径' }).fill('apps/');
    await source.getByRole('button', { name: '保存配置' }).click();
    await expect(source).toContainText('配置已保存');
    expect(savedConfig).toEqual({ provider: 'gitlab', baseUrl: 'https://gitlab.example.com', repositoryPath: 'group/project', allowedPaths: ['apps/'], allowModelContent: false });
    await source.getByLabel('同步令牌', { exact: true }).fill('single-use-e2e');
    await source.getByRole('button', { name: '同步源码' }).click();
    await expect.poll(() => synced).toBe(true);
    await expect(source.getByLabel('同步令牌', { exact: true })).toHaveValue('');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('single-use-e2e');
    await expect(source.locator('source-manifest')).toContainText('release-e2e');
    await page.screenshot({ path: testInfo.outputPath(`source-settings-${viewport.width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

async function diagnosisFixture(page: Page, options: { permissions?: string[]; stale?: boolean; empty?: boolean; evidenceStatus?: number } = {}) {
  const permissions = options.permissions ?? ['resources:view', 'ai:view', 'ai:manage'];
  await page.addInitScript(permissions => {
    localStorage.setItem('token', 'fixture-token');
    localStorage.setItem('refreshToken', 'fixture-refresh');
    localStorage.setItem('slide.control.session_token.v1', 'fixture-token');
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
  }, permissions);
  await page.routeWebSocket('**/agent-ws', socket => {
    socket.onMessage(message => { if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' })); });
  });
  const state = { status: 'pending', queryStatus: 200, stallStatus: false, stallEvidence: false, evidenceRequests: 0, posts: [] as unknown[], result: null as unknown };
  const observedAt = options.stale ? '2020-01-01T00:00:00Z' : new Date().toISOString();
  const validUntil = options.stale ? '2020-01-01T00:05:00Z' : new Date(Date.now() + 300_000).toISOString();
  const fact = { id: 'b'.repeat(64), kind: 'observation', status: 'fact', quality: 'good', observedAt, validUntil, source: 'collector', correlationId: 'raw-correlation', payload: { metricId: 'cpu', value: 91 } };
  const resource = { type: 'instance', id: 1 };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    let body: unknown = {};
    let status = 200;
    if (path === '/api/auth/permissions') body = permissions;
    else if (path === '/api/user/preferences') body = { preferences: { locale: 'zh-CN' } };
    else if (path === '/api/resources') body = { items: [{ resource, label: '订单数据库', status: 'online', attributes: {} }] };
    else if (path.endsWith('/evidence')) {
      state.evidenceRequests++;
      if (state.stallEvidence) return;
      status = options.evidenceStatus ?? 200;
      body = { generatedAt: new Date().toISOString(), facts: options.empty ? [] : [fact], inferences: [], hypotheses: [], gaps: options.empty ? ['NO_EVIDENCE_IN_WINDOW'] : options.stale ? ['EVIDENCE_STALE'] : [], truncated: false };
    } else if (path.endsWith('/evaluation')) body = { generatedAt: new Date().toISOString(), rulesVersion: 2, invariants: [{ ruleId: 'CPU 使用率上限', version: 1, status: options.empty || options.stale ? 'unknown' : 'fail', reason: options.empty || options.stale ? 'FRESH_NUMERIC_EVIDENCE_REQUIRED' : 'CONSTRAINT_VIOLATED', evidenceRefs: options.empty ? [] : [fact.id] }], expectations: [], gaps: [] };
    else if (path.endsWith('/invariants')) body = { version: 0, rules: [] };
    else if (path.endsWith('/decisions')) body = { items: [], gaps: [], truncated: false };
    else if (path.endsWith('/recovery-policy')) body = { enabled: false, version: 0, commandTypes: [], metricId: '', source: '', windowSeconds: 60, maxSampleGapSeconds: 30 };
    else if (path.includes('/analyses/')) {
      if (state.stallStatus) return;
      status = state.queryStatus;
      body = { analysisId: 42, resource, status: state.status, result: state.result, createdAt: '2026-10-01T09:00:00Z', completedAt: ['completed', 'failed'].includes(state.status) ? '2026-10-01T10:00:00Z' : null };
    } else if (path.endsWith('/diagnose-agent')) { state.posts.push(route.request().postDataJSON()); body = { analysisId: 42, status: 'queued' }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return state;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  test(`business diagnosis, keyboard and accessible task states at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const state = await diagnosisFixture(page);
    await page.goto('/resource-diagnosis?resourceType=instance&resourceId=1');
    const view = page.locator('resource-diagnosis-page');
    await expect(view.locator('[data-diagnosis-overview]')).toContainText('分析对象：订单数据库');
    await expect(view.getByRole('region', { name: '异常评估结论' })).toContainText('发现观测值超出配置范围');
    await view.getByRole('heading', { name: '跨资源诊断', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`diagnosis-overview-${viewport.width}.png`), fullPage: true });
    const search = view.getByRole('searchbox', { name: '搜索资源', exact: true });
    await search.focus(); await page.keyboard.press('Tab');
    await expect(view.getByRole('combobox', { name: '资源', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    const technical = view.locator('[data-diagnosis-overview] summary');
    await expect(technical).toBeFocused(); await page.keyboard.press('Enter');
    await expect(view.locator('[data-diagnosis-overview] details')).toHaveAttribute('open', '');
    await page.keyboard.press('Tab'); await expect(view.getByRole('button', { name: '获取关联证据' })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(view.getByRole('button', { name: '开始只读诊断', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(view.locator('[data-task-status]')).toContainText('排队中'); expect(state.posts).toHaveLength(1);
    await expect(view.getByRole('button', { name: '开始只读诊断', exact: true })).toBeDisabled();
    state.status = 'running';
    await expect(view.locator('[data-task-status]')).toContainText('运行中');
    state.status = 'unknown';
    await expect(view.locator('[data-task-status]')).toContainText('结果未知');
    const retry = view.getByRole('button', { name: '确认后重新分析' });
    await retry.focus(); await page.keyboard.press('Enter');
    const dialog = view.getByRole('dialog', { name: '确认重新分析' });
    await expect(dialog).toBeVisible();
    await expect(view.locator('app-dialog')).toContainText('具体费用取决于模型和用量，目前无法估算');
    expect(await dialog.ariaSnapshot()).toContain('接受可能再次计费并重试');
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(retry).toBeFocused();
    expect(state.posts).toHaveLength(1);
    await page.keyboard.press('Enter');
    // Native dialog starts at its close button; Tab advances through slotted footer controls.
    await page.keyboard.press('Tab'); await expect(view.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(view.getByRole('button', { name: '接受可能再次计费并重试' })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(view.getByRole('button', { name: 'Close dialog' })).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter');
    await expect.poll(() => state.posts.length).toBe(2);
    expect(state.posts[1]).toEqual({ retryOf: 42, confirmUnknownRetry: true });
    await expect(dialog).not.toBeVisible();
    state.status = 'completed'; state.result = { verification: 'partial', evidenceSnapshot: { collectedAt: '2026-10-01T08:00:00Z' }, conclusions: ['CPU 超出配置范围'], recommendations: [{ action: '检查采集连接' }] };
    await view.getByRole('button', { name: '查询任务状态' }).click();
    await expect(view.locator('[data-task-status]')).toContainText('部分完成');
    const result = view.locator('[data-analysis-id]');
    await expect(result).toContainText('历史依据采集时间'); await expect(result).toContainText('2026/10/1');
    await expect(result).toContainText('检查采集连接'); await expect(result).toContainText('未验证 Evidence ID');
    await expect(result).toContainText('建议尚未执行');
    const snapshot = await view.ariaSnapshot();
    expect(snapshot).toContain('分析对象：订单数据库'); expect(snapshot).toContain('部分完成'); expect(snapshot).toContain('region "事实（自动观测与记录）');
    await view.getByRole('heading', { name: '只读 Agent 诊断 · 订单数据库' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`diagnosis-result-${viewport.width}.png`), fullPage: true });
    const evidenceLink = view.getByRole('link', { name: '查看当前资源证据' });
    await evidenceLink.focus(); await page.keyboard.press('Enter');
    await expect(view.locator('#evidence-facts')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(view.locator('[data-evidence-id] summary')).toBeFocused();
    await page.keyboard.press('Enter'); await expect(view.locator('[data-evidence-id]')).toHaveAttribute('open', '');
    await expect(view.locator('[data-evidence-id]')).toContainText('raw-correlation');
    await page.screenshot({ path: testInfo.outputPath(`business-diagnosis-${viewport.width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    state.status = 'failed'; state.result = null;
    await view.getByRole('button', { name: '查询任务状态' }).click();
    await expect(view.locator('[data-task-status]')).toContainText('执行失败');
    await expect(result).toContainText('尚无可用结论');
    state.queryStatus = 403;
    await view.getByRole('button', { name: '查询任务状态' }).click();
    await expect(view.locator('[data-task-status]')).toContainText('状态待确认');
    await expect(result).toContainText('无分析结果查看权限');
    expect(state.posts).toHaveLength(2); expect(errors).toEqual([]);
  });

  test(`missing, stale and forbidden evidence at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const options of [{ empty: true }, { stale: true }, { evidenceStatus: 403 }]) {
      await page.unroute('**/api/**');
      const state = await diagnosisFixture(page, { ...options, permissions: ['resources:view'] });
      await page.goto('/resource-diagnosis?resourceType=instance&resourceId=1');
      const view = page.locator('resource-diagnosis-page');
      await expect(view.locator('[data-diagnosis-overview]')).toContainText('不能');
      await expect(view.getByRole('button', { name: '开始只读诊断', exact: true })).toHaveCount(0);
      await expect(view).toContainText('无只读诊断权限');
      if (options.empty) await expect(view).toContainText('所选时间范围没有证据');
      if (options.stale) { await expect(view.locator('[data-evidence-id] summary')).toContainText('已过期'); await expect(view.locator('[data-evidence-id] summary')).toContainText('2020/1/1'); }
      if (options.evidenceStatus) await expect(view.getByRole('alert').filter({ hasText: '无当前资源证据查看权限' })).toBeVisible();
      expect(state.posts).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });

  test(`timeouts preserve task identity without paid resubmission at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await diagnosisFixture(page);
    await page.clock.install();
    state.status = 'running';
    await page.goto('/resource-diagnosis?resourceType=instance&resourceId=1&analysisId=42');
    const view = page.locator('resource-diagnosis-page');
    await expect(view.locator('[data-task-status]')).toContainText('运行中');
    state.stallStatus = true;
    await page.clock.fastForward(3_000); await page.clock.fastForward(15_000);
    await expect(view.locator('[data-task-status]')).toContainText('状态待确认');
    await expect(view).toContainText('上次记录为运行中');
    await expect(view.getByRole('button', { name: '开始只读诊断', exact: true })).toBeDisabled();
    await expect(page).toHaveURL(/analysisId=42/); expect(state.posts).toEqual([]);
    state.stallEvidence = true;
    const requests = state.evidenceRequests;
    await view.getByRole('button', { name: '刷新', exact: true }).click();
    await expect.poll(() => state.evidenceRequests).toBeGreaterThan(requests);
    await page.clock.fastForward(15_000);
    await expect(view.getByRole('alert')).toContainText('证据读取超时');
    await expect(view.getByRole('button', { name: '开始只读诊断', exact: true })).toBeDisabled();
    expect(state.posts).toEqual([]);
  });
}
