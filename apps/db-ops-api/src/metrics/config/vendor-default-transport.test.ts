import { expect, it, vi } from 'vitest';
import type { DatabaseConnection } from '../../database-service.js';
import { trialDatabaseTransport } from './database-transport.js';
import { databaseReads } from '../database/catalog.js';

vi.mock('../../security/database-target-policy.js', () => ({ authorizeDatabaseTarget: async () => ({ address: '127.0.0.1', port: 5236 }) }));
vi.mock('../../resources/instance-access-lifecycle.js', () => ({ instanceAccessLifecycle: {
  track: (_id: number, run: () => unknown) => run(), assertAvailable: async () => {},
  ownTemporary: (_id: number, close: () => unknown) => close,
} }));
const native = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('dmdb', () => ({ default: { getConnection: native.open } }));

it.each(['oracle', 'dameng'] as const)('MAX-237 review: %s default factory retains counter lifecycle across temporary sessions', async engine => {
  const execute = vi.fn(async (sql: string) => ({ rows: sql === 'SET TRANSACTION READ ONLY' ? []
    : [['42', '2026-11-02 08:00:00', 'native-instance', ...(engine === 'oracle' ? ['CDB$ROOT'] : [])]] }));
  const close = vi.fn(async () => {});
  const open = vi.fn(async () => ({ execute, close }));
  native.open.mockImplementation(open);
  const connection = { id: 901, db_type: engine, config: {}, oraclePool: engine === 'oracle' ? { getConnection: open } : null } as unknown as DatabaseConnection;
  const sql = databaseReads.find(r => r.engine === engine && r.name === 'transactions')!.sql;
  const first = await (trialDatabaseTransport(connection) as any).counterQuery({ sql, timeout: 1000 });
  const second = await (trialDatabaseTransport(connection) as any).counterQuery({ sql, timeout: 1000 });
  expect(first.counter).toEqual(second.counter);
  expect(open).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls.map(c => c[0]).filter(s => s === 'SET TRANSACTION READ ONLY')).toHaveLength(2);
  execute.mockRejectedValueOnce(Object.assign(Error('denied'), { code: 'ORA-01031' }));
  await expect((trialDatabaseTransport(connection) as any).counterQuery({ sql, timeout: 1000 })).rejects.toMatchObject({ code: 'ORA-01031' });
  expect(close).toHaveBeenCalledTimes(3); expect(execute).toHaveBeenCalledTimes(5);
});
