# MAX-238 B2F — shared readers & store-owned template gateway

- Base: `90dc2bf861c66323765d51974bd9d70de0787fbe`
- Implementation + focused tests: `3d5d93ddf`
- Delivery HEAD: this docs commit on top of `3d5d93ddf`
- Scope: internal wiring only. No route, runtime, default pool, DDL, real DB,
  model, resource, CI or deployment action. MAX238 remains `in_progress`;
  production enablement is still held.

## What changed

| Entry (real call point) | Old behavior | Template / bad row now |
|---|---|---|
| `MysqlPolicyStore.transaction` → `tx.binding` / `tx.members` | blind `JSON.parse` cast to `Published` | shared codec fence; `templates-v1` → `PolicyError TEMPLATE_BINDING_UNSUPPORTED` (409); corrupt/unknown/ambiguous → `PolicyError POLICY_BINDING_INVALID` (409) |
| `tx.saveBinding` | unchecked upsert that could overwrite any row | re-reads the row `FOR UPDATE` and refuses a template/corrupt row before the single-package upsert |
| `tx.audits` | blind cast of every audit payload | template operation audits (operation identity / `template_pins`) are identified and rejected; legacy audits still validated (`POLICY_AUDIT_INVALID` on a bad shape). The 100-row history is still not an operation query — exact operation lookup is the gateway's `lookupOperation` |
| `MysqlPolicyStore.reportApplied` / `reportCapabilities` | read via `tx.binding` | same fence; they cannot advance a template row's applied/capabilities |
| `PolicyService.binding` / `effective` / `changeBinding` / `changeGroup` | via `tx.binding` / `tx.members` | same fence; a group with any template member is rejected as a whole with zero writes (no filtered partial update) |
| `MysqlScheduleStore.scan` (used by `MetricScheduler.tick`) | every row decoded as `Published` | one row at a time: legal legacy rows continue; template/corrupt rows are reported with a stable code and never formalized or enqueued. `platformLogs` `collection.scan_skipped` carries the code, never the payload |
| `MysqlScheduleStore.list` | all rows as `Published` | all-or-nothing legacy view; the first non-legacy row throws its stable code (source-package allowlist fails closed) |
| `MysqlScheduleStore.current` / `enqueue` | decode / resource IO | `readLegacyPublished` before any work; direct `enqueue` validates its input before instance/resource IO. `begin`/`commit`/`recordFailure`/`assertCurrent` re-read through the same fence |
| `MysqlScheduleStore` job handler | a thrown fence would retry | a template row or corrupt snapshot records one sanitized `metric_schedule_events` row (`template_binding_unsupported` / `binding_payload_invalid`) and ends the job without a retry loop |
| `MysqlRolloutCoordinator.policy` | blind cast | shared fence; no shadow/cutover pin, acceptance, generation or formalized state for a template row |
| `MetricFormalization.accept` | blind cast | returns `template` explicitly; `reconcile` does not cache it as reconciled and does not write acceptance/rollout evidence |
| `MysqlPortfolioInventory.list` | `decode<any>` → unconfigured/old-package state | stable refusal `PORTFOLIO_TEMPLATE_BINDING_UNSUPPORTED`; the public portfolio type cannot represent a template binding yet (product interface TODO in code) |
| `monitor-collector.ts enabled` | decode + `!published || enabled` | no binding keeps the legacy default; template/corrupt → `false`; only a validated legacy row reports its `settings.enabled` |
| `MetricConfigurationService.activate/trial/status`, `BulkConfigurationService`, `MetricConsumerService` | already routed through `PolicyService` | no product change needed; integration tests prove the central fence fires before trial reserve, credential resolve, package runner and policy/collection writes |

`bindings/package-reader.ts` is the only fence: it calls the accepted B2E codec,
returns the stored legacy value unchanged (`package-v1` carrier accepted), and
throws a stable error for `templates-v1`, unknown envelopes, ambiguous sources
and corrupt snapshots. It never converts a template row to `Published`, never
infers a source from `package: null`, and never echoes payload/driver text.

