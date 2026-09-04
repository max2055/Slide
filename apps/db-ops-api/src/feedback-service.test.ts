import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import { FeedbackService } from './feedback-service.js';

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: 7,
    username: 'alice',
    roles: [],
    permissions: [],
    sessionVersion: 1,
    instanceScopes: {},
    requestId: 'feedback-test',
    ...overrides,
  };
}

function row(id = 3) {
  return {
    id,
    title: '连接页报错',
    description: '用户在连接页保存配置时看到错误提示。',
    source: 'manual',
    created_by: 7,
    created_by_username: 'alice',
    created_at: new Date('2026-09-04T00:00:00Z'),
    updated_at: new Date('2026-09-04T01:00:00Z'),
  };
}

describe('FeedbackService', () => {
  it('limits ordinary users to their own feedback and lets administrators list all feedback', async () => {
    const execute = vi.fn().mockResolvedValue([[row()], []]);
    const service = new FeedbackService(() => ({ execute } as any));

    await service.list(actor());
    expect(execute.mock.calls[0][0]).toContain('WHERE f.created_by = ?');
    expect(execute.mock.calls[0][1]).toEqual([7]);

    await service.list(actor({ username: 'admin', roles: ['admin'] }));
    expect(execute.mock.calls[1][0]).not.toContain('WHERE f.created_by = ?');
    expect(execute.mock.calls[1][1]).toEqual([]);
  });

  it('creates trimmed feedback and reads it back in the same actor scope', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ insertId: 3 }, []])
      .mockResolvedValueOnce([[row()], []]);
    const service = new FeedbackService(() => ({ execute } as any));

    const item = await service.create(actor(), {
      title: ' 连接页报错 ',
      description: ' 用户在连接页保存配置时看到错误提示。 ',
      source: 'manual',
    });

    expect(item.id).toBe(3);
    expect(execute.mock.calls[0][1]).toEqual([
      '连接页报错',
      '用户在连接页保存配置时看到错误提示。',
      'manual',
      7,
      7,
      null,
    ]);
    expect(execute.mock.calls[1][1]).toEqual([3, 7]);
  });

  it('checks visibility before update and delete operations', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[row()], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ ...row(), title: '更新后的标题' }], []])
      .mockResolvedValueOnce([[row()], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const service = new FeedbackService(() => ({ execute } as any));

    await expect(service.update(actor(), 3, {
      title: '更新后的标题',
      description: '用户在连接页保存配置时仍然看到错误提示。',
    })).resolves.toMatchObject({ title: '更新后的标题' });
    await expect(service.delete(actor(), 3)).resolves.toBeUndefined();
    expect(execute.mock.calls[0][1]).toEqual([3, 7]);
    expect(execute.mock.calls[3][1]).toEqual([3, 7]);
  });

  it('rejects empty or oversized payloads before querying storage', async () => {
    const execute = vi.fn();
    const service = new FeedbackService(() => ({ execute } as any));
    await expect(service.create(actor(), { title: '', description: '描述', source: 'manual' }))
      .rejects.toThrow('FEEDBACK_PAYLOAD_INVALID');
    await expect(service.create(actor(), { title: '标题', description: 'x'.repeat(5001), source: 'manual' }))
      .rejects.toThrow('FEEDBACK_PAYLOAD_INVALID');
    expect(execute).not.toHaveBeenCalled();
  });
});
