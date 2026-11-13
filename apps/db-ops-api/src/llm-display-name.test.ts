import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { llmDatabaseService } from './llm-database-service.js';
import { alertDatabaseService } from './alert-database-service.js';

afterEach(() => vi.restoreAllMocks());
describe('#300 provider display name contract', () => {
  it.each([null, 100, {}, '名'.repeat(101), '😀'.repeat(101)])('rejects invalid name before SQL: %j', async displayName => {
    const execute = vi.fn();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
    expect(await llmDatabaseService.configureProvider({ name: 'fixture', displayName } as any)).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['', '名'.repeat(51), '名'.repeat(100), '😀'.repeat(100)])('round trips supported names on insert and update', async displayName => {
    const execute = vi.fn().mockResolvedValue([{ insertId: 17 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
    const find = vi.spyOn(llmDatabaseService, 'getProviderByName').mockResolvedValue(null);
    expect(await llmDatabaseService.configureProvider({ name: 'fixture', displayName })).toMatchObject({ success: true });
    expect(execute.mock.calls[0][1][1]).toBe(displayName);
    find.mockResolvedValue({ id: 17, name: 'fixture', context_window: 4096, max_tokens: 2048 } as any);
    expect(await llmDatabaseService.configureProvider({ name: 'fixture', displayName })).toMatchObject({ success: true });
    expect(execute.mock.calls[1][1][0]).toBe(displayName);
  });
});
describe('#300 alert constraint boundary', () => {
  it.each([{ threshold_type: null }, { threshold_type: 'invalid' }, { threshold_type: '' },
    { threshold_type: 'STATIC' }, { silence_minutes: null }, { silence_minutes: -1 },
    { silence_minutes: 0.5 }, { silence_minutes: '5' }, { silence_minutes: 2147483648 }])('rejects %j on create and update before SQL', async patch => {
    const execute = vi.fn();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
    expect(await alertDatabaseService.createAlertRule({ name: 'fixture', ...patch } as any)).toMatchObject({ success: false });
    expect(await alertDatabaseService.updateAlertRule(1, patch as any)).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
  });
});
