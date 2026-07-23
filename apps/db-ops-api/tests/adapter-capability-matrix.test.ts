import { describe, expect, it } from 'vitest';
import { assertCreatableDatabaseType, getAdapterCapability, listAdapterCapabilities } from '../src/adapters/capability-matrix.js';

describe('adapter capability matrix', () => {
  it('is exhaustive and marks only implemented adapters creatable', () => {
    expect(listAdapterCapabilities()).toHaveLength(7);
    expect(getAdapterCapability('mysql')).toMatchObject({ creatable: true, capabilities: { connect: 'declared' } });
    expect(getAdapterCapability('mongodb')).toMatchObject({ state: 'unsupported', creatable: false });
  });
  it('rejects unsupported and unknown database types at the common creation boundary', () => {
    expect(() => assertCreatableDatabaseType('redis')).toThrow('DATABASE_TYPE_UNSUPPORTED:redis');
    expect(() => assertCreatableDatabaseType('made-up')).toThrow('DATABASE_TYPE_UNSUPPORTED:made-up');
  });
});
