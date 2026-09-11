import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './dashboard.js';
import { collectionRisk, compareRisk, freshness, isRisk, latestMetric, runState, safeDashboardReturn, scopedItems, summarize, usableMetric, type OverviewItem } from './dashboard-model.js';
const now = Date.now();
function item(overrides: Partial<OverviewItem> = {}): OverviewItem {
  return { resource: { type: 'server', id: 1 }, label: 'host', status: 'online', quality: 'good', freshness: 'fresh', observedAt: new Date(now).toISOString(), unresolvedAlerts: 0, alertIds: [], impactScope: [], relationCount: 0, gaps: [], ...overrides };
}
const metric = (value: number | null, extra = {}) => ({ metricId: 'cpu_usage', value, quality: value === null ? 'unknown' : 'good', observedAt: new Date(now).toISOString(), validUntil: new Date(now + 300_000).toISOString(), ...extra });
beforeEach(() => { authFetch.mockReset(); localStorage.setItem('permissions', '["*"]'); });
afterEach(() => { document.body.replaceChildren(); history.replaceState({}, '', '/'); });

describe('operations overview semantics', () => {
  it('separates expired, missing and failed collection from confirmed outages', () => {
    for (const resource of [item({ freshness: 'stale' }), item({ observedAt: null, freshness: 'missing' }), item({ gaps: ['OBSERVATIONS_UNAVAILABLE'] })]) {
      expect(runState(resource)).toBe('unknown'); expect(collectionRisk(resource)).toBe(true); expect(isRisk(resource)).toBe(true);
    }
    const offline = item({ status: 'offline', freshness: 'missing', observedAt: null });
    expect(runState(offline)).toBe('unavailable');
    expect(summarize([offline]).unavailable).toBe(1);
    expect(runState(item({ status: 'active' }))).toBe('unknown');
    expect(runState(item({ observedAt: new Date(now + 60_000).toISOString() }))).toBe('unknown');
  });
  it('deduplicates resource and alert IDs while retaining acknowledged unresolved counts', () => {
    const db = item({ resource: { type: 'instance', id: 1 }, unresolvedAlerts: 2, alertIds: ['10', '11'], attributes: { dbType: 'mysql' } });
    const server = item({ unresolvedAlerts: 1, alertIds: ['10'] });
    const overview = { collectedAt: '', dataQuality: 'complete', items: [db, server, db] };
    expect(summarize(scopedItems(overview, 'all'))).toMatchObject({ total: 2, alerts: 2, abnormal: 2 });
    expect(summarize(scopedItems(overview, 'server'))).toMatchObject({ total: 1, alerts: 1 });
    expect(scopedItems(overview, 'instance', '', 'postgresql')).toHaveLength(0);
    expect(scopedItems(overview, 'all', 'host')).toHaveLength(2);
  });
  it('marks truncated and failed alert counts as incomplete rather than exact zero', () => {
    expect(summarize([item({ alertsTruncated: true })]).alertsIncomplete).toBe(true);
    expect(summarize([item({ gaps: ['ALERTS_UNAVAILABLE'] })]).alertsUnavailable).toBe(true);
  });
  it('preserves zero, missing, unsupported, expired and newest invalid values separately', () => {
    expect(usableMetric(metric(0))).toBe(true);
    expect(usableMetric(metric(null))).toBe(false);
    expect(usableMetric(metric(0, { reason: 'unsupported_metric', quality: 'unknown' }))).toBe(false);
    expect(usableMetric(metric(42, { validUntil: new Date(now - 1).toISOString() }))).toBe(false);
    const resource = item({ observations: [metric(4, { observedAt: new Date(now - 1000).toISOString() }), metric(null)] });
    expect(latestMetric(resource, 'cpu_usage')?.value).toBeNull();
    expect(freshness(item({ observedAt: new Date(now - 600_000).toISOString() }))).toBe('stale');
  });
  it('uses per-device valid reachability and prioritizes explicit outages', () => {
    const down = item({ resource: { type: 'network_device', id: 2 }, observations: [metric(0, { metricId: 'device_reachability' })] });
    const missing = item({ freshness: 'missing', observedAt: null });
    expect(runState(down)).toBe('unavailable'); expect(compareRisk(down, missing)).toBeLessThan(0);
  });
  it('only accepts same-origin dashboard return targets', () => {
    expect(safeDashboardReturn('/dashboard?scope=server&page=2')).toBe('/dashboard?scope=server&page=2');
    expect(safeDashboardReturn('https://evil.example/dashboard')).toBeNull();
    expect(safeDashboardReturn('//evil.example/dashboard')).toBeNull();
    expect(safeDashboardReturn('/settings')).toBeNull();
  });
});

