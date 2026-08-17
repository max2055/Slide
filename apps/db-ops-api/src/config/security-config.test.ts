import { describe, expect, it } from 'vitest';
import { loadSecurityConfig, requireEncryptionKey, SecurityConfigurationError } from './security-config.js';

const secure = {
  NODE_ENV: 'production',
  JWT_SECRET_KEY: 'j'.repeat(32),
  ENCRYPTION_KEY: 'e'.repeat(32),
  INITIAL_ADMIN_USERNAME: 'bootstrap-admin',
  INITIAL_ADMIN_PASSWORD: 'p'.repeat(32),
  DB_ALLOWED_CIDRS: '10.20.0.0/16',
  DB_ALLOWED_PORTS: '3306,5432',
  SERVER_ALLOWED_CIDRS: '10.30.0.0/16',
  SERVER_ALLOWED_PORTS: '22,2222',
};

describe('security startup configuration', () => {
  it('rejects production configuration with missing, default, or reused secrets', () => {
    expect(() => loadSecurityConfig({ ...secure, JWT_SECRET_KEY: '' })).toThrow(SecurityConfigurationError);
    expect(() => loadSecurityConfig({ ...secure, ENCRYPTION_KEY: 'change-this-to-a-random-32-char-key' })).toThrow(SecurityConfigurationError);
    expect(() => loadSecurityConfig({ ...secure, ENCRYPTION_KEY: secure.JWT_SECRET_KEY })).toThrow(SecurityConfigurationError);
    expect(() => loadSecurityConfig({ ...secure, INITIAL_ADMIN_PASSWORD: '' })).toThrow(SecurityConfigurationError);
  });

  it('accepts distinct configured production secrets and never supplies an encryption fallback', () => {
    expect(loadSecurityConfig(secure)).toMatchObject({ production: true, initialAdminConfigured: true });
    expect(() => requireEncryptionKey('short')).toThrow(SecurityConfigurationError);
  });

  it('rejects encryption keys that are long enough but do not encode exactly 32 bytes', () => {
    expect(() => loadSecurityConfig({ ...secure, ENCRYPTION_KEY: 'x'.repeat(33) })).toThrow(SecurityConfigurationError);
    expect(() => requireEncryptionKey('x'.repeat(33))).toThrow(SecurityConfigurationError);
    expect(requireEncryptionKey('0123456789abcdef'.repeat(4))).toHaveLength(64);
  });

  it.each(['DB_ALLOWED_CIDRS', 'DB_ALLOWED_PORTS', 'SERVER_ALLOWED_CIDRS', 'SERVER_ALLOWED_PORTS'])
  ('rejects production configuration without %s', (key) => {
    expect(() => loadSecurityConfig({ ...secure, [key]: '' })).toThrow(SecurityConfigurationError);
  });

  it.each([
    ['DB_ALLOWED_CIDRS', '10.0.0.0/99'],
    ['SERVER_ALLOWED_CIDRS', 'not-a-cidr'],
    ['DB_ALLOWED_PORTS', '0,70000'],
    ['SERVER_ALLOWED_PORTS', 'ssh'],
  ])('rejects malformed production target policy %s', (key, value) => {
    expect(() => loadSecurityConfig({ ...secure, [key]: value })).toThrow(SecurityConfigurationError);
  });
});
