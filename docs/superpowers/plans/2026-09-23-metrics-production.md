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

## Execution contract v3 — continue remaining implementation

The 07:30 user comment confirms continuation of the existing approved scope, not a new approval boundary. Restore PR #94 at `72deeb5`; preserve v1/v2 and all prior evidence. Budget remains unset; actual aggregate telemetry unavailable; no delegation.

1. Add `config/postgres-counter.ts` and tests: read bound database counters, postmaster startup, database OID and stats_reset in one fixed SQL statement. Preserve microsecond identity in the epoch digest; reject malformed identity/timestamps, retain exact integer values. A reset or restart changes the epoch even when the new counter exceeds the prior value.
2. Extend the internal SQL transport and runner guard to support this atomic read; route PostgreSQL transaction collectors through it in asset access. Keep existing pinned package semantics, fixture transports and non-counter reads compatible. Do not invent MySQL, DM or interface reset signals from uptime/name alone.
3. Exercise package normalization and derived rates across stable epochs and resets; verify bounded native driver access, target authorization, error sanitization and cancellation. Run focused tests and backend typecheck, then affected module integration checks.
4. Continue formal-source consumer/legacy writer inventory and cutover coordination against the full issue acceptance. Shadow policy publication must not by itself replace legacy alert/score inputs. Real target/capacity/release prerequisites remain separate from development authorization.
