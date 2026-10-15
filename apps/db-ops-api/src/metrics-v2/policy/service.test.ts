import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { PolicyService } from './service.js';
import { MemoryPolicyStore, admin, at, pin, resource } from './test-support.js';

describe('policy asynchronous inventory evaluation time', () => {
  const ref = { type: 'instance' as const, id: 1 };
  const setup = (offset = 0) => {
    let now = Date.parse(at);
    const store = new MemoryPolicyStore();
    const service = new PolicyService(store, createBuiltinRegistry(), {
      exists: async () => true,
      inventory: async r => {
        await Promise.resolve();
        now += 10;
        const value = resource(r.id);
        for (const attr of Object.values(value.attributes)) attr.observed_at = new Date(now + offset).toISOString();
        return value;
      },
    }, () => new Date(now).toISOString());
    return { store, service, clock: () => new Date(now).toISOString() };
  };
  it.each([false, true])('evaluates binding after inventory while preserving publication/audit time (publish=%s)', async publish => {
    const { store, service } = setup();
    const result = await service.changeBinding(admin, ref, { expected_revision: 0, package: pin }, publish);
    expect(result.resources[0].resolved.applicability.map(a => a.status)).toEqual(['supported', 'supported']);
    expect(result.resources[0].published_at).toBe(at);
    if (publish) expect(store.logs[0].at).toBe(at);
    else expect(store.bindings.size).toBe(0);
  });
  it.each([false, true])('evaluates every group member after its inventory and retains one audit timestamp (publish=%s)', async publish => {
    const { store, service, clock } = setup();
    await service.changeGroup(admin, 'g', { expected_revision: 0, overrides: {} }, true);
    for (const id of [1, 2]) await service.changeBinding(admin, { ...ref, id }, { expected_revision: 0, package: pin, group_id: 'g' }, true);
    const group = await service.group(admin, 'g'), before = clock();
    const result = await service.changeGroup(admin, 'g', { expected_revision: group.revision, overrides: {} }, publish);
    expect(result.resources).toHaveLength(2);
    for (const value of result.resources) {
      expect(value.resolved.applicability.map(a => a.status)).toEqual(['supported', 'supported']);
      expect(value.published_at).toBe(before);
    }
    if (publish) expect(store.logs.slice(-3).map(a => a.at)).toEqual([before, before, before]);
    else expect((await service.binding(admin, ref)).binding.revision).toBe(1);
  });
  it('continues rejecting inventory actually dated in the future', async () => {
    const { service } = setup(1000);
    const result = await service.changeBinding(admin, ref, { expected_revision: 0, package: pin }, false);
    expect(result.resources[0].resolved.applicability.every(a => a.status === 'unknown')).toBe(true);
  });
});
