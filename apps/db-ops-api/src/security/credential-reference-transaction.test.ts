import { describe, expect, it, vi } from 'vitest';
import { CredentialReferenceService } from './credential-reference-service.js';

describe('MAX-320 atomic credential update', () => {
  const setup = () => {
    const connection = {
      beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
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
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('does not invoke the update for an invalid reference', async () => {
    const { service, connection } = setup();
    connection.execute.mockResolvedValueOnce([[]]);
    const update = vi.fn();
    expect(await service.consumeInTransaction('ref', 7, 'slide_update_db_config', update)).toEqual({ status: 'invalid' });
    expect(update).not.toHaveBeenCalled();
  });
});
