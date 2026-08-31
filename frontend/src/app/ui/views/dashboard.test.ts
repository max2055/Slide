import { describe, expect, it } from 'vitest';
import './dashboard.js';

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
});
