import { createHash } from 'node:crypto';
import type { ActorContext } from '../auth/actor-context.js';
import { freezeInvestigationCaller } from './authorization.js';
import { validateOperationalEvent, type OperationalEvent } from './contracts.js';
import { resolveInvestigationProfile } from './profiles.js';
import type { InvestigationResource } from './store.js';
import type { BudgetPrices } from './budget-ledger.js';

export class EventIngestError extends Error {
  constructor(readonly code: 'EVENT_INPUT_INVALID' | 'EVENT_DELIVERY_CONFLICT' | 'TRIGGER_POLICY_CONFLICT' | 'EVENT_STORE_UNAVAILABLE') { super(code); }
}
export type EventInput = Omit<OperationalEvent, 'id' | 'source' | 'receivedAt'> & {
  stableErrorCode: string; callsite: string; httpStatus?: number;
};
/** Repository/operator-owned configuration, never supplied by producers or models. */
export interface TriggerBinding {
  source: string;
  verified: boolean;
  allowedOrigins: readonly OperationalEvent['origin'][];
  policy: {
    id: string; version: number; domain: string; actor: ActorContext;
    profileId: 'ops' | 'system'; profileVersion: number;
    kinds: readonly string[];
    resources: readonly InvestigationResource[];
    component?: string;
    threshold: number; windowMs: number; cooldownMs: number;
    criticalSingle: boolean;
    reserveTokens: number; reserveCostMicros: number; prices?: BudgetPrices;
  };
}
export type TriggerSuppression = 'ORIGIN_LOOP' | 'UNVERIFIED_SOURCE' | 'KIND_UNSUPPORTED' | 'STATUS_EXCLUDED'
  | 'SCOPE_UNSUPPORTED' | 'BELOW_THRESHOLD' | 'COOLDOWN' | 'OPEN_INVESTIGATION' | 'AUTHORITY_DENIED';

