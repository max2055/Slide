import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BudgetPolicy } from './budget-ledger.js';
import type { InvestigationProfile } from './contracts.js';
import { investigationProfileHash } from './profiles.js';

/** Deliberately dormant: internal composition/test injection only. No environment,
 * HTTP, model or workflow payload selector enables this qualification policy. */
export interface TaskExecutionConfiguration {
  schemaVersion: 1;
  id: 'MAX-222/offline-v1' | 'MAX-222/task-v1';
  /** Supplied only by the trusted startup composition, never a request field.
   * The domain is unique to one owner run/gate and admits one new request. */
  authority?: Readonly<{
    taskId: '01a15ece-1c94-76b9-b2c0-91b83981e9ba';
    ownerRunId: string;
    gateId: string;
    domain: string;
    sourceHash: string;
  }>;
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
  if (policy.maxTotalTokensPerDay !== 1200000 || policy.maxAutomaticTokensPerDay !== 1200000) throw invalid();
  if (value?.id === 'MAX-222/task-v1') {
    const a = value.authority;
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    if (!a || a.taskId !== '01a15ece-1c94-76b9-b2c0-91b83981e9ba'
      || !uuid.test(a.ownerRunId) || !uuid.test(a.gateId) || !/^[a-f0-9]{64}$/.test(a.sourceHash)
      || domain !== `task.max222.${a.ownerRunId}.${a.gateId}` || a.domain !== domain
      || !isDeepStrictEqual(a, { taskId:a.taskId, ownerRunId:a.ownerRunId, gateId:a.gateId, domain, sourceHash:a.sourceHash })
      || !isDeepStrictEqual(value, { ...MAX222_OFFLINE_EXECUTION, id:'MAX-222/task-v1', authority:a })) throw invalid();
    return Object.freeze({ ...value, authority:Object.freeze({ ...a }) });
  }
  if (!isDeepStrictEqual(value, MAX222_OFFLINE_EXECUTION)
    || !/^qualification[.]max222[.][a-zA-Z0-9._:-]{1,100}$/.test(domain)) throw invalid();
  return MAX222_OFFLINE_EXECUTION;
}
type Binding = { requestId: string; investigationId: string; profile: Readonly<InvestigationProfile>; domain: string; mode: 'manual' | 'automatic';
  /** Independent SQL gate binding, supplied when reading a persisted request. */
  executionDomain?: string | null };
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
export function readExecutionAllocation(value: unknown, binding: Binding, policy: BudgetPolicy,
  trustedConfiguration?: Readonly<TaskExecutionConfiguration>): FrozenExecutionAllocation | undefined {
  const formal = trustedConfiguration?.id === 'MAX-222/task-v1' || binding.domain.startsWith('task.max222.')
    || binding.executionDomain != null;
  if (formal && (value === undefined || binding.executionDomain === null
    || binding.executionDomain != null && binding.executionDomain !== binding.domain)) throw invalid();
  if (value === undefined) return undefined;
  const candidate = value as FrozenExecutionAllocation;
  if (!candidate || typeof candidate !== 'object') throw invalid();
  if (formal && candidate.configuration?.id !== 'MAX-222/task-v1') throw invalid();
  // Persisted data (even with a recomputed hash) cannot authorize a task gate.
  if (candidate.configuration?.id === 'MAX-222/task-v1'
    && (!trustedConfiguration || !isDeepStrictEqual(candidate.configuration,
      taskExecutionConfiguration(trustedConfiguration, binding.domain, policy)))) throw invalid();
  const expected = freezeExecutionAllocation(candidate.configuration, binding, policy);
  if (!isDeepStrictEqual(candidate, expected)) throw invalid();
  return expected;
}
