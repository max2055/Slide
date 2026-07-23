# Phase 132-139 Handoff

## Checkpoint

Phase 132-139 reached the authoritative historical **GO** on 2026-07-20. The
post-v0.9 engineering route is now implemented and locally requalified; see the
2026-07-23 closure section below. The only remaining operator action is server
3 SSH credential re-entry and its subsequent live health verification.

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
  passed on 2026-07-20: 51 migrations, repeat initialization, schema and ledger
  invariants.
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
- The checked-in CI workflow passes qualification gate coverage. PR #3 hosted
  run `29939147753` also passed all five jobs and published artifact
  `8537488077`; SHA256 verification and atomic rollback drill passed.
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
  omission that caused runtime health-check persistence to fail. The preceding
  49-migration contract passed on both MySQL containers; the current
  50-migration bootstrap passed on the primary qualification container.
- Migration 049 restores `alerts.level=p0`, which the enabled escalation rules
  already require. The primary database applied it through the migration runner;
  information-schema and transactionally rolled-back write/readback evidence
  confirmed `critical → p0` is now persistable. The next real scheduler cycle
  upgraded all eight previously failing critical alerts to `p0` without
  truncation errors. The schema invariant rejects upgraded databases that lack
  this value.
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

1. HI-06/HI-07/HI-08 are now verified. Browser evidence covers native MySQL
   metric rendering after connection-test/reload, scheduler persistence, a
   scoped threshold alert, and a completed structured RCA. Service tests prove
   target isolation, multi-level thresholds, and duration semantics. Producer
   parity plus current-database readback covers all 10 server metric names
   across 6,517 historical samples with no missing registry definitions.
2. HI-09/HI-11: the operator explicitly approved a no-public-egress local
   qualification exception on 2026-07-19. Do not claim SMTP/Feishu delivery or
   public redirect-chain behavior as verified, and do not weaken SSRF controls,
   credential protection, redaction, or failure/audit behavior. An egress-enabled
   environment is still required if real delivery evidence is later needed.
3. ME/DR/TG/OPT rows marked `Mapped only` or `Partial` in
   `139-VERIFICATION.md` need behavioral evidence before any GO decision.
4. Run the final hosted release gate after changes and update the evidence matrix
   only with current command output.

## Latest RCA Continuation State

- The managed launcher now accepts an optional `QUALIFICATION_DEEPSEEK_API_KEY`.
  Only when it is set does it configure the provider in the disposable
  `db_ops_ai_qualification` database; the normal browser suite stays
  network-independent. The key is encrypted through the runtime helper and is
  never written to a source file or evidence document.
- The optional fresh-alert browser path was exercised on 2026-07-19. It reached
  alert creation, created the matching `alert_rca` analysis, and observed its
  terminal state, but that state was `failed` with `Agent run ended: error`.
  This is diagnostic failure evidence, not RCA-success evidence and does not
  change the authoritative NO-GO decision.
- On 2026-07-20 the diagnostic loss was fixed across the provider response,
  Agent Core runner, `DirectAdapter.invoke()`, and `ai-agent-bridge`. Fresh
  verification passed the full API suite at 91 files / 975 tests, DirectAdapter
  18/18, bridge persistence 1/1, API, frontend, and Agent Core typechecks,
  Agent Core 69/69, the qualification matrix at 37/37, and the no-key
  metric-to-alert Playwright regression 1/1.
- After the operator configured DeepSeek on 2026-07-20, the key was decrypted
  in memory and passed only to the managed child process. The isolated
  fresh-alert browser path passed 1/1 in 53.2 seconds: native MySQL metric,
  scheduler persistence, threshold alert, DeepSeek RCA completion, and
  structured result readback all completed. No key was printed or written to
  source or evidence files. HI-08 is Verified; the overall decision remains
  NO-GO because other Partial findings remain.
- ME-01 browser cancellation is now verified with a managed local streaming
  provider. The fix wires the existing Stop control to the abort controller and
  adds a `run.started` protocol event so the browser adopts the canonical
  server run/session IDs. Playwright passed 1/1 and MySQL readback confirmed
  `state=cancelled` with `finished_at`.
- ME-02 is verified. DirectGateway preserves attachment and idempotency metadata;
  replay returns the existing durable terminal snapshot. Because DirectAdapter
  intentionally declares attachments unsupported, managed browser coverage
  verifies an uploaded image receives explicit `PROTOCOL_V2_INVALID` and MySQL
  run count remains unchanged, rather than silently dropping the attachment or
  invoking the model.
- ME-03 is verified. Real MySQL schedule state proves independent next-due and
  retry behavior, while collector-boundary coverage proves only scheduler-due
  metric IDs reach providers and persistence.
- ME-04 is verified. Real MySQL covers returned server-collector failures;
  Registry + UnifiedCollector coverage proves per-instance disablement after
  three consecutive exceptions, suppression after disablement, and reset after
  success.

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

## Latest GO State (2026-07-20)

