import { describe, expect, it } from 'vitest';
import { operationsFlags, assertOperationsEnabled } from './feature-flags.js';

describe('operations feature gates', () => {
  it('defaults closed and rejects ambiguous configuration', () => {
    expect(operationsFlags({})).toEqual({ context: false, cases: false, baselines: false, attention: false,
      plans: false, dispatch: false });
    expect(() => operationsFlags({ OPERATIONS_ACTION_DISPATCH_ENABLED: 'yes' })).toThrow('OPERATIONS_FLAG_INVALID');
    expect(() => assertOperationsEnabled(operationsFlags({}), 'dispatch')).toThrow('OPERATIONS_FEATURE_DISABLED');
  });
  it('dispatch requires the plan gate and stop is independent of retained evidence', () => {
    const env = { OPERATIONS_ACTION_PLANS_ENABLED: 'true', OPERATIONS_ACTION_DISPATCH_ENABLED: 'true' };
    expect(operationsFlags(env).dispatch).toBe(true);
    expect(operationsFlags({ ...env, OPERATIONS_ACTION_PLANS_ENABLED: 'false' }).dispatch).toBe(false);
    expect(operationsFlags({ ...env, OPERATIONS_STOP_NEW_DISPATCH: 'true' })).toMatchObject({ plans: true, dispatch: false });
  });
});
