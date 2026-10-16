import { OperationsError } from './contracts.js';

export interface OperationsFlags {
  context: boolean; cases: boolean; baselines: boolean; attention: boolean; plans: boolean; dispatch: boolean;
}
const keys = { context: 'OPERATIONS_CONTEXT_ENABLED', cases: 'OPERATIONS_CASES_ENABLED',
  baselines: 'OPERATIONS_BASELINES_ENABLED', attention: 'OPERATIONS_ATTENTION_ENABLED',
  plans: 'OPERATIONS_ACTION_PLANS_ENABLED', dispatch: 'OPERATIONS_ACTION_DISPATCH_ENABLED' } as const;
/** Read at point of use, not module startup. P10 supplies live configuration.
 * Flags only gate new work; retained records, audit, receipt reconciliation and
 * read-only in-flight verification must remain available through their ACLs. */
export function operationsFlags(env: Readonly<Record<string, string | undefined>> = process.env): Readonly<OperationsFlags> {
  const enabled = (key: string): boolean => {
    const value = env[key];
    if (value === undefined || value === 'false') return false;
    if (value === 'true') return true;
    throw new Error('OPERATIONS_FLAG_INVALID');
  };
  const flags = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, enabled(key)])) as unknown as OperationsFlags;
  const stopNewDispatch = enabled('OPERATIONS_STOP_NEW_DISPATCH');
  flags.dispatch = flags.dispatch && flags.plans && !stopNewDispatch;
  return Object.freeze(flags);
}
export function assertOperationsEnabled(flags: Readonly<OperationsFlags>, feature: keyof OperationsFlags): void {
  if (flags[feature] !== true) throw new OperationsError('OPERATIONS_FEATURE_DISABLED');
}
