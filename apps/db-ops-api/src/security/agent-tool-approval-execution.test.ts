import { describe, expect, it, vi } from 'vitest';
import { AgentToolApprovalExecution } from './agent-tool-approval-execution.js';

describe('approval transaction connection lifecycle', () => {
  it('discards a connection when rollback fails instead of returning an open transaction to the pool', async () => {
    const connection = {
      beginTransaction: vi.fn(async () => {}),
      execute: vi.fn(async (): Promise<[any]> => { throw new Error('audit store unavailable'); }),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => { throw new Error('rollback acknowledgement lost'); }),
      release: vi.fn(), destroy: vi.fn(),
    };
    const service = new AgentToolApprovalExecution({ getConnection: async () => connection });
    await expect(service.authorize('1', 'a'.repeat(64), 7, 'test', undefined, async () => {})).rejects.toThrow();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });
});
