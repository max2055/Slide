import { expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('./metrics/consumers/resource-api.js', () => ({ resourceMetricRead: read }));
import { databaseService } from './database-service.js';

it('database realtime compatibility returns formal evidence and never reconnects or invokes historical providers', async () => {
  const reconnect = vi.spyOn(databaseService as any, '_withAutoReconnect');
  const formal = { source_contract: 'metrics', metrics: [], recorded_at: null, semantic_metrics: { metrics: [] } };
  read.mockResolvedValueOnce(formal);
  expect(await databaseService.getRealtimeMetrics(7)).toBe(formal);
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ instanceScopes: { 7: 'read-only' } }), { type: 'instance', id: 7 });
  expect(reconnect).not.toHaveBeenCalled();
  read.mockRejectedValueOnce(new Error('FORMAL_STORE_UNAVAILABLE'));
  await expect(databaseService.getRealtimeMetrics(7)).rejects.toThrow('FORMAL_STORE_UNAVAILABLE');
  expect(reconnect).not.toHaveBeenCalled();
  reconnect.mockRestore();
});
