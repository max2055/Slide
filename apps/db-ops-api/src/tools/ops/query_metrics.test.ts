import { describe, expect, it, vi } from 'vitest';
import { createQueryMetricsTool } from './query_metrics.js';
import { admin } from '../../metrics-v2/policy/test-support.js';
import { PolicyError } from '../../metrics-v2/policy/model.js';
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
});
