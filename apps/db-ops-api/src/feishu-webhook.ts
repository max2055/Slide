import { createHmac } from 'node:crypto';

/** Feishu custom bots require timestamp/sign as JSON fields, not URL parameters. */
export function signFeishuWebhookPayload<T extends Record<string, unknown>>(
  payload: T,
  secret: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): T & { timestamp: string; sign: string } {
  const timestamp = String(timestampSeconds);
  const sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  return { timestamp, sign, ...payload };
}