describe('dashboard behavior', () => {
  it('preserves the last successful snapshot after refresh failure', async () => {
    const dashboard = document.createElement('dashboard-page') as any;
    const snapshot = { collectedAt: new Date().toISOString(), items: [item()] };
    dashboard.resourceOverview = snapshot;
    authFetch.mockResolvedValue({ ok: false, status: 500 });
    await dashboard.loadDashboardData();
    expect(dashboard.resourceOverview).toBe(snapshot); expect(dashboard.error).not.toBe('');
  });
  it('ignores an older snapshot response after a newer refresh', async () => {
    let resolve!: (response: unknown) => void;
    authFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [item({ label: 'new' })] }) });
    const dashboard = document.createElement('dashboard-page') as any;
    const first = dashboard.loadDashboardData(); await dashboard.loadDashboardData();
    resolve({ ok: true, json: async () => ({ items: [item({ label: 'old' })] }) }); await first;
    expect(dashboard.resourceOverview.items[0].label).toBe('new');
  });
  it('restores safe URL scope and only requests database history on demand', async () => {
    history.replaceState({}, '', '/dashboard?scope=server&page=2&hours=banana');
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ items: [item()] }) });
    const dashboard = document.createElement('dashboard-page') as any;
    document.body.append(dashboard); await new Promise(done => setTimeout(done, 0)); await dashboard.updateComplete;
    expect(dashboard.resourceScope).toBe('server'); expect(dashboard.selectedHours).toBe(168);
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual(['/api/resources/overview']);
    expect(dashboard.shadowRoot.querySelectorAll('stat-card')).toHaveLength(4);
    expect(dashboard.shadowRoot.querySelector('.trend-chart-container')).toBeNull();
    expect(dashboard._formatBytes(2.71)).toBe('2.71 GB');
  });
  it('KPI filters do not alter baseline counts or trigger analysis requests', async () => {
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ items: [item(), item({ resource: { type: 'server', id: 2 }, status: 'offline' })] }) });
    const dashboard = document.createElement('dashboard-page') as any;
    document.body.append(dashboard); await new Promise(done => setTimeout(done, 0)); await dashboard.updateComplete;
    dashboard.selectDetail('unavailable'); await dashboard.updateComplete;
    expect(dashboard._visibleResourceItems()).toHaveLength(2);
    expect(dashboard.shadowRoot.querySelector('app-data-table').rows).toHaveLength(1);
    expect(authFetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    const href = dashboard.shadowRoot.querySelector('a[href*="server-detail"]').getAttribute('href');
    expect(href).toContain('id=2'); expect(href).toContain('returnTo=');
  });
});

describe('partial inventory refresh', () => {
  it('retains only the failed type from the previous successful snapshot', async () => {
    const dashboard = document.createElement('dashboard-page') as any;
    dashboard.resourceOverview = { items: [item({ label: 'old server' })] };
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ items: [], unavailableTypes: ['server'], dataQuality: 'partial' }) });
    await dashboard.loadDashboardData();
    expect(dashboard.resourceOverview.items[0].label).toBe('old server');
    expect(dashboard.error).not.toBe('');
  });
});

describe('failure and truncation regressions', () => {
  it('does not confirm healthy when a previously firing alert lookup fails', async () => {
    const dashboard = document.createElement('dashboard-page') as any;
    dashboard.resourceOverview = { items: [item({ unresolvedAlerts: 1, alertIds: ['critical'], alertsObservedAt: new Date().toISOString() })] };
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ items: [item({ gaps: ['ALERTS_UNAVAILABLE'] })] }) });
    await dashboard.loadDashboardData();
    const resource = dashboard.resourceOverview.items[0];
    expect(resource.unresolvedAlerts).toBe(1); expect(runState(resource)).toBe('unknown'); expect(isRisk(resource)).toBe(true);
    expect(summarize([resource]).alertsUnavailable).toBe(true);
  });
  it('does not report unmanaged when the global bound omitted a type', async () => {
    history.replaceState({}, '', '/dashboard?scope=server');
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ truncated: true, items: [item({ resource: { type: 'instance', id: 1 } })] }) });
    const dashboard = document.createElement('dashboard-page') as any;
    document.body.append(dashboard); await new Promise(done => setTimeout(done, 0)); await dashboard.updateComplete;
    expect(dashboard.shadowRoot.querySelector('app-empty-state').title).not.toMatch(/尚未纳管|No managed/);
    expect(dashboard.shadowRoot.querySelector('a[href="/servers"]')).toBeNull();
  });
});
