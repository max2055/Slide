import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
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
    await view.getByRole('button', { name: '返回 instance:1' }).click();
    await expect(view.locator(`[data-evidence-id="${evidenceId}"]`)).toBeVisible();
    await view.getByRole('combobox', { name: '资源', exact: true }).selectOption('server:2');
    await expect(page).toHaveURL(/resourceType=server&resourceId=2/);
    await page.goto('/settings/platform/source');
    const source = page.locator('source-settings');
    await expect(source.getByRole('heading', { name: '部署源码', exact: true })).toBeVisible();
    if (viewport.width < 640) await expect(page.locator('settings-shell select')).toHaveValue('source');
    await expect(source.getByRole('checkbox', { name: '允许模型读取源码内容' })).not.toBeChecked();
    await source.getByRole('textbox', { name: 'GitLab URL' }).fill('https://gitlab.example.com');
    await source.getByRole('textbox', { name: '项目 ID' }).fill('42');
    await source.getByRole('textbox', { name: '允许的源码路径' }).fill('apps/');
    await source.getByRole('button', { name: '保存配置' }).click();
    await expect(source).toContainText('配置已保存');
    expect(savedConfig).toEqual({ baseUrl: 'https://gitlab.example.com', projectId: '42', allowedPaths: ['apps/'], allowModelContent: false });
    await source.getByLabel('单次同步令牌', { exact: true }).fill('single-use-e2e');
    await source.getByRole('button', { name: '同步源码' }).click();
    await expect.poll(() => synced).toBe(true);
    await expect(source.getByLabel('单次同步令牌', { exact: true })).toHaveValue('');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('single-use-e2e');
    await expect(source.locator('source-manifest')).toContainText('release-e2e');
    await page.screenshot({ path: testInfo.outputPath(`source-settings-${viewport.width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
