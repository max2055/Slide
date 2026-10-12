# T03-B Authorization and Session Bridge Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules. No child agents. Stop after the phase PR is merged; T03-C waits for T02-C.

**Goal:** Implement the approved V1.1 Profile, live authorization and atomic Session bridge on T02-B, without HTTP registration, executor or schema changes.

**Architecture:** Repository-owned immutable Profile snapshots constrain current SQL actor grants, ACL membership and all resources. Trusted caller and admission snapshots cap later permission expansion. The bridge composes store admission and explicitly authorized Chat append on one connection, binding one message per new request. Ordinary Chat reads recheck linked investigation authority.

**Tech Stack:** TypeScript, Fastify JWT harness, mysql2 transactions, Vitest, isolated MySQL 8.4.

## 1. Identity and Profiles

- Add a reserved service-account name and non-password marker in `auth/investigation-service-identity.ts`; reject interactive authentication, access-token signing and refresh issuance. Load service actors only through a trusted SQL connection with exact permissions and no admin/wildcards.
- Add `investigations/profiles.ts`: immutable ops/system version 1 snapshots, content hash, prompt text/hash, existing fault_diagnosis scene, readonly tool allowlists, conservative budget. Unknown versions fail closed; no model-controlled configuration.
- Verify schema-compatible snapshots, hash stability, unsafe tools excluded, service authentication rejected.

## 2. Live authorization

- Add `investigations/authorization.ts`: bind a verified numeric ActorContext to a store authorizer; SQL current reads on the transaction connection; sessionVersion/status, owner or unexpired viewer/operator membership, all instance/server/network scopes and caller ceilings.
- Read and content/watch authorization use the same all-scope gate. Missing scope/member hides metadata/messages/counts. Viewer continuation/cancellation returns forbidden only after visibility succeeds.
- Freeze actor permissions, resource scope, Profile hash and effective tools in admission authority. Revalidation intersects live grants and current tool policy with the persisted ceiling; promotions never widen an existing request.
- Test retained JWT revoke/expiry, each required scope negative, ACL expiry, caller mutation, Profile/tool denial, service misuse and later privilege expansion.

## 3. Session bridge

- Add `investigations/session-bridge.ts`: create/convert and optionally first-admit in one store transaction; admit only appends when isNew; persist authorization snapshot and request.message_id on the same connection.
- Add explicit authorized append to `chat-database-service.ts`; validate investigation/session/request/accepted version, user-only request message, count cap and stats, without maintenance append or nested transactions.
- Guard linked ordinary Chat reads and block owner append bypass; preserve ordinary unlinked Chat shares and ownership.
- Verify concurrent same-key one append/job, SQL failures at message/request/stats fully roll back, owner-only conversion preserves message IDs, active Run rejects conversion, service-owned Session remains service-owned for user continuation.

## 4. Verification and handoff

- Run focused authorization/session tests and existing Chat tests, then isolated MySQL/JWT phase acceptance with zero skips, affected security tests, backend typecheck, contracts and lint/diff checks.
- Record bounded review findings and evidence in `docs/slide/ai-native-operations/t03-b-validation.md`; update only the corresponding review-alignment capability.
- Open independent codex/MAX-144-session-bridge PR, collect current-head CI in one foreground watch, resolve in-scope failures, normally merge if repository gates allow. Verify main contains merge SHA.
- Preserve partial T03 status and parent phase evidence; resume parent once only if no active/queued run. Post one final issue comment with evidence attachment. No production mutation or model calls.
