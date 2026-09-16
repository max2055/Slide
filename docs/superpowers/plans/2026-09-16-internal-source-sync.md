# Internal GitLab Source Sync Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; track acceptance evidence. Implement in the isolated `codex/source-sync-internal-gitlab` branch.

**Goal:** Let administrators synchronize an explicitly approved HTTP/HTTPS repository without deployment metadata, while preserving safe, verifiable source reads.

**Architecture:** Fetch a configured ref (default remote HEAD), resolve it to an immutable commit, scan files, and publish an immutable signed repository snapshot. Store the active snapshot reference separately from deployment identity. Compute deployment verification on every response; a missing or mismatched binding never blocks otherwise valid repository reads.

**Tech Stack:** TypeScript, Fastify, Git smart HTTP, Lit, Vitest, Playwright.

## Approved scope and acceptance

The user approved the preceding assessment and requested implementation and a PR. No new approval gate or hard resource budget. No changes to unrelated user work, deployments, or image packaging. Token/cost telemetry unavailable; no subagents planned.

- Exact operator-owned origin allowlist accepts HTTP and HTTPS; deny other protocols, embedded credentials and redirects. Keep admin/read permissions and explicit model sharing.
- Optional `ref` accepts branch/tag/full SHA; empty means remote HEAD. Verify the fetched commit and record it, rather than requiring the deployed SHA.
- Missing, malformed or mismatched deployment metadata yields `repository-unbound` with a reason; complete matching commit/digest and no omissions yields `deployment-verified`.
- Persist origin, project, ref, scope, completeness and skipped paths/reasons in the signed manifest. Key immutable snapshots and active selection by repository/scope identity to prevent stale reads after configuration changes. Retain legacy bound-snapshot reading when no new active selection exists.
- Sensitive/unscannable/oversized files and symlinks are excluded and reported as partial; zero safe files, total/count limits, tampering and authorization violations remain failures. Never return rejected file content. Keep 512 KiB/file, 32 MiB/snapshot and 20,000 selected entries; enforce before accumulation, and a total sync deadline.
- All Agent reads carry commit, completeness and deployment verification; source remains untrusted implementation intent.

## Execution

1. Baseline: run source connector, snapshot, service, routes and deployment-binding tests.
2. RED: add HTTP Git integration covering no binding, explicit branch, skip reports, reads, repeated sync, changed branch head, policy changes and credential/redirect failures. Add UI behavior tests for ref and partial/unbound labels. Run new tests and commit the failing reproducer.
3. Implement `git-source-connector.ts`, source validation helper, `source-management-service.ts`, and `source-snapshot-service.ts`. Add active snapshot persistence, optional deployment verification and signed source metadata; preserve legacy bound APIs.
4. Update source settings, manifest view and Agent tool description; expose actionable statuses. Update deployment docs/environment wiring for signing key, origins and writable snapshot storage.
5. GREEN: run affected backend/platform and frontend source tests, HTTP Git sync integration, frontend production build and typechecks. Review diff and run final relevant CI gates once; classify unrelated baseline failures explicitly.
6. Commit implementation, push branch and create PR against main with results and deployment requirements. Verify the remote PR and leave merge to the user.

Real HTTP integration uses a local authenticated Git smart-HTTP fixture and temporary snapshots. It is not a claim of validation against the user's inaccessible internal GitLab.
