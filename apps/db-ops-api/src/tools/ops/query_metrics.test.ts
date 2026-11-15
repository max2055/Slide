import { describe, expect, it, vi } from 'vitest';
import { createQueryMetricsTool } from './query_metrics.js';
import { admin } from '../../metrics/policy/test-support.js';
import { ActorAuthenticationError } from '../../auth/actor-context.js';
import { PolicyError } from '../../metrics/policy/model.js';
const service = () => ({ query: vi.fn(), discover: vi.fn(), inventory: vi.fn() });
describe('query_metrics authenticated semantic boundary', () => {
  it('requires an authenticated actor before any read', async () => {
    const s = service(); const result = await createQueryMetricsTool(s as any).handler({ instance_id: 1 });
    expect(result).toMatchObject({ success: false, errorCode: 'AUTH_REQUIRED' }); expect(s.query).not.toHaveBeenCalled();
  });
  it('returns resource-not-found and store failures without a healthy/empty success', async () => {
    const s = service(), tool = createQueryMetricsTool(s as any);
    s.query.mockRejectedValueOnce(new PolicyError('POLICY_RESOURCE_NOT_FOUND', 404)).mockRejectedValueOnce(new Error('secret SQL details'));
    expect(await tool.handler({ instance_id: 999 }, { actor: admin })).toMatchObject({ success: false, errorCode: 'POLICY_RESOURCE_NOT_FOUND' });
    const result = await tool.handler({ instance_id: 1 }, { actor: admin });
    expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('missing, stale and estimated metrics produce warning with recovery guidance', async () => {
    const s = service(); s.query.mockResolvedValue({ metrics: [{ state: 'available', series: [] }] });
    const result = await createQueryMetricsTool(s as any).handler({ instance_id: 1 }, { actor: admin });
    expect(result).toMatchObject({ success: true, status: 'warning' }); expect(result.next_actions?.length).toBeGreaterThan(0);
  });
  it('rejects malformed arguments, ambiguous resources and unmappable CPU without reading values', async () => {
    const s = service(); s.inventory.mockResolvedValue(null); const tool = createQueryMetricsTool(s as any);
    for (const input of [{ instance_id: -1 }, { instance_id: 1, mode: 'bad' }, { instance_id: 1, interval: 'bad' }, { instance_id: 1, metric_ids: ['x; DROP TABLE'] }, { instance_id: 1, resourceType: 'server', resourceId: 2 }, { instance_id: 1, metric_ids: ['cpu_usage'] }]) {
      expect((await tool.handler(input, { actor: admin })).success).toBe(false);
    }
    expect(s.query).not.toHaveBeenCalled();
  });
  it('passes explicit Extension discovery and attribute reads through authorized service', async () => {
    const s = service(); s.discover.mockResolvedValue({ definitions: [] }); s.inventory.mockResolvedValue({ attributes: {} });
    const tool = createQueryMetricsTool(s as any);
    await tool.handler({ resourceType: 'server', resourceId: 3, mode: 'discover' }, { actor: admin });
    expect(s.discover).toHaveBeenCalledWith(admin, { type: 'server', id: 3 });
    await tool.handler({ instance_id: 1, mode: 'inventory' }, { actor: admin });
    expect(s.inventory).toHaveBeenCalledWith(admin, { type: 'instance', id: 1 });
  });
  it('uses retained history for the authenticated history tool mode', async () => {
    const s = service(); s.query.mockResolvedValue({ metrics: [] });
    await createQueryMetricsTool(s as any).handler({ instance_id: 1, mode: 'history', period: '24h' }, { actor: admin });
    expect(s.query).toHaveBeenCalledWith(admin, expect.objectContaining({ history: true, resource: { type: 'instance', id: 1 } }));
  });

  it('OCR-0187 reports inherited legacy IDs as UNKNOWN_METRIC before querying values', async () => {
    const s = service(); s.inventory.mockResolvedValue({ attributes: {} });
    const result = await createQueryMetricsTool(s as any).handler({
      resourceType: 'server', resourceId: 3, metric_ids: ['constructor'],
    }, { actor: admin });
    expect(result).toMatchObject({ success: false, errorCode: 'UNKNOWN_METRIC',
      data: { migrations: [{ status: 'review_required', metric_id: null }] } });
    expect(s.query).not.toHaveBeenCalled();
  });
  it('OCR-0187 forwards a valid legacy mapping as a string', async () => {
    const s = service(); s.inventory.mockResolvedValue({ attributes: {} });
    s.query.mockResolvedValue({ metrics: [] });
    const result = await createQueryMetricsTool(s as any).handler({
      resourceType: 'server', resourceId: 3, metric_ids: ['cpu_usage'],
    }, { actor: admin });
    expect(result.success).toBe(true);
    expect(s.query).toHaveBeenCalledWith(admin, expect.objectContaining({
      metric_ids: ['linux.cpu.user_system_percent'],
    }));
  });
});

// GitHub #620: client mistakes must not be reported as storage failures.
describe('query_metrics error codes', () => {
  it.each([
    [{ instance_id: 1, resourceType: 'server', resourceId: 2 }, 'RESOURCE_AMBIGUOUS'],
    [{ instance_id: 1, resourceId: 2 }, 'RESOURCE_AMBIGUOUS'],
    [{}, 'RESOURCE_INVALID'], [{ resourceType: 'server' }, 'RESOURCE_INVALID'],
    [{ resourceId: 2 }, 'RESOURCE_INVALID'],
    [{ instance_id: -1 }, 'INVALID_ARGUMENTS'],
    [{ instance_id: 1, series_index: 0 }, 'INVALID_ARGUMENTS'],
  ])('classifies %j as %s without accessing services', async (input, code) => {
    const s = service();
    expect(await createQueryMetricsTool(s as any).handler(input, { actor: admin })).toMatchObject({ success: false, status: 'error', errorCode: code });
    for (const method of Object.values(s)) expect(method).not.toHaveBeenCalled();
  });
  it('preserves valid series selection and rejects out-of-range selection', async () => {
    const s = service(); s.query.mockResolvedValue({ metrics: [{ state: 'available', series: [
      { dimensions: { mount: '/' }, buckets: [] }, { dimensions: { mount: '/data' }, buckets: [] },
    ] }] });
    const tool = createQueryMetricsTool(s as any);
    const input = { instance_id: 1, metric_ids: ['host.filesystem.used_bytes'] };
    expect(await tool.handler({ ...input, series_index: 1 }, { actor: admin })).toMatchObject({ success: true,
      data: { selection: { series_index: 1, total_series: 2 }, metrics: [{ series: [{ dimensions: { mount: '/data' } }] }] } });
    expect(await tool.handler({ ...input, series_index: 2 }, { actor: admin })).toMatchObject({ success: false, errorCode: 'SERIES_INDEX_UNAVAILABLE' });
  });
  it('rejects selecting a series when the metric itself is absent', async () => {
    const s = service(); s.query.mockResolvedValue({ metrics: [] });
    expect(await createQueryMetricsTool(s as any).handler({ instance_id: 1, metric_ids: ['db.uptime_seconds'], series_index: 0 }, { actor: admin }))
      .toMatchObject({ success: false, errorCode: 'SERIES_INDEX_UNAVAILABLE' });
  });
  it('retains index zero as a warning when a failed collection has no series', async () => {
    const s = service(); s.query.mockResolvedValue({ metrics: [{ state: 'temporary_failure', series: [] }] });
    expect(await createQueryMetricsTool(s as any).handler({ instance_id: 1, metric_ids: ['host.network.bytes_total'], series_index: 0 }, { actor: admin }))
      .toMatchObject({ success: true, status: 'warning', data: { selection: { series_index: 0, total_series: 0 } } });
  });
  it.each([
    [new ActorAuthenticationError(), 'AUTH_REQUIRED'],
    [new PolicyError('POLICY_FORBIDDEN', 403), 'POLICY_FORBIDDEN'],
    [new PolicyError('POLICY_RESOURCE_NOT_FOUND', 404), 'POLICY_RESOURCE_NOT_FOUND'],
    [new Error('RESOURCE_INVALID'), 'QUERY_METRICS_FAILED'],
    [new Error('secret SQL details'), 'QUERY_METRICS_FAILED'],
  ])('preserves typed errors and sanitizes unexpected failures', async (error, code) => {
    const s = service(); s.query.mockRejectedValue(error);
    const result = await createQueryMetricsTool(s as any).handler({ instance_id: 1 }, { actor: admin });
    expect(result).toMatchObject({ success: false, errorCode: code });
    expect(JSON.stringify(result)).not.toContain('secret SQL details');
  });
});
