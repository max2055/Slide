import { describe, expect, it } from 'vitest';
import { freezeTriggerBinding, normalizeEvent, policyExclusion, triggerIdentity, type TriggerBinding, type EventInput } from './trigger-policy.js';

const binding: TriggerBinding = { source: 'isolated-collector', verified: true, allowedOrigins: ['collector', 'investigation_engine'],
  policy: { id: 'test-policy', version: 1, domain: 'test-domain', actor: { principalKind: 'service', userId: 2,
    username: 'slide-investigation-test', roles: [], permissions: ['chat:view', 'instance:view'], sessionVersion: 1,
    instanceScopes: { 1: 'read-only' }, requestId: 'fixture', resourceBoundary: { instanceIds: [1], serverIds: [], networkDeviceIds: [] } },
    profileId: 'ops', profileVersion: 1, resources: [{ type: 'instance', id: 1, role: 'primary' }], kinds: ['failure'],
    threshold: 3, windowMs: 300_000, cooldownMs: 600_000, criticalSingle: true, reserveTokens: 100, reserveCostMicros: 100 } };
const input: EventInput = { schemaVersion: 1, sourceEventId: 'delivery', kind: 'failure', subject: { kind: 'resource', resource: { type: 'instance', id: 1 } },
  occurredAt: '2026-10-12T12:00:00Z', severity: 'error', summary: 'Read-only failure', origin: 'collector', stableErrorCode: 'TIMEOUT', callsite: 'collector.ts:read' };
const event = (change: Partial<EventInput> = {}) => normalizeEvent({ ...input, ...change }, binding, 'event', '2026-10-12T12:01:00Z');
describe('trusted trigger policy and canonical event envelope', () => {
  it.each(['actor', 'grants', 'policy', 'source', 'receivedAt', 'id', 'fingerprint'])('rejects producer supplied %s', key => {
    expect(() => event({ [key]: 'injected' } as Partial<EventInput>)).toThrow('EVENT_INPUT_INVALID');
  });
  it('rejects invalid calendar/subject/origin/release and numeric inputs', () => {
    for (const change of [{ occurredAt: '2026-02-30T00:00:00Z' }, { subject: { kind: 'resource', resource: { type: 'instance', id: 0 } } },
      { origin: 'browser' }, { httpStatus: 99 }, { stableErrorCode: '' }, { subject: { kind: 'platform', component: 'api', releaseId: 'r1' }, releaseId: 'r2' }]) {
      expect(() => event(change as Partial<EventInput>)).toThrow('EVENT_INPUT_INVALID');
    }
  });
  it('fingerprints exclude delivery IDs, timestamps, summaries and severity; include resource/version/release/callsite', () => {
    const identity = triggerIdentity(event(), binding);
    expect(triggerIdentity(event({ sourceEventId: 'another', occurredAt: '2026-10-13T00:00:00Z', severity: 'critical', summary: 'another' }), binding)).toEqual(identity);
    for (const change of [{ releaseId: 'new-release' }, { callsite: 'other' }, { subject: { kind: 'resource', resource: { type: 'instance', id: 2 } } }]) {
      expect(triggerIdentity(event(change as Partial<EventInput>), binding).fingerprint).not.toBe(identity.fingerprint);
    }
    expect(triggerIdentity(event(), { ...binding, policy: { ...binding.policy, version: 2 } }).fingerprint).not.toBe(identity.fingerprint);
  });
  it('excludes recursive, unverified, unsupported, informational and HTTP client failures', () => {
    expect(policyExclusion(event({ origin: 'investigation_engine' }), binding)).toBe('ORIGIN_LOOP');
    expect(policyExclusion(event(), { ...binding, verified: false })).toBe('UNVERIFIED_SOURCE');
    expect(policyExclusion(event({ kind: 'cancelled' }), binding)).toBe('KIND_UNSUPPORTED');
    for (const httpStatus of [400, 401, 403, 499]) expect(policyExclusion(event({ httpStatus }), binding)).toBe('STATUS_EXCLUDED');
    expect(policyExclusion(event({ httpStatus: 500 }), binding)).toBeUndefined();
  });
  it('requires an explicit bounded service actor and freezes producer-independent config', () => {
    expect(() => freezeTriggerBinding({ ...binding, policy: { ...binding.policy, actor: { ...binding.policy.actor, principalKind: 'user' } } })).toThrow();
    const frozen = freezeTriggerBinding(binding);
    expect(Object.isFrozen(frozen.policy.actor.resourceBoundary?.instanceIds)).toBe(true);
    expect(() => freezeTriggerBinding({ ...binding, policy: { ...binding.policy, reserveTokens: 32_001 } })).toThrow();
  });
});
