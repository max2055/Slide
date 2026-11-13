import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronManager } from './cron-manager.js';
import { dbConnection } from '../db-connection.js';
import { bindScript, CONTROL_MAINTENANCE, hashScript, validateBinding } from './script-policy.js';
import { cronAuthorityService } from './cron-authority.js';
import * as controlSql from './control-sql-executor.js';
import type { CronScript } from './types.js';

const script = (content: string) => ({ id: 3, content, script_type: 'sql', target_db_type: 'mysql' }) as CronScript;
afterEach(() => vi.restoreAllMocks());

describe('Cron control-plane SQL regression (audit R3)', () => {
  it.each(['revalidation', 'executor'] as const)('keeps script authorization separate from %s failure evidence (#509)', async failure => {
    const cause = new Error(`CONTROLLED_${failure}`);
    const refreshActor = vi.fn(async () => { if (failure === 'revalidation') throw cause; return {}; });
    vi.spyOn(cronAuthorityService, 'authorize').mockResolvedValue({ audit: {}, refreshActor } as any);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({} as any);
    const execute = vi.spyOn(controlSql, 'executeControlSql').mockRejectedValue(cause);
    const binding = bindScript(script('SELECT 1'), null, undefined, '7');
    const job = { id: 2, task_type: 'script', script_id: 3, target_instance_id: null, script_binding: binding } as any;
    const service = { getJobById: async () => job, startLog: async () => 1, recordExecutionAuthority: async () => true,
      recordScriptAuthorization: vi.fn(async () => true), completeLog: vi.fn(async () => true), updateRunResult: vi.fn() };
    await new CronManager(service as any, {} as any).executeJob(job);
    expect(service.recordScriptAuthorization).toHaveBeenCalledWith(1, { script_id: 3, sha256: binding.sha256,
      capability: binding.capability, authorized_by: binding.authorizedBy });
    expect(service.completeLog).toHaveBeenCalledWith(1, 'error', '执行失败', cause.message, null, { error_trace: cause.stack });
    expect(execute).toHaveBeenCalledTimes(failure === 'revalidation' ? 0 : 1);
  });

  it('rejects the original null-target mutation probe before calling any SQL pool', async () => {
    const execute = vi.fn();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const service = { startLog: vi.fn(async () => 1), completeLog: vi.fn(async () => true), recordScriptAuthorization: vi.fn(async () => true), updateRunResult: vi.fn() };
    const job = {
      id: 2, task_type: 'script', script_id: 3, target_instance_id: null,
    } as any;
    Object.assign(service, { getJobById: async () => job, recordExecutionAuthority: async () => true });
    await new CronManager(service as any, {} as any).executeJob(job);
    expect(execute).not.toHaveBeenCalled();
    expect(service.updateRunResult).toHaveBeenCalledWith(2, 'error');
    expect(service.completeLog).toHaveBeenCalledWith(1, 'error', '执行失败', 'CRON_SCRIPT_BINDING_REQUIRED', null, expect.objectContaining({ error_trace: expect.any(String) }));
  });

  it.each([
    'UPDATE users SET status = 0 WHERE id = 999999', 'DROP TABLE users',
    'SELECT 1; DELETE FROM users', 'SELECT SLEEP(10)', 'SELECT 1 INTO OUTFILE "/tmp/probe"',
    'SELECT * FROM users FOR UPDATE', 'CALL cleanup()', 'SET autocommit = 0',
    'SELECT /*!50000 SQL_NO_CACHE */ 1', 'SELECT /*+ MAX_EXECUTION_TIME(999999) */ 1',
  ])('denies unapproved control SQL: %s', content => {
    expect(() => bindScript(script(content), null, undefined, '7')).toThrow();
  });

  it('binds exact maintenance version, script, target and hash', () => {
    const sql = CONTROL_MAINTENANCE['baseline-cleanup-v1'];
    const binding = bindScript(script(sql), null, 'baseline-cleanup-v1', '7');
    expect(validateBinding(binding, 3, null)).toEqual(binding);
    expect(() => validateBinding(binding, 4, null)).toThrow();
    expect(() => validateBinding(binding, 3, 9)).toThrow();
    expect(() => validateBinding({ ...binding, content: sql + ' ' }, 3, null)).toThrow();
    expect(() => validateBinding({ ...binding, content: 'DELETE FROM users', sha256: hashScript('DELETE FROM users') }, 3, null)).toThrow();
    expect(() => bindScript(script(sql), null, 'read-only', '7')).toThrow();
  });

  it('does not convert a deleted managed target into control-plane authority', () => {
    const binding = bindScript(script('SELECT 1'), 9, undefined, '7');
    expect(() => validateBinding(binding, 3, null)).toThrow('CRON_SCRIPT_BINDING_REQUIRED');
  });

  it('fails closed if durable authorization audit cannot be written', async () => {
    vi.spyOn(cronAuthorityService, 'authorize').mockResolvedValue({ actor: { userId: 7 }, audit: {}, refreshActor: async () => ({}) } as any);
    const getPool = vi.spyOn(dbConnection, 'getPool');
    const service = { startLog: vi.fn(async () => 1), completeLog: vi.fn(async () => true), recordScriptAuthorization: vi.fn(async () => false), updateRunResult: vi.fn() };
    const job = {
      id: 2, task_type: 'script', script_id: 3, target_instance_id: null,
      script_binding: bindScript(script(CONTROL_MAINTENANCE['silence-cleanup-v1']), null, 'silence-cleanup-v1', '7'),
    } as any;
    Object.assign(service, { getJobById: async () => job, recordExecutionAuthority: async () => true });
    await new CronManager(service as any, {} as any).executeJob(job);
    expect(getPool).not.toHaveBeenCalled();
    expect(service.updateRunResult).toHaveBeenCalledWith(2, 'error');
  });
});

it('records runtime output exhaustion as partial and never releases same-job ownership before settlement', async () => {
  let settle!: () => void;
  const executionSettled = new Promise<void>(r => { settle = r; });
  const execute = vi.fn(async () => ({ finalContent: 'partial', error: 'OUTPUT_LIMIT', stopReason: 'output_limit',
    resolution: { kind: 'partial', reasonCode: 'OUTPUT_LIMIT' }, toolsUsed: [], toolEvents: [], usage: {}, executionSettled, cancellationPending: true }));
  const service = { startLog: vi.fn(async () => 1), completeLog: vi.fn(async () => true), updateRunResult: vi.fn() };
  const manager = new CronManager(service as any, { execute } as any);
  const job = { id: 89, name: 'recovery', task_description: 'test', timeout_seconds: 1 } as any;
  vi.spyOn(cronAuthorityService, 'authorize').mockResolvedValue({ audit: {} } as any);
  Object.assign(service, { getJobById: async () => job, recordExecutionAuthority: async () => true });
  await manager.executeJob(job); await manager.executeJob(job);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(service.updateRunResult).toHaveBeenCalledWith(89, 'partial');
  settle(); await executionSettled; await manager.executeJob(job);
  expect(execute).toHaveBeenCalledTimes(2);
});
