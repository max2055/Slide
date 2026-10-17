# P05 implementation plan

> **Execution:** Within approved implementation-1.2 and MAX-198 file ownership; no delegation.

**Goal:** B08 deterministic, permission scoped event correlation and ranking with immutable replay.
**Architecture:** Pure correlator/scoring; MySQL snapshot store composes existing event/admission, P02 relation session and P04 baseline read. HTTP registration remains an export for P10.
**Tech Stack:** TypeScript, Fastify, mysql2, Zod, Vitest.

1. Add pure scoring and correlation tests: 15-minute original observation windows, two-hop/100-edge bounds, known signature only, severity partition, fixed 50/20/15/15 bounds, stable ties and shuffled replay. Implement scoring.ts/correlator.ts.
2. Implement store.ts using existing attention schema. Accept only resource/window requests; load source event rows read-only, verify investigation membership and full scope. Compose P02 evidence/legacy validation and P04 qualification on the transaction connection; no model/tool/execution dependency. Append immutable versions and outbox; serialize through the existing metrics control lock. Preserve group IDs by event overlap across late-event revisions.
3. Implement audited merge/split with expected-version CAS and exact event partition; preserve original event/investigation IDs. Frozen-version pagination contains visible stable IDs only; recheck authority, source validity, expiry and flags at final delivery. Permission changes invalidate cursors.
4. Add real isolated MySQL/listening HTTP/JWT tests: source ingestion, deterministic replay, concurrent versions, late events, split/merge history, hidden investigation/resources, revocation, stale facts, baseline unknown, flags and retained history. No VM or Provider actions.
5. Run focused suite, operations module suite, API typecheck/contracts and required candidate CI. Create MAX-198 PR; record exact base/head and evidence. Register child checks continuation against actual delivery thread; parent independently reviews, merges and verifies main. No self approval.

Stop at reviewable PR delivery after in-scope verification. Data fixtures never establish 14/28-day qualification. Product model calls remain zero.


## P05-R1 repair (2026-10-17)

Continue original PR210 at 11b02f22; preserve the implementation baseline and prior evidence. No delegation or product model calls.

1. Reproduce the independent final-principal resource expiry on real isolated MySQL; retain red evidence before changing the store.
2. Add an attention-local SQL expiry horizon with monotonic elapsed time; use the final principal's complete resource/investigation/path scope, and reject expired projections immediately before synchronous delivery.
3. Cover grant/member/role expiry, final-query IO on both sides, full investigation scope, multiple groups/cursors/override history, hidden path nodes, synchronous projection delay, listening HTTP and actual final scope revocation.
4. Run focused checks, affected Operations, API typecheck and candidate gates; push original PR, renew child checks continuation, deliver exact head evidence for the existing independent parent review. No self merge/done or P12 unlock.
