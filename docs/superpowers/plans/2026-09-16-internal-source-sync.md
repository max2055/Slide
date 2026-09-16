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

## Implementation adjustments (v2)

- Legacy deployment-only manifests lack origin/ref identity. Instead of reusing them after an origin change, require one resync into the new repository snapshot format; existing files remain untouched. This supersedes the v1 legacy fallback clause.
- A runtime check of the existing local API image found no Git executable. Install Git/CA certificates in the production stage and add a deployment regression check.
- The production root filesystem is read-only and /tmp is a 64 MiB tmpfs. Use the existing private writable source directory for temporary checkouts as well as snapshots; clean checkout directories in finally. No image build or deployment is included.
- Empty optional Compose deployment overrides must not mask a supplied manifest. Nonempty partial overrides still produce an unbound status.
- Save refreshes the manifest view so a changed repository/ref cannot leave a stale snapshot displayed. Existing tool names stay stable; search/symbol responses now wrap matches with source identity/status.

## Validation evidence

- Baseline source suite: 40 tests passed; RED commit reproduced blocked HTTP/ref and missing UI ref control.
- Implementation full API suite: 250 files / 2,107 tests passed; full frontend suite: 69 files / 406 tests passed.
- Final affected platform/tool suite: 14 files / 66 tests passed, including deployment override, digest mismatch, origin/scope isolation and ref validation.
- Real HTTP Git integration: POST sync 200, actual Commit matches, signed manifest persisted, GET manifest 200, safe region/search/symbol reads, repeat sync and changed branch head. Checks partial/unbound states, denied credentials, redirects, tampering and stale scope/origin rejection.
- Chromium interaction tests passed at 390px and 1280px: save HTTP/ref config, sync, clear token, show skipped paths and partial/unbound labels, refresh after ref changes. Browser API responses are fixtures.
- Both typechecks, production frontend build/CSP, API contract check, qualification matrix, secret scan, dependency audit and deployment security checks passed. Lint exited successfully with existing repository warnings; no errors.
- Inaccessible internal GitLab, live MySQL-backed sync, full image rebuild and production switching were not exercised.
- No hard budget set; actual token/cost telemetry unavailable. Zero delegated agents. Original dirty user worktree remains unchanged.

## User-directed adjustment (v3)

The user requested relaxing sensitive-content and oversized-file rejection for an internal repository controlled by the same development/operations team. This supersedes v1/v2 per-file content rejection:

- Retain sensitive-pattern matches and unscannable configuration as original text; record signed advisory warnings without blocking publication, reads or deployment comparison.
- Replace the 512 KiB hard cutoff with an advisory large-file marker. A single file may use the existing 32 MiB aggregate snapshot budget. Keep the total/count limit, binary/path/symlink checks, signatures and 200-line/16-KiB region output limits.
- Keep the Git authentication token outside persisted data/logs/Agent results. Existing explicit model sharing also covers flagged repository content; explain that in the UI.
- Advisory warnings do not set partial status. Show retained-file warnings separately from actual omissions. Region reads include their own warnings; other tool source envelopes include the count.
- The large-file regression exposed quadratic scanning of long lowercase runs in the URL detector. Anchor URI schemes at a token boundary to retain advisory scanning without that failure.
- Extend the existing PR; no deployment or image build. Same scope boundary and no hard budget; telemetry remains unavailable and no agents delegated.
- v3 validation: RED reproduced SOURCE_SENSITIVE_CONTENT during publication. GREEN covers retained original text, >512-KiB reads/search/symbols, idempotence, signed warning tamper rejection, binary/aggregate limits and the real HTTP sync flow. Full API suite 250 files / 2,109 tests and frontend suite 69 files / 407 tests passed; both typechecks, two Chromium viewport tests, build/CSP, source secret scan, API contracts and focused lint passed. Target internal GitLab and live MySQL remain untested.
