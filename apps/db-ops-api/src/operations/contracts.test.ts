import { describe, expect, it } from 'vitest';
import { actionPlanContentSchema, operationsContentHash, OperationsError, assertExpectedVersion,
  executionStateSchema, verificationStateSchema } from './contracts.js';

export const planContent = () => ({
  schemaVersion: 1, investigationId: 'investigation-1', resultVersion: 1,
  target: { type: 'server', id: 1 }, tool: { name: 'restart_demo_service', version: '1', hash: 'a'.repeat(64) },
  parameters: { unit: 'slide-action-demo.service' },
  evidence: [{ id: 'evidence-1', version: 1, hash: 'b'.repeat(64), validUntil: '2026-10-17T01:00:00.000Z' }],
  relations: [], baselines: [], preconditions: [{ kind: 'target_config_hash', expected: 'c'.repeat(64) }],
  risk: 'medium', impact: 'Dedicated demo service restart', policyVersion: '1',
  validFrom: '2026-10-17T00:00:00.000Z', validUntil: '2026-10-17T00:15:00.000Z',
  verifier: { id: 'demo-service', version: '1', definitionHash: 'd'.repeat(64),
    beforeSeconds: 120, readinessSeconds: 60, observationSeconds: 300, intervalSeconds: 10,
    maxExtraRestarts: 0, requireAllHealthy: true },
  rollback: { capability: 'none', description: 'Process memory cannot be restored' },
  author: { kind: 'user', id: 1 }, requester: { kind: 'user', id: 1 },
});

describe('operations internal contracts', () => {
  it('accepts only bounded complete plans; caller cannot smuggle commands or credentials', () => {
    expect(actionPlanContentSchema.safeParse(planContent()).success).toBe(true);
    for (const change of [{ parameters: { unit: 'ssh.service' } }, { parameters: { unit: 'slide-action-demo.service', command: 'id' } },
      { target: { type: 'server', id: 0 } }, { credentials: 'secret' }, { schemaVersion: 2 },
      { validUntil: '2026-10-17T00:31:00.000Z' }, { validUntil: '2026-10-16T23:59:00.000Z' },
      { verifier: { ...planContent().verifier, intervalSeconds: 0 } }]) {
      expect(actionPlanContentSchema.safeParse({ ...planContent(), ...change }).success).toBe(false);
    }
  });
  it('hashes all substantive fields and canonicalizes object keys without reordering lists', () => {
    const base = actionPlanContentSchema.parse(planContent());
    const hash = operationsContentHash(base);
    expect(operationsContentHash(Object.fromEntries(Object.entries(base).reverse()))).toBe(hash);
    for (const change of [{ resultVersion: 2 }, { target: { type: 'server', id: 2 } },
      { tool: { ...base.tool, version: '2' } }, { policyVersion: '2' },
      { verifier: { ...base.verifier, definitionHash: 'e'.repeat(64) } },
      { preconditions: [] }, { risk: 'high' }, { validUntil: '2026-10-17T00:14:00.000Z' }]) {
      expect(operationsContentHash({ ...base, ...change })).not.toBe(hash);
    }
    expect(() => operationsContentHash({ missing: undefined })).toThrow();
    expect(() => operationsContentHash({ number: NaN })).toThrow();
  });
  it('preserves conflict, expired and unknown semantics', () => {
    expect(() => assertExpectedVersion(1, 2)).toThrow('OPERATIONS_VERSION_CONFLICT');
    expect(() => assertExpectedVersion(0, 0)).toThrow('OPERATIONS_INPUT_INVALID');
    expect(assertExpectedVersion(2, 2)).toBeUndefined();
    expect(new OperationsError('OPERATIONS_NOT_FOUND').statusCode).toBe(404);
    expect(new OperationsError('OPERATIONS_FORBIDDEN').statusCode).toBe(403);
    expect(new OperationsError('OPERATIONS_EXPIRED').statusCode).toBe(410);
    expect(new OperationsError('OPERATIONS_PRECONDITION_FAILED').statusCode).toBe(422);
    expect(new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE').statusCode).toBe(503);
    expect(executionStateSchema.parse('outcome_unknown')).toBe('outcome_unknown');
    expect(verificationStateSchema.safeParse('resolved').success).toBe(false);
  });
});
