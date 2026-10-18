import { describe, expect, it } from 'vitest';
import { verifySourceAudit, sourceIntentHash } from './audit.js';
import { auditFixture } from './audit.fixture.js';

describe('parent source audit authorization', () => {
  it('separates a known-partial continuation receipt from zero-send collection authorization', () => {
    const f = auditFixture();
    const config = { ...f.config, phase: 'continue' as const, investigationId: f.row.id, requestId: f.row.payload.operationId };
    const { failureCode: _failure, metricsJobs: _jobs, modelUsage: _usage, ...common } = f.receipt;
    const receipt = { ...common, decision: 'known_partial_explicit_continuation', partial: {
      investigationId: config.investigationId, requestId: config.requestId, runId: f.row.id, resultVersion: 1,
      executionJobId: f.row.id, executionJobHash: 'a'.repeat(64), recordsHash: 'b'.repeat(64),
    } };
    expect(verifySourceAudit(f.authorize(receipt as never), config)).toEqual(receipt);
    expect(() => verifySourceAudit(f.authorize(), config)).toThrow();
    expect(() => verifySourceAudit(f.authorize(receipt as never), f.config)).toThrow();
    expect(() => verifySourceAudit(f.authorize(receipt as never), { ...config, requestId: f.row.id })).toThrow();
  });
  it('accepts an exact independently signed successor and hashes the entire old row', () => {
    const f = auditFixture(); expect(verifySourceAudit(f.authorize(), f.config)).toEqual(f.receipt);
    expect(sourceIntentHash(f.row)).toBe(f.receipt.predecessor.jobHash);
    expect(sourceIntentHash({ ...f.row, attempts: 2 })).not.toBe(f.receipt.predecessor.jobHash);
  });
  it.each(['signature', 'key', 'config', 'head', 'lock', 'operation', 'port', 'deadline', 'reviewer', 'expired', 'future', 'usage', 'executed'])('refuses %s mismatch', kind => {
    const f = auditFixture(); let a = f.authorize();
    if (kind === 'signature') a.envelope[a.envelope.length - 12] ^= 1;
    if (kind === 'key') a.publicKey = auditFixture().authorize().publicKey;
    if (kind === 'config') a.binding.configHash = 'f'.repeat(64);
    if (kind === 'head') a.binding.head = 'f'.repeat(40);
    if (kind === 'lock') a.binding.lockHash = 'f'.repeat(64);
    if (kind === 'port') a.binding.databasePort++;
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
