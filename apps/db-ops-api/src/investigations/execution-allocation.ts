import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BudgetPolicy } from './budget-ledger.js';
import type { InvestigationProfile } from './contracts.js';
import { investigationProfileHash } from './profiles.js';

/** Deliberately dormant: internal composition/test injection only. No environment,
 * HTTP, model or workflow payload selector enables this qualification policy. */
export interface TaskExecutionConfiguration {
  schemaVersion: 1;
  id: 'MAX-222/offline-v1';
  maxToolCalls: 36;
  maxProviderAttempts: 8;
  maxTotalTokens: 1200000;
  deadlineMs: 120000;
  contextWindowTokens: 294912;
  maxTokens: 8192;
  summaryMaxTokens: 10240;
}
export const MAX222_OFFLINE_EXECUTION: Readonly<TaskExecutionConfiguration> = Object.freeze({
  schemaVersion: 1, id: 'MAX-222/offline-v1', maxToolCalls: 36, maxProviderAttempts: 8,
  maxTotalTokens: 1200000, deadlineMs: 120000, contextWindowTokens: 294912, maxTokens: 8192, summaryMaxTokens: 10240,
});
export interface FrozenExecutionAllocation {
  schemaVersion: 1;
  requestId: string;
  investigationId: string;
  profileHash: string;
  domain: string;
  mode: 'manual' | 'automatic';
  policyHash: string;
  configuration: Readonly<TaskExecutionConfiguration>;
  hash: string;
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export function allocationHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const invalid = () => new Error('INVESTIGATION_ALLOCATION_INVALID');
export function taskExecutionConfiguration(value: TaskExecutionConfiguration, domain: string, policy: BudgetPolicy): Readonly<TaskExecutionConfiguration> {
  // One bounded task contract, not an arbitrary ceiling override. Domains and
  // daily policy are separately frozen by the existing ledger domain lock.
  if (!isDeepStrictEqual(value, MAX222_OFFLINE_EXECUTION)
    || !/^qualification[.]max222[.][a-zA-Z0-9._:-]{1,100}$/.test(domain)
    || policy.maxTotalTokensPerDay !== 1200000 || policy.maxAutomaticTokensPerDay !== 1200000) throw invalid();
  return MAX222_OFFLINE_EXECUTION;
}
type Binding = { requestId: string; investigationId: string; profile: Readonly<InvestigationProfile>; domain: string; mode: 'manual' | 'automatic' };
export function freezeExecutionAllocation(configuration: TaskExecutionConfiguration, binding: Binding, policy: BudgetPolicy): FrozenExecutionAllocation {
  const config = taskExecutionConfiguration(configuration, binding.domain, policy);
  if (binding.profile.id !== 'ops' || binding.profile.version !== 1
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(binding.requestId) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(binding.investigationId)
    || !['manual', 'automatic'].includes(binding.mode)) throw invalid();
  const payload = { schemaVersion: 1 as const, requestId: binding.requestId, investigationId: binding.investigationId,
    profileHash: investigationProfileHash(binding.profile), domain: binding.domain, mode: binding.mode,
    policyHash: allocationHash(policy), configuration: config };
  return { ...payload, hash: allocationHash(payload) };
}
export function readExecutionAllocation(value: unknown, binding: Binding, policy: BudgetPolicy): FrozenExecutionAllocation | undefined {
  if (value === undefined) return undefined;
  const candidate = value as FrozenExecutionAllocation;
  if (!candidate || typeof candidate !== 'object') throw invalid();
  const expected = freezeExecutionAllocation(candidate.configuration, binding, policy);
  if (!isDeepStrictEqual(candidate, expected)) throw invalid();
  return expected;
}
