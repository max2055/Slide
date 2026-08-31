import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execute, encryptData } = vi.hoisted(() => ({
  execute: vi.fn(),
  encryptData: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock('./db-connection.js', () => ({
  dbConnection: { getPool: () => ({ execute }), isConnected: () => true },
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
      .mockResolvedValueOnce([[{ config: JSON.stringify({ password_encrypted: 'encrypted:old-password', smtp_host: 'smtp.old.example' }) }]])
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
        { config: JSON.stringify({
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
        { config: JSON.stringify({
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
