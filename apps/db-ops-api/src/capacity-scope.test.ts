import { describe, expect, it } from 'vitest';
import { capacityInstanceIds } from './capacity-scope.js';
describe('explicit capacity scope', () => {
  it('preserves absent scope and deduplicates explicit IDs', () => {
    expect(capacityInstanceIds(undefined, () => true)).toBeNull();
    expect(capacityInstanceIds('1,2,1', () => true)).toEqual([1, 2]);
  });
  it('rejects empty, malformed and unbounded scopes', () => {
    for (const value of ['', '0', '-1', '1 OR 1=1', '1,', ['1'], '9007199254740992', Array.from({ length: 501 }, (_, i) => i + 1).join(',')]) {
      expect(() => capacityInstanceIds(value, () => true)).toThrow('CAPACITY_SCOPE_INVALID');
    }
  });
  it('rejects any inaccessible instance rather than broadening the scope', () => {
    expect(() => capacityInstanceIds('1,2', id => id === 1)).toThrow('CAPACITY_SCOPE_FORBIDDEN');
  });
});
