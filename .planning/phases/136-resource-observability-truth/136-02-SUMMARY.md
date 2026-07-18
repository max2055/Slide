---
phase: 136-resource-observability-truth
plan: 02
status: complete
commits: [19d535f, fafc4e5, 9fa76e4, 9201e53]
---

# Phase 136 Plan 02 Summary

## Delivered

- Metric identity is now `(resource_type, metric_id, canonical_dimensions)`; display name is not the key. Migration `031_metric_identity_and_schedule.sql` normalizes the registry.
- Due-only scheduling (`19d535f`): `_tick()` only collects metrics whose per-metric interval has elapsed, not all metrics on every tick. Configuration granularity is per-metric, not global minimum.
- Disabled providers are excluded from collection (`fafc4e5`): `getProvidersByDbType()` returns only registry-enabled entries. The duplicate `provider.enabled` flag is removed; the registry is the single source of truth.
- Failure counter resets on successful collection (`9fa76e4`): intermittent failures don't accumulate to spurious disable states. "Fail → success → fail" sequences are tested.
- Canonical collection schedules are persisted (`9201e53`): `next_collection_at` and `last_collected_at` are exposed per metric.

## Verification

- All tests pass: `resources/`, `collectors/`, and `monitor-collector` due-only logic verified
- Registry enabled/disabled toggle reflected in collection behavior
