import { describe, expect, it, vi } from 'vitest';
import { AgentToolIdempotencyService } from './agent-tool-idempotency-service.js';

class Pool {
  row: any;
  constructor(private readonly foundRows = false) {}
  async query(sql: string, values: any[] = []): Promise<any> {
    if (sql.startsWith('INSERT INTO agent_tool_idempotency')) {
      if (this.row) {
        if (sql.includes('ON DUPLICATE KEY UPDATE')) return [{ affectedRows: this.foundRows ? 1 : 0 }];
        throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 });
      }
      this.row = { arguments_hash: values[5], state: 'running', result_json: null };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT arguments_hash')) return [[this.row]];
    if (sql.startsWith('UPDATE agent_tool_idempotency')) {
      this.row.state = values[0];
      this.row.result_json = values[1];
      return [{ affectedRows: 1 }];
    }
    throw new Error(sql);
  }
}

describe.each([true, false])('AgentToolIdempotencyService (FOUND_ROWS=%s)', (foundRows) => {
  it('claims once, reports in-progress, then replays the completed result', async () => {
    const pool = new Pool(foundRows);
    const service = new AgentToolIdempotencyService(() => pool as any);
    const first = await service.claim(7, 'session', 'tool', 'key', { b: 2, a: 1 });
    const duplicate = await service.claim(7, 'session', 'tool', 'key', { a: 1, b: 2 });
    expect(first.kind).toBe('claimed');
    expect(duplicate.kind).toBe('in_progress');
    await service.finish(7, 'session', 'tool', 'key', first.argumentsHash, 'completed', { success: true, data: { id: 1 } });
    await expect(service.claim(7, 'session', 'tool', 'key', { a: 1, b: 2 })).resolves.toMatchObject({ kind: 'completed', result: { success: true } });
  });

  it('detects reuse of a key with different arguments', async () => {
    const pool = new Pool(foundRows);
    const service = new AgentToolIdempotencyService(() => pool as any);
    await service.claim(7, 'session', 'tool', 'key', { a: 1 });
    await expect(service.claim(7, 'session', 'tool', 'key', { a: 2 })).resolves.toMatchObject({ kind: 'conflict' });
  });

  it('regression #371: concurrent requests permit only one side effect', async () => {
    const pool = new Pool(foundRows);
    let effects = 0;
    const claims = await Promise.all(Array.from({ length: 20 }, async () => {
      const claim = await new AgentToolIdempotencyService(() => pool as any).claim(7, 'session', 'tool', 'key', { a: 1 });
      if (claim.kind === 'claimed') effects++;
      return claim.kind;
    }));
    expect(effects).toBe(1);
    expect(claims.filter(kind => kind === 'in_progress')).toHaveLength(19);
  });
});

describe('AgentToolIdempotencyService storage failures', () => {
  it.each(['ER_LOCK_DEADLOCK', 'ER_ACCESS_DENIED_ERROR', 'ETIMEDOUT'])('propagates %s without retrying an unknown write', async (code) => {
    const error = Object.assign(new Error(code), { code });
    const query = vi.fn().mockRejectedValue(error);
    const service = new AgentToolIdempotencyService(() => ({ query }) as any);
    await expect(service.claim(7, 'session', 'tool', 'key', {})).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('fails closed if the duplicate record cannot be read', async () => {
    const query = vi.fn().mockRejectedValueOnce({ code: 'ER_DUP_ENTRY' }).mockResolvedValueOnce([[]]);
    const service = new AgentToolIdempotencyService(() => ({ query }) as any);
    await expect(service.claim(7, 'session', 'tool', 'key', {})).rejects.toThrow('IDEMPOTENCY_CLAIM_FAILED');
  });
});
