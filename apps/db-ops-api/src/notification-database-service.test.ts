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
