import { describe, expect, it, vi } from 'vitest';
import { CapabilityService, type CapabilityStore, type ResourceCapability } from './capability-service.js';
import type { ActorContext } from '../auth/actor-context.js';

const actor: ActorContext = { userId: 1, username: 'fixture', roles: [], permissions: ['*'], sessionVersion: 1, instanceScopes: {}, requestId: 'fixture' };
const resource = { type: 'network_device' as const, id: 7 };
const now = new Date('2026-11-13T00:00:00Z');
const value: ResourceCapability = { resource, key: 'metrics.core', state: 'verified', evidence: { probe: 'collector' }, checkedAt: new Date(0) };
function fixture(row = value) {
  const store = { get: vi.fn(async () => row), list: vi.fn(async () => [row]), put: vi.fn(async () => {}) };
  return { store, service: new CapabilityService(store as CapabilityStore) };
}

describe('GitHub #549 capability read validity', () => {
  it.each([
    ['verified', new Date(now.getTime() + 1), 'verified'],
    ['verified', now, 'configured'],
    ['verified', new Date(1), 'configured'],
    ['verified', null, 'verified'],
    ['verified', undefined, 'verified'],
    ...['declared', 'configured', 'degraded', 'unsupported'].map(state => [state, new Date(1), state]),
  ])('keeps list and key consistent: %s / %s', async (state, validUntil, expected) => {
    const row = { ...value, state, validUntil, reason: 'original' } as ResourceCapability;
    const { store, service } = fixture(row);
    const single = await service.get(actor, resource, row.key, now);
    expect(await service.list(actor, resource, now)).toEqual([single]);
    expect(single?.state).toBe(expected);
    expect(single?.reason).toBe(state === 'verified' && expected === 'configured' ? 'capability_verification_expired' : 'original');
    expect(row.state).toBe(state);
    expect(store.put).not.toHaveBeenCalled();
  });
  it('returns empty results and rejects forbidden reads before storage', async () => {
    const { store, service } = fixture();
    store.get.mockResolvedValue(null as never); store.list.mockResolvedValue([]);
    expect(await service.get(actor, resource, 'missing')).toBeNull();
    expect(await service.list(actor, resource)).toEqual([]);
    for (const denied of [{ ...actor, permissions: [] }, { ...actor, resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } }]) {
      store.get.mockClear(); store.list.mockClear();
      await expect(service.get(denied, resource, value.key)).rejects.toThrow('RESOURCE_FORBIDDEN');
      await expect(service.list(denied, resource)).rejects.toThrow('RESOURCE_FORBIDDEN');
      expect(store.get).not.toHaveBeenCalled(); expect(store.list).not.toHaveBeenCalled();
    }
  });
});

describe('GitHub #550 validate capability times before storage', () => {
  it.each(['checkedAt', 'validUntil'])('rejects invalid %s without writing', async field => {
    const { store, service } = fixture();
    await expect(service.put(actor, { ...value, [field]: new Date('abc') })).rejects.toThrow('CAPABILITY_TIME_INVALID');
    expect(store.put).not.toHaveBeenCalled();
  });
  it.each([null, undefined, new Date(0), new Date('2030-01-01')])('preserves valid optional deadline %s', async validUntil => {
    const { store, service } = fixture(); const row = { ...value, validUntil };
    await service.put(actor, row); expect(store.put).toHaveBeenCalledWith(row);
  });
});
