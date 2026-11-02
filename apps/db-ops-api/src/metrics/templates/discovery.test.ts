import { describe, expect, it } from 'vitest';
import { reconcileDiscovery } from './discovery.js';

const rule = { rule_id: 'interfaces', name: '接口', item_ids: ['oper'], identity_dimensions: ['interface_epoch'],
  timeout_ms: 5000, max_instances: 4, lost_after_ms: 1000, retire_after_ms: 3000 };
const row = (epoch = 'physical-a', name = 'old', index = '1') => ({ identity: epoch, name, dimensions: { interface_epoch: epoch, if_index: index } });
describe('MAX245 discovery lifecycle and history identity', () => {
  it('deduplicates retries and preserves identity under rename and dimension change', () => {
    const first = reconcileDiscovery(rule, [], [row()], 1000, true);
    const renamed = reconcileDiscovery(rule, first, [row('physical-a', 'new', '2')], 2000, true);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ id: first[0].id, name: 'new', first_seen: 1000, state: 'active' });
    expect(renamed[0].dimension_history).toHaveLength(2);
    expect(reconcileDiscovery(rule, renamed, [row('physical-a', 'new', '2')], 2000, true)).toEqual(renamed);
  });
  it('ifIndex reuse creates a new identity while the old instance waits', () => {
    const first = reconcileDiscovery(rule, [], [row()], 1000, true);
    const next = reconcileDiscovery(rule, first, [row('physical-b')], 2000, true);
    expect(next).toHaveLength(2);
    expect(next.find(v => v.id === first[0].id)?.state).toBe('waiting');
  });
  it('failed or unknown enumeration cannot mark absence or advance retirement', () => {
    const first = reconcileDiscovery(rule, [], [row()], 1000, true);
    expect(reconcileDiscovery(rule, first, [], 9000, false)).toEqual(first);
  });
  it('waits, disables, retires without removing evidence; reappears with original identity', () => {
    const first = reconcileDiscovery(rule, [], [row()], 1000, true);
    const waiting = reconcileDiscovery(rule, first, [], 2000, true);
    expect(waiting[0].state).toBe('waiting');
    const disabled = reconcileDiscovery(rule, waiting, [], 3000, true);
    expect(disabled[0].state).toBe('disabled');
    const retired = reconcileDiscovery(rule, disabled, [], 5000, true);
    expect(retired[0]).toMatchObject({ id: first[0].id, state: 'retired', first_seen: 1000, last_seen: 1000 });
    const back = reconcileDiscovery(rule, retired, [row()], 6000, true);
    expect(back[0]).toMatchObject({ id: first[0].id, state: 'active', first_seen: 1000, last_seen: 6000 });
    expect(back[0].transitions.map(v => v.state)).toEqual(['active', 'waiting', 'disabled', 'retired', 'active']);
  });
  it('explicitly stopped instances remain stopped after rediscovery', () => {
    const first = reconcileDiscovery(rule, [], [row()], 1000, true);
    const stopped = [{ ...first[0], state: 'disabled' as const, manual: true }];
    expect(reconcileDiscovery(rule, stopped, [row()], 2000, true)[0].state).toBe('disabled');
  });
  it('rejects duplicate identities, over-budget results and time regression atomically', () => {
    expect(() => reconcileDiscovery(rule, [], [row(), row()], 1000, true)).toThrow('DISCOVERY_DUPLICATE');
    expect(() => reconcileDiscovery({ ...rule, max_instances: 1 }, [], [row(), row('b')], 1000, true)).toThrow('DISCOVERY_BUDGET');
    const first = reconcileDiscovery(rule, [], [row()], 1000, true);
    expect(() => reconcileDiscovery(rule, first, [], 999, true)).toThrow('DISCOVERY_CLOCK');
  });
});
