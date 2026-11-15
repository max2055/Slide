import { beforeEach, expect, it, vi } from 'vitest';
const { encryptData } = vi.hoisted(() => ({ encryptData: vi.fn((value: string) => 'v2:sentinel:' + value) }));
vi.mock('./db-connection.js', () => ({ encryptData }));
import { migrateNotificationCredentials } from './notification-credential-migration.js';

function fixture(rows: any[]) {
  const connection = { query: vi.fn().mockResolvedValue([rows]), execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
  return { connection, pool: { getConnection: vi.fn().mockResolvedValue(connection) } as any };
}
beforeEach(() => encryptData.mockClear());

it('MAX-590 migrates arbitrary URL bearer paths without retaining a plaintext rollback snapshot', async () => {
  const { pool, connection } = fixture([{ id: 1, type: 'feishu', config: { webhook_url: 'https://example.test/sentinel-path?UnknownName=sentinel-token' } }]);
  expect(await migrateNotificationCredentials(pool)).toBe(1);
  const config = JSON.parse(connection.execute.mock.calls[0][1][0]);
  expect(config).toEqual({ webhook_url_encrypted: 'v2:sentinel:https://example.test/sentinel-path?UnknownName=sentinel-token' });
  expect(connection.commit).toHaveBeenCalledTimes(1);
  expect(connection.release).toHaveBeenCalledTimes(1);
});

it('MAX-590 skips unchanged JSON even when MySQL returns keys in canonical order', async () => {
  const { pool, connection } = fixture([{ id: 1, type: 'webhook', config: { secret_encrypted: 'cipher-signature', severity: 'p0', webhook_url_encrypted: 'cipher-url' } }]);
  expect(await migrateNotificationCredentials(pool)).toBe(0);
  expect(connection.execute).not.toHaveBeenCalled();
  expect(encryptData).not.toHaveBeenCalled();
});

it('MAX-590 serializes bounded batches without nested pool acquisition', async () => {
  const { pool, connection } = fixture([]);
  connection.query.mockResolvedValueOnce([Array.from({ length: 100 }, (_, i) => ({ id: i + 1, type: 'email', config: {} }))])
    .mockResolvedValueOnce([[{ id: 101, type: 'webhook', config: { webhook_url: 'https://sentinel.test/private' } }]]);
  expect(await migrateNotificationCredentials(pool)).toBe(1);
  expect(pool.getConnection).toHaveBeenCalledTimes(1);
  expect(connection.query.mock.calls[1][1]).toEqual([100]);
  expect(connection.commit).toHaveBeenCalledTimes(2);
});

it('MAX-590 aborts on invalid legacy JSON, hides driver errors, and never replays writes', async () => {
  const { pool, connection } = fixture([{ id: 1, type: 'webhook', config: { webhook_url: 'sentinel-url' } }]);
  connection.execute.mockRejectedValueOnce(new Error('sentinel-sensitive-sql'));
  await expect(migrateNotificationCredentials(pool)).rejects.toThrow(/^NOTIFICATION_CREDENTIAL_MIGRATION_FAILED$/);
  expect(connection.execute).toHaveBeenCalledTimes(1);
  expect(connection.rollback).toHaveBeenCalledTimes(1);
  expect(connection.release).toHaveBeenCalledTimes(1);
});