## Store-owned gateway

`MysqlPolicyStore` takes an optional second constructor argument:

```ts
new MysqlPolicyStore(provider, { trustedInputs, trustedNow, registry })
```

- `templateGateway().apply(intent)` → accepted `MysqlBindingHost.apply`
  (B2E → B2D → B2C → B2A), with the real `PackageRegistry` passed by the caller.
- `templateGateway().lookupOperation(callerKey)` → accepted exact operation read;
  `complete: false`/`null` is not proof a replay is safe, and an unknown key is
  never re-sent.
- Without the injected options (the default store) both entries throw
  `TEMPLATE_GATEWAY_UNAVAILABLE` before a connection is taken.
- Lease: one connection from the **same** `MysqlPolicyStore` pool provider.
- Admission: the store's exported `withPolicyAdmission` queue (shared; max one
  lease at a time is asserted in the fixture).
- Lock order: admission → host `BEGIN` → `metric_policy_lock id=1 FOR UPDATE` →
  row locks; the host owns the single transaction, the store never nests a
  second one.
- Trusted reads: only the injected `trustedInputs(connection)` factory
  (`authorize`, `applicationContext`, `mandatoryItems`, `templateVersions`) on
  the host's live connection; no client actor/plan/receipt substitutes.
- Writes remain the accepted three: operation row (also the receipt
  consumption), binding payload CAS, audit — all inside the host transaction.
  The gateway writes only the pending candidate; the previous effective
  snapshot and `applied_revision` are preserved (asserted).

## Verification (real exit codes)

| Command | Result |
|---|---|
| `pnpm exec vitest run src/metrics/policy/template-gateway.test.ts src/metrics/bindings/package-reader.test.ts src/monitor-collector.fence.test.ts` | exit 0 — 3 files, 14 tests |
| `pnpm exec vitest run src/metrics src/monitor-collector.fence.test.ts` | exit 0 — 55 files passed / 24 skipped, 740 tests passed / 121 skipped |
| `pnpm exec vitest run src/operations` | exit 0 — 34 passed / 17 skipped, 349 passed / 335 skipped |
| `pnpm -C apps/db-ops-api exec tsc --noEmit` | exit 0 |
| `pnpm exec oxlint <13 changed files>` | exit 0 — 0 warnings, 0 errors |

The fixture is an in-memory model of the binding/group/audit/operation tables
and one connection. It is **not** MySQL: real transactions, deadlocks,
`JSON_EXTRACT`, commit-unknown/rollback drills, permissions, inventory, trial
application, formal sample gates and load remain unverified.

### Per-file hashes (git blob / sha256)

