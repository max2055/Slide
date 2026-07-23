import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './actor-context.js';
import { dbConnection } from '../db-connection.js';
import { chatDatabaseService } from '../chat-database-service.js';

interface StoredSession {
  id: number;
  session_id: string;
  user_id: number;
  title: string;
  instance_id: number | null;
  message_count: number;
  last_message_at: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface StoredMessage {
  id: number;
  session_id: string;
  message_id: string;
  parent_id: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  related_tool: string | null;
  related_skill: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface StoredShare {
  session_id: string;
  granted_by: number;
  recipient_user_id: number;
  permission: 'read';
  created_at: Date;
}

function makeActor(userId: number): ActorContext {
  return Object.freeze({
    userId,
    username: `user-${userId}`,
    roles: Object.freeze([]),
    permissions: Object.freeze([]),
    sessionVersion: 1,
    instanceScopes: Object.freeze({}),
    requestId: `request-${userId}`,
  });
}

function session(id: number, sessionId: string, userId: number): StoredSession {
  const timestamp = new Date(`2026-07-17T00:00:0${id}.000Z`);
  return {
    id,
    session_id: sessionId,
    user_id: userId,
    title: sessionId,
    instance_id: null,
    message_count: 1,
    last_message_at: timestamp,
    metadata: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

class ChatAclPool {
  sessions: StoredSession[] = [];
  messages: StoredMessage[] = [];
  shares: StoredShare[] = [];
  persistenceCount = 0;
  query = vi.fn(this.execute.bind(this));

  reset(): void {
    this.sessions = [session(1, 'owner-session', 7), session(2, 'other-session', 8)];
    this.messages = [{
      id: 1,
      session_id: 'owner-session',
      message_id: 'message-1',
      parent_id: null,
      role: 'user',
      content: 'private',
      related_tool: null,
      related_skill: null,
      metadata: null,
      created_at: new Date('2026-07-17T00:00:01.000Z'),
    }];
    this.shares = [{
      session_id: 'owner-session',
      granted_by: 7,
      recipient_user_id: 9,
      permission: 'read',
      created_at: new Date('2026-07-17T00:00:02.000Z'),
    }];
    this.persistenceCount = 0;
    this.query.mockClear();
  }

  async getConnection() {
    return {
      query: this.query,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
  }

  private canRead(item: StoredSession, userId: number): boolean {
    return item.user_id === userId || this.shares.some((share) =>
      share.session_id === item.session_id
      && share.recipient_user_id === userId
      && share.permission === 'read');
  }

  private async execute(sql: string, values: unknown[] = []): Promise<any> {
    const compact = sql.replace(/\s+/g, ' ').trim();

    if (compact.startsWith('INSERT INTO chat_sessions')) {
      const [sessionId, ownerId, title, instanceId] = values as [string, number, string, number | null];
      const item = session(this.sessions.length + 1, sessionId, ownerId);
      item.title = title;
      item.instance_id = instanceId;
      this.sessions.push(item);
      this.persistenceCount += 1;
      return [{ insertId: item.id, affectedRows: 1 }];
    }

    if (compact.includes('JOIN chat_messages cm') && compact.includes('FROM chat_sessions cs')) {
      const sessionId = String(values[0]);
      const actorId = Number(values[1]);
      const item = this.sessions.find((candidate) => candidate.session_id === sessionId);
      if (!item || !this.canRead(item, actorId)) return [[]];
      const messages = this.messages
        .filter((message) => message.session_id === sessionId)
        .map((message) => ({ ...message, authorized_session_id: item.id }));
      return [messages.length > 0 ? messages : [{ id: null, message_id: null, authorized_session_id: item.id }]];
    }

    if (compact.startsWith('SELECT cs.*') && compact.includes('ORDER BY')) {
      const actorId = Number(values[0]);
      const limit = Number(values.at(-1));
      return [this.sessions.filter((item) => this.canRead(item, actorId)).slice(0, limit)];
    }

    if (compact.startsWith('SELECT cs.*') && compact.includes('WHERE cs.session_id')) {
      const sessionId = String(values[0]);
      const actorId = Number(values[1]);
      const item = this.sessions.find((candidate) =>
        candidate.session_id === sessionId
        && (compact.includes('chat_session_shares')
          ? this.canRead(candidate, actorId)
          : candidate.user_id === actorId));
      return [[...(item ? [item] : [])]];
    }

    if (compact.startsWith('INSERT INTO chat_messages') && compact.includes('SELECT')) {
      const [messageId, parentId, role, content, relatedTool, relatedSkill, metadata, sessionId, ownerId]
        = values as [string, string | null, StoredMessage['role'], string, string | null, string | null, string | null, string, number];
      const item = this.sessions.find((candidate) => candidate.session_id === sessionId && candidate.user_id === ownerId);
      if (!item) return [{ affectedRows: 0 }];
      this.messages.push({
        id: this.messages.length + 1,
        session_id: sessionId,
        message_id: messageId,
        parent_id: parentId,
        role,
        content,
        related_tool: relatedTool,
        related_skill: relatedSkill,
        metadata: metadata ? JSON.parse(metadata) : null,
        created_at: new Date(),
      });
      this.persistenceCount += 1;
      return [{ affectedRows: 1 }];
    }

    if (compact.startsWith('UPDATE chat_sessions cs')) {
      const sessionId = String(values.at(-2));
      const ownerId = Number(values.at(-1));
      const item = this.sessions.find((candidate) => candidate.session_id === sessionId && candidate.user_id === ownerId);
      if (!item) return [{ affectedRows: 0 }];
      this.persistenceCount += 1;
      return [{ affectedRows: 1 }];
    }

    if (compact.startsWith('UPDATE chat_sessions')) {
      return [{ affectedRows: 1 }];
    }

    if (compact.startsWith('DELETE cm FROM chat_messages')) {
      return [{ affectedRows: 0 }];
    }

    if (compact.startsWith('DELETE cs FROM chat_sessions cs')) {
      const [sessionId, ownerId] = values as [string, number];
      const index = this.sessions.findIndex((candidate) => candidate.session_id === sessionId && candidate.user_id === ownerId);
      if (index < 0) return [{ affectedRows: 0 }];
      this.sessions.splice(index, 1);
      this.persistenceCount += 1;
      return [{ affectedRows: 1 }];
    }

    if (compact.startsWith('INSERT INTO chat_session_shares')) {
      const [sessionId, grantor, recipient, permission, checkedSessionId, ownerId]
        = values as [string, number, number, 'read', string, number];
      if (checkedSessionId !== sessionId) return [{ affectedRows: 0 }];
      const item = this.sessions.find((candidate) => candidate.session_id === sessionId && candidate.user_id === ownerId);
      if (!item) return [{ affectedRows: 0 }];
      this.shares.push({
        session_id: sessionId,
        granted_by: grantor,
        recipient_user_id: recipient,
        permission,
        created_at: new Date(),
      });
      this.persistenceCount += 1;
      return [{ affectedRows: 1 }];
    }

    if (compact.includes('FOR UPDATE')) {
      const [sessionId, ownerId] = values as [string, number];
      const item = this.sessions.find((candidate) => candidate.session_id === sessionId && candidate.user_id === ownerId);
      return [[...(item ? [item] : [])]];
    }

    if (compact.includes('COUNT(*)') && compact.includes('chat_messages')) {
      const sessionId = String(values[0]);
      return [[{ cnt: this.messages.filter((message) => message.session_id === sessionId).length }]];
    }

    if (compact.startsWith('DELETE FROM chat_messages')) {
      this.persistenceCount += 1;
      return [{ affectedRows: 0 }];
    }

    throw new Error(`Unexpected SQL in ChatAclPool: ${compact}`);
  }
}

const owner = makeActor(7);
const other = makeActor(8);
const reader = makeActor(9);
const pool = new ChatAclPool();
const service = chatDatabaseService as any;

describe('chat ownership repository boundary', () => {
  beforeAll(() => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as any);
  });

  beforeEach(() => {
    pool.reset();
  });

  it('lists only sessions owned by or read-shared with the actor', async () => {
    await expect(service.getSessions(owner, 20)).resolves.toMatchObject([
      { session_id: 'owner-session', user_id: 7 },
    ]);
    await expect(service.getSessions(reader, 20)).resolves.toMatchObject([
      { session_id: 'owner-session', user_id: 7 },
    ]);
    await expect(service.getSessions(other, 20)).resolves.toMatchObject([
      { session_id: 'other-session', user_id: 8 },
    ]);
  });

  it.each([
    ['owner', owner, true],
    ['read share', reader, true],
    ['other', other, false],
  ])('%s can read and watch only when the ACL allows it', async (_name, actor, allowed) => {
    const read = service.getSession(actor, 'owner-session');
    const history = service.getMessages(actor, 'owner-session', 20);
    const watch = service.authorizeSession(actor, 'owner-session', 'watch');

    if (allowed) {
      await expect(read).resolves.toMatchObject({ session_id: 'owner-session' });
      await expect(history).resolves.toMatchObject([{ content: 'private' }]);
      await expect(watch).resolves.toMatchObject({ session_id: 'owner-session' });
    } else {
      await expect(read).rejects.toThrow('Chat session not found');
      await expect(history).rejects.toThrow('Chat session not found');
      await expect(watch).rejects.toThrow('Chat session not found');
    }
  });

  it.each([
    ['owner', owner, true],
    ['read share', reader, false],
    ['other', other, false],
  ])('%s mutation matrix is owner-only for append, patch, delete, and cap', async (_name, actor, allowed) => {
    const baseline = pool.persistenceCount;
    const append = service.addMessage(actor, 'owner-session', {
      messageId: `message-${actor.userId}`,
      role: 'user',
      content: 'new message',
    });

    if (allowed) await expect(append).resolves.toBeUndefined();
    else await expect(append).rejects.toThrow('Chat session not found');

    const patch = service.updateSessionSettings(actor, 'owner-session', { model: 'model-a' });
    if (allowed) await expect(patch).resolves.toBe(true);
    else await expect(patch).rejects.toThrow('Chat session not found');

    const cap = service.enforceMessageCap(actor, 'owner-session', 20);
    if (allowed) await expect(cap).resolves.toBe(0);
    else await expect(cap).rejects.toThrow('Chat session not found');

    const remove = service.deleteSession(actor, 'owner-session');
    if (allowed) await expect(remove).resolves.toBe(true);
    else await expect(remove).rejects.toThrow('Chat session not found');

    if (!allowed) expect(pool.persistenceCount).toBe(baseline);
  });

  it('creates an unpredictable server key owned by the actor and never adopts a client key', async () => {
    const first = await service.createSession(owner, { title: 'First', instanceId: 12 });
    const second = await service.createSession(owner, { title: 'Second' });

    expect(first.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second.session_id).not.toBe(first.session_id);
    expect(first).toMatchObject({ user_id: owner.userId, title: 'First', instance_id: 12 });
    expect(pool.sessions.some((item) => item.session_id === 'attacker-key')).toBe(false);

    const baseline = pool.persistenceCount;
    await expect(service.addMessage(owner, 'attacker-key', {
      messageId: 'attack',
      role: 'user',
      content: 'claim this key',
    })).rejects.toThrow('Chat session not found');
    expect(pool.persistenceCount).toBe(baseline);
  });

  it('records the grantor, recipient, read permission, and creation time for a share', async () => {
    await expect(service.grantSessionShare(owner, 'owner-session', 10, 'read')).resolves.toBeUndefined();

    expect(pool.shares.at(-1)).toMatchObject({
      session_id: 'owner-session',
      granted_by: owner.userId,
      recipient_user_id: 10,
      permission: 'read',
      created_at: expect.any(Date),
    });
    await expect(service.grantSessionShare(other, 'owner-session', 10, 'read'))
      .rejects.toThrow('Chat session not found');
  });

  it('exposes retention deletion only through an explicitly named maintenance API', async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 2 }]);
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

    await expect(service.deleteOldSessionsForMaintenance(30)).resolves.toBe(2);
    expect(service.deleteOldSessions).toBeUndefined();
  });
});
