# MAX-101 Structured Memory Pipeline

Implementation base: main `1f2766beff9165bff4793ade3094d4cd35defc1d` (C1 #103, C2 #104, M0 #102 already merged). The assigned worktree's `5928537` contains unrelated local baseline changes; implementation uses a separate branch from main and preserves those changes.

## Contract and design

Scope v1: versioned records with user-message evidence; private actor/session scope and explicit read sharing; bounded extraction jobs with durable ownership, usage and reservations; authenticated business completion/replay entry; source invalidation, deletion, legacy import and versioned export/restore. No vector database, tool execution, approval changes, general agent framework or automatic legacy-file rewrite. Hard task budget: unset. Actual agent token/cost telemetry: unavailable. Child agents: 0; maximum depth: 0; concurrency peak: 1.

A SQL committed user-source snapshot feeds a dedicated extractor with no tools. Extractor output is a strict JSON array; content must equal a verbatim source quote and match its source ID/hash. A `fact` means **user-stated information**, with `evidence=user_statement`, not verification of external action success. Confidence describes extraction only. Assistant self-report, tool results, reasoning, derived summaries and pending/discarded text are excluded. Uncertainty remains uncertain; new conflicts mark both records uncertain; explicit changes supersede prior records and retain both supporting and denying evidence. Unknown legacy text is always uncertain.

The recommended design adds a separate `.slide/structured-memory/memory-v1.json` transaction file, using the existing fsync/rename primitive. Reusing MEMORY.md as the structured database would lose scope, provenance and deletion semantics. A new daemon/queue would introduce deployment and ownership machinery beyond this task. Instead authenticated completion, replay or `memory.retry` owns and awaits a finite job. No paid worker runs by default.

## Enablement and entrance

Set `SLIDE_MEMORY_PIPELINE_ENABLED=true` and an explicit stable `SLIDE_MEMORY_WORKSPACE_ID` (missing identity fails startup when enabled). The ID is a deployment identity, never an actor permission derived from cwd. Provider purpose `memory` uses the configured global default provider. Each extractor call has zero tool schemas; credential lookup stays in the existing provider layer, outside persisted memory. The registry/executor is never available to extraction.

For idempotent WS chat (`chat.send` with messageId/idempotencyKey), extraction occurs after AgentRunService's completed transaction and after success is sent to clients. Completion recovery and duplicate replay enter the same job ID. Legacy unkeyed chat, standalone invoke and cron do not create automatic memory because they do not have this authenticated durable-completion contract. Programmatic callers may await `DirectAdapter.extractCompletedMemory` after their own completed transaction.

Authenticated WS operations: `memory.list`, `memory.export`, `memory.import` (`text` for legacy or `export` for schema v1), `memory.delete` (`recordId`), `memory.share` (`recordId`, explicit numeric `actorIds`, empty array revokes), `memory.retry` and `memory.stop` (`runId`). They require ownership of the supplied session; ordinary shared-chat history access grants no memory writes. Actor B can retrieve explicitly shared records while querying B's own session, and cannot change or delete A's records. The service validates stored source-owner scopes before SQL queries. Memory records are reference data; they do not enter trusted policy or confer approvals.

`memory.list`/export reconcile current canonical sources, including source owners of explicitly shared records. Editing/deleting source messages or deleting the source session changes records to uncertain and retains invalid source IDs; affected jobs become obsolete. Delete removes the topic's records, persists a semantic-topic tombstone and cancels unfinished owner-scope jobs. Older jobs/exports cannot recreate that topic. Tombstones have no automatic expiry or implicit undelete. Import never rewrites human MEMORY.md. Versioned restore preserves provenance, strips grants, remains uncertain and never resets job/session budgets. Retaining the structured file when disabling the flag preserves records, jobs and sources for rollback.

## Limits, recovery and stopping

Default per job: 40 user messages, 20 candidates, 12,000 input bytes, 2,048 output tokens, 16,384 cumulative tokens, two provider attempts, absolute 30-second deadline. Session scope has a separate cumulative ceiling of 131,072 tokens/32 attempts. Cached usage is a subset of input and is never added again. Raw provider usage and request IDs are retained; token accounting normalizes prompt/input and completion/output aliases. Monetary billing is not available and is not inferred from tokens.

Admission writes the immutable boundary, sanitized source snapshot, limits, absolute deadline and job ID before requests. Each request reserves conservative UTF-8 prompt bytes + prompt allowance + capped output tokens and increments attempts durably before dispatch. Known usage replaces its reservation; failures/unknown usage retain it. Crash recovery requires a dead same-host owner and reuses counters/deadline; terminal success, Stop, timeout, obsolete and exhausted jobs cannot silently restart. Recovery of a failed attempt only uses its remaining allowance.

Deadline/Stop fence publication, even if a provider returns late. Owned request promises remain tracked through settlement; `dispose()` aborts and drains jobs and outstanding requests. Late replies can settle billing only, never publish candidates. Transport cancellation uses provider AbortSignal support (existing OpenAI/Anthropic clients disable SDK retries). A provider that permanently ignores cancellation can hold shutdown drain; that is fail-closed ownership rather than detached background work.

File transactions serialize within a process and use an exclusive same-host PID lock across processes. Reclamation rechecks ownership behind an exclusive guard. Cross-host shared-directory writers, malformed locks or a crash leaving a reclamation guard fail closed and require operator diagnosis; no unsupported distributed lease is claimed. Job budgets/records and success publication share one atomic file transaction. MySQL + this file is not an atomic dual write: missed post-commit admission is recovered by authenticated replay/retry. Every retrieval rechecks sources because deletion may race file publication.

## Verification

Focused memory tests: 111 passed across focused runs (including 74 new pipeline tests and 37 compatibility/consolidation tests). Fixed corpus has 45 cases, plus update/denial/conflict/uncertainty/schema/actor/share/cancellation/budget/restore cases. A real child exits during provider dispatch and restart preserves its pending reservation and attempt count. Late-output tests prove no publication and complete settlement after deadline.

Focused backend tests: 67 passed (memory service/WS 13, DirectAdapter and AgentRunService regressions). Tests use actual authenticated WS handling and persistence-boundary doubles; the separate MySQL qualification uses an isolated initialized schema and real completed transactions. It proves pre-completion exclusion, A/B ownership, actual post-commit adapter admission, replay, explicit sharing, source edit/delete, tombstones and unchanged completed chat state. The temporary schema is dropped and workspace removed in finally.

Run isolated qualification with authorized DB credentials already in environment:

```sh
pnpm --filter slide-api exec tsx ../../tests/qualification/memory-pipeline-mysql.ts
```

Real extraction is explicitly opt-in using `SLIDE_MEMORY_QUALIFY_REAL=1`; it reads the configured default provider without live credential migration, issues at most one request per qualification invocation (512 output tokens / 4,096 total / 15-second deadline), and emits sanitized source/job/record/usage evidence to `MEMORY_QUALIFICATION_REPORT` when specified. Real model success is reported separately; failure or missing usage does not count as passing. See the evidence JSON files and final validation report for the observed result.

Acceptance requires: focused checks, affected module tests/typechecks, source/permission/deletion invariants, live MySQL evidence, and honest real-provider result. Unrelated failures do not widen scope. Stop new work on an actual external authorization/tool refusal; retain a reviewable checkpoint if a required environment is unavailable.
