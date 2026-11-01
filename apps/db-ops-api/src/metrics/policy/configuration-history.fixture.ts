import { encodeTemplatePendingPayload } from '../bindings/persistence-codec.js';
const at = '2026-11-01T00:00:00.000Z';
const ref = { type: 'instance' as const, id: 1 };
export function historicalTemplatePayload(interval = 60000, revision = 1) {
  const identity = `sha256:${'a'.repeat(64)}` as const;
  const settings = { enabled: false, interval_ms: interval, timeout_ms: 5000, stale_after_ms: 180000,
    max_counter_gap_ms: 300000, max_rows: 100, max_concurrency: 1, max_series_per_resource: 100 };
  const plan = { kind: 'template_collection_plan', internal: true, persisted: false, applied: false, executable: false,
    identity, revision: revision - 1, resource: { type: 'instance', id: '1' }, settings, parameters: [], triggers: [], releases: [], excluded: [],
    budget: { estimate: true, request_unit: 'logical_reads', estimated_series_upper_bound: 0, max_series_per_resource: 100, requests_per_hour_estimate: 0 } };
  return encodeTemplatePendingPayload({ binding: { resource: ref, package: null, group_id: null, overrides: {}, revision,
    template_pins: [{ template_id: 'fixture-pin', version: 1, content_hash: identity }] }, base_revision: revision - 1, target_revision: revision,
    resolution_identity: identity, plan: plan as never, decided_at: at, operation_key: 'fixture', applied_revision: null,
    previous_resolution_identity: null, previous_effective: null, published_at: at });
}
