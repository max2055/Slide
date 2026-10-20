import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { writeFile, rm, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { syntheticPilot } from '../action-environment.fixture.js';
import { operationsContentHash } from '../contracts.js';
import { actionRuntimeConfigured, loadActionRuntimePorts, HttpActionHealthSource } from './runtime-ports.js';

describe('P11 protected runtime configuration and bounded read-only collector', () => {
  it('missing configuration fails closed, never constructs a synthetic default', async () => {
    expect(actionRuntimeConfigured({})).toBe(false);
    await expect(loadActionRuntimePorts({})).rejects.toThrow('OPERATIONS_DEPENDENCY_UNAVAILABLE');
  });
  it('checks target signature, exact verifier bytes and protected file revocation', async () => {
    const f = await syntheticPilot();
    const signing = generateKeyPairSync('ed25519');
    const env = { ...f.env, OPERATIONS_ACTION_TARGET_SIGNATURE_FILE: `${f.directory}/target.sig`,
      OPERATIONS_ACTION_VERIFIER_FILE: `${f.directory}/verifier.json`, OPERATIONS_ACTION_HEALTH_FILE: `${f.directory}/health.json` };
    const bytes = JSON.stringify({ ...f.manifest.verifier, target: `server:${f.manifest.target.serverId}/slide-action-demo.service` });
    f.manifest.verifier.definitionHash = createHash('sha256').update(bytes).digest('hex');
    const save = async () => {
      await writeFile(env.OPERATIONS_PILOT_PUBLIC_KEY_FILE, signing.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
      await writeFile(env.OPERATIONS_PILOT_MANIFEST_FILE, JSON.stringify({ manifest: f.manifest,
        signature: sign(null, Buffer.from(operationsContentHash(f.manifest)), signing.privateKey).toString('base64') }), { mode: 0o600 });
      await writeFile(env.OPERATIONS_ACTION_TARGET_SIGNATURE_FILE, sign(null, Buffer.from(operationsContentHash(f.manifest.target)), signing.privateKey).toString('base64'), { mode: 0o600 });
      await writeFile(env.OPERATIONS_ACTION_VERIFIER_FILE, bytes, { mode: 0o600 });
      await writeFile(env.OPERATIONS_ACTION_HEALTH_FILE, JSON.stringify({ url: 'http://127.0.0.1:1234/health' }), { mode: 0o600 });
    };
    try {
      await save();
      const ports = await loadActionRuntimePorts(env);
      expect(ports.evidence.definitionHash).toBe(f.manifest.verifier.definitionHash);
      await writeFile(env.OPERATIONS_ACTION_TARGET_SIGNATURE_FILE, Buffer.alloc(64).toString('base64'));
      await expect(loadActionRuntimePorts(env)).rejects.toThrow('OPERATIONS_DEPENDENCY_UNAVAILABLE');
      await save(); await writeFile(env.OPERATIONS_ACTION_VERIFIER_FILE, bytes + '\n');
      await expect(loadActionRuntimePorts(env)).rejects.toThrow('OPERATIONS_DEPENDENCY_UNAVAILABLE');
      await save(); await chmod(env.OPERATIONS_ACTION_HEALTH_FILE, 0o666);
      await expect(loadActionRuntimePorts(env)).rejects.toThrow('OPERATIONS_DEPENDENCY_UNAVAILABLE');
      await chmod(env.OPERATIONS_ACTION_HEALTH_FILE, 0o600);
      await rm(env.OPERATIONS_PILOT_MANIFEST_FILE);
      await expect(loadActionRuntimePorts(env)).rejects.toThrow('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    } finally { await f.close(); }
  });
  it('rejects credential URLs, cleartext remote URLs and redirect/oversized responses', async () => {
    expect(() => new HttpActionHealthSource(new URL('http://example.com'))).toThrow();
    expect(() => new HttpActionHealthSource(new URL('https://user:secret@example.com'))).toThrow();
    let mode = 'valid';
    const server = createServer((req, res) => {
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://example.com' }).end(); return; }
      res.end(mode === 'large' ? 'x'.repeat(65_000) : req.url?.includes('mode=history') ? '[]' : '{}');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const source = new HttpActionHealthSource(new URL(`http://127.0.0.1:${(server.address() as any).port}/health`));
    try {
      expect(await source.history('from', 'until')).toEqual([]);
      expect(await source.sample()).toEqual({});
      mode = 'redirect'; await expect(source.sample()).rejects.toThrow();
      mode = 'large'; await expect(source.sample()).rejects.toThrow();
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
});
