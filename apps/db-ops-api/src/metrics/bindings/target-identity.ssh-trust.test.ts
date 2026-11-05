import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { stable } from '../packages/model.js';
import { TARGET_IDENTITY_FORMAT, trustedTargetIdentity } from './target-identity.js';

it('keeps the pre-upgrade password and legacy pinned key digest; explicit key decisions invalidate it', async () => {
  for (const type of ['password', 'key']) {
    const ref = { type: 'server' as const, id: 7 };
    const row = { host: 'fixture', port: 22, credential_type: type, host_key_fingerprint: 'pin', credential_encrypted: 'cipher' };
    const baseline = 'sha256:' + createHash('sha256').update(stable({ format: TARGET_IDENTITY_FORMAT, resource: 'server:7',
      host: 'fixture', port: '22', credential_type: type, host_key_fingerprint: 'pin', credential: 'cipher' })).digest('hex');
    const identity = (mode: string | null) => trustedTargetIdentity({ execute: async () => [[{ ...row, ssh_trust_mode: mode }], []] }, ref);
    expect(await identity(null)).toBe(baseline);
    if (type === 'password') expect(await identity('insecure')).toBe(baseline);
    else {
      expect(await identity('insecure')).not.toBe(baseline);
      expect(await identity('insecure')).not.toBe(await identity('pinned'));
    }
  }
});

it('preserves the network password digest while recording only explicit key policy changes', async () => {
  const ref = { type: 'network_device' as const, id: 7 };
  const row = { protocol: 'ssh', username: 'fixture', auth_protocol: '', privacy_protocol: '', credential_type: 'password',
    host_key_fingerprint: 'pin', auth_secret_encrypted: '', privacy_secret_encrypted: '', credential_encrypted: 'cipher' };
  const baseline = 'sha256:' + createHash('sha256').update(stable({ format: TARGET_IDENTITY_FORMAT, resource: 'network_device:7',
    host: 'fixture', snmp_port: '161', credentials: [{ protocol: 'ssh', username: 'fixture', auth_protocol: '', privacy_protocol: '',
      credential_type: 'password', host_key_fingerprint: 'pin', auth_secret: '', privacy_secret: '', credential: 'cipher' }] })).digest('hex');
  const identity = (mode: string | null) => trustedTargetIdentity({ execute: async sql => [
    sql.includes('FROM network_devices') ? [{ host: 'fixture', snmp_port: 161 }] : [{ ...row, ssh_trust_mode: mode }], [],
  ] }, ref);
  expect(await identity(null)).toBe(baseline);
  expect(await identity('insecure')).toBe(baseline);
});
