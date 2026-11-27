import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import * as metricRead from './metrics/consumers/resource-api.js';
import { serverDatabaseService, type ServerRow } from './server-database-service.js';
import { scoreIo, scoreNetwork, scoreReachability, ServerReportService, type ServerReportEntry } from './server-report-service.js';

afterEach(() => vi.restoreAllMocks());

describe('server report health dimensions', () => {
  it('treats missing network evidence as unknown and zero errors as healthy', () => {
    expect(scoreNetwork(null, null)).toBeNull();
    expect(scoreNetwork(0, 0)).toBe(100);
    expect(scoreNetwork(11, 0)).toBe(20);
  });

  it('weights reachability as an explicit degraded dimension', () => {
    expect(scoreReachability('online')).toBe(100);
    expect(scoreReachability('unreachable')).toBe(0);
    expect(scoreReachability('unknown')).toBeNull();
  });

  it('does not award an IO score without either load or IO evidence', () => {
    expect(scoreIo(null, null)).toBeNull();
    expect(scoreIo(0.5, null)).toBe(100);
    expect(scoreIo(null, 2000)).toBe(20);
  });

  it('keeps measured zero and valid scores visible while identifying unscored targets in both export formats', () => {
    const generated_at = '2026-10-29T12:00:00.000Z';
    const measured: ServerReportEntry = {
      host: 'scored.fixture.invalid', label: null, status: 'online', cpu_score: 100, memory_score: 60,
      disk_score: 0, load_score: 0, reachability_score: 100, network_score: null, io_score: null,
      health_status: 'healthy', metrics_fresh: true, metrics_recorded_at: generated_at, overall_score: 91,
      metrics_summary: { cpu_usage_pct: 0, memory_usage_pct: 75, disk_usage_pct: null, load_1min: null,
        network_errors: null, network_drops: null, disk_io_time_ms: null },
    };
    const unscored: ServerReportEntry = {
      ...measured, host: 'unscored.fixture.invalid', status: 'unreachable', cpu_score: 0, memory_score: 0,
      reachability_score: 0, health_status: 'unknown', metrics_fresh: false, metrics_recorded_at: null, overall_score: 0,
      metrics_summary: { ...measured.metrics_summary, cpu_usage_pct: null, memory_usage_pct: null },
    };
    const report = { generated_at, server_count: 2, healthy_count: 1, warning_count: 0, critical_count: 0,
      unknown_count: 1, servers: [measured, unscored] };
    const service = new ServerReportService();
    const html = service.generateHtml(report);
    expect(html).toMatch(/<div class="num">1<\/div>\s*<div class="label">未评分<\/div>/);
    expect(html).toContain('100<br><small>0%</small>');
    expect(html).toContain('60<br><small>75%</small>');
    const unscoredRow = html.split('<tr>').find(row => row.includes(unscored.host));
    expect(unscoredRow).toContain('最近连接检查失败，缺少有效采集样本');
    expect(unscoredRow?.match(/未评分/g)).toHaveLength(5);
    expect(unscoredRow).not.toContain('score-critical');
    const markdown = service.generateMarkdown(report);
    expect(markdown).toContain('| 未评分 | 1 |');
    expect(markdown).toContain('| **91** | 0% | 75% |');
    expect(markdown).toContain('最近连接检查失败，缺少有效采集样本');
    expect(markdown).toContain('| **未评分** | — | — |');
    expect(unscored.overall_score).toBe(0);
  });
});

it('reads only the allowed servers in an all-target report and refuses an explicit out-of-scope server', async () => {
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({} as NonNullable<ReturnType<typeof dbConnection.getPool>>);
  vi.spyOn(serverDatabaseService, 'getAllServers').mockResolvedValue([
    { id: 71, host: 'scope-one.fixture.invalid', status: 'online' } as ServerRow,
    { id: 72, host: 'scope-two.fixture.invalid', status: 'offline' } as ServerRow,
  ]);
  const getServer = vi.spyOn(serverDatabaseService, 'getServerById');
  const read = vi.spyOn(metricRead, 'resourceMetricRead').mockResolvedValue({ metrics: [] } as unknown as Awaited<ReturnType<typeof metricRead.resourceMetricRead>>);
  const scoped = {
    userId: 9, username: 'scoped-reader', roles: [], permissions: ['servers:view'], instanceScopes: {}, sessionVersion: 1,
    requestId: 'scoped-report', resourceBoundary: { serverIds: [72], instanceIds: [], networkDeviceIds: [] },
  };
  const service = new ServerReportService();
  const report = await service.generateReport(undefined, scoped);
  expect(report.server_count).toBe(1);
  expect(report.servers[0].host).toBe('scope-two.fixture.invalid');
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0][1]).toEqual({ type: 'server', id: 72 });
  await expect(service.generateReport([71], scoped)).rejects.toMatchObject({ code: 'POLICY_FORBIDDEN', status: 403 });
  expect(getServer).not.toHaveBeenCalled();
});
