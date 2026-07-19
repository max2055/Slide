# Phase 132-139 Handoff

## Checkpoint

This checkpoint contains the in-progress Phase 132-139 implementation and
qualification work. It is deliberately **not** a release approval. The current
decision is **NO-GO**; see `139-VERIFICATION.md` and
`139-EVIDENCE-MATRIX.md` for the evidence boundary.

## Environment Rules

- Do not pull MySQL images or create disposable Docker containers.
- Reuse the operator-provided running container named `mysql` on port 3306.
- Do not stop or modify the user's services on ports 3000 and 5173.
- Managed Playwright qualification uses API 3003, WS 28890, and Vite 5175.
- The qualification DB is `db_ops_ai_qualification`. The recovery script uses
  only uniquely prefixed `slide_qualification_existing_*` databases and drops
  them in cleanup.

## Current Evidence

- `bash scripts/qualification/run-existing-mysql.sh bootstrap-upgrade`
  passed: 44 migrations, repeat initialization, schema and ledger invariants.
- `failover`, `backup-restore`, and `stability` scenarios passed against the
  existing MySQL 9.6 container. Backup recovery requires
  `mysqldump --single-transaction --set-gtid-purged=OFF` because GTIDs are
  enabled in that container.
- Backend: `pnpm --filter slide-api test -- src/adapter/__tests__/direct-adapter.test.ts`
  passed with 84 files / 952 tests; `pnpm --filter slide-api exec tsc --noEmit`
  passed.
- Frontend typecheck/build and Agent Core typecheck/69 tests passed earlier in
  this checkpoint. `pnpm lint` exits zero but reports 250 warnings, so it is
  not lint-clean evidence.
- Current managed E2E commands:

```sh
QUALIFICATION_ADMIN_PASSWORD=Tpam1234 PLAYWRIGHT_MANAGED_ENV=1 \
  pnpm --filter slide-frontend exec playwright test \
  e2e/release-security.spec.ts --workers=1

QUALIFICATION_ADMIN_PASSWORD=Tpam1234 PLAYWRIGHT_MANAGED_ENV=1 \
  pnpm --filter slide-frontend exec playwright test \
  e2e/release-critical-paths.spec.ts --workers=1
```

The security suite passed 9/9 and the critical-path suite passed 5/5 in the
most recent independent runs.

## Recent Additions

- `scripts/qualification/run-existing-mysql.sh`: recovery qualification using
  the existing `mysql` container, with destructive-name guard.
- 039-043 migrations: event resolution notes, report target parity,
  report-delivery audit, server report enum parity, and approval state parity.
- Report notification persistence, durable schedule jobs, dead-letter/replay
  handling, and recovery verification closure.
- WebSocket test coverage for real production-catalog tool policy denial and
  provider failure terminal state.
- Managed E2E for credentials DTO redaction and offline-resource readiness.
- Current evidence documents: `139-EVIDENCE-MATRIX.md`,
  `139-RECOVERY-EVIDENCE.md`, and `139-VERIFICATION.md`.

## Do Not Overclaim

The old `139-03-SUMMARY.md` says "Conditional GO" and treats source mappings
as finding closure. It is stale and must not be used as a release decision.
The current verification document is authoritative and remains NO-GO.

## Highest-Priority Remaining Work

1. HI-06/HI-07/HI-08: managed instance/server metric-to-alert-to-RCA workflow.
   The code supports server-target analysis records, but server RCA create /
   persistence / readback lacks managed E2E proof.
2. HI-09/HI-11: successful outbound notification to a controlled public HTTPS
   target and redirect-chain behavior. Do not weaken SSRF controls or use a
   private endpoint as a success target.
3. HI-10: managed database readback for failed/timed-out Agent runs. WS-level
   error and terminal-state behavior is covered, but database evidence is not.
4. HI-12/DR-03/HI-13: process-level startup ordering, interrupted migration
   recovery/readiness, and production weak/missing secret startup tests.
5. ME/DR/TG/OPT rows marked `Mapped only` or `Partial` in
   `139-VERIFICATION.md` need behavioral evidence before any GO decision.
6. Run the final full release gate after changes and update the evidence matrix
   only with current command output.

## Useful Commands

```sh
pnpm qualification:matrix
pnpm --filter slide-api exec tsx ../../tests/qualification/coverage-matrix.ts --check-ci .github/workflows/ci.yml
pnpm --filter slide-api test
pnpm --filter slide-api exec tsc --noEmit
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm --filter agent-core typecheck
pnpm --filter agent-core test
```

The bare root command `pnpm exec tsx ...` is not available in this workspace;
run qualification TypeScript through `pnpm --filter slide-api exec tsx ...` or
the `qualification:matrix` package script.
