import { describe, expect, it, vi } from 'vitest';

vi.mock('./security/outbound-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./security/outbound-policy.js')>();
  return { ...actual, resolveOutboundTarget: vi.fn() };
});

import { NotificationService } from './notification-service.js';
import { resolveOutboundTarget } from './security/outbound-policy.js';

const channel = {
  id: 1,
  name: 'qualification webhook',
  type: 'webhook' as const,
  enabled: true,
  config: { webhook_url: 'https://hooks.example.com/report' },
  created_at: new Date('2026-07-19T00:00:00.000Z'),
  updated_at: new Date('2026-07-19T00:00:00.000Z'),
};

const emailChannel = {
  id: 2,
  name: 'qualification email',
  type: 'email' as const,
  enabled: true,
  config: {
    smtp_host: 'smtp.example.com',
    smtp_port: 587,
    smtp_username: 'alerts@example.com',
    password: 'app-password',
    from: 'alerts@example.com',
    to: 'dba@example.com',
  },
  created_at: new Date('2026-07-19T00:00:00.000Z'),
  updated_at: new Date('2026-07-19T00:00:00.000Z'),
};

describe('NotificationService outbound delivery', () => {
  it('records a successful 2xx response from a verified, pinned target', async () => {
    vi.mocked(resolveOutboundTarget).mockResolvedValue({
      url: new URL(channel.config.webhook_url), addresses: ['203.0.113.10'],
    });
    const service = new NotificationService();
    const post = vi.spyOn(service as any, 'postJsonToVerifiedTarget').mockResolvedValue({ statusCode: 204, body: '' });

    await expect(service.send(channel, { type: 'report', reportId: 7 })).resolves.toEqual({ success: true });
    expect(post).toHaveBeenCalledWith(channel.config.webhook_url, ['203.0.113.10'], { type: 'report', reportId: 7 });
  });

  it('does not follow redirects from a verified target', async () => {
    vi.mocked(resolveOutboundTarget).mockResolvedValue({
      url: new URL(channel.config.webhook_url), addresses: ['203.0.113.10'],
    });
    const service = new NotificationService();
    vi.spyOn(service as any, 'postJsonToVerifiedTarget').mockResolvedValue({ statusCode: 302, body: '' });

    await expect(service.send(channel, { type: 'report', reportId: 7 }))
      .resolves.toEqual({ success: false, error: 'OUTBOUND_REDIRECT_DENIED' });
  });

  it('delivers an email notification through the configured SMTP transport', async () => {
    const service = new NotificationService();
    const sendEmail = vi.spyOn(service as any, 'sendEmail').mockResolvedValue(undefined);

    await expect(service.send(emailChannel, {
      subject: '[CRITICAL] qualification alert',
      text: 'Database CPU is above threshold.',
    })).resolves.toEqual({ success: true });

    expect(sendEmail).toHaveBeenCalledWith(emailChannel.config, {
      subject: '[CRITICAL] qualification alert',
      text: 'Database CPU is above threshold.',
    });
  });

  it('returns a safe error when an email channel is missing its recipient', async () => {
    const service = new NotificationService();
    const incompleteChannel = { ...emailChannel, config: { ...emailChannel.config, to: '' } };

    await expect(service.send(incompleteChannel, { subject: 'test', text: 'test' }))
      .resolves.toEqual({ success: false, error: 'EMAIL_CONFIGURATION_INVALID' });
  });

  it('accepts an OAuth2 email channel without a password credential', async () => {
    const service = new NotificationService();
    const sendEmail = vi.spyOn(service as any, 'sendEmail').mockResolvedValue(undefined);
    const oauthChannel = {
      ...emailChannel,
      config: {
        smtp_host: 'smtp-mail.outlook.com', smtp_port: 587, smtp_username: 'alerts@example.com',
        smtp_auth: 'oauth2' as const, oauth2_tenant: 'consumers', oauth2_client_id: 'client-id',
        oauth2_refresh_token_encrypted: 'encrypted-refresh-token', from: 'alerts@example.com', to: 'dba@example.com',
      },
    };

    await expect(service.send(oauthChannel, { subject: 'test', text: 'test' }))
      .resolves.toEqual({ success: true });
    expect(sendEmail).toHaveBeenCalledWith(oauthChannel.config, { subject: 'test', text: 'test' });
  });
});
