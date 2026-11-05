import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { NetworkDeviceSshCredentialSchema } from '../contracts/public-api.js';
import {
  parseNetworkDeviceCreateInput, parseNetworkDeviceUpdateInput,
  validateSnmpV2Credential, validateSnmpV3Credential, validateSshCredential,
} from './network-device-types.js';

const ssh = (credentialValue: unknown, credentialType = 'key') => ({ username: 'synthetic', credentialType, credentialValue });

describe('MAX-312 / #433 bounded multiline SSH private keys', () => {
  for (const bits of [2048, 4096]) {
    // Runtime-generated test material only; never use saved credentials.
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: bits, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    it(`preserves RSA-${bits} PEM through SSH, create and update parsers`, () => {
      expect(privateKey.length).toBeGreaterThan(512);
      const raw = `\n ${privateKey.replaceAll('\n', '\r\n')} \n`;
      expect(validateSshCredential(ssh(raw)).credentialValue === raw).toBe(true);
      const payload = { name: 'synthetic-switch', host: '192.0.2.7', ssh: ssh(raw) };
      expect(parseNetworkDeviceCreateInput(payload).ssh?.credentialValue === raw).toBe(true);
      expect(parseNetworkDeviceUpdateInput(payload).ssh?.credentialValue === raw).toBe(true);
      expect(Value.Check(NetworkDeviceSshCredentialSchema, ssh(raw))).toBe(true);
    });
  }

  it.each([1, 512, 513, 8191, 8192])('accepts a key of %i code units without trimming', length => {
    const raw = length === 1 ? '\n' : `\n${'x'.repeat(length - 2)} `;
    expect(validateSshCredential(ssh(raw)).credentialValue === raw).toBe(true);
    expect(Value.Check(NetworkDeviceSshCredentialSchema, ssh(raw))).toBe(true);
  });

  it.each(['', 'x'.repeat(8193), null, 7, {}, undefined])('rejects an empty, oversized or non-string key (%#)', raw => {
    expect(() => validateSshCredential(ssh(raw))).toThrow('SSH_CREDENTIAL_VALUE_INVALID');
    expect(Value.Check(NetworkDeviceSshCredentialSchema, ssh(raw))).toBe(false);
  });

  it('rejects unknown authentication types without applying the key allowance', () => {
    expect(() => validateSshCredential(ssh('x', 'KEY'))).toThrow('SSH_CREDENTIAL_TYPE_INVALID');
    expect(Value.Check(NetworkDeviceSshCredentialSchema, ssh('x', 'KEY'))).toBe(false);
  });

  it('keeps the 512 password boundary and its leading/trailing whitespace', () => {
    const raw = ` ${'p'.repeat(510)} `;
    expect(validateSshCredential(ssh(raw, 'password')).credentialValue === raw).toBe(true);
    expect(Value.Check(NetworkDeviceSshCredentialSchema, ssh(raw, 'password'))).toBe(true);
    expect(() => validateSshCredential(ssh('p'.repeat(513), 'password'))).toThrow('SSH_CREDENTIAL_VALUE_INVALID');
    expect(Value.Check(NetworkDeviceSshCredentialSchema, ssh('p'.repeat(513), 'password'))).toBe(false);
    expect(() => validateSshCredential(ssh('', 'password'))).toThrow('SSH_CREDENTIAL_VALUE_INVALID');
  });

  it('keeps the SNMPv2 community and SNMPv3 auth/privacy boundaries', () => {
    expect(validateSnmpV2Credential({ community: 's'.repeat(512) }).community).toHaveLength(512);
    expect(() => validateSnmpV2Credential({ community: 's'.repeat(513) })).toThrow('SNMPV2C_COMMUNITY_INVALID');
    const value = { username: 'synthetic', securityLevel: 'authPriv', authProtocol: 'SHA', privacyProtocol: 'AES', authSecret: 'a'.repeat(512), privacySecret: 'p'.repeat(512) };
    expect(validateSnmpV3Credential(value).authSecret).toHaveLength(512);
    expect(validateSnmpV3Credential(value).privacySecret).toHaveLength(512);
    expect(() => validateSnmpV3Credential({ ...value, authSecret: 'a'.repeat(513) })).toThrow('SNMPV3_AUTH_SECRET_INVALID');
    expect(() => validateSnmpV3Credential({ ...value, privacySecret: 'p'.repeat(513) })).toThrow('SNMPV3_PRIVACY_SECRET_INVALID');
  });

  it('applies the key bound in both enrollment and edit paths', () => {
    for (const parse of [parseNetworkDeviceCreateInput, parseNetworkDeviceUpdateInput]) {
      expect(() => parse({ name: 'synthetic', host: '192.0.2.7', ssh: ssh('x'.repeat(8193)) })).toThrow('SSH_CREDENTIAL_VALUE_INVALID');
    }
  });
});
