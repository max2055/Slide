import { describe, expect, it, vi } from 'vitest';
import { CredentialReferenceService } from './credential-reference-service.js';

describe('MAX-320 atomic credential update', () => {
  const setup = () => {
    const connection = {
      beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
      execute: vi.fn(async (sql: string) => sql.startsWith('SELECT')
        ? [[{ secret_encrypted: 'encrypted-secret' }]] : [{ affectedRows: 1 }]),
    };
    const service = new CredentialReferenceService(() => ({ getConnection: async () => connection }) as any, () => 'secret');
    return { service, connection };
  };

  it('rolls back consumption when the update fails, without exposing the error', async () => {
    const { service, connection } = setup();
    const result = await service.consumeInTransaction('ref', 7, 'slide_update_db_config', async () => { throw new Error('secret'); });
    expect(result).toEqual({ status: 'rolled_back' });
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('commits only after the callback has completed on the same connection', async () => {
    const { service, connection } = setup();
    const result = await service.consumeInTransaction('ref', 7, 'slide_update_db_config', async (executor, secret) => {
      expect(executor).toBe(connection);
      expect(secret).toBe('secret');
      expect(connection.commit).not.toHaveBeenCalled();
      return 42;
    });
    expect(result).toEqual({ status: 'committed', value: 42 });
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it.each(['commit', 'rollback'] as const)('never declares retry safe when %s acknowledgement is lost', async (failure) => {
    const { service, connection } = setup();
    connection[failure].mockRejectedValue(new Error('secret'));
    const result = await service.consumeInTransaction('ref', 7, 'slide_update_db_config', async () => {
      if (failure === 'rollback') throw new Error('secret');
    });
    expect(result).toEqual({ status: 'unknown' });
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });

  it('does not invoke the update for an invalid reference', async () => {
    const { service, connection } = setup();
    connection.execute.mockResolvedValueOnce([[]]);
    const update = vi.fn();
    expect(await service.consumeInTransaction('ref', 7, 'slide_update_db_config', update)).toEqual({ status: 'invalid' });
    expect(update).not.toHaveBeenCalled();
  });

  it('fails closed when a concurrent claim or expiry prevents consumption', async () => {
    const { service, connection } = setup();
    connection.execute.mockResolvedValueOnce([[{ secret_encrypted: 'encrypted-secret' }]]).mockResolvedValueOnce([{ affectedRows: 0 }]);
    const update = vi.fn();
    expect(await service.consumeInTransaction('ref', 7, 'slide_update_db_config', update)).toEqual({ status: 'rolled_back' });
    expect(update).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it.each([['', 7], ['ref', 0], ['ref', 1.5], ['x'.repeat(129), 7]])('rejects malformed reference/owner without acquiring a connection', async (ref, owner) => {
    const update = vi.fn();
    const provider = vi.fn();
    const service = new CredentialReferenceService(provider);
    expect(await service.consumeInTransaction(String(ref), Number(owner), 'slide_update_db_config', update)).toEqual({ status: 'invalid' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('rolls back when stored credentials cannot be decrypted', async () => {
    const { connection } = setup();
    const service = new CredentialReferenceService(() => ({ getConnection: async () => connection }) as any, () => { throw new Error('secret'); });
    const update = vi.fn();
    expect(await service.consumeInTransaction('ref', 7, 'slide_update_db_config', update)).toEqual({ status: 'rolled_back' });
    expect(update).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
  });
});
