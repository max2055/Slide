import { describe, expect, it } from 'vitest';
import {
  validateNotificationChannelConfig,
  validateEmailChannelConfig,
} from './notification-channel-config.js';

describe('email notification channel configuration', () => {
  it('accepts a password-authenticated SMTP configuration', () => {
    const result = validateEmailChannelConfig({
      smtp_host: 'smtp.example.com',
      smtp_port: '587',
      smtp_username: 'alerts@example.com',
      password: 'app-password',
      from: 'alerts@example.com',
      to: 'dba@example.com, oncall@example.com',
      smtp_secure: false,
    });

    expect(result).toMatchObject({ valid: true });
    if (result.valid) {
      expect(result.config.smtp_port).toBe(587);
      expect(result.config.smtp_auth).toBe('password');
    }
  });

  it('accepts OAuth2 without requiring a password', () => {
    const result = validateEmailChannelConfig({
      smtp_host: 'smtp-mail.outlook.com',
      smtp_port: 587,
      smtp_username: 'alerts@example.com',
      smtp_auth: 'oauth2',
      oauth2_tenant: 'common',
      oauth2_client_id: 'client-id',
      oauth2_refresh_token: 'refresh-token',
      from: 'alerts@example.com',
      to: ['dba@example.com'],
    });

    expect(result).toMatchObject({ valid: true });
  });

  it('rejects an SMTP port outside the TCP range', () => {
    const result = validateEmailChannelConfig({
      smtp_host: 'smtp.example.com', smtp_port: 70000,
      smtp_username: 'alerts@example.com', password: 'secret',
      from: 'alerts@example.com', to: 'dba@example.com',
    });

    expect(result).toMatchObject({ valid: false, code: 'EMAIL_CONFIGURATION_INVALID', field: 'smtp_port' });
  });

  it('rejects malformed sender and recipient addresses', () => {
    const result = validateEmailChannelConfig({
      smtp_host: 'smtp.example.com', smtp_port: 465,
      smtp_username: 'alerts@example.com', password: 'secret',
      from: 'not-an-email', to: 'dba@example.com',
    });

    expect(result).toMatchObject({ valid: false, field: 'from' });
  });

  it('rejects SMTP hosts containing a URL or whitespace', () => {
    const result = validateEmailChannelConfig({
      smtp_host: 'https://smtp.example.com', smtp_port: 465,
      smtp_username: 'alerts@example.com', password: 'secret',
      from: 'alerts@example.com', to: 'dba@example.com',
    });

    expect(result).toMatchObject({ valid: false, field: 'smtp_host' });
  });

  it('allows partial updates while still validating supplied fields', () => {
    const result = validateNotificationChannelConfig('email', {
      smtp_host: 'smtp.new.example.com',
      smtp_port: '2525',
    }, { partial: true, allowEncryptedCredentials: false });

    expect(result).toMatchObject({ valid: true });
    if (result.valid) expect(result.config.smtp_port).toBe(2525);
  });

  it('does not inject password auth into a partial OAuth2 update', () => {
    const result = validateNotificationChannelConfig('email', { smtp_port: 2525 }, { partial: true });

    expect(result).toMatchObject({ valid: true });
    if (result.valid) expect(result.config).not.toHaveProperty('smtp_auth');
  });

  it('does not infer password authentication when a partial update omits smtp_auth', () => {
    const result = validateNotificationChannelConfig('email', {
      smtp_port: 2525,
    }, { partial: true, allowEncryptedCredentials: false });

    expect(result).toMatchObject({ valid: true });
    if (result.valid) expect(result.config).not.toHaveProperty('smtp_auth');
  });

  it('does not allow clients to submit encrypted credential material', () => {
    const result = validateNotificationChannelConfig('email', {
      smtp_host: 'smtp.example.com', smtp_port: 587,
      smtp_username: 'alerts@example.com', password_encrypted: 'ciphertext',
      from: 'alerts@example.com', to: 'dba@example.com',
    }, { allowEncryptedCredentials: false });

    expect(result).toMatchObject({ valid: false, field: 'password' });
  });

  it('rejects unsupported notification channel types', () => {
    const result = validateNotificationChannelConfig('pager', {});

    expect(result).toMatchObject({ valid: false, code: 'NOTIFICATION_CHANNEL_TYPE_INVALID' });
  });
});
