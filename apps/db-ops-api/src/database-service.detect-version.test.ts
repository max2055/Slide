import { createRequire } from 'node:module';
import dmdb from 'dmdb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';

const setConnection = (id: number, connection: Record<string, unknown>) =>
  (databaseService as any).connections.set(id, connection);

describe('detectVersion', () => {
  afterEach(async () => {
    await Promise.all([47, 48].map(id => databaseService.removeConnection(id)));
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

  it('uses the full Oracle server release for both configuration and health', async () => {
    const execute = vi.fn(async (_sql: string) => ({ rows: [[1]] }));
    setConnection(49, { id: 49, db_type: 'oracle', connected: true, oraclePool: {},
      oracleConnection: { oracleServerVersionString: '19.19.0.0.0', execute } });

    await expect(databaseService.detectVersion(49)).resolves.toBe('19.19.0.0.0');
    expect(execute).not.toHaveBeenCalled();
    await expect(databaseService.checkHealth(49)).resolves.toMatchObject({ db_version: '19.19.0.0.0' });
    expect(execute).not.toHaveBeenCalledWith('SELECT VERSION FROM V$INSTANCE');
  });

  it.each([undefined, '19.19.unverified', '19.19.' + '0'.repeat(64)])('keeps an invalid Oracle release unknown (%s)', async (version) => {
    setConnection(49, { id: 49, db_type: 'oracle', connected: true, oracleConnection: { oracleServerVersionString: version } });

    await expect(databaseService.detectVersion(49)).resolves.toBeNull();
  });

  it('uses each Dameng connection’s own handshake release for configuration and health', async () => {
    const { Login } = createRequire(import.meta.url)('dmdb/src/net/msg/login.js');
    const release = '8.1.3.62';
    const createConnection = (version?: string) => {
      const connection = { execute: vi.fn(async () => ({ rows: [[1]] })), close: vi.fn(async () => {}) };
      if (version) Login.processServerVersion(version, connection);
      return connection;
    };
    vi.spyOn(dmdb, 'getConnection')
      .mockImplementationOnce(async () => createConnection(release) as any)
      .mockImplementationOnce(async () => createConnection() as any);
    const config = { host: '192.0.2.1', port: 5236, user: 'fixture', password: 'fixture', db_type: 'dameng' };

    await expect(Promise.all([databaseService.addConnection(47, 'known', config),
      databaseService.addConnection(48, 'unknown', config)])).resolves.toEqual([true, true]);
    await expect(databaseService.detectVersion(47)).resolves.toBe(release);
    await expect(databaseService.detectVersion(48)).resolves.toBeNull();
    await expect(databaseService.checkHealth(47)).resolves.toMatchObject({ db_version: release });
    await expect(databaseService.checkHealth(48)).resolves.toMatchObject({ db_version: null });
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
