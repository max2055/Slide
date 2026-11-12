import { describe, expect, it, vi } from 'vitest';
import { AgentToolIdempotencyService, stableArgumentsHash } from './agent-tool-idempotency-service.js';

class Pool {
  row: any;
  constructor(private readonly foundRows = false) {}
  async query(sql: string, values: any[] = []): Promise<any> {
    if (sql.startsWith('INSERT INTO agent_tool_idempotency')) {
      if (this.row) {
        if (sql.includes('ON DUPLICATE KEY UPDATE')) return [{ affectedRows: this.foundRows ? 1 : 0 }];
        throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 });
      }
      this.row = { arguments_hash: values[5], hash_version: 2, owner_token: values[6], state: 'running', result_json: null, checkpoint_json: { items: {} }, expired: false };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT arguments_hash')) return [[this.row]];
    if (sql.startsWith('UPDATE agent_tool_idempotency')) {
      if (sql.includes("SET state = 'unknown'")) {
        if (this.row.expired && this.row.state === 'running') this.row.state = 'unknown';
        return [{ affectedRows: 1 }];
      }
      if (this.row.state !== 'running' || this.row.expired || values.at(-1) !== this.row.owner_token) return [{ affectedRows: 0 }];
      if (sql.includes('SET state = ?')) {
        this.row.state = values[0];
        this.row.result_json = values[1];
      }
      if (sql.includes('JSON_SET')) this.row.checkpoint_json.items[values[0].match(/\d+/)[0]] = JSON.parse(values[1]);
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
    if (first.kind !== 'claimed') throw new Error('expected claim');
    expect(duplicate.kind).toBe('in_progress');
    await service.finish(7, 'session', 'tool', 'key', first.argumentsHash, 'completed', { success: true, data: { id: 1 } }, first.ownerToken);
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

// MAX-458 / #372: expiry exposes evidence but never permits a new execution.
describe('interrupted execution and legacy identity', () => {
  it('fences a foreign owner and protects a live executor', async () => {
    const pool = new Pool();
    const service = new AgentToolIdempotencyService(() => pool);
    const first = await service.claim(7, 'session', 'tool', 'key', {});
    if (first.kind !== 'claimed') throw new Error('expected claim');
    await expect(service.heartbeat(7, 'session', 'tool', 'key', { ...first, ownerToken: 'foreign' })).rejects.toThrow('OWNERSHIP_LOST');
    await expect(service.claim(7, 'session', 'tool', 'key', {})).resolves.toMatchObject({ kind: 'in_progress' });
    await service.heartbeat(7, 'session', 'tool', 'key', first);
    await service.checkpoint(7, 'session', 'tool', 'key', first, 0, { state: 'completed', result: { instanceId: 123 } });
    pool.row.expired = true;
    await expect(service.claim(7, 'session', 'tool', 'key', {})).resolves.toMatchObject({ kind: 'unknown', checkpoint: { items: { 0: { result: { instanceId: 123 } } } } });
    await expect(service.finish(7, 'session', 'tool', 'key', first.argumentsHash, 'completed', {}, first.ownerToken)).rejects.toThrow('OWNERSHIP_LOST');
    await expect(service.claim(7, 'session', 'tool', 'key', {})).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('uses deterministic recursive key ordering without changing array order', () => {
    expect(stableArgumentsHash({ z: [{ aa: 1, z: 2 }], aa: 'x' })).toBe(stableArgumentsHash({ aa: 'x', z: [{ z: 2, aa: 1 }] }));
    expect(stableArgumentsHash([1, 2])).not.toBe(stableArgumentsHash([2, 1]));
    // A localeCompare regression must fail even when CI runs under English.
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('locale-dependent comparator'); });
    try { expect(stableArgumentsHash({ aa: 'x', z: 'y' })).toHaveLength(64); }
    finally { localeCompare.mockRestore(); }
  });

  it('replays #566 historical Danish digests and conservatively rejects unverified legacy arguments', async () => {
    const { createHash } = await import('node:crypto');
    const pool = new Pool();
    const service = new AgentToolIdempotencyService(() => pool);
    const args = { aa: 'x', z: 'y' };
    const digest = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b, 'da-DK'))))).digest('hex');
    pool.row = { arguments_hash: digest, hash_version: 1, state: 'completed', result_json: '{"success":true}' };
    await expect(service.claim(7, 'session', 'tool', 'key', args)).resolves.toMatchObject({ kind: 'completed', result: { success: true } });
    await expect(service.claim(7, 'session', 'tool', 'key', { ...args, z: 'changed' })).resolves.toMatchObject({ kind: 'identity_unverified' });
  });
});

// MAX-458 Chief review: unsupported historical ordering must not produce key-change guidance.
describe('unverified historical identity', () => {
  it('preserves an unmatched historical record without exposing its result or changing state', async () => {
    const pool = new Pool();
    const service = new AgentToolIdempotencyService(() => pool);
    pool.row = { arguments_hash: '0'.repeat(64), hash_version: 1, state: 'running', result_json: { prior: 'result' }, expired: true };
    const before = structuredClone(pool.row);
    const result = await service.claim(7, 'legacy', 'tool', 'key', { aa: 'x', z: 'y' });
    expect(result).toMatchObject({ kind: 'identity_unverified' });
    expect(result).not.toHaveProperty('result');
    expect(pool.row).toEqual(before);
  });
});
