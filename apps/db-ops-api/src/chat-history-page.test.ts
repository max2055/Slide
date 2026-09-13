import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { ChatDatabaseService, ChatSessionNotFoundError } from './chat-database-service.js';
import type { ActorContext } from './auth/actor-context.js';

const actor = { userId: 7 } as ActorContext;
const session = { id: 1, session_id: 'one', user_id: 7, created_at: new Date(), updated_at: new Date() };
const row = (id: number) => ({ id, message_id: `m-${id}`, session_id: 'one', role: 'user', content: 'message', created_at: new Date(0) });
afterEach(() => vi.restoreAllMocks());

describe('history database cursor boundary', () => {
  it('uses exclusive IDs for equal timestamps, returns chronological pages, and keeps ACL in every query', async () => {
    const query = vi.fn().mockResolvedValueOnce([[session]])
      .mockResolvedValueOnce([[row(9), row(8), row(7)]])
      .mockResolvedValueOnce([[session]])
      .mockResolvedValueOnce([[row(7)]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ query } as any);
    const service = new ChatDatabaseService();
    const first = await service.getMessagePage(actor, 'one', 2);
    expect(first.messages.map((message) => message.id)).toEqual([8, 9]);
    expect(first.nextBefore).toBe(8);
    const second = await service.getMessagePage(actor, 'one', 2, first.nextBefore!);
    expect(second.messages.map((message) => message.id)).toEqual([7]);
    expect(second.nextBefore).toBeNull();
    expect(query.mock.calls[3][0]).toContain('cm.id < ?');
    expect(query.mock.calls[3][0]).toContain('ORDER BY cm.id DESC LIMIT ?');
    expect(query.mock.calls[3][1]).toEqual(['one', 7, 7, 8, 3]);
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('cs.user_id = ?');
      expect(sql).toContain('chat_session_shares');
    }
  });

  it('rejects unauthorized sessions before reading messages and handles an authorized empty session', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ query } as any);
    const service = new ChatDatabaseService();
    await expect(service.getMessagePage(actor, 'foreign', 200, 100)).rejects.toBeInstanceOf(ChatSessionNotFoundError);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockResolvedValueOnce([[session]]).mockResolvedValueOnce([[]]);
    await expect(service.getMessagePage(actor, 'one', 200)).resolves.toEqual({ messages: [], nextBefore: null });
  });
});
