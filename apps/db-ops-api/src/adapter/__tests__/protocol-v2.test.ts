import { describe, expect, it } from 'vitest';
import { CHAT_PROTOCOL_VERSION, validateChatSendV2 } from '../protocol-v2.js';

describe('WS protocol v2', () => {
  const valid = { type: 'chat.send', protocolVersion: CHAT_PROTOCOL_VERSION, messageId: 'message-1', idempotencyKey: '1234567890abcdef', sessionKey: 'session-1', message: 'hello' };
  it('accepts a bounded v2 chat send frame', () => expect(validateChatSendV2(valid).ok).toBe(true));
  it('rejects unknown versions, oversized content, and unsupported attachments', () => {
    expect(validateChatSendV2({ ...valid, protocolVersion: 3 }).ok).toBe(false);
    expect(validateChatSendV2({ ...valid, message: 'x'.repeat(32_001) }).ok).toBe(false);
    expect(validateChatSendV2({ ...valid, attachments: [{ name: 'x' }] }).ok).toBe(false);
  });
});
