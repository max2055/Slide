import { generateKeyPairSync, type KeyObject } from 'node:crypto';

/** Test-only unencrypted OpenSSH Ed25519 encoding. ssh2's generator strips
 * leading zero public bytes, although Ed25519 keys are fixed-width strings. */
export function generateSshFixtureKeyPair(
  pair: { publicKey: KeyObject; privateKey: KeyObject } = generateKeyPairSync('ed25519'),
) {
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const field = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  const publicBlob = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(publicBytes)]);
  const payload = Buffer.concat([Buffer.alloc(8), publicBlob, field(Buffer.concat([seed, publicBytes])), field(Buffer.alloc(0))]);
  const paddingLength = 8 - payload.length % 8;
  const count = Buffer.alloc(4); count.writeUInt32BE(1);
  const binary = Buffer.concat([Buffer.from('openssh-key-v1\0'), field(Buffer.from('none')), field(Buffer.from('none')),
    field(Buffer.alloc(0)), count, field(publicBlob), field(Buffer.concat([payload, Buffer.from(Array.from({ length: paddingLength }, (_, i) => i + 1))]))]);
  return { private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${binary.toString('base64').match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    public: `ssh-ed25519 ${publicBlob.toString('base64')}` };
}