| File | blob | sha256 |
|---|---|---|
| `src/metrics/bindings/package-reader.ts` | `bf9411f1ad9ed349cdd0717d46ef7f14b5953f8c` | `ae32d2405587a27cf8409307816ff69af00e6d2807f05eb2660c1fa27fbaaf91` |
| `src/metrics/bindings/index.ts` | `afc627889e867b186d07ac6a590505d1cfd2e32b` | `5a088f54d9c49e9130bbf4fb818b321d5d1a407c2e9efa6fc2e34b62c874f416` |
| `src/metrics/policy/store.ts` | `d0c74f2c69cca3707d1fb1ab9b69355baed246cb` | `885fe7f7a84d4aed72076df0ef0bd68b0d4aed3307b140cb768fb9ee752f88e7` |
| `src/metrics/policy/template-gateway.ts` | `44b29f17d4448c50b4ad2ea798128e54ee7df2ea` | `ad9cef2feb0611fdabe21a1530ac48ba909cb4ed3cbd5c038f491dc0daf1628e` |
| `src/metrics/scheduler/store.ts` | `81c90a214d984e473c515722197442f44843b677` | `221a1183bdf7d3d1f25843cb5b324109631f253b49e5d9d89d731e1566878068` |
| `src/metrics/scheduler/service.ts` | `b8523fd0bebbdc4a9182a4a74c6e809ac6f2e66e` | `3d30a9cb7d66e3fc8d65a3ccfbea2d71c34878af7d782bec3173c264fb6514ad` |
| `src/metrics/rollout/coordinator.ts` | `573eacf107a44c33aa447c5e6381d99fcdf5df03` | `530ea336708b144ae1a711ff4454076e625b1edac26736299036482c43ebb30a` |
| `src/metrics/rollout/formalization.ts` | `e7d8f3bb180e2670413fdc68dfaae0ca01f77cbb` | `c108f91a5dffdf147e4e584c94d0babde8be0be192f713e7b799fa5e4e5f5ca8` |
| `src/metrics/rollout/portfolio.ts` | `88098639e91e31bf3cb29472649d0085afebd728` | `0a34842b1c3142dd4e871f80c456491a0321247ab531bc62a9d4120655c3d9a3` |
| `src/monitor-collector.ts` | `92c3799ccfcb23dc8500a3db436d6e52bc3ca9b9` | `ab5b4c1d8d1937b9c64a148b074f415d6880d9b516cfd44d07a37ca21b70cf0d` |
| `src/metrics/bindings/package-reader.test.ts` | `d1502cb747dabaeaf8a13e8c73a8ea29cfe6d2a0` | `140ab25ae5a77550c5dac873774f9a8fb324e1053d3427f801643329fe9d7801` |
| `src/metrics/policy/template-gateway.test.ts` | `a474adf34b808b62f0a54352615597faf5d345a1` | `340106be6526bffd5629a79b30d45e1762bfac45148ba48458ec1afd4fd3f8af` |
| `src/monitor-collector.fence.test.ts` | `08e21f8abebaf62824023e4fbaca8b1845d594aa` | `1200fa62eb36670fc6449b02024397a322077d5e6150ad0fc17c8458018de380` |

Accepted B1–B2E-R1 files are unchanged; the accepted codec/host/guard/adapter
tests are reused, not copied or edited. No public contract, migration, route or
frontend file changed.

## Reused and not covered

- Reused: B2E codec/host/guard/adapter and their accepted fault matrix; the
  whole `src/metrics` module gate (including config/bulk/consumers) and
  `src/operations`.
- Not covered here: it is **not** proven that all production readers are wired.
  The revision SQL in `src/metrics/rollout/formal-store.ts`,
  `src/metrics/config/status-store.ts` and
  `src/metrics/consistency-checker.ts` is a not-yet-admitted S5/state-integration
  object (owner S5/MAX-240, Chief confirms): those paths are registered, not
  modified. `operations/baselines` still only hashes `binding` and the
  legacy-write fence only checks row existence — both intentionally read-only.

## Production resume facts (per item)

| wait_kind | next_action | input_owner | minimum_resume_fact |
|---|---|---|---|
| isolated DB + schema | provision a disposable schema at the candidate DDL version | DB owner / Chief | schema/DDL version, backup/rollback plan and execution window |
| real write authorization | approve one write drill for the two tables | Max / Chief | explicit real-DB write authorization |
| template storage read port | MAX-237 same-connection template read interface | MAX-237 | accepted read port with permission |
| receipt issuer | real per-item receipt issue/revoke source | S5/MAX-240 | issuer identity/permission and revocation path |
| S5 readers / public trial & apply API | admit status-store/formal-store reader integration | S5/MAX-240 | exact reader interface + public trial/apply admission |
| multi-release execution | real multi-release runner + formal sample gate | MAX-236/S6/MAX-239 | accepted execution/sample gate evidence |

These are separate blockers; this package does not wait for "MAX-236 done" as a
whole and does not claim any of them.
