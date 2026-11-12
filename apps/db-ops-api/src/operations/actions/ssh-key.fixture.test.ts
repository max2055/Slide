import { createPrivateKey, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { generateSshFixtureKeyPair } from '../../../tests/fixtures/ssh-key.fixture.js';
const { utils } = createRequire(import.meta.url)('ssh2') as typeof import('ssh2');

it('MAX-624 preserves a leading-zero Ed25519 public byte through OpenSSH parsing and signing', () => {
  // Deterministic synthetic seed search, never emit private material in assertions.
  for (let i = 0; i < 10000; i++) {
    const seed = Buffer.alloc(32); seed.writeUInt32BE(i);
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(privateKey);
    const bytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    if (bytes[0] !== 0) continue;
    const parsed = utils.parseKey(generateSshFixtureKeyPair({ privateKey, publicKey }).private);
    expect(parsed instanceof Error).toBe(false);
    if (parsed instanceof Error) throw new Error('fixture key parsing failed');
    expect(parsed.getPublicSSH().subarray(-32).equals(bytes)).toBe(true);
    const message = Buffer.from('fixture challenge');
    const signature = parsed.sign(message);
    expect(signature instanceof Error).toBe(false);
    if (signature instanceof Error) throw new Error('fixture signing failed');
    expect(parsed.verify(message, signature)).toBe(true);
    return;
  }
  throw new Error('deterministic leading-zero case not found');
});