This section supersedes every earlier NO-GO continuation note in this handoff.
The authoritative decision in `139-VERIFICATION.md` is **GO** and v0.9 is
marked shipped in `ROADMAP.md` and `STATE.md`.

- Final suites passed: API 93 files / 982 tests, frontend 19 / 182, Agent Core
  7 / 69, all typechecks, frontend production build, lint 0 errors, coverage
  37/37, and CI gate parity.
- Managed browser qualification passed 22/22 on the current 51-migration
  ledger. The cancellable-provider suite separately passed 2/2 with no skip,
  proving browser cancellation persistence and explicit unsupported-attachment
  rejection with zero Agent-run side effect.
- Migration 050 enforces SQL-history/approval/Operation associations. Primary
  orphan preflight returned zero for all three links, primary migration applied,
  and empty/repeated bootstrap plus backup/restore passed at 51 migrations.
- ME-05, ME-06, ME-07, HI-09, HI-11, DR-01, TG-01/02/04/06 are closed with
  behavioral evidence. Optimizations OPT-01/02/03 are explicitly deferred and
  do not represent correctness failures.
- PostgreSQL 18, Dameng 8, and Oracle 19c passed connection, health, query,
  native metrics, disconnect, and recovery. Oracle UAT exposed and drove the
  shared Oracle/Dameng AST fallback fix. After the Dameng environment was
  repaired, the final licensed `adapter-uat` rerun passed the complete matrix
  on 2026-07-20; TG-05 is Verified and no dated evidence gap remains.
- Real public SMTP/Feishu delivery remains outside the operator-approved local
  no-public-egress evidence scope and is not claimed. Worker, encryption,
  redaction, signing, SSRF, failure, dead-letter, and replay behavior is Verified.

## Post-GO Capacity Consistency Fix (2026-07-21)

- Reproduced the operator-visible mismatch: instance management showed five
  managed instances totaling `2.71 GB`, while Dashboard showed `0.9 GB` because
  `/api/dashboard/capacity-trend` summed only `status='active'` rows and rounded
  the result to one decimal.
- The “闭环健康” capacity check also filtered to active instances and accepted
  any aggregate delta below `1 GB`. Runtime evidence showed the false-positive
  message `实例总容量 0.9GB 与容量历史 0.4GB 一致`.
- Dashboard and consistency checking now use the same managed-instance scope.
  The check compares each instance at the persisted `0.01 GB` precision and
  treats every missing collection record as a warning.
- A forced capacity collection exposed a second root cause: MySQL and Dameng
  capacity totals summed already-rounded per-database/tablespace values. MySQL
  DECIMAL strings could also be concatenated by JavaScript `+`. Both adapters
  now sum explicitly numeric raw bytes and round only the final total.
- Red/green coverage: backend capacity/consistency/management tests passed
  20/20; backend and frontend typechecks passed; the focused Dashboard test and
  production frontend build passed. After service restart and forced capacity
  collection, managed-instance total and Dashboard current total both read
  `2.71 GB`, and `capacity_sum_match` returned `pass`.
- Evidence boundary: the historical Phase 139 GO remains the shipped v0.9
  decision. This post-GO delta has focused and live verification, but the full
  Phase 139 API/frontend/Agent Core and managed-browser gate has not been rerun
  after this change and must be rerun before claiming a newly qualified release
  artifact.

## 2026-07-23 Continuation Closure

- The previous “full gate not rerun” statement above is historical. The current
  local batch passed API 98 files/1001 tests, frontend 23/188, Agent Core 7/69,
  all typechecks, production build, lint with 0 errors/249 warnings, 37/37
  coverage, CI parity, generated-contract drift, and lazy-route/locale browser
  checks 2/2.
- PR #3 hosted run `29939147753` passed backend, frontend, agent-core, recovery,
  and release-artifact jobs. Artifact `8537488077` was independently SHA256
  verified and the atomic rollback drill passed.
- OPT-01 is implemented: the main entry is approximately 69.3% smaller and
  heavy operational routes load on demand. OPT-02 now enforces en/zh-CN key and
  placeholder parity and applies server-synced locale at runtime. OPT-03 now
  generates OpenAPI and frontend types from TypeBox with CI drift checking.
- A Docker runtime-wide exit 137 stopped all existing database containers during
  final browser work. Only the existing `mysql`, `mysql3308`, `postgresql`,
  `oracle19c`, and `dameng` containers were restarted. A clean backend restart
  then restored all 5/5 database connections and 3000/28888; frontend is active
  on 127.0.0.1:5173.
- Current capacity evidence is 2.59 GB on both managed-instance aggregation and
  Dashboard, with `capacity_sum_match=pass`. This supersedes the earlier 2.71 GB
  snapshot without changing the consistency conclusion.
- Stored database, DeepSeek, and Feishu credentials are live-verified. Server 3
  at `192.168.64.5` still requires an operator to re-enter its SSH username and
  password; do not fabricate or recover that secret from evidence. After entry,
  rerun server collection, metric persistence, and readiness truth.
