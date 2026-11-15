import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  discover: vi.fn(), samples: vi.fn(), query: vi.fn(), create: vi.fn(), pool: vi.fn(),
}));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: deps.pool } }));
vi.mock('./metrics/consumers/runtime.js', () => ({ internalMetricConsumerService: { discover: deps.discover, query: deps.query } }));
vi.mock('./metrics/rollout/formal-store.js', () => ({
  MysqlFormalMetricStore: class { baselineSamples = deps.samples; },
}));
vi.mock('./ai-analysis-database-service.js', () => ({
  aiAnalysisDatabaseService: { createAnalysis: deps.create },
}));
import { capacityPredictor, PredictionHorizonError, type PredictionHorizon } from './capacity-predictor.js';

beforeEach(() => {
  vi.clearAllMocks();
  deps.pool.mockReturnValue({});
  deps.discover.mockResolvedValue({
    effective: { published_revision: 1, resolved: {
      plan: { binding: { package: { id: 'mysql-test' } } },
      settings: { enabled: true },
      metric_templates: [{ metric: { id: 'mysql.processlist.count' }, enabled: true }],
    } },
    definitions: [{ id: 'mysql.processlist.count', kind: 'gauge', dimensions: { keys: [] } }],
  });
  deps.samples.mockResolvedValue([1, 2].map((value, index) => ({
    observed_at: new Date(Date.now() - (2 - index) * 86400000).toISOString(),
    quality: { status: 'good' }, value: { value, encoding: 'float64' },
  })));
  deps.query.mockResolvedValue({ metrics: [] });
  deps.create.mockResolvedValue({ success: false });
});

describe('MAX-511 / #501 service horizon boundary', () => {
  it.each(['1y', '', '7D', ' 7d', 'toString', '__proto__', 7, null, undefined, [], {}])(
    'rejects invalid horizon %j before discovery, sample reads or caching', async value => {
      const horizon = value as PredictionHorizon;
      await expect(capacityPredictor.predict(1, 'connections', horizon)).rejects.toMatchObject({ statusCode: 400 });
      await expect(capacityPredictor.predictAll(1, horizon)).rejects.toBeInstanceOf(PredictionHorizonError);
      expect(deps.discover).not.toHaveBeenCalled();
      expect(deps.samples).not.toHaveBeenCalled();
      expect(deps.pool).not.toHaveBeenCalled();
      expect(deps.create).not.toHaveBeenCalled();
    },
  );
  it.each([['7d', 7, 14], ['30d', 30, 31], ['90d', 90, 31]] as const)(
    '%s uses the same duration for output and sample threshold', async (horizon, days, lookback) => {
      const result = await capacityPredictor.predict(1, 'connections', horizon);
      expect(result.horizon).toBe(horizon);
      expect(result.predictions).toHaveLength(days);
      expect(result.warning).toContain(`2/${days}`);
      expect(result.effective_lookback_days).toBe(lookback);
    },
  );
  it('keeps per-metric failure isolation for a valid batch', async () => {
    deps.discover.mockRejectedValue(new Error('fixture unavailable'));
    const results = await capacityPredictor.predictAll(1, '7d');
    expect(results).toHaveLength(5);
    expect(results.every(r => r.horizon === '7d' && r.warning?.startsWith('预测失败:'))).toBe(true);
  });
});
