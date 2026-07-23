---
phase: 132-security-boundaries
plan: 01
status: complete
commits: [63def89, 9701fca, 57ff80d, a8be942, ed03af6, 85599fe, b98ce6c, 9b1d31d]
---

# Phase 132 Plan 01 Summary

## Delivered

- REST, refresh, and DirectAdapter WS construct and revalidate the same fail-closed `ActorContext`.
- Session-version changes revoke refresh sessions; WS revalidation is serialized and closes stale actors.
- Chat session creation uses a server UUID and every list/read/history/watch/append/patch/delete/cap path is actor-scoped. Read shares are explicitly read-only.
- Empty first-chat session keys are adopted from the server and synchronized to settings, URL, and session list.
- Agent Core adapters use actor-bound registries. Every call produces a `PolicyDecision`; owner, permission, instance-scope, and approval failures return before the handler runs.
- `get_instance_connection` returns public connection metadata only. Passwords and connection strings are not returned to the model.

## Verification

- Backend actor/chat/tool suite: 97/97 passed during Task 3 validation.
- Phase-level backend security/chat/tool suite: 112/112 passed on 2026-07-18.
- Frontend DirectGateway suite: 13/13 passed.

## Decisions

- Background `invoke()` has no authenticated actor and therefore receives an empty tool registry; it cannot use a maintenance write path to mutate user chat data.
- Subagent delegation is absent from actor-bound tool registries until a child ActorContext propagation contract exists.
- The repository still exposes maintenance helpers for controlled maintenance code, but request-reachable chat and invoke paths do not call them.

## Known Baseline

- Whole-backend typecheck remains blocked by Phase 131 baseline configuration/error debt; targeted changed-file diagnostics contain no Phase 132 errors.
