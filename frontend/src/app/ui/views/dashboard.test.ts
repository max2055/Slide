import { beforeEach, describe, expect, it, vi } from 'vitest';
const authFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './dashboard.js';

beforeEach(() => authFetch.mockReset());

describe('dashboard capacity formatting', () => {
  it('preserves database capacity precision so the total matches instance management', () => {
    const dashboard = document.createElement('dashboard-page') as any;

    expect(dashboard._formatBytes(2.71)).toBe('2.71 GB');
  });

  it('filters the unified resource snapshot by the selected scope', () => {
    const dashboard = document.createElement('dashboard-page') as any;
    dashboard.resourceOverview = {
      items: [
        { resource: { type: 'instance', id: 1 }, label: 'mysql', status: 'active', quality: 'good', freshness: 'fresh', observedAt: null, unresolvedAlerts: 0, relationCount: 0, impactScope: [], gaps: [] },
        { resource: { type: 'server', id: 2 }, label: 'app-01', status: 'online', quality: 'good', freshness: 'fresh', observedAt: null, unresolvedAlerts: 1, relationCount: 1, impactScope: [], gaps: [] },
      ],
    };
    dashboard.resourceScope = 'server';
    expect(dashboard._visibleResourceItems()).toHaveLength(1);
    expect(dashboard._visibleResourceItems()[0].label).toBe('app-01');
  });

  it('summarizes visible resources without database-specific metrics', () => {
    const dashboard = document.createElement('dashboard-page') as any;
    dashboard.resourceOverview = {
      summary: { total: 2, byType: { instance: 1, server: 1, network_device: 0 }, fresh: 1, stale: 0, missing: 1, unresolvedAlerts: 2, impactedResources: 1 },
      items: [
        { resource: { type: 'instance', id: 1 }, label: 'mysql', status: 'active', quality: 'good', freshness: 'fresh', observedAt: null, unresolvedAlerts: 2, relationCount: 0, impactScope: [], gaps: [] },
        { resource: { type: 'server', id: 2 }, label: 'app-01', status: 'offline', quality: 'unknown', freshness: 'missing', observedAt: null, unresolvedAlerts: 0, relationCount: 1, impactScope: [], gaps: [] },
      ],
    };
    const summary = dashboard._visibleResourceSummary();
    expect(summary).toMatchObject({ total: 2, healthy: 0, degraded: 1, critical: 1, activeIncidents: 2, staleOrMissing: 1 });
  });

  it('keeps missing and offline resources in the actionable danger queue', () => {
    const dashboard = document.createElement('dashboard-page') as any;
    const missing = {
      resource: { type: 'server', id: 3 }, label: 'app-02', status: 'online', quality: 'unknown',
      freshness: 'missing', observedAt: null, unresolvedAlerts: 0, relationCount: 0, impactScope: [], gaps: ['OBSERVATIONS_EMPTY'],
    };
    const offline = {
      resource: { type: 'network_device', id: 4 }, label: 'switch-01', status: 'offline', quality: 'good',
      freshness: 'fresh', observedAt: new Date().toISOString(), unresolvedAlerts: 0, relationCount: 0, impactScope: [{ type: 'server', id: 3 }], gaps: [],
    };
    expect(dashboard._resourceStatusVariant(missing)).toBe('danger');
    expect(dashboard._resourceStatusVariant(offline)).toBe('danger');
  });

  it('formats reachability as a state rather than a percentage and combines data quality', () => {
    const dashboard = document.createElement('dashboard-page') as any;
    dashboard.resourceScope = 'network_device';
    dashboard.resourceMetrics = {
      dataQuality: 'partial',
      scopes: {
        instance: { metrics: {} },
        server: { metrics: {} },
        network_device: { metrics: { device_reachability: { value: 1, resourceCount: 2, observedAt: null } } },
      },
    };
    dashboard.resourceOverview = { dataQuality: 'complete', items: [] };
    expect(dashboard._resourceMetricRows()[0].value).not.toContain('%');
    expect(['Reachable', '可达']).toContain(dashboard._resourceMetricRows()[0].value);
    expect(dashboard._combinedDataQuality()).toBe('partial');
  });

  it('recreates database charts after leaving and returning to a database scope', async () => {
    const dashboard = document.createElement('dashboard-page') as any;
    dashboard.loadDashboardData = vi.fn();
    const pieDispose = vi.fn();
    const trendDispose = vi.fn();
    const pieInit = vi.fn(() => ({ chart: { dispose: pieDispose }, ro: { disconnect: vi.fn() } }));
    const trendInit = vi.fn(() => ({ chart: { dispose: trendDispose }, ro: { disconnect: vi.fn() } }));
    dashboard._initPieChart = pieInit;
    dashboard._initTrendChart = trendInit;
    dashboard.loading = false;
    dashboard.dbTypeDistribution = [{ name: 'mysql', value: 1 }];
    dashboard.capacityTrend = { current_total_gb: 1, trend: [{ time: 'now', total_size_gb: 1 }] };
    document.body.appendChild(dashboard);
    await dashboard.updateComplete;
    expect(pieInit).toHaveBeenCalledTimes(1);
    expect(trendInit).toHaveBeenCalledTimes(1);

    dashboard.resourceScope = 'server';
    await dashboard.updateComplete;
    expect(pieDispose).toHaveBeenCalled();
    expect(trendDispose).toHaveBeenCalled();

    dashboard.resourceScope = 'all';
    await dashboard.updateComplete;
    expect(pieInit).toHaveBeenCalledTimes(2);
    expect(trendInit).toHaveBeenCalledTimes(2);
    dashboard.remove();
  });

  it('clears stale alert and AI data when a refresh endpoint fails', async () => {
    const dashboard = document.createElement('dashboard-page') as any;
    dashboard.recentAlerts = [{ id: 1, title: 'Old alert', severity: 'critical', created_at: new Date().toISOString() }];
    dashboard.aiStats = { today_total: 7, breakdown: {} };
    authFetch.mockResolvedValue({ ok: false, json: async () => ({}) });

    await dashboard.loadDashboardData();

    expect(dashboard.recentAlerts).toEqual([]);
    expect(dashboard.aiStats).toBeNull();
  });
});
