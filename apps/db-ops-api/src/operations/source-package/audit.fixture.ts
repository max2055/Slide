/** Synthetic signing authority, used only by tests; never the parent trust anchor. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { bytesHash } from './config.js';
import { sourceTestConfig } from './config.fixture.js';
export function auditFixture() {
  const config = sourceTestConfig(), keys = generateKeyPairSync('ed25519');
  const binding = { head: 'b'.repeat(40), configHash: 'c'.repeat(64), lockHash: 'd'.repeat(64), databasePort: 19332 };
  const row = { id: '11111111-1111-4111-8111-111111111111', job_type: 'qualification.source', schema_version: 1,
    payload: { operationId: '22222222-2222-4222-8222-222222222222', phase: 'collect' },
    state: 'dead_letter', attempts: 1, max_attempts: 1, lease_owner: null, lease_expires_at: null,
    last_error: 'V23_SOURCE_REQUIRES_AUDIT', fencing_token: 1 };
  const receipt = { schemaVersion: 1, reviewId: '33333333-3333-4333-8333-333333333333',
    reviewerId: '1ef5122f-7ac8-4a18-8f18-cae01ffd527d', reviewEvidenceHash: 'e'.repeat(64),
    decision: 'pre_execution_connection_failure_zero_usage', failureCode: 'V23_SOURCE_INSTANCE_CONNECTION',
    metricsJobs: 0, modelUsage: 0, reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: config.deadline,
    predecessor: { intentId: row.id, operationId: row.payload.operationId, configHash: 'a'.repeat(64), head: 'a'.repeat(40), jobHash: bytesHash(JSON.stringify([row])) },
    successor: { ...binding, databaseServerUuid: '44444444-4444-4444-8444-444444444444', operationId: config.operationId, database: config.database, deadline: config.deadline } };
  const authorize = (value = receipt) => {
    const payload = Buffer.from(JSON.stringify(value));
    return { envelope: Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })),
      publicKey: Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })), binding };
  };
  return { config, binding, row, receipt, authorize, keys };
}
