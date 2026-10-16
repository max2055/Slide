import { describe, expect, it } from 'vitest';
import { SnmpDiscoveryCache } from './discovery-cache.js';

describe('asset scoped SNMP continuity', () => {
  it('preserves the same target, isolates resources, and resets on target or credential rotation', () => {
    const cache = new SnmpDiscoveryCache();
    const first = cache.get(1, ['device', 161, { version: 3, password: 'test-only' }]);
    expect(cache.get(1, ['device', 161, { version: 3, password: 'test-only' }])).toBe(first);
    expect(cache.get(2, ['device', 161, { version: 3, password: 'test-only' }])).not.toBe(first);
    expect(cache.get(1, ['device', 161, { version: 3, password: 'rotated' }])).not.toBe(first);
    const rotated = cache.get(1, ['device', 161, { version: 3, password: 'rotated' }]);
    expect(cache.get(1, ['new-device', 161, { version: 3, password: 'rotated' }])).not.toBe(rotated);
  });
  it('bounds retained discoveries and resets on deletion or process restart', () => {
    const cache = new SnmpDiscoveryCache(2), first = cache.get(1, 'one');
    cache.get(2, 'two'); cache.get(3, 'three');
    expect(cache.get(1, 'one')).not.toBe(first);
    const current = cache.get(1, 'one'); cache.forget(1);
    expect(cache.get(1, 'one')).not.toBe(current);
    expect(new SnmpDiscoveryCache().get(1, 'one')).not.toBe(current);
  });
});
