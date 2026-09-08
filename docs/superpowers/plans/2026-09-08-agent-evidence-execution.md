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
- [ ] Evidence schema, durable store, resource authorization, observation adapter, tools and HTTP integration.
- [ ] GitLab configuration/synchronization, deployment identity, source search/read/symbol tools and outbound policy.
- [ ] Platform structured logs and independent health/freshness evidence integrated with actual runtime hooks.
- [ ] Invariant/expectation evaluations, evidence-linked decisions and independent recovery verification.
- [ ] Cross-resource diagnosis workspace, platform health and source configuration UI, compatibility checks.
- [ ] Security/spec reviews, affected regression, final build/gates, commit and GitHub PR.

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
