import { createHash } from 'node:crypto';
import { feedbackService, type FeedbackService } from '../../../feedback-service.js';
import type { AnyAgentTool } from '../../types.js';

type FeedbackWriter = Pick<FeedbackService, 'create'>;

export function createRecordFeedbackTool(service: FeedbackWriter = feedbackService): AnyAgentTool {
  return {
    name: 'slide_record_feedback',
    description: '仅当用户明确要求反馈或记录对话中遇到的问题时调用。调用前将问题整理为可直接发给开发者的简洁第三人称描述，不得写入密码、令牌或其他敏感信息。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '简洁的问题标题，最多 160 个字符' },
        description: { type: 'string', description: '面向开发者的第三人称问题描述，最多 5000 个字符' },
      },
      required: ['title', 'description'],
    },
    group: 'slide_self_mgmt',
    readOnly: false,
    requiresApproval: false,
    dangerLevel: 1,
    handler: async (args, context) => {
      if (!context?.actor) {
        return { success: false, errorCode: 'AUTHENTICATION_REQUIRED', error: '需要已认证用户' };
      }
      if (typeof args.title !== 'string' || typeof args.description !== 'string') {
        return { success: false, errorCode: 'FEEDBACK_PAYLOAD_INVALID', error: '标题和描述不能为空' };
      }
      try {
        const idempotencyKey = context.idempotencyKey
          ? createHash('sha256')
            .update(`${context.idempotencyKey}\0${args.title}\0${args.description}`)
            .digest('hex')
          : undefined;
        const item = await service.create(context.actor, {
          title: args.title,
          description: args.description,
          source: 'agent',
          idempotencyKey,
        });
        return {
          success: true,
          data: { feedbackId: item.id, title: item.title },
          summary: `问题反馈已记录：${item.title}`,
          artifacts: { feedbackId: item.id },
          next_actions: [],
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'FEEDBACK_OPERATION_FAILED';
        return { success: false, errorCode: reason, error: '问题反馈记录失败' };
      }
    },
  };
}

export const recordFeedbackTool = createRecordFeedbackTool();
