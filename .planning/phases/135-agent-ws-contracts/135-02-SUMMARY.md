---
phase: 135-agent-ws-contracts
plan: 02
status: complete
commits: [0ee4bf4, 9ca04f3, b3db71f, 7c1f6e5]
---

# Phase 135 Plan 02 Summary

## Delivered

- AI analysis is persisted as versioned `AnalysisEnvelope` (`analysis/analysis-envelope.ts`, migration `030_analysis_envelope.sql`). Structured data (hypotheses, evidence, recommendations) is stored in a typed JSON column with schema validation, not embedded in Markdown code blocks.
- Backward compatibility: legacy Markdown records with embedded JSON code blocks are parsed and migrated to the envelope format on read. New writes must pass envelope validation.
- Agent management UI is driven by DirectAdapter capability declarations (`7c1f6e5`). Unsupported features (model switching, fallback, reload for non-existent backends) are hidden; only negotiated capabilities with real handlers appear.
- Observation freshness is modeled explicitly (`b3db71f`): `observed_at`, `valid_until`, `source`, and `quality` fields distinguish live data from stale/unknown.

## Verification

- `analysis/analysis-envelope.test.ts`: 16/16 passed (envelope validation, migration from legacy, schema enforcement)
- Frontend typecheck and production build pass
- Agent management page renders only supported capability controls

## Known Baseline

- Whole-backend typecheck blocked by Phase 131 TS5103.
