/** #369: actual server.ts route with real Fastify JSON parsing and service validation. */
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoringConfigService, DEFAULT_WEIGHTS } from './scoring-config-service.js';
import { dbConnection } from './db-connection.js';
import { requirePermission } from './auth/require-permission.js';

vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: vi.fn() } }));
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.restoreAllMocks();
});
function setup() {
  const app = Fastify(); apps.push(app);
  const execute = vi.fn().mockResolvedValue([{}]);
  vi.mocked(dbConnection.getPool).mockReturnValue({ execute } as any);
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("  fastify.put('/api/scoring/config'");
  const route = source.slice(start, source.indexOf('  // 获取品牌配置', start));
  const compiled = ts.transpileModule(route, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('fastify', 'verifyToken', 'requirePermission', 'scoringConfigService', compiled)(
    app, async (request: any) => { request.user = { permissions: ['metric:manage'] }; }, requirePermission, scoringConfigService,
  );
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/scoring/config',
    headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  return { execute, put };
}

describe('#369 scoring configuration HTTP input', () => {
  it.each([null, false, true, 1, 'text', [], [DEFAULT_WEIGHTS], {}, { availability: .35 },
    { ...DEFAULT_WEIGHTS, security: null }, { ...DEFAULT_WEIGHTS, security: '0.1' },
    { ...DEFAULT_WEIGHTS, security: -1 }, { ...DEFAULT_WEIGHTS, security: 2 },
    { ...DEFAULT_WEIGHTS, availability: .1 }])('rejects invalid input %j before any write', async input => {
    const { put, execute } = setup();
    const response = await put(input);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual(expect.any(String));
    expect(response.body).not.toMatch(/TypeError|Cannot read|stack/);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([DEFAULT_WEIGHTS, { availability: 1, performance: 0, capacity: 0, security: 0 },
    { ...DEFAULT_WEIGHTS, availability: .345 }, { ...DEFAULT_WEIGHTS, availability: .355 }])('preserves valid weights and tolerance %j', async weights => {
    const { put, execute } = setup();
    expect((await put(weights)).statusCode).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][1]).toEqual(['scoring.weights', JSON.stringify(weights)]);
  });
  it('conceals storage errors and returns a server error', async () => {
    const { put, execute } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    execute.mockRejectedValueOnce(new Error('SQL INTERNAL SENTINEL'));
    const response = await put(DEFAULT_WEIGHTS);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: '保存评分权重失败' });
  });
  it('conceals unexpected service errors', async () => {
    const { put } = setup();
    vi.spyOn(scoringConfigService, 'saveWeights').mockRejectedValueOnce(new Error('INTERNAL SENTINEL'));
    const response = await put(DEFAULT_WEIGHTS);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: '保存评分权重失败' });
  });
  it('reports unavailable storage as a server error', async () => {
    const { put } = setup();
    vi.mocked(dbConnection.getPool).mockReturnValue(null);
    expect((await put(DEFAULT_WEIGHTS)).statusCode).toBe(500);
  });
});
