import { expect, test, type Page } from '@playwright/test';

/**
 * MAX238-APPLY-IDEMPOTENCY-R1 browser evidence for the response-loss protocol.
 * The real metric-configuration component is served by Vite and driven through
 * its own controls. Every /api/metrics response comes from this protocol stub:
 * the activate request records its outcome and then drops the response, exactly
 * the case a client cannot observe. This proves the UI wiring (query the
 * original resource and key before any retry); it is not a real API, trial,
 * target database or formal-collection acceptance.
 */
const pkg = { id: 'mysql-basic', version: '1.0.0', digest: 'pin', resource_type: 'instance' };
const release = { package: pkg, recommendations: { interval_ms: 60000 }, documentation: [] };
const catalog = { packages: [release], metrics: [] };
const recommendations = { resource: { type: 'instance', id: 1 }, evaluated_at: '2026-10-28T00:00:00Z',
  packages: [{ release, compatibility: 'compatible', recommended: true, checks: [],
    coverage: [{ id: 'db.uptime_seconds', semantic_version: '1.0.0' }], missing_core_metrics: [] }] };
const status = { contract_version: '1.0.0', resource: { type: 'instance', id: 1 }, evaluated_at: '2026-10-28T00:00:00Z',
  can_manage: true, binding: { state: 'unbound', package: null, published_revision: null, applied_revision: null, application: 'unbound' },
  effective_enabled: { enabled: false, global_enabled: true, asset_enabled: true, policy_enabled: false, source: 'package' },
  collection: { state: 'unknown', last_attempt_at: null, last_success_at: null, in_flight: false },
  formal_visibility: { state: 'unbound', source: 'none', last_observed_at: null, generation: null, freshness: 'unknown' },
  blockers: ['UNBOUND'], coverage: [] };
const preview = { published: false, affected_resources: 1, requests_per_hour_before: 0, requests_per_hour_after: 1,
  resources: [{ binding: { package: pkg, revision: 1, group_id: null, overrides: {} },
    resolved: { settings: { enabled: true, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 300000, max_counter_gap_ms: 600000,
      max_rows: 100, max_concurrency: 1, max_series_per_resource: 1000 }, sources: {}, metric_templates: [], metric_sources: {},
      applicability: [], platform_limits: {}, dependencies: [], collector_timeouts: [], impact: { requests_per_hour_estimate: 1 } },
    application: { status: 'pending', applied_revision: null, reported_at: null, error_code: null } }] };
const trial = { trial: true, persisted: false, decision: 'attempted', attempts: [{ id: 'attempt-1', collector_id: 'mysql.status', status: 'succeeded' }],
  capabilities: [], samples: [{ metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, value: 1000, quality: { status: 'good' }, unit: 's' }],
  applicability: [], lifecycle_evidence: 'available' };
type Call = { method: string; path: string; body?: { operation_key?: string } };

async function stub(page: Page, outcome: 'committed' | 'pending') {
  const calls: Call[] = [];
  const recorded = new Map<string, 'committed' | 'pending'>();
  await page.route('**/api/metrics/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/metrics', '');
    let body: { operation_key?: string } | undefined;
    try { body = request.postDataJSON() as { operation_key?: string }; } catch { body = undefined; }
    calls.push({ method: request.method(), path, ...(body ? { body } : {}) });
    if (path === '/config/catalog') return route.fulfill({ json: catalog });
    if (path.endsWith('/access')) return route.fulfill({ json: { can_manage: true } });
    if (path.endsWith('/attempts')) return route.fulfill({ json: [] });
    if (path.endsWith('/recommendations')) return route.fulfill({ json: recommendations });
    if (path.endsWith('/status')) return route.fulfill({ json: status });
    if (path === '/policy/groups') return route.fulfill({ json: { groups: [] } });
    if (path.endsWith('/preview')) return route.fulfill({ json: preview });
    if (path.endsWith('/trial')) return route.fulfill({ json: trial });
    if (path.endsWith('/activate')) {
      // The intent was accepted and its outcome recorded; the response is lost.
      recorded.set(body?.operation_key ?? '', outcome);
      return route.abort('connectionreset');
    }
    if (path.includes('/operations/')) {
      const key = decodeURIComponent(path.split('/operations/')[1]!);
      const state = recorded.get(key) ?? 'absent';
      return route.fulfill({ json: { state, operation: state === 'absent' ? null : {
        resource: { type: 'instance', id: 1 }, target_revision: 1,
        configuration_digest: state === 'committed' ? `sha256:${'a'.repeat(64)}` : null,
        committed_at: state === 'committed' ? '2026-10-28T00:00:00Z' : null } } });
    }
    return route.fulfill({ status: 404, json: { error: 'POLICY_NOT_FOUND' } });
  });
  return calls;
}

async function prove(page: Page) {
  const host = page.locator('metric-configuration');
  await expect(host.getByText('选择适合此对象的采集模板')).toBeVisible();
  await host.getByRole('button', { name: '检查并启用' }).click();
  await host.getByRole('button', { name: '预检与影响预览' }).click();
  await expect(host.getByRole('button', { name: '试采' })).toBeEnabled();
  await host.getByRole('button', { name: '试采' }).click();
  await expect(host.getByRole('button', { name: '发布' })).toBeEnabled();
  return host;
}

test('a committed publish whose response was lost is recovered by querying the same key', async ({ page }) => {
  const calls = await stub(page, 'committed');
  await page.goto('/e2e/fixtures/max238-idempotency-recovery.html');
  const host = await prove(page);
  await host.getByRole('button', { name: '发布' }).click();
  await expect(page.locator('app-toast-container')).toContainText('已确认上次发布已完成');
  const activates = calls.filter(call => call.path.endsWith('/activate'));
  const queries = calls.filter(call => call.path.includes('/operations/'));
  expect(activates).toHaveLength(1);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.path).toBe(`/config/resources/instance/1/operations/${activates[0]!.body!.operation_key}`);
  // The mutation was never resent and the unknown state is not reported as pending.
  await expect(host.getByText('尚未确认')).toHaveCount(0);
  await expect(host.getByRole('button', { name: '发布' })).toHaveCount(1);
});

test('a pending publish keeps the intent and offers a query, never a second mutation', async ({ page }) => {
  const calls = await stub(page, 'pending');
  await page.goto('/e2e/fixtures/max238-idempotency-recovery.html');
  const host = await prove(page);
  await host.getByRole('button', { name: '发布' }).click();
  await expect(host.getByText('上次发布的结果尚未确认')).toBeVisible();
  const query = host.getByRole('button', { name: '查询发布结果' });
  await expect(query).toBeEnabled();
  const before = calls.length;
  await query.click();
  await expect.poll(() => calls.slice(before).filter(call => call.path.includes('/operations/')).length).toBe(1);
  expect(calls.slice(before).filter(call => call.path.endsWith('/activate'))).toHaveLength(0);
  expect(calls.filter(call => call.path.endsWith('/activate'))).toHaveLength(1);
  await expect(host.getByText('上次发布的结果尚未确认')).toBeVisible();
});
