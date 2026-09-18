# MAX-68 implementation contract (v1)

Baseline: main `bf64502`, containing MAX-64 (#76), MAX-66 (#78), and MAX-65 (#79).

Scope: an internal, authorized V2 query and semantic aggregation boundary over normalized MySQL observations; exact metric/version/unit/dimension checks; deterministic time buckets and spatial reductions for gauge, counter, ratio, state and compatible histograms. Return window, coverage, freshness, provenance and semantic identity. Use the same reducer for live, history and downsampled windows. Add deterministic fixtures and isolated MySQL comparison.

Excluded: collector integration, HTTP routes, new distribution sources, changes to legacy APIs or historical AVG results, production rollout, and schema/contract migrations. Resource inventory is read separately from observations. No distribution or p95 is invented from summary quantiles.

Acceptance: focused reducer tests cover irregular intervals, boundary clipping, gaps, restarts, weighted ratios, state duration, histogram compatibility and semantic conflicts; isolated MySQL exercises indexed range, predecessor, authorization and bucket equivalence; affected contract/storage tests, typecheck and repository document gate pass. A PR with code, fixtures and validation evidence is the deliverable. Rollback is removing V2 service callers; old paths are unchanged.

Resource budget: at most approximately three hours of implementation and one final integration gate; no subagents. Actual token and cost telemetry is unavailable, so estimates are not reported as measurements. Stop if prerequisites are absent or required isolated-MySQL verification cannot be obtained; do not claim unverified acceptance.
