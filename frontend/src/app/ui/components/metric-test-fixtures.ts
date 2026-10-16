import type { CollectionStatus } from './metric-api.js';

export const collectionStatus = (state: 'bound' | 'unbound' = 'bound'): CollectionStatus => ({
  contract_version: '1.0.0', resource: { type: 'instance', id: 1 }, evaluated_at: '2026-10-16T00:00:00Z', can_manage: true,
  binding: { state, package: state === 'bound' ? { id: 'mysql-basic', version: '2.0.0', digest: 'pin' } : null,
    published_revision: state === 'bound' ? 1 : null, applied_revision: state === 'bound' ? 1 : null, application: state === 'bound' ? 'applied' : 'unbound' },
  effective_enabled: { enabled: state === 'bound', global_enabled: true, asset_enabled: true, policy_enabled: state === 'bound', source: 'package' },
  collection: { state: state === 'bound' ? 'succeeded' : 'unknown', last_attempt_at: null, last_success_at: null, in_flight: false },
  formal_visibility: { state: state === 'bound' ? 'available' : 'unbound', source: state === 'bound' ? 'semantic' : 'none', last_observed_at: null, generation: null },
  blockers: state === 'bound' ? [] : ['UNBOUND'], coverage: [],
});
