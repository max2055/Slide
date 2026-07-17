import { describe, expect, it } from 'vitest';
import { AgentRunService } from '../agent-run-service.js';

class Pool {
  row: any;
  async query(sql: string, values: any[] = []): Promise<any> {
    if (sql.startsWith('INSERT INTO agent_runs')) {
      if (!this.row) this.row = { id: values[0], actor_id: values[1], session_id: values[2], message_id: values[3], idempotency_key: values[4], state: 'running' };
      return [{}];
    }
    if (sql.startsWith('SELECT * FROM agent_runs')) return [[this.row]];
    if (sql.startsWith('UPDATE agent_runs')) {
      if (this.row.state !== 'running') return [{ affectedRows: 0 }];
      this.row.state = values[0];
      return [{ affectedRows: 1 }];
    }
    throw new Error(sql);
  }
}

describe('AgentRunService', () => {
  it('returns the same durable run for a replay and seals a terminal state once', async () => {
    const pool = new Pool();
    const service = new AgentRunService(() => pool as any);
    const first = await service.claim(7, 'session', 'message', '1234567890abcdef');
    const replay = await service.claim(7, 'session', 'message', '1234567890abcdef');
    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, run: { id: first.run.id, state: 'running' } });
    expect(await service.finish(first.run.id, 'cancelled')).toBe(true);
    expect(await service.finish(first.run.id, 'completed')).toBe(false);
  });
});
