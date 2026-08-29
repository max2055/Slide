import { describe, expect, it } from 'vitest';
import { AgentToolIdempotencyService } from './agent-tool-idempotency-service.js';

class Pool {
  row: any;
  async query(sql: string, values: any[] = []): Promise<any> {
    if (sql.startsWith('INSERT INTO agent_tool_idempotency')) {
      if (this.row) return [{ affectedRows: 0 }];
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

describe('AgentToolIdempotencyService', () => {
  it('claims once, reports in-progress, then replays the completed result', async () => {
    const pool = new Pool();
    const service = new AgentToolIdempotencyService(() => pool as any);
    const first = await service.claim(7, 'session', 'tool', 'key', { b: 2, a: 1 });
    const duplicate = await service.claim(7, 'session', 'tool', 'key', { a: 1, b: 2 });
    expect(first.kind).toBe('claimed');
    expect(duplicate.kind).toBe('in_progress');
    await service.finish(7, 'session', 'tool', 'key', first.argumentsHash, 'completed', { success: true, data: { id: 1 } });
    await expect(service.claim(7, 'session', 'tool', 'key', { a: 1, b: 2 })).resolves.toMatchObject({ kind: 'completed', result: { success: true } });
  });

  it('detects reuse of a key with different arguments', async () => {
    const pool = new Pool();
    const service = new AgentToolIdempotencyService(() => pool as any);
    await service.claim(7, 'session', 'tool', 'key', { a: 1 });
    await expect(service.claim(7, 'session', 'tool', 'key', { a: 2 })).resolves.toMatchObject({ kind: 'conflict' });
  });
});
