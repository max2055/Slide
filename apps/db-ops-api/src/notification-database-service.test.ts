import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execute, encryptData } = vi.hoisted(() => ({
  execute: vi.fn(),
  encryptData: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock('./db-connection.js', () => ({
  dbConnection: { getPool: () => ({ execute, getConnection: async () => ({ execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }) }), isConnected: () => true },
  encryptData,
}));

import { notificationDatabaseService } from './notification-database-service.js';

describe('NotificationDatabaseService email credentials', () => {
  beforeEach(() => {
    execute.mockReset();
    encryptData.mockClear();
  });

  it('encrypts an email SMTP password before storing channel configuration', async () => {
    execute.mockResolvedValue([{ insertId: 9 }]);

    await expect(notificationDatabaseService.createChannel({
      name: 'mail',
      type: 'email',
      config: { smtp_host: 'smtp.example.com', password: 'app-password' },
    })).resolves.toEqual({ success: true, channelId: 9 });

    const config = JSON.parse(execute.mock.calls[0][1][2]);
    expect(encryptData).toHaveBeenCalledWith('app-password');
    expect(config).toMatchObject({ smtp_host: 'smtp.example.com', password_encrypted: 'encrypted:app-password' });
    expect(config).not.toHaveProperty('password');
  });

  it('keeps an existing encrypted SMTP password when an update omits it', async () => {
    execute
      .mockResolvedValueOnce([[{ type: 'email', config: JSON.stringify({ password_encrypted: 'encrypted:old-password', smtp_host: 'smtp.old.example' }) }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(notificationDatabaseService.updateChannel(9, {
      config: { smtp_host: 'smtp.new.example' },
    })).resolves.toEqual({ success: true });

    const config = JSON.parse(execute.mock.calls[1][1][0]);
    expect(config).toMatchObject({ smtp_host: 'smtp.new.example', password_encrypted: 'encrypted:old-password' });
    expect(encryptData).not.toHaveBeenCalled();
  });

  it('keeps an existing encrypted OAuth refresh token when an update omits it', async () => {
    execute
      .mockResolvedValueOnce([[
        { type: 'email', config: JSON.stringify({
          smtp_auth: 'oauth2',
          oauth2_refresh_token_encrypted: 'encrypted:old-refresh-token',
          smtp_host: 'smtp.old.example',
        }) },
      ]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(notificationDatabaseService.updateChannel(10, {
      config: {
        smtp_auth: 'oauth2',
        smtp_host: 'smtp.new.example',
        oauth2_tenant: 'common',
        oauth2_client_id: 'client-id',
      },
    })).resolves.toEqual({ success: true });

    const config = JSON.parse(execute.mock.calls[1][1][0]);
    expect(config).toMatchObject({
      smtp_host: 'smtp.new.example',
      oauth2_refresh_token_encrypted: 'encrypted:old-refresh-token',
    });
    expect(config).not.toHaveProperty('oauth2_refresh_token');
    expect(encryptData).not.toHaveBeenCalled();
  });

  it('merges a partial email config instead of dropping existing SMTP fields', async () => {
    execute
      .mockResolvedValueOnce([[
        { type: 'email', config: JSON.stringify({
          smtp_host: 'smtp.old.example',
          smtp_port: 587,
          smtp_username: 'alerts@example.com',
          smtp_auth: 'oauth2',
          oauth2_tenant: 'common',
          oauth2_client_id: 'old-client',
          oauth2_refresh_token_encrypted: 'encrypted:old-refresh-token',
          from: 'alerts@example.com',
          to: 'dba@example.com',
          severity: 'info',
        }) },
      ]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(notificationDatabaseService.updateChannel(10, {
      config: { smtp_port: 2525, oauth2_client_id: 'new-client' },
    })).resolves.toEqual({ success: true });

    const config = JSON.parse(execute.mock.calls[1][1][0]);
    expect(config).toMatchObject({
      smtp_host: 'smtp.old.example',
      smtp_port: 2525,
      smtp_username: 'alerts@example.com',
      smtp_auth: 'oauth2',
      oauth2_tenant: 'common',
      oauth2_client_id: 'new-client',
      oauth2_refresh_token_encrypted: 'encrypted:old-refresh-token',
      from: 'alerts@example.com',
      to: 'dba@example.com',
    });
  });

  it('encrypts OAuth refresh tokens before storing an email channel', async () => {
    execute.mockResolvedValue([{ insertId: 10 }]);

    await notificationDatabaseService.createChannel({
      name: 'oauth mail',
      type: 'email',
      config: { smtp_auth: 'oauth2', oauth2_refresh_token: 'refresh-token' },
    });

    const config = JSON.parse(execute.mock.calls[0][1][2]);
    expect(encryptData).toHaveBeenCalledWith('refresh-token');
    expect(config).toMatchObject({ oauth2_refresh_token_encrypted: 'encrypted:refresh-token' });
    expect(config).not.toHaveProperty('oauth2_refresh_token');
  });

  it('encrypts a webhook signing secret before storing a channel', async () => {
    execute.mockResolvedValue([{ insertId: 11 }]);

    await notificationDatabaseService.createChannel({
      name: 'feishu', type: 'feishu',
      config: { webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/example', secret: 'signing-secret' },
    });

    const config = JSON.parse(execute.mock.calls[0][1][2]);
    expect(encryptData).toHaveBeenCalledWith('signing-secret');
    expect(config).toMatchObject({ secret_encrypted: 'encrypted:signing-secret' });
    expect(config).not.toHaveProperty('secret');
  });

  it('atomically replaces a rotated OAuth refresh token without exposing plaintext', async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);

    await expect(notificationDatabaseService.updateOAuth2RefreshToken(10, 'rotated-refresh-token'))
      .resolves.toEqual({ success: true });

    expect(encryptData).toHaveBeenCalledWith('rotated-refresh-token');
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("JSON_SET(config, '$.oauth2_refresh_token_encrypted', ?)"),
      ['encrypted:rotated-refresh-token', 10],
    );
  });
});

describe('MAX-590 #296 / #342 credential ownership', () => {
  beforeEach(() => { execute.mockReset(); encryptData.mockClear(); });

  const legacy = {
    webhook_url_encrypted: 'encrypted:old-url', secret_encrypted: 'encrypted:old-secret',
    password_encrypted: 'encrypted:old-password', oauth2_refresh_token_encrypted: 'encrypted:old-refresh',
    smtp_host: 'smtp.example.test', unknownSecretAlias: 'sentinel-never-store',
  };
  async function update(type: string, data: Record<string, unknown>) {
    execute.mockResolvedValueOnce([[{ type, config: legacy }]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    expect(await notificationDatabaseService.updateChannel(9, data)).toEqual({ success: true });
    const args = execute.mock.calls[1][1];
    return JSON.parse(args.find((arg: unknown) => typeof arg === 'string' && arg.startsWith('{')));
  }

  it.each(['webhook', 'feishu', 'dingtalk', 'wecom'])('encrypts the entire %s URL and never stores unknown aliases', async type => {
    execute.mockResolvedValue([{ insertId: 9 }]);
    const url = 'https://hooks.example.test/sentinel-private-path?ArbitraryName=sentinel-bearer';
    await notificationDatabaseService.createChannel({ name: type, type,
      config: { webhook_url: url, unknownSecretAlias: 'sentinel-never-store' } });
    expect(JSON.parse(execute.mock.calls[0][1][2])).toEqual({ webhook_url_encrypted: 'encrypted:' + url });
  });

  it('does not restore email credentials after email to webhook switch', async () => {
    expect(await update('email', { type: 'webhook', config: { webhook_url: 'https://hooks.example.test/new',
      smtp_host: 'irrelevant', password: 'irrelevant', unknownSecretAlias: 'irrelevant' } }))
      .toEqual({ webhook_url_encrypted: 'encrypted:https://hooks.example.test/new' });
  });

  it('does not restore URL or signature after webhook to email switch', async () => {
    expect(await update('webhook', { type: 'email', config: { smtp_host: 'smtp.new.test', password: 'new-password',
      webhook_url: 'https://irrelevant.test', secret: 'irrelevant' } }))
      .toEqual({ smtp_host: 'smtp.new.test', password_encrypted: 'encrypted:new-password' });
  });

  it('clears old config on a type-only switch', async () => {
    expect(await update('email', { type: 'webhook' })).toEqual({});
  });

  it('preserves omitted same-type URL and signature, while removing inapplicable credentials', async () => {
    expect(await update('webhook', { config: { severity: 'p0' } })).toEqual({
      webhook_url_encrypted: legacy.webhook_url_encrypted, secret_encrypted: legacy.secret_encrypted, severity: 'p0',
    });
  });

  it.each(['', null])('explicitly clears optional webhook credentials with %s', async empty => {
    expect(await update('webhook', { config: { webhook_url: empty, secret: empty } })).toEqual({});
  });

  it.each(['', null])('explicitly clears email credentials with %s', async empty => {
    expect(await update('email', { config: { password: empty, oauth2_refresh_token: empty } }))
      .toEqual({ smtp_host: legacy.smtp_host });
  });

  it('does not replay or expose driver errors containing SQL values', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      execute.mockRejectedValueOnce(new Error('sentinel-private-path encrypted:old-url'));
      expect(await notificationDatabaseService.createChannel({ name: 'failing', type: 'webhook', config: {} }))
        .toEqual({ success: false, error: 'NOTIFICATION_CHANNEL_CREATE_FAILED' });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain('sentinel');
    } finally { log.mockRestore(); }
  });
});
