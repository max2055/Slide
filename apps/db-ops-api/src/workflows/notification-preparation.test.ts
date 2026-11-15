// MAX-598 / GitHub #630, #700: use the real sender; inject only external boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import * as https from 'node:https';
import { NotificationService } from '../notification-service.js';
import { exchangeMicrosoftSmtpRefreshToken } from '../smtp-oauth2.js';
import { resolveOutboundTarget, OutboundPolicyError } from '../security/outbound-policy.js';
import { JobRegistry } from './job-registry.js';
import { registerNotificationHandlers } from './notification-handlers.js';
import type { DeliveryGate, DeliveryRequest } from './delivery-store.js';
import type { RolloutAlertPublicationGate } from '../metrics/rollout/alert-publication-fence.js';

vi.mock('../maintenance-notification.js', () => ({ maintenanceBlocksDelivery: async () => false }));
vi.mock('../smtp-oauth2.js', () => ({ exchangeMicrosoftSmtpRefreshToken: vi.fn() }));
vi.mock('../db-connection.js', () => ({
  dbConnection: { getPool: () => null }, decryptData: () => 'test-refresh-token',
}));
vi.mock('../security/outbound-policy.js', async original => ({
  ...await original<typeof import('../security/outbound-policy.js')>(), resolveOutboundTarget: vi.fn(),
}));
vi.mock('node:https', async original => ({
  ...await original<typeof import('node:https')>(), request: vi.fn(),
}));

const email = { id: 1, name: 'isolated', type: 'email' as const, enabled: true,
  config: { smtp_host: 'smtp.example.test', smtp_port: 587, smtp_username: 'sender@example.test',
    smtp_auth: 'oauth2' as const, oauth2_tenant: 'consumers', oauth2_client_id: 'test-client',
    oauth2_refresh_token_encrypted: 'test-encrypted', from: 'sender@example.test', to: 'receiver@example.test' },
  created_at: new Date(), updated_at: new Date() };
const webhook = { ...email, type: 'webhook' as const, config: { webhook_url: 'https://receiver.example.test' } };
const fence = { series_hash: 'a'.repeat(64), source: 'semantic', generation: 1, revision: 1 };

function setup(channel = webhook as typeof email | typeof webhook, publicationGate?: RolloutAlertPublicationGate, retryDeadline?: number) {
  const controller = new AbortController();
  const finishes: Array<{ state: string; error?: string }> = [];
  let frozen: DeliveryRequest | null = null;
  let state = 'ready';
  const gate: DeliveryGate = {
    skipDisabled: async () => {},
    preflightFailed: async () => {},
    snapshot: async () => frozen,
    acquire: vi.fn(async (_job, context, request) => {
      context.signal.throwIfAborted();
      if (state === 'unknown') throw new Error('DELIVERY_RECONCILIATION_REQUIRED');
      frozen ??= request;
      state = 'sending';
      return { key: 'test', attemptId: 'test', request: frozen!, retryDeadline };
    }),
    finish: vi.fn(async (_job, context, _claim, next, error) => {
      context.signal.throwIfAborted();
      state = next;
      finishes.push({ state: next, error });
    }),
  };
  const registry = new JobRegistry();
  registerNotificationHandlers(registry, {
    getAlertById: async () => ({ id: 1, level: 'warning', title: 'test', message: 'test',
      source: 'metrics-rollout', tags: { rollout_fence: fence }, created_at: new Date() }) as any,
    getChannelById: async () => channel,
  }, new NotificationService(), {
    getReportById: async () => ({ id: 1, name: 'test' }) as any,
  }, gate, publicationGate ?? { run: async (_id, _fence, publish) => { await publish(); return 'published'; } });
  return { controller, finishes, gate, run: (type = 'report.notify') => registry.execute({
    id: 'test', type, payload: { reportId: 1, alertId: 1, channelId: 1 },
    attempts: 1, maxAttempts: 3, fencingToken: 1,
  }, { workerId: 'test', fencingToken: 1, signal: controller.signal }) };
}

