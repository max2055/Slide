import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { instanceDatabaseService } from './instance-database-service.js';

describe('recordDetectedVersion', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes only the version the connection reported, and only when it changed', async () => {
    const execute = vi.fn(async (_sql: string, _values?: unknown[]) => [{}]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await instanceDatabaseService.recordDetectedVersion(1, ' 8.4.10 ', 'mysql');

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, values] = execute.mock.calls[0]!;
    expect(sql.replace(/\s+/g, ' ').trim())
      .toBe("UPDATE database_instances SET db_version = ? WHERE id = ? AND db_type = ? AND lifecycle_state = 'available' AND (db_version IS NULL OR db_version <> ?)");
    expect(values).toEqual(['8.4.10', 1, 'mysql', '8.4.10']);
  });

  it('keeps an unknown version unknown instead of writing a placeholder', async () => {
    const execute = vi.fn(async () => [{}]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await instanceDatabaseService.recordDetectedVersion(1, null, 'mysql');
    await instanceDatabaseService.recordDetectedVersion(1, null, 'postgresql');
    await instanceDatabaseService.recordDetectedVersion(1, '   ', 'oracle');
    await instanceDatabaseService.recordDetectedVersion(1, 'v'.repeat(65), 'dameng');

    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['oracle', 'dameng'])('invalidates stale qualification after a connected %s target reports no version', async engine => {
    const execute = vi.fn(async () => [{}]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await instanceDatabaseService.recordDetectedVersion(1, null, engine);

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "UPDATE database_instances SET db_version = NULL WHERE id = ? AND db_type = ? AND lifecycle_state = 'available' AND db_version IS NOT NULL",
      [1, engine]
    );
  });

  it('never fails the connection that produced the version', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn(async () => { throw new Error('write failed'); }) } as any);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(instanceDatabaseService.recordDetectedVersion(1, '8.4.10', 'mysql')).resolves.toBeUndefined();
  });
});
