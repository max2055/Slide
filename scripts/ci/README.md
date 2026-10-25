# CI execution policy

The `CI` workflow always runs for pull requests, main pushes, manual dispatch and
daily at 18:23 UTC (02:23 Asia/Shanghai). Workflow-level path filtering is not used.

| Candidate | Base checks and source security | Browser + real SQL-backed UI | Full API/MySQL + recovery | Rootless security + capacity + packaging |
| --- | --- | --- | --- | --- |
| Documentation-only PR | Yes | No | No | No |
| Frontend source/E2E/public assets PR | Yes | Yes | No | No |
| Ordinary backend implementation PR | Yes | Yes | Yes | No |
| Cross-cutting or unknown paths, empty diff | Yes | Yes | Yes | Yes |
| main push, nightly, manual | Yes | Yes | Yes | Yes |

Cross-cutting paths include CI/qualification scripts, dependency files, frontend
configuration, Agent Core, sandbox controller, API entry points, migrations,
authentication, security, lifecycle, contracts, tools and Investigation/adapter
implementation. A PR uses its complete base/head diff, including deleted and
renamed paths. Classification errors fail planning and therefore fail the gate.
Basic checks remain enabled even for documentation-only PRs.

## Coverage ownership

- `backend` owns the ordinary API suite when the full MySQL candidate is not
  selected. Otherwise `investigation-api-qualification` runs the complete suite,
  including the ordinary tests and all enabled SQL gates. They never both run
  the same full API suite in one workflow. The suite is split into five
  `--shard=<i>/5` legs plus one `exec` leg dedicated to
  `execution-recovery.mysql.test.ts`; each leg has its own isolated MySQL (the
  `exec` leg needs only the 8.4 server). The union of the legs is the same
  complete candidate as the former single job.
- `investigation-workspace-qualification` owns the Investigation browser
  configuration, including both feedback specs. `browser-qualification` owns
  TLS/login/runtime/cron/candidate-isolation/streaming.
  `browser-edge-qualification` owns Edge critical paths and instance-query.
  Feedback evaluation/runtime qualification remains; its SQL files run
  separately only when the full API candidate is not selected.
- `investigation-rollout-qualification` owns the 10k duplicate / 100k event capacity
  fixture. Its `--rollout` mode does not repeat SQL or browser suites. The former
  31-file / 575-test SQL stage is covered by the full API candidate (verified
  against run 38677311260's raw API report).
- Runtime MySQL qualification retains its distinct runtime checks. The extra
  Vitest suites from the standalone wrapper are already part of the full API
  candidate; CI uses `--runtime-only`. Related backend changes always select API.
- `security` owns dependency audit and source secret scanning once. Rootless CI
  uses `--runtime-only` for security tests, deployment checks and real sandbox
  execution. Standalone rootless and release-security commands keep all scans.
- Recovery scripts retain their separate process/container failure scenarios,
  split into five independent groups; they are not removed merely because some
  test files overlap the API suite.
- Packaging still performs a build with its traceable build ID and the rollback
  drill. It runs for full candidates, including packaging/CI changes on PRs.

## Failure propagation

`release-artifact` always validates every selected check before optional packaging.
`ci-gate` always runs after it and validates all results again, including packaging.
Selected checks must succeed; unselected checks must be explicitly skipped.
Missing, failed, cancelled or unexpectedly skipped results fail the gate. Invalid
planning also fails it. A packaging failure cannot leave a successful final gate.

Use `ci-gate` as the required check when configuring branch protection. This PR
does not change repository settings; no active ruleset or branch protection was
configured when the policy was introduced.

## Validation contract

Scope: CI selection, duplicate execution and wrapper modes; no production code,
test assertions, database schema or repository protection changes. No hard resource
budget is imposed; no subagents are used. Actual token/cost telemetry is unavailable.

Acceptance: policy tests, script syntax, actionlint, qualification matrix and a
full GitHub candidate on the PR head pass. Routing and gates must reject missing
or unsuccessful required results. Standalone wrapper behavior is preserved.
Run focused checks during implementation and one complete gate for the final
candidate; stop when the requested PR is reviewable with current-head evidence.
