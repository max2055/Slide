import { afterEach, expect, it, vi } from 'vitest';
import { databaseService } from './database-service';
import { scoringConfigService } from './scoring-config-service';
afterEach(() => vi.restoreAllMocks());
it.each([[1, 0, 0, 0, 100, 'healthy'], [.35, .35, .2, .1, 73, 'warning']])('derives overall status from the configured weighted score %j', async (a, p, c, s, score, status) => {
  vi.spyOn(databaseService as any, '_withAutoReconnect').mockImplementation(async (_id: any, fn: any) => fn({ id: 21, db_type: 'oracle', oraclePool: {} }));
  vi.spyOn(databaseService as any, 'checkOracleHealth').mockResolvedValue({ health_score: 40, status: 'critical', checks: [
    { name: '连接状态', status: 'healthy', score: 100 },
    { name: '库缓存命中率', status: 'critical', score: 40 },
    { name: '表空间使用率', status: 'critical', score: 70 },
    { name: '死锁检测', status: 'healthy', score: 100 },
  ] });
  vi.spyOn(scoringConfigService, 'getWeights').mockResolvedValue({ availability: a, performance: p, capacity: c, security: s } as any);
  const result = await databaseService.checkHealth(21);
  expect(result).toMatchObject({ health_score: score, status });
  expect(result?.checks.some(c => c.status === 'critical')).toBe(true);
});

it.each([
  [{ name: 'Oracle 检查', status: 'critical', score: 0 }],
  [{ name: '连接状态', status: 'critical', score: 0 }],
])('keeps failed or unavailable health checks at zero regardless of weights: %j', async (check) => {
  vi.spyOn(databaseService as any, '_withAutoReconnect').mockImplementation(async (_id: any, fn: any) => fn({ id: 21, db_type: 'oracle', oraclePool: {} }));
  vi.spyOn(databaseService as any, 'checkOracleHealth').mockResolvedValue({ health_score: 0, status: 'critical', checks: [check] });
  vi.spyOn(scoringConfigService, 'getWeights').mockResolvedValue({ availability: 0, performance: 1, capacity: 0, security: 0 });
  await expect(databaseService.checkHealth(21)).resolves.toMatchObject({ health_score: 0, status: check.name === '连接状态' ? 'critical' : 'unknown' });
});

it('marks an incomplete weighted health assessment unknown instead of displaying a healthy score', async () => {
  vi.spyOn(databaseService as any, '_withAutoReconnect').mockImplementation(async (_id: any, fn: any) => fn({ id: 21, db_type: 'oracle', oraclePool: {} }));
  vi.spyOn(databaseService as any, 'checkOracleHealth').mockResolvedValue({ health_score: 100, status: 'healthy', checks: [
    { name: '连接状态', status: 'ok', score: 100 },
    { name: '表空间使用率', status: 'unknown', score: 100, message: '权限不足' },
  ] });
  vi.spyOn(scoringConfigService, 'getWeights').mockResolvedValue({ availability: .35, performance: .35, capacity: .2, security: .1 });
  await expect(databaseService.checkHealth(21)).resolves.toMatchObject({ status: 'unknown', checks: expect.arrayContaining([expect.objectContaining({ name: '表空间使用率', status: 'unknown', score: 0 })]) });
});

it('preserves confirmed connectivity when the remainder of a health assessment fails', async () => {
  vi.spyOn(databaseService as any, '_withAutoReconnect').mockImplementation(async (_id: any, fn: any) => fn({ id: 21, db_type: 'oracle', oraclePool: {} }));
  vi.spyOn(databaseService as any, 'checkOracleHealth').mockResolvedValue({ health_score: 0, status: 'unknown', checks: [
    { name: '连接状态', status: 'ok', score: 100 },
    { name: 'Oracle 检查', status: 'unknown', score: 0 },
  ] });
  vi.spyOn(scoringConfigService, 'getWeights').mockResolvedValue({ availability: .35, performance: .35, capacity: .2, security: .1 });
  await expect(databaseService.checkHealth(21)).resolves.toMatchObject({ status: 'unknown' });
});
