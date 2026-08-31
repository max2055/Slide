import { describe, expect, it } from 'vitest';
import { isResourceType, parseResourceRef, resourceKey, resourceTypeLabel } from './resource-subject.js';

describe('resource subject', () => {
  it('accepts all supported resource types and emits stable keys', () => {
    expect(parseResourceRef({ type: 'network_device', id: 4 })).toEqual({ type: 'network_device', id: 4 });
    expect(resourceKey({ type: 'network_device', id: 4 })).toBe('network_device:4');
    expect(resourceTypeLabel('network_device')).toBe('network_device');
    expect(isResourceType('instance')).toBe(true);
  });

  it('rejects invalid types, IDs, and non-object subjects', () => {
    for (const value of [null, undefined, {}, { type: 'bogus', id: 1 }, { type: 'server', id: 0 }, { type: 'server', id: 'x' }]) {
      expect(() => parseResourceRef(value)).toThrow();
    }
  });
});