export function stableHash(value: unknown): string {
  const canonical = (input: any): any => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const text = (value: unknown, max = 128): value is string => typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= max;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export function freezeTriggerBinding(value: TriggerBinding): TriggerBinding {
  const p = value?.policy;
  if (!value || !text(value.source) || typeof value.verified !== 'boolean' || !Array.isArray(value.allowedOrigins)
    || !value.allowedOrigins.length || value.allowedOrigins.some(origin => !['collector', 'workflow', 'user_operation', 'investigation_engine'].includes(origin))
    || !p || !text(p.id) || !text(p.domain) || !positive(p.version) || !positive(p.threshold) || p.threshold > 10_000
    || !positive(p.windowMs) || !positive(p.cooldownMs) || p.windowMs > 3_600_000 || p.cooldownMs > 86_400_000
    || typeof p.criticalSingle !== 'boolean' || !positive(p.reserveTokens) || !positive(p.reserveCostMicros)
    || !Array.isArray(p.kinds) || !p.kinds.length || p.kinds.some(kind => !text(kind))
    || !Array.isArray(p.resources) || p.resources.length > 20
    || p.resources.some(ref => !ref || !['instance', 'server', 'network_device'].includes(ref.type) || !positive(ref.id) || ref.id > 4_294_967_295
      || !['primary', 'related'].includes(ref.role))
    || new Set(p.resources.map(ref => `${ref.type}:${ref.id}`)).size !== p.resources.length
    || p.actor?.principalKind !== 'service' || !p.actor.resourceBoundary
    || !positive(p.actor.userId) || !positive(p.actor.sessionVersion)) throw new EventIngestError('EVENT_INPUT_INVALID');
  const profile = resolveInvestigationProfile(p.profileId, p.profileVersion);
  if (p.reserveTokens > profile.budget.maxTokens || (p.profileId === 'system' ? !text(p.component) || !!p.resources.length : !p.resources.length || p.component !== undefined))
    throw new EventIngestError('EVENT_INPUT_INVALID');
  if (p.prices && Object.values(p.prices).some(rate => !Number.isSafeInteger(rate) || rate < 0)) throw new EventIngestError('EVENT_INPUT_INVALID');
  return Object.freeze({ source: value.source, verified: value.verified, allowedOrigins: Object.freeze([...value.allowedOrigins]),
    policy: Object.freeze({ ...p, actor: freezeInvestigationCaller(p.actor), kinds: Object.freeze([...p.kinds].sort()),
      resources: Object.freeze(p.resources.map(ref => Object.freeze({ ...ref })).sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)),
      ...(p.prices ? { prices: Object.freeze({ ...p.prices }) } : {}) }) });
}
export function normalizeEvent(input: EventInput, binding: TriggerBinding, id: string, receivedAt: string): OperationalEvent & Pick<EventInput, 'stableErrorCode' | 'callsite' | 'httpStatus'> {
  if (!input || !text(input.stableErrorCode) || !text(input.callsite, 512)
    || input.httpStatus !== undefined && (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) throw new EventIngestError('EVENT_INPUT_INVALID');
  const allowed = ['schemaVersion', 'sourceEventId', 'kind', 'subject', 'occurredAt', 'severity', 'summary', 'correlationId', 'releaseId', 'commitSha', 'origin', 'rawRef', 'stableErrorCode', 'callsite', 'httpStatus'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new EventIngestError('EVENT_INPUT_INVALID');
  const { stableErrorCode, callsite, httpStatus, ...envelope } = input;
  const event = { ...envelope, id, source: binding.source, receivedAt };
  if (!validateOperationalEvent(event).ok || !binding.allowedOrigins.includes(event.origin)
    || event.subject.kind === 'platform' && event.subject.releaseId !== undefined && event.subject.releaseId !== event.releaseId)
    throw new EventIngestError('EVENT_INPUT_INVALID');
  return structuredClone({ ...event, stableErrorCode, callsite, ...(httpStatus === undefined ? {} : { httpStatus }) });
}
export function scopeSupported(event: OperationalEvent, binding: TriggerBinding): boolean {
  const p = binding.policy;
  const subject = event.subject;
  return subject.kind === 'platform' ? p.profileId === 'system' && p.component === subject.component
    : p.profileId === 'ops' && p.resources.some(ref => ref.type === subject.resource.type && ref.id === subject.resource.id);
}
export function policyExclusion(event: OperationalEvent & { httpStatus?: number }, binding: TriggerBinding): TriggerSuppression | undefined {
  const p = binding.policy;
  if (event.origin === 'investigation_engine') return 'ORIGIN_LOOP';
  if (!binding.verified) return 'UNVERIFIED_SOURCE';
  if (!p.kinds.includes(event.kind)) return 'KIND_UNSUPPORTED';
  if (event.httpStatus !== undefined && event.httpStatus < 500 || event.severity === 'info') return 'STATUS_EXCLUDED';
  if (!scopeSupported(event, binding)) return 'SCOPE_UNSUPPORTED';
  return undefined;
}
export function triggerIdentity(event: ReturnType<typeof normalizeEvent>, binding: TriggerBinding) {
  const p = binding.policy;
  const scopeHash = stableHash({ domain: p.domain, actorId: p.actor.userId, sessionVersion: p.actor.sessionVersion,
    resources: p.resources, component: p.component ?? null, profile: [p.profileId, p.profileVersion] });
  const fingerprint = stableHash({ policy: [p.id, p.version], scopeHash, subject: event.subject,
    code: event.stableErrorCode, callsite: event.callsite, release: event.releaseId ?? null, commit: event.commitSha ?? null });
  const policyHash = stableHash({ ...p, actor: { id: p.actor.userId, sessionVersion: p.actor.sessionVersion,
    permissions: p.actor.permissions, instanceScopes: p.actor.instanceScopes, boundary: p.actor.resourceBoundary } });
  return { scopeHash, fingerprint, policyHash };
}
