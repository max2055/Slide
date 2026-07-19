import { describe, expect, it } from 'vitest';
import { publicInstanceDto, publicNotificationDto, publicServerDto } from './public-dto.js';

describe('public response DTOs', () => {
  it('removes encrypted instance credentials and connection strings', () => {
    const dto = publicInstanceDto({ id: 1, host: 'db.example.com', password_encrypted: 'ciphertext', connection_string: 'mysql://root:secret@db' });
    expect(dto).toMatchObject({ id: 1, hasCredential: true, credentialVersion: 1 });
    expect(dto).not.toHaveProperty('password_encrypted');
    expect(dto).not.toHaveProperty('connection_string');
  });

  it('removes encrypted SSH credentials', () => {
    const dto = publicServerDto({ id: 2, host: 'ssh.example.com', credential_encrypted: 'ciphertext' });
    expect(dto).toMatchObject({ id: 2, hasCredential: true, credentialVersion: 1 });
    expect(dto).not.toHaveProperty('credential_encrypted');
  });

  it('redacts notification credentials and webhook paths', () => {
    const dto = publicNotificationDto({ id: 3, config: {
      webhook_url: 'https://hooks.example.com/private-token',
      secret: 'secret-value',
      password_encrypted: 'encrypted-smtp-password',
    } });
    expect(dto).toMatchObject({ config: { endpoint: 'https://hooks.example.com', hasCredential: true } });
    expect(JSON.stringify(dto)).not.toContain('secret-value');
    expect(JSON.stringify(dto)).not.toContain('private-token');
    expect(JSON.stringify(dto)).not.toContain('encrypted-smtp-password');
  });
});
