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
  // #504 / MAX-266: length alone must not accept whitespace as a secret.
  it.each([
    ['missing', undefined], ['empty', ''], ['31 spaces', ' '.repeat(31)],
    ['32 spaces', ' '.repeat(32)], ['tabs/newlines', '\t\r\n '.repeat(8)],
    ['Unicode whitespace', '\u00a0\u2003\u2028\u3000'.repeat(8)],
  ])('rejects %s in both secret entrypoints', (_name, value) => {
    expect(() => loadSecurityConfig({ ...secure, JWT_SECRET_KEY: value })).toThrow(SecurityConfigurationError);
    expect(() => loadSecurityConfig({ ...secure, ENCRYPTION_KEY: value })).toThrow(SecurityConfigurationError);
    expect(() => requireEncryptionKey(value)).toThrow(SecurityConfigurationError);
  });

  it('preserves JWT length boundaries and the exact signing secret, including surrounding newlines', () => {
    expect(() => loadSecurityConfig({ ...secure, JWT_SECRET_KEY: 'j'.repeat(31) })).toThrow(SecurityConfigurationError);
    for (const value of ['j'.repeat(32), 'j'.repeat(33), '\n' + 'j'.repeat(30) + '\n', '密'.repeat(32)]) {
      expect(loadSecurityConfig({ ...secure, JWT_SECRET_KEY: value }).jwtSecret).toBe(value);
    }
  });

  it('preserves UTF-8, hex and base64 encryption formats without trimming or widening the contract', () => {
    for (const value of ['e'.repeat(32), '\n' + 'e'.repeat(30) + '\n', '0123456789abcdef'.repeat(4), Buffer.alloc(32, 7).toString('base64')]) {
      expect(loadSecurityConfig({ ...secure, ENCRYPTION_KEY: value }).encryptionKey).toBe(value);
      expect(requireEncryptionKey(value)).toBe(value);
    }
    for (const value of ['e'.repeat(31), 'e'.repeat(33), '\n' + 'ab'.repeat(32) + '\n', Buffer.alloc(31, 7).toString('base64'), '密'.repeat(32)]) {
      expect(() => requireEncryptionKey(value)).toThrow(SecurityConfigurationError);
    }
  });

  it.each(['change-this-to-a-random-32-char-key', '\nCHANGE-THIS-TO-A-RANDOM-32-CHAR-KEY\n', 'your-secret-key-min-32-chars', 'your-jwt-secret-key', 'secret'])(
    'rejects known default variants', value => {
      for (const field of ['JWT_SECRET_KEY', 'ENCRYPTION_KEY']) {
        try { loadSecurityConfig({ ...secure, [field]: value }); throw new Error('accepted default'); }
        catch (error) {
          expect(error).toBeInstanceOf(SecurityConfigurationError);
          expect((error as Error).message).toMatch(new RegExp(`^${field} must `));
        }
      }
    },
  );

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

});

it('MAX-267 rejects blank identities, weak and bcrypt-truncated bootstrap passwords', () => {
  for (const INITIAL_ADMIN_USERNAME of [' ', 'x'.repeat(51)]) {
    expect(() => loadSecurityConfig({ ...secure, INITIAL_ADMIN_USERNAME })).toThrow();
  }
  for (const INITIAL_ADMIN_PASSWORD of [' ', 'Tpam1234', 'x'.repeat(73)]) {
    expect(() => loadSecurityConfig({ ...secure, INITIAL_ADMIN_PASSWORD })).toThrow();
  }
});
