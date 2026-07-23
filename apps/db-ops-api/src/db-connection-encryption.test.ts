import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptData, encryptData, needsEncryptionMigration } from './db-connection.js';

const key = '0123456789abcdef'.repeat(4);

function legacyEncrypt(value: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key.slice(0, 32)), iv);
  return `${iv.toString('hex')}:${cipher.update(value, 'utf8', 'hex')}${cipher.final('hex')}`;
}

describe('versioned credential encryption', () => {
  it('writes and reads an authenticated v2 envelope', () => {
    const encrypted = encryptData('credential-value', key);
    expect(encrypted).toMatch(/^v2:[0-9a-f]{12}:[0-9a-f]{24}:[0-9a-f]{32}:/);
    expect(needsEncryptionMigration(encrypted)).toBe(false);
    expect(decryptData(encrypted, key)).toBe('credential-value');
  });

  it('fails closed when ciphertext or authentication tag is modified', () => {
    const encrypted = encryptData('credential-value', key);
    const parts = encrypted.split(':');
    parts[4] = `${parts[4].slice(0, -2)}00`;
    expect(() => decryptData(parts.join(':'), key)).toThrow();
  });

  it('retains read compatibility with the legacy CBC envelope', () => {
    const encrypted = legacyEncrypt('legacy-credential');
    expect(needsEncryptionMigration(encrypted)).toBe(true);
    expect(decryptData(encrypted, key)).toBe('legacy-credential');
  });

  it('rejects ambiguous key lengths for new encryption', () => {
    expect(() => encryptData('value', 'x'.repeat(33))).toThrow('ENCRYPTION_KEY');
  });
});
