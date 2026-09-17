import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { MySqlNonceStore } from './nonce-store.js';

describe('nonce storage failure handling', () => {
  it('only treats duplicate keys as replays', async () => {
    const query = vi.fn().mockRejectedValue({ code: 'ER_DUP_ENTRY' });
    const store = new MySqlNonceStore({ query } as unknown as Pool);
    expect(await store.claim('nonce', 1000)).toBe(false);
    for (const code of ['PROTOCOL_SEQUENCE_TIMEOUT', 'ECONNRESET', 'ER_NO_SUCH_TABLE']) {
      query.mockRejectedValue({ code });
      await expect(store.claim('nonce', 1000)).rejects.toEqual({ code });
    }
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('does not make cleanup failure a bypass or a prerequisite for claims', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('cleanup unavailable')).mockResolvedValueOnce([{ affectedRows: 1 }]);
    const store = new MySqlNonceStore({ query } as unknown as Pool);
    await expect(store.cleanup()).rejects.toThrow('cleanup unavailable');
    expect(await store.claim('nonce', 1000)).toBe(true);
  });
});
