import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytesHash } from './config.js';
import { verifySourceAudit, sourceIntentHash } from './audit.js';
import { sourceTestConfig } from './config.fixture.js';

export function auditFixture() {
  const config = sourceTestConfig(), keys = generateKeyPairSync('ed25519');
  const binding = { head: 'b'.repeat(40), configHash: 'c'.repeat(64), lockHash: 'd'.repeat(64) };
  const row = { id: '11111111-1111-4111-8111-111111111111', job_type: 'qualification.source', schema_version: 1,
    payload: { operationId: '22222222-2222-4222-8222-222222222222', phase: 'collect' },
    state: 'dead_letter', attempts: 1, max_attempts: 1, lease_owner: null, lease_expires_at: null,
    last_error: 'V23_SOURCE_REQUIRES_AUDIT', fencing_token: 1 };
  const receipt = { schemaVersion: 1, reviewId: '33333333-3333-4333-8333-333333333333',
    reviewerId: '1ef5122f-7ac8-4a18-8f18-cae01ffd527d', reviewEvidenceHash: 'e'.repeat(64),
    decision: 'pre_execution_connection_failure_zero_usage', failureCode: 'V23_SOURCE_INSTANCE_CONNECTION',
    metricsJobs: 0, modelUsage: 0, reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: config.deadline,
    predecessor: { intentId: row.id, operationId: row.payload.operationId, configHash: 'a'.repeat(64), head: 'a'.repeat(40), jobHash: bytesHash(JSON.stringify([row])) },
    successor: { ...binding, operationId: config.operationId, database: config.database, deadline: config.deadline } };
  const authorize = (value = receipt) => {
    const payload = Buffer.from(JSON.stringify(value));
    return { envelope: Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })),
      publicKey: Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })), binding };
  };
  return { config, binding, row, receipt, authorize, keys };
}
describe('parent source audit authorization', () => {
  it('accepts an exact independently signed successor and hashes the entire old row', () => {
    const f = auditFixture(); expect(verifySourceAudit(f.authorize(), f.config)).toEqual(f.receipt);
    expect(sourceIntentHash(f.row)).toBe(f.receipt.predecessor.jobHash);
    expect(sourceIntentHash({ ...f.row, attempts: 2 })).not.toBe(f.receipt.predecessor.jobHash);
  });
  it.each(['signature', 'key', 'config', 'head', 'lock', 'operation', 'deadline', 'reviewer', 'expired', 'future', 'usage', 'executed'])('refuses %s mismatch', kind => {
    const f = auditFixture(); let a = f.authorize();
    if (kind === 'signature') a.envelope[a.envelope.length - 12] ^= 1;
    if (kind === 'key') a.publicKey = auditFixture().authorize().publicKey;
    if (kind === 'config') a.binding.configHash = 'f'.repeat(64);
    if (kind === 'head') a.binding.head = 'f'.repeat(40);
    if (kind === 'lock') a.binding.lockHash = 'f'.repeat(64);
    if (kind === 'operation') f.config.operationId = f.row.payload.operationId;
    if (kind === 'deadline') f.config.deadline = new Date(Date.now() + 50000).toISOString();
    if (kind === 'reviewer') a = f.authorize({ ...f.receipt, reviewerId: '45c6e088-9615-48ae-a675-f91d1447c25e' });
    if (kind === 'expired') a = f.authorize({ ...f.receipt, expiresAt: new Date(0).toISOString() });
    if (kind === 'future') a = f.authorize({ ...f.receipt, reviewedAt: new Date(Date.now() + 5000).toISOString() });
    if (kind === 'usage') a = f.authorize({ ...f.receipt, modelUsage: 1 } as never);
    if (kind === 'executed') a = f.authorize({ ...f.receipt, metricsJobs: 1 } as never);
    expect(() => verifySourceAudit(a, f.config)).toThrow();
  });
});
