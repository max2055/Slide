import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const CHAT_PROTOCOL_VERSION = 2;
export const ChatSendV2 = Type.Object({
  type: Type.Literal('chat.send'),
  protocolVersion: Type.Literal(CHAT_PROTOCOL_VERSION),
  messageId: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 16, maxLength: 128 }),
  sessionKey: Type.Optional(Type.String({ maxLength: 512 })),
  message: Type.String({ minLength: 1, maxLength: 32_000 }),
  attachments: Type.Optional(Type.Array(Type.Never(), { maxItems: 0 })),
});
export type ChatSendV2 = Static<typeof ChatSendV2>;

export function validateChatSendV2(value: unknown): { ok: true; value: ChatSendV2 } | { ok: false; error: string } {
  if (!Value.Check(ChatSendV2, value)) return { ok: false, error: 'PROTOCOL_V2_INVALID' };
  return { ok: true, value: value as ChatSendV2 };
}
