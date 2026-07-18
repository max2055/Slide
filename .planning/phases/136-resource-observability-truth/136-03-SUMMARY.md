---
phase: 136-resource-observability-truth
plan: 03
status: complete
commits: [2488bb0, 8f59ea9, 6464ab7, b0c20ea, 044efba, 077c1d3, 70d4381]
---

# Phase 136 Plan 03 Summary

## Delivered

- Unified alert thresholds (`8f59ea9`): instance and server rules share the same compiled-rule evaluator with target, operator, three-level threshold, duration, recovery, and dedup semantics. Old server-alert-evaluator divergence (single-value comparison, no duration) is eliminated.
- Health aggregation is severity-capped (`2488bb0`): four dimensions replace the single pass/fail percentage:
  - **control plane**: database connectivity, migration ledger currency
  - **managed availability**: per-resource health status with denominator
  - **data freshness**: per-resource metric staleness
  - **workflow health**: cron, outbox, notification worker status
- Critical/unknown/stale resources cannot be diluted by pass items (`b0c20ea`): readiness is capped when the majority of managed resources are critical.
- Health center UI shows resource-level truth (`044efba`): per-instance and per-server status, denominator, and failed refs.
- `consistency-checker.test.ts`: 13/13 passed including resource health truth tests.

## Verification

- `consistency-checker.test.ts`: 13/13 passed (resource health truth, severity capping, freshness degradation)
- Health center API returns four-dimension output; critical resources visible in denominator
