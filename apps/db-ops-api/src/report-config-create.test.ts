import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerHttpSecurity } from './security/http-security.js';
import { dbConnection } from './db-connection.js';
import { reportConfigService, ReportConfigCreateOutcomeUnknownError } from './report-config-database-service.js';
import { InvalidReportCronError } from './report-cron.js';
import { getReportAccessScope } from './report-access.js';
import { assertReportTarget } from './report-target.js';

const value = { name: 'MAX-615', cron: '@daily', type: 'health', instance_id: 701 };
afterEach(() => vi.restoreAllMocks());

describe('MAX-615 / #361 confirmed creation receipt', () => {
  it.each(['healthy', 'throws', 'empty'] as const)('does not depend on %s readback', async readback => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT')) return [{ insertId: 42, affectedRows: 1 }];
      if (readback === 'throws') throw Error('read unavailable');
      return [readback === 'empty' ? [] : [{ id: 42 }]];
    });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const read = vi.spyOn(reportConfigService, 'getConfigById');
    await expect(reportConfigService.createConfig(value)).resolves.toEqual({ id: 42 });
    expect(execute).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not replay a rejected write whose commit outcome is unknown', async () => {
    const execute = vi.fn().mockRejectedValue(Error('connection lost after send'));
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await expect(reportConfigService.createConfig(value)).rejects.toBeInstanceOf(ReportConfigCreateOutcomeUnknownError);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([{ insertId: 0, affectedRows: 1 }, { insertId: 9, affectedRows: 0 }, { insertId: Number.MAX_SAFE_INTEGER + 1, affectedRows: 1 }])('does not claim success for invalid receipt %j', async receipt => {
    const execute = vi.fn().mockResolvedValue([receipt]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await expect(reportConfigService.createConfig(value)).rejects.toBeInstanceOf(ReportConfigCreateOutcomeUnknownError);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('production HTTP route returns the confirmed ID or an explicit no-replay result', async () => {
    const app = Fastify();
    await registerHttpSecurity(app, { NODE_ENV: 'test' });
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const start = source.indexOf("  fastify.post('/api/reports/configs'");
    const end = source.indexOf('  // 更新报表配置', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('fastify', 'verifyToken', 'requirePermission', 'hasInstanceAccess', 'reportConfigService', 'notificationDatabaseService', 'InvalidReportCronError', 'ReportConfigCreateOutcomeUnknownError', 'assertReportTarget', 'canReadResource', code)(
      app, async () => {}, () => async () => {}, () => true, reportConfigService, {}, InvalidReportCronError, ReportConfigCreateOutcomeUnknownError, assertReportTarget, () => true,
    );
    const execute = vi.fn().mockResolvedValueOnce([{ insertId: 42, affectedRows: 1 }]).mockRejectedValueOnce(Error('unknown write'));
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    try {
      const created = await app.inject({ method: 'POST', url: '/api/reports/configs', payload: value });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toEqual({ id: 42, message: '创建成功' });
      const uncertain = await app.inject({ method: 'POST', url: '/api/reports/configs', payload: value });
      expect(uncertain.statusCode).toBe(409);
      expect(uncertain.json()).toEqual({ code: 'REPORT_CONFIG_CREATE_OUTCOME_UNKNOWN', retryable: false, error: '创建结果未确认，请刷新配置列表核对，勿重复提交' });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });
});

// MAX-615 R1: no pool, rejected SELECT and healthy empty results are different states.
describe('MAX-615 R1 reconciliation list', () => {
  it('rejects an unavailable pool instead of returning an empty list', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
    await expect(reportConfigService.getConfigs()).rejects.toThrow('REPORT_CONFIG_LIST_UNAVAILABLE');
  });
  it('rejects failed SELECT but preserves a healthy empty list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const execute = vi.fn().mockRejectedValueOnce(Error('SELECT unavailable')).mockResolvedValueOnce([[]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await expect(reportConfigService.getConfigs()).rejects.toThrow('REPORT_CONFIG_LIST_UNAVAILABLE');
    await expect(reportConfigService.getConfigs()).resolves.toEqual([]);
  });
  it('production GET and security hook expose an exact public error without SQL details', async () => {
    const app = Fastify();
    await registerHttpSecurity(app, { NODE_ENV: 'test' });
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const start = source.indexOf("  fastify.get('/api/reports/configs'");
    const end = source.indexOf('  // 创建报表配置', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('fastify', 'verifyToken', 'requirePermission', 'reportConfigService', 'getReportAccessScope', 'CronJob', code)(
      app, async (req: any) => { req.user = { permissions: ['*'] }; }, () => async () => {}, reportConfigService, getReportAccessScope, undefined,
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const execute = vi.fn().mockRejectedValueOnce(Error('SELECT private schema')).mockResolvedValueOnce([[]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    try {
      const failed = await app.inject({ method: 'GET', url: '/api/reports/configs' });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual({ error: 'REPORT_CONFIG_LIST_UNAVAILABLE' });
      const recovered = await app.inject({ method: 'GET', url: '/api/reports/configs' });
      expect(recovered.statusCode).toBe(200); expect(recovered.json()).toEqual([]);
    } finally { await app.close(); }
  });
});
