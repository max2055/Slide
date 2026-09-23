# Metrics V2 production implementation plan

> **Execution:** Follow this plan within existing authorization and repository rules. No production activation without a concrete environment and change window.

**Goal:** Complete the approved MAX-85 production wiring and establish auditable acceptance evidence.

**Architecture:** Reuse MetricScheduler, JobRegistry and WorkerRuntime. Asset access stays server-side. Shadow evidence is persisted separately from formal publications; only accepted publications feed formal consumers. Legacy remains the default until resource-specific rollout acceptance.

**Tech Stack:** Fastify, TypeScript, mysql2, Vitest, existing Metrics V2 contracts.

## Execution contract v1

Baseline: origin/main 2da7b2d, isolated feat/max85-production worktree. Preserve original worktree changes. Hard budget: unset. Actual token/cost telemetry: unavailable. No subagents. Excludes semantic redefinition, new scheduling engine, history rewriting and unapproved production changes.

1. Wire lifecycle in `src/metrics-v2/scheduler/lifecycle.ts` and `server.ts`: explicit opt-in, migration readiness, shared registry registration, non-overlapping ticks, bounded drain and lease-loss stop. Test disabled behavior, restart registration, overlap, failed tick recovery and shutdown timeout.
2. Harden `src/metrics-v2/config/access.ts`: exact live asset identity checks, reusable production entry point, SNMP lifecycle preservation within an unchanged target and credential; fail closed for deleted assets. Keep unsupported lifecycle evidence unknown rather than inventing counters.
3. Add formal read store under `src/metrics-v2/rollout/`: query only accepted publications and active/applied V2 control, preserve invalid/unknown evidence, filter dimension discovery as well as semantic queries. Test shadow exclusion, pending revision and rollback.
4. Verify affected modules, real isolated MySQL migrations/scheduler/rollout, API contracts, backend/frontend type checks, frontend build/CSP, qualification and secret/deployment gates. Classify failures; environment skips are not production acceptance.
5. Record remaining writer/consumer migration inventory, target compatibility, capacity and rollback evidence in production operations documentation. Real assets, inventory scale and deployment permissions are required for production acceptance; stop actual rollout on any missing mandatory evidence.

## Acceptance tracking

MAX-85's full acceptance remains authoritative. Lifecycle and formal query tests establish development readiness only. Production CollectorAccess counter evidence, all legacy writer/consumer boundaries, real target versions, physical devices, production capacity, staged rollout and rollback must each be evidenced before production GO. Do not infer completion from local unit checks.

## Execution contract v2 — discovered acceptance blockers

Preserve v1 and its full MAX-85 scope. The runner produced Raw lineage but discarded Raw payloads before persistence; retaining Raw alongside normalized results is necessary for the stated storage/evidence acceptance. Production tickets also need resource identity to snapshot before IO, so append migration 102 without editing 098–101. Existing browser qualification used outdated pre-main labels and omitted the current discard-confirmation interaction; update only those test interactions. No new subsystem, subagent, external activation or budget limit was introduced.
