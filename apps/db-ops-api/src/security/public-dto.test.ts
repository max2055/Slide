import { describe, expect, it } from 'vitest';
import { publicInstanceDto, publicNetworkDeviceDto, publicNotificationDto, publicServerDto } from './public-dto.js';

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

  it('removes network device credential material while preserving presence flags', () => {
    const dto = publicNetworkDeviceDto({
      id: 3, host: '192.0.2.10', credential_encrypted: 'ssh-cipher',
      auth_secret_encrypted: 'auth-cipher', privacy_secret_encrypted: 'priv-cipher',
      has_snmp_credential: 1, has_ssh_credential: 1,
    });
    expect(dto).toMatchObject({ hasSnmpCredential: true, hasSshCredential: true, collection_enabled: false });
    expect(JSON.stringify(dto)).not.toContain('cipher');
  });

  it('uses an allowlist so joined/camelCase secret fields and backup content cannot leak', () => {
    const dto = publicNetworkDeviceDto({
      id: 4, name: 'edge-2', host: '192.0.2.11', collectionEnabled: true,
      credentialEncrypted: 'ssh-cipher', authSecret: 'snmp-auth', privacySecret: 'snmp-privacy',
      privateKeyEncrypted: 'key-cipher', contentEncrypted: 'backup-cipher', content: 'raw-config',
      arbitraryInternalValue: 'must-not-cross-boundary', hasSnmpCredential: true,
    });
    expect(dto).toMatchObject({ id: 4, name: 'edge-2', collection_enabled: true, hasSnmpCredential: true });
    expect(Object.keys(dto)).not.toContain('credentialEncrypted');
    expect(Object.keys(dto)).not.toContain('content');
    expect(JSON.stringify(dto)).not.toMatch(/cipher|snmp-auth|snmp-privacy|raw-config|must-not-cross-boundary/);
  });

  it('redacts notification credentials and webhook paths', () => {
    const dto = publicNotificationDto({ id: 3, config: {
      webhook_url: 'https://hooks.example.com/private-token',
      secret: 'secret-value',
      secret_encrypted: 'encrypted-webhook-secret',
      password_encrypted: 'encrypted-smtp-password',
    } });
    expect(dto).toMatchObject({ config: { endpoint: 'https://hooks.example.com', hasCredential: true } });
    expect(JSON.stringify(dto)).not.toContain('secret-value');
    expect(JSON.stringify(dto)).not.toContain('encrypted-webhook-secret');
    expect(JSON.stringify(dto)).not.toContain('private-token');
    expect(JSON.stringify(dto)).not.toContain('encrypted-smtp-password');
  });
});
