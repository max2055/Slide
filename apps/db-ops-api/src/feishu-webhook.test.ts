import { describe, expect, it } from 'vitest';
import { signFeishuWebhookPayload } from './feishu-webhook.js';

describe('Feishu custom webhook signing', () => {
  it('adds the documented timestamp and HMAC-SHA256 signature to the JSON body', () => {
    expect(signFeishuWebhookPayload(
      { msg_type: 'text', content: { text: '数据库告警' } },
      'test-secret',
      1599360473,
    )).toEqual({
      timestamp: '1599360473',
      sign: 'wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=',
      msg_type: 'text',
      content: { text: '数据库告警' },
    });
  });
});
