import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { PolicyError, refKey, type Ref } from '../policy/model.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, at, pin, testResources } from '../policy/test-support.js';
import type { PolicyStore } from '../policy/store.js';
import { createConfigurationRegistry } from './registry.js';
import { MetricConfigurationService } from './service.js';

/**
 * MAX238-APPLY-IDEMPOTENCY-R2. The three counterexamples that rejected
 * d874ae663, plus the recovery contract around each one. Every case runs on the
 * transactional test store with no target IO: a stub at the trial boundary can
 * start remote work but never proves a target was read.
 */
const ref: Ref = { type: 'instance', id: 1 };
const other: Ref = { type: 'instance', id: 2 };
const revoked = (): ActorContext => ({ ...admin, permissions: [], instanceScopes: {} });
const code = async (action: () => Promise<unknown>) => {
  try { await action(); return null; }
  catch (error) { return error instanceof PolicyError ? { code: error.code, status: error.status } : { code: String((error as Error).message), status: 0 }; }
};
function setup(store: PolicyStore = new MemoryPolicyStore(), reload?: (seed: ActorContext) => Promise<ActorContext>) {
  const registry = createConfigurationRegistry();
  const policy = new PolicyService(store, registry, testResources, () => at);
  const service = new MetricConfigurationService(policy, registry, {} as never, {} as never, undefined, reload);
  vi.spyOn(service, 'status').mockResolvedValue({} as never);
  return { registry, policy, service };
}
const input = (key: string) => ({ expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: key });

describe('MAX-238 R2 unknown outcome is never reported as absent', () => {
  it('keeps a claim pending when the trial boundary throws after IO may have started', async () => {
    const { policy, service } = setup();
    let trials = 0;
    vi.spyOn(service, 'trial').mockImplementation(async () => { trials++; throw new Error('remote outcome unknown'); });
    const request = input('unknown-trial');
    await expect(service.activate(admin, ref, request)).rejects.toThrow('remote outcome unknown');
    // The target may have been read; neither absent nor retryable.
    expect(await policy.operation(admin, ref, 'unknown-trial')).toMatchObject({ state: 'pending' });
    expect(await code(() => service.activate(admin, ref, request)))
      .toEqual({ code: 'POLICY_OPERATION_PENDING', status: 409 });
    expect(trials).toBe(1);
  });

  it('keeps the claim pending across a new process instead of clearing it', async () => {
    const store = new MemoryPolicyStore();
    const running = setup(store);
    vi.spyOn(running.service, 'trial').mockImplementation(async () => { throw new Error('timeout at the boundary'); });
    await expect(running.service.activate(admin, ref, input('restart-unknown'))).rejects.toThrow('timeout at the boundary');
    // A restarted process reads the same journal row and still refuses a retry.
    const restarted = setup(store).service;
    expect(await restarted.operation(admin, ref, 'restart-unknown')).toMatchObject({ state: 'pending' });
    expect(store.bindings.size).toBe(0); expect(store.logs).toHaveLength(0);
  });

  it('still releases a claim when the trial itself returned a definite failure', async () => {
    const { policy, service } = setup();
    vi.spyOn(service, 'trial').mockResolvedValue({ decision: 'failed', error: 'connection_error', attempts: [], samples: [] } as never);
    const request = { ...input('definite-failure'), overrides: { enabled: 'enable' as const } };
    expect(await code(() => service.activate(admin, ref, request)))
      .toEqual({ code: 'CONFIGURATION_TRIAL_FAILED', status: 422 });
    expect(await policy.operation(admin, ref, 'definite-failure')).toEqual({ state: 'absent', operation: null });
  });

  it('recovers the recorded result when the publication committed but its response was lost', async () => {
    const store = new MemoryPolicyStore();
    let lost = true;
    const lostResponse: PolicyStore = { transaction: async fn => {
      const result = await store.transaction(fn);
      // The commit landed; the caller only saw the connection drop, once.
      if (lost && (result as { published?: boolean }).published === true) { lost = false; throw new Error('connection lost after commit'); }
      return result;
    } };
    const { policy, service } = setup(lostResponse);
    const trial = vi.spyOn(service, 'trial').mockResolvedValue({ samples: [], attempts: [] } as never);
    const result = await service.activate(admin, ref, input('lost-commit'));
    expect(result.resources[0].binding.revision).toBe(1);
    expect(trial).toHaveBeenCalledTimes(1);
    expect(store.logs).toHaveLength(1);
    expect(await policy.operation(admin, ref, 'lost-commit')).toMatchObject({ state: 'committed', operation: { target_revision: 1 } });
  });

  it('clears the claim only after proving the publication transaction rolled back', async () => {
    const store = new MemoryPolicyStore();
    const { policy, service } = setup(store);
    vi.spyOn(service, 'trial').mockResolvedValue({ samples: [], attempts: [] } as never);
    store.failAudit = true;
    expect(await code(() => service.activate(admin, ref, input('rolled-back')))).not.toBeNull();
    expect(store.bindings.size).toBe(0); expect(store.logs).toHaveLength(0);
    // The journal and the binding commit together, so the pending row proves
    // nothing was published and the same key may be retried.
    expect(await policy.operation(admin, ref, 'rolled-back')).toEqual({ state: 'absent', operation: null });
    store.failAudit = false;
    expect((await service.activate(admin, ref, input('rolled-back'))).resources[0].binding.revision).toBe(1);
  });
});