beforeEach(() => {
  vi.mocked(resolveOutboundTarget).mockResolvedValue({ url: new URL(webhook.config.webhook_url), addresses: ['203.0.113.10'] });
  vi.mocked(exchangeMicrosoftSmtpRefreshToken).mockResolvedValue({ accessToken: 'test-access' } as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('preparation and transport outcome boundary', () => {
  it.each(['report.notify', 'notification.deliver'])('OAuth failure remains retryable for %s and the next attempt sends', async type => {
    const sendMail = vi.fn().mockResolvedValue({});
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close: vi.fn() } as any);
    vi.mocked(exchangeMicrosoftSmtpRefreshToken).mockRejectedValueOnce(new Error('OAuth secret details'));
    const test = setup(email);
    await expect(test.run(type)).rejects.toThrow('EMAIL_DELIVERY_FAILED');
    expect(sendMail).not.toHaveBeenCalled();
    expect(test.finishes).toEqual([{ state: 'retryable', error: 'EMAIL_DELIVERY_FAILED' }]);
    await test.run(type);
    expect(sendMail).toHaveBeenCalledOnce();
    expect(test.finishes.at(-1)?.state).toBe('sent');
  });

  it('DNS failure is retryable without a receiver deduplication contract', async () => {
    vi.mocked(resolveOutboundTarget).mockRejectedValueOnce(new OutboundPolicyError('DNS_FAILED'));
    const test = setup();
    await expect(test.run()).rejects.toThrow('DNS_FAILED');
    expect(https.request).not.toHaveBeenCalled();
    expect(test.finishes).toEqual([{ state: 'retryable', error: 'DNS_FAILED' }]);
  });

  it.each(['oauth', 'dns', 'after-acquire'])('cancellation at %s settles retryable before transport', async phase => {
    const sendMail = vi.fn();
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close: vi.fn() } as any);
    const test = setup(phase === 'oauth' ? email : webhook);
    if (phase === 'oauth') vi.mocked(exchangeMicrosoftSmtpRefreshToken).mockImplementationOnce(async () => {
      test.controller.abort(new Error('SEND_CANCELLED')); return { accessToken: 'test' } as any;
    });
    if (phase === 'dns') vi.mocked(resolveOutboundTarget).mockImplementationOnce(async () => {
      test.controller.abort(new Error('SEND_CANCELLED')); return { url: new URL(webhook.config.webhook_url), addresses: ['203.0.113.10'] };
    });
    if (phase === 'after-acquire') {
      const acquire = test.gate.acquire;
      vi.spyOn(test.gate, 'acquire').mockImplementationOnce(async (...args) => {
        const claim = await acquire(...args); test.controller.abort(new Error('SEND_CANCELLED')); return claim;
      });
    }
    await expect(test.run()).rejects.toThrow('SEND_CANCELLED');
    expect(test.finishes).toEqual([{ state: 'retryable', error: 'SEND_CANCELLED' }]);
    expect(sendMail).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });

  it.each([false, true])('SMTP failure after sendMail remains unknown (cancelled=%s)', async cancel => {
    const test = setup(email);
    const sendMail = vi.fn(async () => {
      if (cancel) test.controller.abort(new Error('SEND_CANCELLED'));
      throw new Error('receipt lost');
    });
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close: vi.fn() } as any);
    await expect(test.run()).rejects.toThrow(cancel ? 'SEND_CANCELLED' : 'DELIVERY_TRANSPORT_UNCERTAIN');
    // After-send cancellation leaves the durable sending claim uncertain on lease expiry.
    expect(test.finishes).toEqual(cancel ? [] : [{ state: 'unknown', error: 'DELIVERY_OUTCOME_UNCERTAIN' }]);
    if (!cancel) await expect(test.run()).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('HTTP request failure after invocation remains unknown', async () => {
    vi.mocked(https.request).mockImplementationOnce(() => { throw new Error('request failed'); });
    const test = setup();
    await expect(test.run()).rejects.toThrow('DELIVERY_TRANSPORT_UNCERTAIN');
    expect(test.finishes).toEqual([{ state: 'unknown', error: 'DELIVERY_OUTCOME_UNCERTAIN' }]);
    await expect(test.run()).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
    expect(https.request).toHaveBeenCalledOnce();
  });

  it('a preparation failure on a contracted retry preserves the earlier uncertain outcome', async () => {
    vi.mocked(resolveOutboundTarget).mockRejectedValueOnce(new OutboundPolicyError('DNS_FAILED'));
    const test = setup(webhook, undefined, Date.now() + 60000);
    await expect(test.run()).rejects.toThrow('DNS_FAILED');
    expect(https.request).not.toHaveBeenCalled();
    expect(test.finishes).toEqual([{ state: 'unknown', error: 'DELIVERY_OUTCOME_UNCERTAIN' }]);
  });

  it('serialization fails before HTTP invocation and remains retryable', async () => {
    const test = setup();
    // The scheduled report body is constructed by the production handler.
    vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('serialization'); });
    await expect(test.run()).rejects.toThrow('OUTBOUND_REQUEST_FAILED');
    expect(https.request).not.toHaveBeenCalled();
    expect(test.finishes).toEqual([{ state: 'retryable', error: 'OUTBOUND_REQUEST_FAILED' }]);
  });

  it.each(['ROLLOUT_ALERT_FENCE_UNAVAILABLE', 'ER_LOCK_DEADLOCK', 'database details with secrets'])(
    'only a genuine fence outage keeps its code: %s', async original => {
      const test = setup(webhook, { run: async () => { throw new Error(original); } });
      const expected = original.includes(' ') ? 'DELIVERY_PREPARATION_FAILED' : original;
      await expect(test.run('notification.deliver')).rejects.toThrow(expected);
      expect(test.finishes).toEqual([{ state: 'retryable', error: expected }]);
      expect(https.request).not.toHaveBeenCalled();
    });
});
