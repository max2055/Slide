import { describe, expect, it } from 'vitest';
import { loadSecurityConfig, requireEncryptionKey, SecurityConfigurationError } from './security-config.js';

const secure = {
  NODE_ENV: 'production',
  JWT_SECRET_KEY: 'j'.repeat(32),
  ENCRYPTION_KEY: 'e'.repeat(32),
  INITIAL_ADMIN_USERNAME: 'bootstrap-admin',
  INITIAL_ADMIN_PASSWORD: 'p'.repeat(32),
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
});
