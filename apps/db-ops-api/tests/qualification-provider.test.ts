import { describe, it, expect, vi } from 'vitest';
import { configureQualificationProvider } from '../../../scripts/qualification/configure-provider.js';

const config = { displayName: 'Test', encryptedApiKey: 'opaque', baseUrl: 'http://localhost/v1', model: 'test' };
const target = { id: 2, display_name: 'Test', api_key_encrypted: 'opaque', api_base_url: config.baseUrl,
  default_model: 'test', enabled: 1, is_default: 1, deployment_type: 'api', api_format: 'openai-completions' };
function fixture(options: { missing?: boolean; failWrite?: boolean; badState?: boolean; rollbackFails?: boolean } = {}) {
  let calls = 0;
  const connection = {
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(async () => {
      if (options.rollbackFails) throw new Error('rollback unknown');
    }), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async () => {
      calls++;
      if (calls === 1) return [[{ id: 1 }, { id: 2 }]];
      if (calls === 2) return [options.missing ? [] : [{ id: 2 }]];
      if (calls === 4 && options.failWrite) throw new Error('second write rejected');
      if (calls === 5) return [[{ ...target, enabled: options.badState ? 0 : 1 }]];
      return [{ affectedRows: 0 }];
    }),
  };
  const pool = { getConnection: vi.fn(async () => connection) };
  return { connection, pool: pool as unknown as Parameters<typeof configureQualificationProvider>[0] };
}
describe('#458 qualification atomic Provider switch', () => {
  it('accepts zero affectedRows only after verifying the actual state on the reserved connection', async () => {
    const { pool, connection } = fixture();
    await configureQualificationProvider(pool, config);
    expect(connection.execute.mock.calls).toHaveLength(5);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });
  it('rejects a missing target before either write', async () => {
    const { pool, connection } = fixture({ missing: true });
    await expect(configureQualificationProvider(pool, config)).rejects.toThrow('not found');
    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });
  it('rolls back a failed second update and preserves the original failure', async () => {
    const { pool, connection } = fixture({ failWrite: true });
    await expect(configureQualificationProvider(pool, config)).rejects.toThrow('second write rejected');
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });
  it('rejects silent write suppression instead of reporting success', async () => {
    const { pool, connection } = fixture({ badState: true });
    await expect(configureQualificationProvider(pool, config)).rejects.toThrow('state verification failed');
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });
  it('destroys a connection when rollback is unknown, without replay', async () => {
    const { pool, connection } = fixture({ failWrite: true, rollbackFails: true });
    await expect(configureQualificationProvider(pool, config)).rejects.toThrow('second write rejected');
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
    expect(connection.execute).toHaveBeenCalledTimes(4);
  });
});
