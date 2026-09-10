import { expect, it } from 'vitest';
import { createRecoveryBinding, parseRecoveryPolicy, validateRecoveryBinding } from './recovery-policy.js';
export const policy = { schemaVersion: 1, version: 1, enabled: true, commandTypes: ['write'], metricId: 'cpu', source: 'collector', max: 80, windowSeconds: 60, maxSampleGapSeconds: 30 };
it('binds only enabled matching policies to the persisted operation identity', () => {
  const binding = createRecoveryBinding(policy, 7, { type: 'instance', id: 1 }, 'write');
  expect(binding).toMatchObject({ actorId: 7, commandType: 'write', policyVersion: 1, source: 'collector' });
  expect(validateRecoveryBinding(binding)).toBe(true);
  expect(validateRecoveryBinding({ ...binding, actorId: 8 })).toBe(false);
  expect(createRecoveryBinding(policy, 7, { type: 'instance', id: 1 }, 'read')).toBeNull();
  expect(createRecoveryBinding({ ...policy, enabled: false }, 7, { type: 'instance', id: 1 }, 'write')).toBeNull();
});
it('rejects policies without source, bounded time windows or numerical constraints', () => {
  for (const patch of [{ source: '' }, { windowSeconds: 3601 }, { maxSampleGapSeconds: 61 }, { min: 100 }, { max: undefined }, { injected: true }]) expect(() => parseRecoveryPolicy({ ...policy, ...patch })).toThrow('RECOVERY_POLICY_INVALID');
});
