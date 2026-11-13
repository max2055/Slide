import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { CronJobDatabaseService, cronJobService } from './cron-job-service.js';
import { ScriptService, scriptService } from './script-service.js';
import { registerCronRoutes } from './cron-routes.js';
import { actorContextService } from '../auth/actor-context.js';
import { CronManager } from './cron-manager.js';

afterEach(() => vi.restoreAllMocks());
const actor = { userId: 7, permissions: ['*'], roles: ['admin'], instanceScopes: {} };

describe('MAX-414/415/418/420 storage failures', () => {
  const reads = [
    () => new CronJobDatabaseService().getJobs(),
    () => new CronJobDatabaseService().getEnabledJobs(),
    () => new CronJobDatabaseService().getJobById(1),
    () => new CronJobDatabaseService().getLogs(1),
    () => new ScriptService().getAllScripts(),
    () => new ScriptService().getScriptById(1),
    () => new ScriptService().deleteScript(1, actor as any),
  ];
  it.each(reads.map((read, i) => [i, read] as const))('propagates missing pool and driver failures: %s', async (_, read) => {
    const pool = vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(read()).rejects.toThrow('CRON_STORAGE_UNAVAILABLE');
    pool.mockReturnValue({ execute: vi.fn().mockRejectedValue(new Error('password=secret SELECT private')) } as any);
    await expect(read()).rejects.toThrow('CRON_STORAGE_UNAVAILABLE');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });

  it('preserves genuine empty queries', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockResolvedValue([[]]) } as any);
    await expect(cronJobService.getJobs()).resolves.toEqual([]);
    await expect(cronJobService.getEnabledJobs()).resolves.toEqual([]);
    await expect(cronJobService.getJobById(1)).resolves.toBeNull();
    await expect(cronJobService.getLogs(1)).resolves.toEqual({ logs: [], total: 0 });
    await expect(scriptService.getAllScripts()).resolves.toEqual([]);
    await expect(scriptService.getScriptById(1)).resolves.toBeNull();
  });

  it.each([0, 1])('reports actual DELETE affectedRows=%s', async affectedRows => {
    const execute = vi.fn().mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ affectedRows }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await expect(scriptService.deleteScript(1, actor as any)).resolves.toBe(affectedRows > 0);
    expect(execute.mock.calls[1][0]).toContain('DELETE FROM cron_scripts');
  });

  it('propagates DELETE failure after successful reference authorization', async () => {
    const execute = vi.fn().mockResolvedValueOnce([[]]).mockRejectedValueOnce(new Error('private SQL'));
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(scriptService.deleteScript(1, actor as any)).rejects.toThrow('CRON_STORAGE_UNAVAILABLE');
  });

  it('denies inaccessible references before DELETE', async () => {
    const execute = vi.fn().mockResolvedValue([[{ target_instance_id: 42 }]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await expect(scriptService.deleteScript(1, { userId: 8, permissions: [], instanceScopes: {} } as any))
      .rejects.toThrow('CRON_SCRIPT_ACCESS_DENIED');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  async function app() {
    const server = Fastify();
    registerCronRoutes(server, async request => { (request as any).user = actor; }, () => undefined);
    return server;
  }
  it.each(['/jobs', '/jobs/1', '/scripts', '/scripts/1', '/jobs/1/logs'])('returns sanitized 503 for %s', async url => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = await app();
    try {
      const response = await server.inject({ url: '/api/cron' + url });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'CRON_STORAGE_UNAVAILABLE' });
    } finally { await server.close(); }
  });

  it.each(['1.5', 'Infinity', '9007199254740992', '-1', 'abc', ''])('rejects invalid pagination %s before querying logs', async value => {
    vi.spyOn(cronJobService, 'getJobById').mockResolvedValue({ id: 1, target_instance_id: null } as any);
    const logs = vi.spyOn(cronJobService, 'getLogs');
    const server = await app();
    try {
      for (const key of ['limit', 'offset']) {
        const response = await server.inject({ url: '/api/cron/jobs/1/logs?' + key + '=' + value });
        expect(response.statusCode).toBe(400);
      }
      expect(logs).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each([false, true])('HTTP deletion success reflects storage result %s', async deleted => {
    vi.spyOn(scriptService, 'getScriptById').mockResolvedValue({ id: 1 } as any);
    vi.spyOn(scriptService, 'deleteScript').mockResolvedValue(deleted);
    const server = await app();
    try {
      const response = await server.inject({ method: 'DELETE', url: '/api/cron/scripts/1' });
      expect(response.statusCode).toBe(deleted ? 200 : 404);
    } finally { await server.close(); }
  });

  it('returns storage failure during script binding rather than script-not-found (#511)', async () => {
    vi.spyOn(actorContextService, 'loadActiveActor').mockResolvedValue(actor as any);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockResolvedValue([[]]) } as any);
    vi.spyOn(scriptService, 'getScriptById').mockRejectedValue(new Error('CRON_STORAGE_UNAVAILABLE'));
    const server = await app();
    try {
      const response = await server.inject({ method: 'POST', url: '/api/cron/jobs', payload: {
        name: 'test', task_description: 'test', cron_expr: '0 0 * * *', task_type: 'script', script_id: 1,
      } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'CRON_STORAGE_UNAVAILABLE' });
    } finally { await server.close(); }
  });

  it('rejects unsafe pagination at service boundary without issuing SQL', async () => {
    const execute = vi.fn();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    for (const [limit, offset] of [[1.5, 0], [20, Infinity], [101, 0], [20, 2147483648]]) {
      await expect(cronJobService.getLogs(1, limit, offset)).rejects.toThrow('CRON_INVALID_PAGINATION');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails scheduler reload visibly and stops scheduling on failed read', async () => {
    const manager = new CronManager({ getEnabledJobs: vi.fn().mockRejectedValue(new Error('CRON_STORAGE_UNAVAILABLE')) } as any, {} as any);
    (manager as any).running = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.reload()).rejects.toThrow('CRON_STORAGE_UNAVAILABLE');
    expect((manager as any).running).toBe(true);
  });
  it('recovers through normal reload after a failed read without replaying executions (Chief R1)', async () => {
    const job = { id: 1, target_instance_id: null, resource_scope: { instanceIds: [] } };
    const read = vi.fn().mockRejectedValueOnce(new Error('CRON_STORAGE_UNAVAILABLE')).mockResolvedValue([job]);
    const owned = vi.fn().mockResolvedValue(undefined);
    const manager = new CronManager({ getEnabledJobs: read } as any, {} as any, undefined, undefined, owned);
    const schedule = vi.spyOn(manager as any, 'scheduleJob').mockImplementation(() => {});
    const execute = vi.spyOn(manager, 'executeJob');
    (manager as any).running = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.reload()).rejects.toThrow('CRON_STORAGE_UNAVAILABLE');
    await manager.reload();
    expect(read).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledWith(job);
    expect(execute).not.toHaveBeenCalled();
    await manager.stop();
    await manager.reload();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not schedule when stopped during loading or when ownership is lost (Chief R1)', async () => {
    let finish!: (rows: any[]) => void;
    const manager = new CronManager({ getEnabledJobs: () => new Promise(r => { finish = r; }) } as any, {} as any);
    const schedule = vi.spyOn(manager as any, 'scheduleJob').mockImplementation(() => {});
    (manager as any).running = true;
    const reload = manager.reload();
    await manager.stop();
    finish([{ id: 1 }]);
    await reload;
    expect(schedule).not.toHaveBeenCalled();
    const lost = new CronManager({ getEnabledJobs: async () => [{ id: 1 }] } as any, {} as any,
      undefined, undefined, async () => { throw new Error('WORKER_LEASE_LOST'); });
    (lost as any).running = true;
    const lostSchedule = vi.spyOn(lost as any, 'scheduleJob').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(lost.reload()).rejects.toThrow('WORKER_LEASE_LOST');
    expect(lostSchedule).not.toHaveBeenCalled();
  });

});
