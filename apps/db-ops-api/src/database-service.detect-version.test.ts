import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';

const setConnection = (id: number, connection: Record<string, unknown>) =>
  (databaseService as any).connections.set(id, connection);

describe('detectVersion', () => {
  afterEach(() => {
    (databaseService as any).connections.clear();
    vi.restoreAllMocks();
  });

  it('reads the version a connected MySQL target reports', async () => {
    const query = vi.fn(async () => [[{ version: '8.4.10' }]]);
    setConnection(41, { id: 41, db_type: 'mysql', connected: true, pool: { query } });

    await expect(databaseService.detectVersion(41)).resolves.toBe('8.4.10');
    expect(query).toHaveBeenCalledWith('SELECT VERSION() AS version');
  });

  it('reads the version a connected PostgreSQL target reports', async () => {
    const query = vi.fn(async () => ({ rows: [{ version: '16.4' }] }));
    setConnection(42, { id: 42, db_type: 'postgresql', connected: true, pgClient: { query } });

    await expect(databaseService.detectVersion(42)).resolves.toBe('16.4');
    expect(query).toHaveBeenCalledWith("SELECT current_setting('server_version') AS version");
  });

  it('stays unknown without a live connection', async () => {
    await expect(databaseService.detectVersion(43)).resolves.toBeNull();
    setConnection(44, { id: 44, db_type: 'mysql', connected: false, pool: { query: vi.fn() } });
    await expect(databaseService.detectVersion(44)).resolves.toBeNull();
  });

  it('stays unknown when the target cannot answer or has no version', async () => {
    setConnection(45, { id: 45, db_type: 'mysql', connected: true, pool: { query: vi.fn(async () => { throw new Error('gone'); }) } });
    await expect(databaseService.detectVersion(45)).resolves.toBeNull();
    setConnection(46, { id: 46, db_type: 'mysql', connected: true, pool: { query: vi.fn(async () => [[{ version: '  ' }]]) } });
    await expect(databaseService.detectVersion(46)).resolves.toBeNull();
  });
});
