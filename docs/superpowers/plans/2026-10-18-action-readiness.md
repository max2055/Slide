# P10 Action Readiness Implementation Plan

> **Execution:** Follow the approved action-readiness-1 contract, existing authorization and repository rules. No delegation or target writes.

**Goal:** Wire the real server to a fail-closed, read-only pilot environment so valid source-bound plans can reach pending approval.

**Architecture:** P10 composition loads an Ed25519 signed, expiring registration from deployment-owned files. The environment locks the existing server row, compares the complete plan binding, pins SSH identity and reads only the fixed helper inspect protocol. P06 continues to own source/ACL checks and approvals; dispatch remains disabled. P07 head 7c24a15d is interface reference only.

**Tech Stack:** TypeScript, Zod, ssh2, Fastify, mysql2, Vitest.

## 1. Trusted environment and server wiring

- Add `operations/action-environment.ts`: exact P07 registration fields, signed policy/verifier registration, bounded file reads, fixed SSH inspect with host verification, SQL locking identity checks, registration freshness and post-I/O rechecks. Missing configuration rejects without network access. Never expose execute/receipt here.
- Update `operations/composition.ts` to construct that environment by default; retain explicit dependency injection for domain tests. The existing `server.ts` composition call must automatically use this production wiring.
- Add focused tests covering signature tampering, unknown target/tool/policy/verifier, expired registration, SQL identity changes, helper/config/unit mismatch and missing config.
- Run `pnpm --filter slide-api exec vitest run src/operations/action-environment.test.ts` and API typecheck.

## 2. Actual server qualification

- Add `operations/action-readiness.mysql.test.ts`: isolated full migrated schema, synthetic investigation/evidence/result, real JWT/HTTP and actual `server.ts` child. Use a synthetic SSH protocol endpoint with test-only TCP redirection, keeping production fixed host/host-key rules intact.
- Validate plan create/submit, signature/config/identity rejection, ACL revocation, evidence expiry, absent configuration, no execution route, no approval consumption/outbox action jobs. Close child, SSH listener and fixture in finally.
- Run against a new dedicated local MySQL container; run affected operations tests then the repository's full API qualification gate and contract checks. Reuse previous B16 evidence.

## 3. Controlled source handoff

- Document dedicated schema/backup/restore points, API-only lease/ports, fixed registration and credential references, real collection→alert→investigation→result/evidence→pending plan steps and ownership in `docs/slide/development/action-readiness.md`.
- Keep real runtime source/approvals explicitly pending. Commit/push on PR212, preserve draft, register 30-minute checks continuation, deliver evidence attachment and independent parent review route. No merge/done or actual target access.
