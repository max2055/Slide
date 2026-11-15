import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual route registrations without starting unrelated background services.
vi.mock('./db-connection.js', () => ({ dbConnection: {} }));
vi.mock('./metrics/consumers/runtime.js', () => ({ internalMetricConsumerService: {} }));
vi.mock('./ai-analysis-database-service.js', () => ({ aiAnalysisDatabaseService: {} }));
import { assertPredictionHorizon, PredictionHorizonError } from './capacity-predictor.js';

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const routes = source.slice(source.indexOf("  fastify.post('/api/ai/analysis',"), source.indexOf('  // 轮询分析状态'))
  + source.slice(source.indexOf('  // 容量预测（单指标）'), source.indexOf('  // ========== 日志分析 API'));

describe('MAX-511 / #501 production HTTP registrations', () => {
  it('rejects invalid input on all three routes, preserves defaults, valid periods and access checks', async () => {
    const app = Fastify();
    const predictor = { predict: vi.fn(async (_id, _metric, horizon) => ({ horizon })),
      predictAll: vi.fn(async (_id, horizon) => [{ horizon }]) };
    let allowed = true;
    const deps = { fastify: app, capacityPredictor: predictor, assertPredictionHorizon, PredictionHorizonError,
      verifyToken: async () => {}, requirePermission: () => async () => {},
      hasInstanceAccess: () => allowed };
    new Function(...Object.keys(deps), transpileModule(routes, {}).outputText)(...Object.values(deps));
    try {
      for (const route of ['single', 'all', 'post']) {
        const request = (horizon?: unknown, camel = false) => {
          if (route === 'post') return app.inject({ method: 'POST', url: '/api/ai/analysis',
            payload: { analysis_type: 'capacity_prediction', instance_id: 1, metric: 'connections',
              ...(horizon === undefined ? {} : { horizon }) } });
          const query = new URLSearchParams({ [camel ? 'instanceId' : 'instance_id']: '1', metric: 'connections' });
          if (horizon !== undefined) query.set('horizon', String(horizon));
          return app.inject({ method: 'GET', url: '/api/ai/capacity/predict' + (route === 'all' ? '/all' : '') + '?' + query });
        };
        for (const value of ['1y', '', '7D', 'toString', '__proto__', 90]) {
          const before = predictor.predict.mock.calls.length + predictor.predictAll.mock.calls.length;
          expect((await request(value)).statusCode).toBe(400);
          expect(predictor.predict.mock.calls.length + predictor.predictAll.mock.calls.length).toBe(before);
        }
        if (route === 'post') for (const value of [null, false, [], {}]) expect((await request(value)).statusCode).toBe(400);
        for (const horizon of [undefined, '7d', '30d', '90d']) {
          const response = await request(horizon, true);
          expect(response.statusCode).toBe(200);
          const body = response.json();
          expect((route === 'post' ? body.result : route === 'all' ? body[0] : body).horizon).toBe(horizon ?? '30d');
        }
        allowed = false;
        expect((await request('7d')).statusCode).toBe(403);
        allowed = true;
      }
    } finally { await app.close(); }
  });
});
