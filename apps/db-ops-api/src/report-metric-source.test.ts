import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  query: vi.fn(),
  createReport: vi.fn(),
  updateReportStatus: vi.fn(),
  getReportById: vi.fn(),
  getInstanceById: vi.fn(),
  getRealtimeMetrics: vi.fn(),
  getSlowQueries: vi.fn(),
}));

vi.mock('./metrics-v2/consumers/runtime.js', () => ({
  operationalSource: mocks.source,
  metricConsumerService: { query: mocks.query },
}));
vi.mock('./report-database-service', () => ({
  reportDatabaseService: {
    createReport: mocks.createReport,
    updateReportStatus: mocks.updateReportStatus,
    getReportById: mocks.getReportById,
  },
}));
vi.mock('./metrics-database-service', () => ({
  metricsDatabaseService: {
    getRealtimeMetrics: mocks.getRealtimeMetrics,
    getSlowQueries: mocks.getSlowQueries,
  },
}));
vi.mock('./database-service', () => ({ databaseService: {} }));
vi.mock('./instance-database-service', () => ({
  instanceDatabaseService: { getInstanceById: mocks.getInstanceById },
}));

const source = readFileSync(resolve(import.meta.dirname, 'report-service.ts'), 'utf8');

describe('report formal metric source contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInstanceById.mockResolvedValue({ id: 7, name: 'db-7' });
    mocks.createReport.mockResolvedValue({ id: 91 });
    mocks.getReportById.mockResolvedValue({ id: 91, status: 'completed' });
  });

  it('routes metric-backed reports by formal source before legacy collection', () => {
    expect(source).toContain('operationalSource');
    expect(source).toContain("source === 'pending'");
    expect(source).toContain('METRIC_SOURCE_PENDING');
    expect(source).toContain("source === 'v2'");
    expect(source).toContain('generateSemanticMetricReport');
  });

  it('persists the complete semantic response and renders quality without legacy name mapping', () => {
    expect(source).toContain('metricConsumerService.query');
    expect(source).toContain("view: 'all'");
    expect(source).toContain('semantic_metrics: semantic');
    expect(source).toContain('bucket.quality.status');
    expect(source).toContain('bucket.unit');
    expect(source).not.toContain('semantic.cpu_usage');
  });

  it('rejects a pending source before creating or collecting a report', async () => {
    mocks.source.mockResolvedValue('pending');
    const { reportService } = await import('./report-service.js');

    await expect(reportService.generateReport('health', 7)).rejects.toThrow('METRIC_SOURCE_PENDING');
    expect(mocks.createReport).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.getRealtimeMetrics).not.toHaveBeenCalled();
  });

  it('persists and renders the unmodified V2 semantic response without legacy reads', async () => {
    const semantic = {
      contract_version: '1.0.0',
      resource: { type: 'instance', id: 7 },
      window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:01:00.000Z' },
      evaluated_at: '2026-01-01T00:01:00.000Z',
      profile: { id: 'instance-core', version: '1.0.0', owner: 'product', resource_type: 'instance', columns: [] },
      configuration_revision: 4,
      metrics: [{
        definition: { id: 'db.latency', unit: 'ms' },
        enabled: true,
        state: 'available',
        series: [{
          dimensions: { operation: 'read' },
          buckets: [{
            unit: 'ms', value: { encoding: 'number', value: 12 },
            quality: { status: 'partial', reason: 'missing_input' }, freshness: 'stale', coverage: 0.5,
            sources: [{ id: 'obs-1', source: { collector_id: 'mysql' }, versions: { config_revision: 4 } }],
          }],
        }],
      }],
    };
    mocks.source.mockResolvedValue('v2');
    mocks.query.mockResolvedValue(semantic);
    const { reportService } = await import('./report-service.js');

    await reportService.generateReport('performance', 7);

    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ instanceScopes: { 7: 'read-only' } }), {
      resource: { type: 'instance', id: 7 }, view: 'all',
    });
    expect(mocks.getRealtimeMetrics).not.toHaveBeenCalled();
    expect(mocks.getSlowQueries).not.toHaveBeenCalled();
    const [, status, html, data] = mocks.updateReportStatus.mock.calls[0];
    expect(status).toBe('completed');
    expect(data.semantic_metrics).toBe(semantic);
    expect(html).toContain('db.latency');
    expect(html).toContain('partial');
    expect(html).toContain('stale');
    expect(html).toContain('ms');
  });
});
