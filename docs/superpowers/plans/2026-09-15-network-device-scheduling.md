# Network device scheduling and Chinese detail UI

> **Execution:** Follow this plan within existing authorization and repository rules; track acceptance evidence. User approved the design and implementation in this task.

**Goal:** Verify configurable metric collection, add daily per-device configuration backups (00:00 Asia/Shanghai by default), and translate network-device details.

**Architecture:** Keep existing database/server/network metric scheduling and the metric registry as the frequency source. Add a persisted per-device daily backup schedule and atomic daily occurrence claims; reuse ConfigBackupService for SSH policy, encryption and audit. The detail view edits the schedule with backup permission and displays its last outcome.

**Tech Stack:** Fastify, TypeScript, MySQL migrations, Lit, Vitest, Playwright.

## Execution contract

- Branch: codex/network-device-scheduling-zh; isolated worktree, preserve original local changes.
- No remote deployment, real-device SSH/SNMP calls or unrelated refactors.
- Budget: not set; actual token/cost telemetry unavailable; no subagents.
- Stop after tested changes are committed, pushed and a reviewable PR is created.

## Tasks and acceptance

1. Add `091_network_config_backup_schedule.sql` with settings and per-device/date occurrence tables. Defaults: enabled, 00:00 Beijing time. No credentials are copied. FK cascade on device deletion.
2. Add `config-backup-scheduler.ts` and tests. Scan every 30 seconds, catch up today's occurrence after a restart or late startup, never replay older days. Atomically claim once per local day across workers/restarts. Disabled/no-SSH devices are excluded. A failed occurrence is recorded without automatic same-day retries; manual capture remains available. Interrupted attempts expire to failed after ten minutes rather than repeating an uncertain SSH operation. Changing time after today's attempt takes effect tomorrow.
3. Add GET/PUT `/api/network-devices/:id/backup-schedule` to the existing route module. Read uses view permission, write uses backup permission. Validate boolean enabled and strict HH:mm, reject unknown fields, check device existence; persist settings and return latest outcome. Test unauthorized writes, invalid input, defaults and save/read behavior.
4. Wire scheduler start/stop in `server.ts`. Translate `network-device-detail.ts` text and dynamic enum labels; add schedule form using shared components, pending/error states, explicit timezone and SSH prerequisite, plus collection configuration guidance. Test form submission, permission-safe failures, Chinese labels and existing actions.
5. Extend collection scheduler tests for all resource types, frequency increase/decrease and resource isolation. Run focused Vitest tests during development, then API/frontend suites, typechecks, frontend build and a browser scenario for the final candidate. Validate migration in an isolated MySQL schema if available. Review diff, commit, push and create PR with validation and runtime limitations.

## Validation evidence

- Existing resource collection: database heartbeat in `monitor-collector.ts`, server heartbeat in `server-collector.ts`, network heartbeat in `network-device-collector.ts`. All use `dueStoredMetricIds` and metric registry intervals. Network defaults are 300 seconds; the 10-second network heartbeat checks due work, not a fixed collection frequency. The additional reachability probe runs every 60 seconds independently.
- Network collector fake-clock test proves live 300 → 30 → 600 second interval changes without restarting; due-time tests cover all three resource types.
- API and frontend TypeScript checks pass. Final API full suite: 243 files / 2045 tests passed. Frontend full suite: 69 files / 397 tests passed. Production frontend build and CSP check pass.
- Contract generation check, qualification coverage matrix (37/37), secret scan and lint pass (lint reports existing warnings, zero errors).
- Real MySQL: `DOTENV_CONFIG_PATH=<local configuration> pnpm --filter slide-api exec tsx tests/config-backup-schedule-mysql.ts` passed. It creates and drops an isolated schema, applies migration 091 twice, verifies defaults, persisted settings, disabled/no-SSH filtering, concurrent and restarted scheduler claims, stale configuration rejection, interrupted-attempt expiry and foreign-key cleanup. No production schema or credentials were changed.
- New browser scenario: `pnpm --filter slide-frontend exec playwright test --config playwright.audit.config.ts network-device-scheduling.spec.ts` passed at 390px and 1280px, including default midnight, changing time, disabling backup, saving, reload persistence and Chinese detail tabs.
- Additional existing `infrastructure-ops.spec.ts` run: one passed, two blocked at the pre-existing `app-dialog[title="添加服务器"]` selector before reaching network-device steps. The snapshot shows the server dialog is visible; `app-dialog.title` is a property without attribute reflection. Server/dialog source is unchanged. Network-step selectors were translated to match this change; the unrelated server selector was not changed.

## Rollout notes

- Deploy with migration 091 applied through the existing migration runner before starting the API workers.
- Existing and new devices default to enabled daily midnight backup; devices without SSH credentials wait until configured. Backup scheduling is independent of the metric collection switch.
- On late startup or restart, only today's due backup is caught up. One automatic attempt per device per Beijing date includes failures; use manual capture to retry. No historical-day replay. A process-interrupted attempt is marked failed after ten minutes, not automatically repeated.
- Real network-device SSH/SNMP and remote deployment were not exercised. The SSH service and authorization policy are reused unchanged; browser data is mocked.