describe('MAX-238 R2 live grants at the serialization boundary', () => {
  it('refuses a committed replay when the grant was revoked during the lock wait', async () => {
    const memory = new MemoryPolicyStore();
    let block = false, entered!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store: PolicyStore = { transaction: async fn => {
      if (block) { block = false; entered(); await gate; }
      return memory.transaction(fn);
    } };
    const { policy, service } = setup(store);
    const request = input('revoked-in-lock');
    await policy.changeBinding(admin, ref, request, true);
    let current: ActorContext = admin, checks = 0;
    block = true;
    const replay = service.activate(admin, ref, request, { check: async () => { checks++; return current; } });
    await locked;
    current = revoked();
    release();
    expect(await replay.then(() => 'replayed', e => e.code)).toBe('POLICY_FORBIDDEN');
    expect(checks).toBeGreaterThan(1);
    expect(memory.logs).toHaveLength(1);
  });

  it('refuses publication when the grant was revoked while waiting for the publish lock', async () => {
    const memory = new MemoryPolicyStore();
    let block = false, entered!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store: PolicyStore = { transaction: async fn => {
      if (block) { block = false; entered(); await gate; }
      return memory.transaction(fn);
    } };
    const { service } = setup(store);
    // The lock wait under test is the publication's, after the trial finished.
    vi.spyOn(service, 'trial').mockImplementation(async () => { block = true; return { samples: [], attempts: [] } as never; });
    let current: ActorContext = admin;
    const activation = service.activate(admin, ref, input('revoked-publish'), { check: async () => current });
    await locked;
    current = revoked();
    release();
    expect(await activation.then(() => 'published', e => e.code)).toBe('POLICY_FORBIDDEN');
    expect(memory.bindings.size).toBe(0); expect(memory.logs).toHaveLength(0);
  });

  it('re-reads the actor before disclosing an intent state', async () => {
    const store = new MemoryPolicyStore();
    let current: ActorContext = admin;
    const { service } = setup(store, async () => current);
    await new PolicyService(store, createConfigurationRegistry(), testResources, () => at)
      .changeBinding(admin, ref, input('query-revoked'), true);
    current = revoked();
    expect(await code(() => service.operation(admin, ref, 'query-revoked')))
      .toEqual({ code: 'POLICY_FORBIDDEN', status: 403 });
  });
});

describe('MAX-238 R2 resource isolation', () => {
  it('never discloses or replays one resource key on another resource', async () => {
    const store = new MemoryPolicyStore();
    const { policy } = setup(store);
    await policy.changeBinding(admin, ref, input('resource-1'), true);
    expect(await policy.operation(admin, other, 'resource-1')).toEqual({ state: 'absent', operation: null });
    expect(await code(() => policy.changeBinding(admin, other, input('resource-1'), true)))
      .toEqual({ code: 'POLICY_OPERATION_CONFLICT', status: 409 });
    expect(store.bindings.has(refKey(other))).toBe(false);
  });
});
