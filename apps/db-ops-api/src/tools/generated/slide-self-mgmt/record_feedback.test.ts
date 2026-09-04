import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../auth/actor-context.js';
import { createRecordFeedbackTool } from './record_feedback.js';

const actor: ActorContext = {
  userId: 7,
  username: 'alice',
  roles: [],
  permissions: [],
  sessionVersion: 1,
  instanceScopes: {},
  requestId: 'record-feedback-test',
};

describe('slide_record_feedback', () => {
  it('describes the explicit third-person reporting contract and stores Agent feedback', async () => {
    const create = vi.fn().mockResolvedValue({ id: 12, title: '连接页无法保存' });
    const tool = createRecordFeedbackTool({ create } as any);
    expect(tool.description).toContain('用户明确要求');
    expect(tool.description).toContain('第三人称');

    const result = await tool.handler({
      title: '连接页无法保存',
      description: '用户在连接页点击保存后，页面提示请求失败。',
    }, { actor, idempotencyKey: 'chat-request-1234567890' });

    expect(result).toMatchObject({ success: true, data: { feedbackId: 12 } });
    expect(create).toHaveBeenCalledWith(actor, expect.objectContaining({
      source: 'agent',
      description: '用户在连接页点击保存后，页面提示请求失败。',
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('fails closed without an authenticated actor', async () => {
    const create = vi.fn();
    const result = await createRecordFeedbackTool({ create } as any).handler({
      title: '标题',
      description: '用户遇到了问题。',
    });
    expect(result).toMatchObject({ success: false, errorCode: 'AUTHENTICATION_REQUIRED' });
    expect(create).not.toHaveBeenCalled();
  });
});
