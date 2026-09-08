# Agent Evidence Execution Contract v1.1

This amendment preserves the discussion plan in `2026-09-08-agent-evidence-replay.md` as historical context. Where that plan contradicts the user's subsequent corrections or the checked-out code, this contract takes precedence.

## Baseline and Scope

- Base: origin/main at 3f76d32; branch: codex/agent-evidence-replay.
- Worktree: /Users/max/.config/superpowers/worktrees/Slide/agent-evidence-replay.
- Database, server and network device resources have equal standing. Capabilities differ, importance does not.
- Preserve Workspace, Resources, Operations and Security/Governance groups. Keep the combined alerts/events entry and historical Agent sessions in their existing locations.
- Add a cross-resource diagnostic workspace; embed evidence, freshness, invariant, expectation, source/deployment and decision views there. Reuse platform health and settings rather than adding independent centers.
- GitLab is a read-only source provider, pinned to deployment commit. Bounded source tools read validated local snapshots; they never receive repository credentials.
- Include structured platform logs, bounded aggregation, redaction, provenance and explicit missing/stale states.
- Reuse real ActorContext user/resource authorization. The codebase has no tenant identity: do not invent one or silently skip authorization.
- Historical PR review is supporting design evidence only. Do not implement replay contracts, runners, fault cases, replay gates or another PR review project.
- Do not introduce automatic remediation, new shell/SQL/network writes, automatic learning policy activation, or production deployment.
- Existing action authorization remains authoritative. Verification is observational and must never turn an unverified operation into recovered.

## Delivery Batches

- [x] Fetch latest default branch; isolated branch; frozen dependency installation; API/frontend baseline typecheck.
- [x] Evidence schema, durable store, resource authorization, observation adapter, tools and HTTP integration. Verified real MySQL on all three types and a fresh process.
- [x] GitLab configuration/synchronization, deployment identity, source search/read/symbol tools and outbound policy. Fixture-tested; real GitLab credentials not supplied.
- [x] Platform structured logs and independent health/freshness evidence integrated with actual runtime hooks. Bounded process-local logs explicitly report retention/restart gaps; external dependencies not instrumented remain unknown.
- [x] Invariant/expectation evaluations, evidence-linked decisions and independent recovery verification. Opt-in policies snapshot at operation creation; a full independent observation window is required.
- [x] Cross-resource diagnosis workspace, platform health, source configuration, invariant configuration, evidence-linked decision and recovery UI. Live desktop/mobile checks passed.
- [x] Security/spec reviews, affected regression and release build. Gate outcomes and environment limitations are recorded below; not all smoke cases passed.
- [x] Push branch and create GitHub PR #36: https://github.com/max2055/Slide/pull/36. No merge or deployment; remote CI is tracked on the PR.

## Verification

Develop with failing focused tests before implementation. At batch boundaries run affected modules and typechecks; run final gates once after the integrated candidate stabilizes. Capture baseline failures separately and do not repair unrelated failures. Use an isolated test database, never production. Browser validation must include desktop/mobile, deep links and permission states. Fixture tests prove fixture behavior, not real GitLab/Oracle/DM8/Huawei UAT.

## Resources and Stop Conditions

- No user-provided token or monetary ceiling. Do not invent a token budget; model usage is unavailable unless the runtime supplies it. Goal ledger usage is not measured aggregate model throughput.
- Maximum eight child agents over this Goal, depth one, peak concurrency four. Delegate only independently bounded tasks; no nested delegation.
- Cumulative subagents: three (evidence implementation, independent review, frontend integration), depth one, peak concurrency two. Update this entry on dispatch; do not reset cumulative usage.
- Stop feature expansion on confirmed data loss, authorization bypass or secret disclosure. Fix directly touched issues before proceeding.
- Missing real GitLab credentials/hardware cannot justify fake UAT success; record the limitation and verify the adapter against isolated fixtures.
- User has authorized autonomous judgments and requested no confirmation prompts. Continue safe in-scope alternatives; never expand authority to deployment or destructive production actions.

## Decision Log

2026-09-08 v1.1: removed stale replay requirements and database-first hierarchy; use real user/resource security model; preserve existing settings-based Agent policy. This is reconciliation with explicit user corrections, not additional scope. The original plan is retained and Goal usage is not reset.

2026-09-09 implementation checkpoint: migrations 087/088 validated on isolated MySQL; real evidence/decisions survive a separate process. Preserved original network observation expiry after integration exposed a five-minute validity extension. Stable observation IDs now exclude diagnostic request identity. Source JSON/YAML secret checks, current-directory revocation, idempotent immutable publication, complete deployment binding, total synchronization deadline and source read budgets are enforced. Recovery is opt-in prospective policy capture, never a retroactive success claim. No new agents have been spawned; the same three implementation/review agents are reused. Raw token/cached/output/cost telemetry is unavailable; Goal ledger remains cumulative and is not presented as actual throughput.

## Final Qualification (2026-09-09)

- Integrated new upstream main commit 6f74a96 (#35) without conflicts. Original workspace remains untouched by implementation.
- Workspace tests: frontend 66 files / 368 tests passed; Agent core and sandbox-controller suites passed. API final suite after upstream integration: 230 files / 1,940 tests passed. The added release-script regression and deployment-binding tests subsequently passed (3 tests). Migration-runner fixture was updated for the new schema invariants after two failures in the initial full run.
- Workspace typechecks passed; API typecheck repeated after the release regression addition and upstream merge passed. Contracts check, secret scan, schema consistency (10 checks), production frontend build and CSP check passed.
- Release artifact with source binding generated at commit e5a30e3. Production build reports existing chunk-size/mixed-import warnings; these are not suppressed or refactored here.
- Isolated MySQL migrations, three-resource persistence across a fresh process, authorization and immutable recovery snapshots passed. A real 30-second controlled observation window remained unknown until complete, then returned recovered. This is integration qualification, not physical-resource UAT or historical PR replay.
- Live desktop 1,440px and mobile 390px Playwright: 2 tests passed, including equal resource deep links, durable decisions, default-off policies/source sharing and recovery result. Screenshots inspected for wrapping/overflow. Mocked diagnostic workflow tests also passed in both sizes.
- Existing API smoke: 82/85 passed against the isolated API. The three unchanged schema/index collection cases returned 400 because the qualification instance is deliberately disconnected and contains no collected indexes. No real resource was connected to satisfy the smoke assumptions. Existing deep-smoke hardcodes localhost:3000/admin; it was not run against the user's service. These are recorded environment limits, not claims of a fully green smoke gate.
- Independent spec/security review found no remaining actionable blockers after fixes for structured scalar secrets and the initially unobserved recovery interval. Resource evidence/decisions are durable, but automatic retention cleanup, a unified durable platform/source EvidenceItem store and legacy AnalysisEnvelope reference migration are not included. Platform logs are a bounded process-local ring. Real GitLab credentials and physical database/network device UAT were unavailable.
- Resources: three reused child agents, depth one, maximum three active goal agents including the parent; no new descendants. Actual aggregate input/cached/output/cost telemetry unavailable; no fabricated consumption totals.
