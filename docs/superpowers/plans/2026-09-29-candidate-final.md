# MAX-88 Candidate Final Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; track acceptance evidence. No delegation.

**Goal:** Reject high-confidence repeated candidates without polluting session, storage or reconnect history.
**Architecture:** Deterministic bounded detector plus per-run supervisor; optional rejection hook retracts cumulative streaming snapshots. Existing completion transaction remains authoritative.
**Tech Stack:** TypeScript, Vitest, Fastify, Lit.

Contract v1: approved runtime-v2-source plan §2.2–2.5/T2. Base/latest main `6eb8be58524946d00be043cd83a253c61e44def0`; only T1 differs from original `07b3e6c`. No provider switching, LLM judge, general recovery/context rewrite or unrelated UI work. No hard budget; actual token/cost telemetry unavailable. Stop for unmet external merge/acceptance gates; preserve work and arrange durable wakeup if needed.

1. Add `packages/agent-core/src/__tests__/runtime-supervisor.test.ts` reproducing repeated_text_accepted; cover success after rejection, exhaustion after three candidates, empty retry reclassification, cancellation, injection and clean checkpoints/provider history. Run focused tests and record baseline failure.
2. Add `runtime/text-repetition.ts`, `anomaly-guard.ts`, `supervisor.ts`: bounded Unicode-normalized blocks/ngrams, structured content and explicit repetition exemptions, at most eight current-run fingerprints, cross-step rejection only with stalled progress. Classify error/empty/length/unresolved calls before final acceptance. Add optional resolution and rejection hook in types. Integrate into turn-loop; two repetition recoveries with projection-only reminder; observe mode adds no requests.
3. Update adapter hook/ChatResponse/types and gateway/controller to preserve explicit empty snapshots and discard late streams. Cover catch, cancel, session-save failure, DB failure and reconnect. Add `candidate-final.test.ts`; extend gateway tests.
4. Map subagent non-success to failed with precise reason. Add completion service guards before staging and replay; keep existing transaction and idempotency. Extend existing subagent and run-service tests.
5. Freeze at least 200 labeled normal samples plus high-confidence anomalies in agent-core fixtures; report false rejection/miss rates by category. Run core/API/frontend affected modules, typechecks and final repository gates once per final candidate. Preserve legacy traces as historical evidence and explicitly update only changed expectations.
6. Commit stage, push PR with MAX-88 title; verify Multica association, collect CI in foreground, repair related failures. Merge only after actual required checks/reviews and stage acceptance; record merged SHA and evidence.
