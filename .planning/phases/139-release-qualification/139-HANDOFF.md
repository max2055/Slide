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
  them in cleanup. The managed browser launcher resets only
  `db_ops_ai_qualification` before every run and reinitializes it with the
  current migration ledger; it never resets an application database.

## Current Evidence

- `bash scripts/qualification/run-existing-mysql.sh bootstrap-upgrade`
  passed: 49 migrations, repeat initialization, schema and ledger invariants.
- `failover`, `backup-restore`, and `stability` scenarios passed against the
  existing MySQL 9.6 container. Backup recovery requires
  `mysqldump --single-transaction --set-gtid-purged=OFF` because GTIDs are
  enabled in that container.
- Full local regression passed on 2026-07-19: `pnpm test` passed API 88 files / 968 tests
  (including signed Feishu webhook, lost-encryption-key recovery, and
  notification-activation contracts),
  frontend 19 files / 181 tests, and Agent Core 7 files / 69 tests. API and
  frontend typechecks/build passed; `pnpm lint` exits zero but reports 250
  warnings, so it is not lint-clean evidence.
- The checked-in CI workflow passes the qualification gate coverage check. This
  confirms configuration coverage only; no hosted CI execution artifact exists.
- Lost-key recovery was qualification-tested and then executed locally after the
  historical encryption key was confirmed unavailable. It intentionally
  invalidated stored secrets: operators must re-enter five database-instance
  credentials, one server credential, two LLM-provider credentials, and the
  credentials for any notification channels that should be re-enabled.
- Settings now contains an admin-only “飞书通知” page. It creates or updates a
  Feishu channel, keeps stored webhook paths and signing secrets redacted, and
  exposes the protected one-shot test action. It does not turn blocked external
  delivery into success evidence.
- Migration 047 sets a per-channel delivery activation boundary. A newly
  enabled channel receives only alerts created from that boundary forward; both
  the durable scheduler and delivery worker reject older alerts. This closes the
  observed historical-notification retry storm without weakening outbound policy.
- Migration 048 restores `health_check_history.dimensions`, a historical schema
  omission that caused runtime health-check persistence to fail. Empty and
  repeated bootstrap now verifies this 49-migration contract on both MySQL
  containers.
- `workflow-catalog` now runs every registered durable workflow handler in an
  isolated empty control plane and reads each terminal completion from MySQL,
  including the persisted `report.notify` unavailable-target skip audit. It
  covers safe no-op/unavailable-target paths only; LLM-driven cron behavior
  still requires its own runtime evidence.
- Approval retry now reattaches the approval record to the newly created
  attempt. Managed recovery coverage reads back a cancelled first attempt, a
  queued second attempt, and the updated approval link; it also opens the
  pending approval in the browser and clicks the cancellation/retry controls.
- `adapter-uat` connected real local PostgreSQL 18 and Dameng 8 and read native
  metrics. `oracle-adapter-uat` separately connected real Oracle 19c and read
  native metrics after its listener service was restored.
- Managed browser qualification was rerun after the dedicated qualification
  database reset fix: the security, critical-path, and Agent capability suites
  passed 22/22 on 2026-07-19.
- Current managed E2E commands:

```sh
QUALIFICATION_ADMIN_PASSWORD=Tpam1234 PLAYWRIGHT_MANAGED_ENV=1 \
  pnpm --filter slide-frontend exec playwright test \
  e2e/release-security.spec.ts --workers=1

QUALIFICATION_ADMIN_PASSWORD=Tpam1234 PLAYWRIGHT_MANAGED_ENV=1 \
  pnpm --filter slide-frontend exec playwright test \
  e2e/release-critical-paths.spec.ts --workers=1
```

The security suite passed 11/11 and the critical-path suite passed 8/8 in the
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

1. HI-06/HI-07/HI-08: browser evidence now covers native MySQL metric rendering
   after the connection-test/reload user flow, scheduler persistence, and a
   scoped threshold alert. It separately covers server RCA. A single browser
   workflow that attaches a real RCA to that fresh alert remains needed.
2. HI-09/HI-11: the operator explicitly approved a no-public-egress local
   qualification exception on 2026-07-19. Do not claim SMTP/Feishu delivery or
   public redirect-chain behavior as verified, and do not weaken SSRF controls,
   credential protection, redaction, or failure/audit behavior. An egress-enabled
   environment is still required if real delivery evidence is later needed.
3. ME/DR/TG/OPT rows marked `Mapped only` or `Partial` in
   `139-VERIFICATION.md` need behavioral evidence before any GO decision.
4. Run the final hosted release gate after changes and update the evidence matrix
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
