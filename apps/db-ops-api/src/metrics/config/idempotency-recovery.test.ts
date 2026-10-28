import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { PolicyError, refKey, type Ref } from '../policy/model.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, at, pin, testResources } from '../policy/test-support.js';
import { createConfigurationRegistry } from './registry.js';
import { MetricConfigurationService } from './service.js';

/**
 * MAX238-APPLY-IDEMPOTENCY-R1. These are the two independent counterexamples
 * that rejected d89860916 plus the recovery contract around them, executed on
 * the transactional test store with no target IO:
 *   1. replaying an intent must recover its own recorded publication, never be
 *      re-resolved against configuration a later intent changed;
 *   2. a keyed activate reserves its intent before the trial, so a duplicate is
 *      pending rather than absent and never starts a second trial.
 */
const ref: Ref = { type: 'instance', id: 1 };
const other: Ref = { type: 'instance', id: 2 };
const reader = (target: Ref): ActorContext => ({ userId: 2, username: 'reader', roles: [], permissions: ['instance:view'],
  instanceScopes: { [target.id]: 'read-only' }, sessionVersion: 1, requestId: 'test-reader' });
const code = async (action: () => Promise<unknown>) => {
  try { await action(); return null; }
  catch (error) { return error instanceof PolicyError ? { code: error.code, status: error.status } : { code: String((error as Error).message), status: 0 }; }
};
function setup(clock: () => string = () => at) {
  const registry = createConfigurationRegistry();
  const store = new MemoryPolicyStore();
  const policy = new PolicyService(store, registry, testResources, clock);
  return { registry, store, policy };
}
function service(registry: ReturnType<typeof createConfigurationRegistry>, policy: PolicyService) {
  // trial/status are stubbed orchestration boundaries: no remote IO, no
  // collection claim, and no claim that a real target was exercised.
  return new MetricConfigurationService(policy, registry, {} as never, {} as never);
}

