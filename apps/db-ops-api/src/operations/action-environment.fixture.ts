/** Synthetic signing material for isolated tests only. Never a real registration. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { operationsContentHash } from './contracts.js';
import type { PilotManifest } from './action-environment.js';
export async function syntheticPilot() {
  await mkdir('.qualification', { recursive: true });
  const directory = await mkdtemp('.qualification/synthetic-pilot-');
  const keys = generateKeyPairSync('ed25519');
  const manifest: PilotManifest = {
    schemaVersion: 1, target: { protocol: 1, serverId: 501, host: '192.168.49.130', port: 22,
      username: 'slide-action', unit: 'slide-action-demo.service', helper: '/usr/local/libexec/slide-action-demo-helper',
      helperHash: 'a'.repeat(64), unitHash: 'b'.repeat(64), hostFingerprint: 'SHA256:' + Buffer.alloc(32, 7).toString('base64').replace(/=+$/, ''),
      toolVersion: '1', eligible: true },
    policyVersion: 'synthetic-policy-1', verifier: { id: 'demo-service', version: 'synthetic-1', definitionHash: 'd'.repeat(64),
      beforeSeconds: 120, readinessSeconds: 60, observationSeconds: 300, intervalSeconds: 10, maxExtraRestarts: 0, requireAllHealthy: true },
    validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 3600_000).toISOString(),
  };
  const env = { OPERATIONS_PILOT_MANIFEST_FILE: `${directory}/manifest.json`, OPERATIONS_PILOT_PUBLIC_KEY_FILE: `${directory}/public.pem`,
    OPERATIONS_PILOT_SSH_KEY_FILE: `${directory}/ssh.pem` };
  await writeFile(env.OPERATIONS_PILOT_PUBLIC_KEY_FILE, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const sshKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(env.OPERATIONS_PILOT_SSH_KEY_FILE, sshKey.privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  const save = async () => writeFile(env.OPERATIONS_PILOT_MANIFEST_FILE, JSON.stringify({ manifest,
    signature: sign(null, Buffer.from(operationsContentHash(manifest)), keys.privateKey).toString('base64') }), { mode: 0o600 });
  await save();
  const proposal = () => ({ schemaVersion: 1, investigationId: 'synthetic-investigation', resultVersion: 1,
    target: { type: 'server', id: manifest.target.serverId },
    tool: { name: 'restart_demo_service', version: '1', hash: manifest.target.helperHash }, parameters: { unit: manifest.target.unit },
    evidence: [{ id: 'synthetic-evidence', version: 1, hash: 'e'.repeat(64), validUntil: new Date(Date.now() + 1200_000).toISOString() }],
    relations: [], baselines: [], preconditions: [{ kind: 'target_config_hash', expected: operationsContentHash(manifest.target) }],
    risk: 'medium', impact: 'Synthetic isolated protocol test; no target action', policyVersion: manifest.policyVersion,
    verifier: structuredClone(manifest.verifier), rollback: { capability: 'none', description: 'No process-memory rollback' } });
  const inspection = () => ({ protocol: 1, serverId: manifest.target.serverId, unit: manifest.target.unit,
    configHash: operationsContentHash(manifest.target), helperHash: manifest.target.helperHash, unitHash: manifest.target.unitHash, invocationId: 'f'.repeat(32) });
  return { manifest, env, directory, proposal, inspection, save, close: () => rm(directory, { recursive: true, force: true }) };
}
