# MAX-101 validation

Base: `1f2766beff9165bff4793ade3094d4cd35defc1d`. Scope v1 is described in MAX-101-memory-pipeline.md. C1, C2 and M0 implementation PRs #103/#104/#102 are merged. Original assigned worktree and unrelated modifications remain untouched.

## Delivered

- Schema-v1 records: stable IDs, kind/subject/verbatim content, workspace/actor/session, source IDs/hash/quotes, timestamps, extraction confidence, user-statement/legacy evidence, active/superseded/uncertain status, denied-source lineage and explicit grants.
- Default-off authenticated post-commit WS entrance, recover/replay/retry, searchable list and explicit Stop, export/restore/legacy import/deletion. No extractor tools or chat-write access.
- Durable job boundary/ownership/deadline, per-job and cumulative scope budget, pre-request reservation and complete available provider usage, late-response fencing/settlement, shutdown drain and real child-process restart recovery.
- Source edit/delete invalidation, permanent deletion tombstones and restore without grants or budget reset. Human MEMORY.md is preserved.

## Verification evidence

| Check | Result |
|---|---|
| Fixed evidence corpus | 45 fixed cases, plus uncertainty/update/negation/conflict/injection/secret/schema and lifecycle cases |
| New pipeline tests | 74 passed on final code |
| Existing memory compatibility/consolidation | 37 passed |
| Backend memory/DirectAdapter/AgentRunService focused tests | 67 passed |
| agent-core full suite | 563 passed, 23 files on final code |
| Backend full suite | 2,754 passed; 129 skipped in 21 files (environment-gated tests), 294 passing files |
| agent-core/backend typecheck | Passed |
| New implementation oxlint | Zero errors/warnings; DirectAdapter retains two pre-existing unused imports |
| Real isolated MySQL | Both committed-source and business-entry/share/source-edit/delete/tombstone scenarios passed, twice |
| Real child exit during extraction | Passed; next process retains original reservation, attempts and deadline |
| Limited real provider | **Not passed**: configured deepseek-v4-flash returns HTTP 402 / LLM_INSUFFICIENT_BALANCE |

The provider was invoked in two bounded qualification runs, one attempt per run, max 512 output / 4,096 total tokens / 15-second deadline. No valid extracted record, usage, request ID or monetary billing was supplied. Each job retains a conservative 1,913-token reservation (3,826 total across the two isolated jobs). This reservation is a budget charge, not measured model throughput. Evidence files preserve the source snapshot, job limits/state, empty records and the second attempt's exact safe HTTP/error code. No further paid retry was performed.

The real extraction acceptance gap requires topping up the provider or selecting an available authorized model, then rerunning the opt-in qualification. Deterministic provider and real SQL evidence do not substitute for this success. No production enablement or provider configuration change was made.

Commands:

```sh
pnpm --filter @slide/agent-core exec vitest run src/__tests__/memory-pipeline.test.ts src/__tests__/memory.test.ts src/__tests__/memory-consolidation.test.ts
pnpm --filter slide-api exec vitest run src/adapter/__tests__/memory-service.test.ts src/adapter/__tests__/direct-adapter.test.ts src/adapter/__tests__/agent-run-service.test.ts
pnpm --filter @slide/agent-core test
pnpm --filter slide-api test
pnpm --filter @slide/agent-core typecheck
pnpm --filter slide-api typecheck
SLIDE_MEMORY_QUALIFY_REAL=1 pnpm --filter slide-api exec tsx ../../tests/qualification/memory-pipeline-mysql.ts
```

Qualification reads existing provider configuration without live credential migration and writes only an isolated test schema/workspace, both removed on completion. Credentials are loaded in process memory and never written to the report, Git, jobs, records or temporary fixture files.

Limits: source reconciliation occurs on retrieval; MySQL + file publication is not a dual-write transaction. Same-host ownership is enforced; cross-host/malformed locks fail closed. Providers must support AbortSignal for finite shutdown drain. Standalone invoke/cron and legacy unkeyed chats remain outside automatic extraction because they lack authenticated durable completion. Explicit sharing covers the nominated actor within the workspace; chat sharing alone grants no memory writes. Nothing promotes memory into policy/approval.

Hard task budget: unset. Actual raw/cached/output tokens and monetary cost: unavailable. Delegated agents: 0; depth: 0; active-agent peak: 1. Cached input is not counted twice. CI is handed off through a PR checks condition; no background local work or service remains.
