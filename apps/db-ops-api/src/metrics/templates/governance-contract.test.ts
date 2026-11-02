import { describe, it, expect } from 'vitest';
import { RolloutInput, RolloutStep } from '../../contracts/metrics/template-governance.js';
const pin = { template_id: 'template-a', version: 1, content_hash: 'sha256:' + '1'.repeat(64) };
const value = {
  operation_key: 'one-intent',
  pins: [pin],
  resources: [{ resource: { type: 'instance', id: 7 }, expected_revision: 0 }],
};
describe('MAX244 governance intent boundaries', () => {
  it('accepts bounded exact intent but rejects duplicate scope or template identities', () => {
    expect(RolloutInput.parse(value)).toEqual(value);
    expect(RolloutInput.safeParse({ ...value, pins: [pin, pin] }).success).toBe(false);
    expect(
      RolloutInput.safeParse({ ...value, resources: [...value.resources, ...value.resources] })
        .success,
    ).toBe(false);
  });
  it('rejects authority injection, missing stable command key and invalid revisions', () => {
    expect(RolloutInput.safeParse({ ...value, actor_id: 1 }).success).toBe(false);
    expect(
      RolloutInput.safeParse({
        ...value,
        resources: [{ resource: { type: 'instance', id: 7 }, expected_revision: -1 }],
      }).success,
    ).toBe(false);
    expect(RolloutStep.safeParse({ action: 'retry' }).success).toBe(false);
    expect(RolloutStep.safeParse({ action: 'unbind', operation_key: 'one' }).success).toBe(false);
    expect(RolloutStep.parse({ action: 'rollback', operation_key: 'one' }).action).toBe('rollback');
  });
});