describe('MAX-238 operation-key recovery', () => {
  it('replays the original omitted-overrides request after a newer intent changed the binding', async () => {
    const { policy } = setup();
    const original = { expected_revision: 0, package: pin, operation_key: 'chief-original' };
    const first = await policy.changeBinding(admin, ref, original, true);
    expect(first.resources[0].binding.revision).toBe(1);
    await policy.changeBinding(admin, ref, { expected_revision: 1, package: pin,
      overrides: { enabled: 'disable' }, operation_key: 'chief-new-intent' }, true);
    expect((await policy.binding(admin, ref)).binding.revision).toBe(2);
    // The original committed result is recoverable; current configuration is not its input.
    const replay = await policy.changeBinding(admin, ref, original, true);
    expect(replay.resources[0].binding.revision).toBe(1);
    expect(replay.resources[0].binding.overrides).toEqual({});
    expect((await policy.binding(admin, ref)).binding.revision).toBe(2);
  });

  it('rejects a genuinely different payload even when it resolves to the same configuration', async () => {
    const { policy } = setup();
    const original = { expected_revision: 0, package: pin, operation_key: 'payload-1' };
    await policy.changeBinding(admin, ref, original, true);
    // Explicit empty overrides is a different request than omitted overrides.
    expect(await code(() => policy.changeBinding(admin, ref, { ...original, overrides: {} }, true)))
      .toEqual({ code: 'POLICY_OPERATION_CONFLICT', status: 409 });
    expect(await code(() => policy.changeBinding(admin, ref, { ...original, overrides: { enabled: 'disable' } }, true)))
      .toEqual({ code: 'POLICY_OPERATION_CONFLICT', status: 409 });
    // The identical explicit request replays exactly.
    const explicit = { expected_revision: 1, package: pin, overrides: { interval_ms: { mode: 'set' as const, value: 30000 } },
      operation_key: 'payload-2' };
    const published = await policy.changeBinding(admin, ref, explicit, true);
    const replayed = await policy.changeBinding(admin, ref, explicit, true);
    expect(replayed.resources[0].published_at).toBe(published.resources[0].published_at);
    expect(replayed.resources[0].binding.revision).toBe(published.resources[0].binding.revision);
  });

  it('does not report absent, and does not start a second trial, while the keyed activate is inside its trial', async () => {
    const { registry, policy, store } = setup();
    const serviceUnderTest = service(registry, policy);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const trial = vi.spyOn(serviceUnderTest, 'trial').mockImplementation(async () => {
      enter(); await gate; return { samples: [], attempts: [] } as never;
    });
    vi.spyOn(serviceUnderTest, 'status').mockResolvedValue({} as never);
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' }, operation_key: 'chief-inflight' };
    const activation = serviceUnderTest.activate(admin, ref, input);
    await entered;
    const state = await serviceUnderTest.operation(admin, ref, 'chief-inflight');
    expect(state.state).toBe('pending');
    expect(state.operation).toMatchObject({ target_revision: 1, configuration_digest: null, committed_at: null });
    // The duplicate is refused before any IO, so the trial count stays at one.
    expect(await code(() => serviceUnderTest.activate(admin, ref, input)))
      .toEqual({ code: 'POLICY_OPERATION_PENDING', status: 409 });
    expect(trial).toHaveBeenCalledTimes(1);
    release(); const result = await activation;
    expect(result.resources[0].binding.revision).toBe(1);
    expect(store.logs).toHaveLength(1);
    expect((await serviceUnderTest.operation(admin, ref, 'chief-inflight')).state).toBe('committed');
  });

  it('keeps a claim orphaned by a restart pending instead of clearing it as absent', async () => {
    const { registry, store } = setup();
    const crashed = new PolicyService(store, registry, testResources);
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' }, operation_key: 'restart-1' };
    expect(await crashed.beginOperation(admin, ref, input)).toEqual({ claimed: true });
    // A new process reads the same persisted state; the remote outcome is unknown.
    const restarted = new PolicyService(store, registry, testResources);
    expect(await restarted.operation(admin, ref, 'restart-1')).toMatchObject({ state: 'pending' });
    expect(await code(() => restarted.beginOperation(admin, ref, input)))
      .toEqual({ code: 'POLICY_OPERATION_PENDING', status: 409 });
    expect(await code(() => restarted.changeBinding(admin, ref, input, true)))
      .toEqual({ code: 'POLICY_OPERATION_PENDING', status: 409 });
    // Still pending later: nothing expires an unknown result into a safe retry.
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await new MetricConfigurationService(restarted, registry, {} as never, {} as never)
      .operation(admin, ref, 'restart-1')).state).toBe('pending');
    expect(store.bindings.size).toBe(0);
    expect(store.logs).toHaveLength(0);
  });

  it('releases only its own claim after a known in-process failure so the same key may be retried', async () => {
    const { registry, policy, store } = setup();
    const serviceUnderTest = service(registry, policy);
    let failTrial = true;
    vi.spyOn(serviceUnderTest, 'trial').mockImplementation(async () => failTrial
      ? { samples: [], attempts: [], error: 'connection_error' } as never
      : { samples: [{ value: 1, quality: { status: 'good' } }], attempts: [{ status: 'succeeded' }] } as never);
    vi.spyOn(serviceUnderTest, 'status').mockResolvedValue({} as never);
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'enable' }, operation_key: 'retry-same-key' };
    expect(await code(() => serviceUnderTest.activate(admin, ref, input)))
      .toEqual({ code: 'CONFIGURATION_TRIAL_FAILED', status: 422 });
    expect(await serviceUnderTest.operation(admin, ref, 'retry-same-key')).toEqual({ state: 'absent', operation: null });
    expect(store.bindings.size).toBe(0); expect(store.logs).toHaveLength(0);
    // The same key is now provably safe to use for the same intent.
    failTrial = false;
    const published = await serviceUnderTest.activate(admin, ref, input);
    expect(published.resources[0].binding.revision).toBe(1);
  });

  it('recovers a publication whose response was lost, without a second trial, revision or audit', async () => {
    const { registry, policy, store } = setup();
    const serviceUnderTest = service(registry, policy);
    const trial = vi.spyOn(serviceUnderTest, 'trial').mockResolvedValue({ samples: [], attempts: [] } as never);
    const status = vi.spyOn(serviceUnderTest, 'status').mockResolvedValue({} as never);
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' }, operation_key: 'lost-response' };
    const published = await serviceUnderTest.activate(admin, ref, input);
    expect(published.resources[0].binding.revision).toBe(1);
    // The client never observed that response; it queries the key before retrying.
    expect(await serviceUnderTest.operation(admin, ref, 'lost-response')).toMatchObject({ state: 'committed', operation: { target_revision: 1 } });
    const recovered = await serviceUnderTest.activate(admin, ref, input);
    expect(recovered.resources[0].published_at).toBe(published.resources[0].published_at);
    expect(trial).toHaveBeenCalledTimes(1); expect(store.logs).toHaveLength(1);
    expect(store.bindings.get(refKey(ref))!.binding.revision).toBe(1);
    status.mockRestore();
  });

  it('does not disclose or replay one resource key on another resource', async () => {
    const { policy, store } = setup();
    await policy.changeBinding(admin, ref, { expected_revision: 0, package: pin, operation_key: 'resource-1' }, true);
    expect(await policy.operation(admin, other, 'resource-1')).toEqual({ state: 'absent', operation: null });
    expect(await code(() => policy.changeBinding(admin, other,
      { expected_revision: 0, package: pin, operation_key: 'resource-1' }, true)))
      .toEqual({ code: 'POLICY_OPERATION_CONFLICT', status: 409 });
    expect(store.bindings.has(refKey(other))).toBe(false);
  });

  it('refuses the publication when live permission is revoked while the trial runs', async () => {
    const { registry, policy, store } = setup();
    let revoked = false;
    const serviceUnderTest = new MetricConfigurationService(policy, registry, {} as never, {} as never, undefined,
      async seed => revoked ? reader(ref) : seed);
    vi.spyOn(serviceUnderTest, 'trial').mockImplementation(async () => {
      revoked = true; return { samples: [], attempts: [] } as never;
    });
    vi.spyOn(serviceUnderTest, 'status').mockResolvedValue({} as never);
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' }, operation_key: 'revoked' };
    expect(await code(() => serviceUnderTest.activate(admin, ref, input)))
      .toEqual({ code: 'POLICY_FORBIDDEN', status: 403 });
    expect(store.bindings.size).toBe(0); expect(store.logs).toHaveLength(0);
    // A live read grant is still required to read the intent's state.
    expect(await code(() => serviceUnderTest.operation({ ...admin, permissions: ['instance:view'], instanceScopes: {} }, ref, 'revoked')))
      .toEqual({ code: 'POLICY_FORBIDDEN', status: 403 });
  });

  it('leaves no publication, audit or journal row when the publication transaction fails', async () => {
    const { policy, store } = setup();
    await policy.changeBinding(admin, ref, { expected_revision: 0, package: pin }, true);
    const before = JSON.stringify(store.bindings.get(refKey(ref)));
    store.failAudit = true;
    expect(await code(() => policy.changeBinding(admin, ref,
      { expected_revision: 1, package: pin, overrides: { enabled: 'disable' }, operation_key: 'rolled-back' }, true)))
      .not.toBeNull();
    expect(JSON.stringify(store.bindings.get(refKey(ref)))).toBe(before);
    expect(store.logs).toHaveLength(1);
    expect(store.operations.size).toBe(0);
    expect(await policy.operation(admin, ref, 'rolled-back')).toEqual({ state: 'absent', operation: null });

    store.failAudit = false; store.failOperation = true;
    expect(await code(() => policy.changeBinding(admin, ref,
      { expected_revision: 1, package: pin, overrides: { enabled: 'disable' }, operation_key: 'journal-failed' }, true)))
      .not.toBeNull();
    expect(JSON.stringify(store.bindings.get(refKey(ref)))).toBe(before);
    expect(store.logs).toHaveLength(1);
    expect(store.operations.size).toBe(0);
  });
});
