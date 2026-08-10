import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { instanceDatabaseService } from './instance-database-service.js';

describe('active instance id selector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects only active ids without credential-bearing columns and returns only valid ids', async () => {
    const execute = vi.fn(async (_sql: string) => [[
      { id: 7 },
      { id: '8' },
      { id: 0 },
      { id: -1 },
      { id: 1.5 },
      { id: Number.MAX_SAFE_INTEGER + 1 },
      { id: null },
      { id: 'invalid' },
    ]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await expect(instanceDatabaseService.listActiveInstanceIds()).resolves.toEqual([7, 8]);

    expect(execute).toHaveBeenCalledTimes(1);
    const sql = execute.mock.calls[0]![0].replace(/\s+/g, ' ').trim();
    expect(sql).toBe("SELECT id FROM database_instances WHERE status = 'active' ORDER BY id");
    expect(sql).not.toMatch(/\*|username|password|password_encrypted|connection_string|host/i);
  });

  it('returns an empty list when no active instances exist', async () => {
    const execute = vi.fn(async () => [[]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await expect(instanceDatabaseService.listActiveInstanceIds()).resolves.toEqual([]);
  });

  it('rejects with a stable error when the database pool is unavailable', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);

    await expect(instanceDatabaseService.listActiveInstanceIds())
      .rejects.toThrow('INSTANCE_ENUMERATION_UNAVAILABLE');
  });

  it('rejects with a stable error and preserves the SQL failure as cause', async () => {
    const sqlFailure = new Error('query failed');
    const execute = vi.fn(async () => { throw sqlFailure; });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await expect(instanceDatabaseService.listActiveInstanceIds()).rejects.toMatchObject({
      message: 'INSTANCE_ENUMERATION_UNAVAILABLE',
      cause: sqlFailure,
    });
  });

  it('is the only instance enumeration used by the production fault diagnosis default', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'fault-diagnosis-service.ts'), 'utf8');

    expect(source).toContain('instanceDatabaseService.listActiveInstanceIds()');
    expect(source).not.toContain('instanceDatabaseService.getAllInstances()');
  });
});
