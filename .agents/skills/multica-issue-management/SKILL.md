---
name: multica-issue-management
description: Use when creating, updating, searching, or verifying Multica tasks/issues from repository requirements, plans, reviews, or conversation decisions.
---

# Multica Issue Management

Use the Multica CLI for task operations. The Desktop app bundles the CLI even when `multica` is absent from `PATH`; do not infer that Multica has no CLI and do not substitute GitHub Issues.

## Locate and preflight

Use `scripts/multica-issue.sh`. It discovers `multica` from `PATH` or the macOS Desktop bundle, selects the configured Desktop profile when appropriate, and requires an explicit workspace for remote operations.

```bash
SKILL_DIR=/absolute/path/to/multica-issue-management
"$SKILL_DIR/scripts/multica-issue.sh" preflight --workspace-id <workspace-uuid>
"$SKILL_DIR/scripts/multica-issue.sh" projects --workspace-id <workspace-uuid>
```

If authentication is absent, report `multica setup cloud` or `multica login` as the blocker. Never extract or print tokens from configuration or Desktop storage.

## Create a task

1. Read the relevant source material and current project rules. Resolve the Multica project by exact title from `projects`; pass its UUID to creation.
2. Search active tasks before drafting. Search with a short stable phrase, then inspect plausible matches. Do not use `--allow-duplicate` unless the user explicitly wants a duplicate.
3. Draft a concise title and Markdown body in a file inside the current repository. The body contains only durable problem context, scope, acceptance criteria, dependencies, and established compatibility decisions.
4. Keep transient instructions out of the body: “only create,” “do not start now,” approval history, current chat logistics, and temporary execution limits belong in the delivery response.
5. Resolve assignment and execution authorization from the full conversation, including earlier approved owners and continuation arrangements. When implementation is already authorized, create tasks for the agreed owners and dispatch eligible work within dependencies, file ownership, and concurrency limits; do not add a create-only restriction or require a new start instruction. Use `issue assign`, `rerun`, or enqueueing status transitions as needed for that authorized workflow, after checking existing runs. Keep tasks unassigned and do not enqueue work when no assignment/execution authorization exists, or when the user explicitly requests drafts, creation only, or a pause.
6. Create with `--description-file`, explicit `--project`, `--status todo`, and JSON output:

```bash
"$SKILL_DIR/scripts/multica-issue.sh" create \
  --workspace-id <workspace-uuid> \
  --project-id <project-uuid> \
  --title "Task title" \
  --description-file .multica/task-draft.md
```

7. Parse the returned ID, then run `scripts/multica-issue.sh get --workspace-id <workspace-uuid> --issue-id <id>` and `scripts/multica-issue.sh runs --workspace-id <workspace-uuid> --issue-id <id> --active`. Verify title, full description, project, status, assignee, and identifier against the authorized workflow, including whether work is running or queued for a concrete dependency/concurrency reason. Confirm unassigned/no active runs only when that is the intended workflow. If content is wrong, update it with `--no-start` and read it back again.

Creation is an external write. Treat the user's direct request to create a Multica task as authorization for this exact creation. Do not add a second confirmation step for terminal CLI use. A draft-only request stops before `create`.

## Batch scope and task size

- Reconcile the proposed batch against current merged work and its evidence. Map each source finding to one implementation owner; related audits may describe the same defect. Keep already delivered work as regression coverage rather than creating it again.
- Before creation, choose implementation boundaries using shared files, common dependencies, acceptance criteria, rollback needs, review size, and repeated CI setup costs. Closely related small fixes can share one implementation task with individually traceable criteria; independently deliverable or risky changes should remain separate. Do not equate every audit row with a mandatory task or PR. Honor an explicitly requested breakdown; do not retroactively merge an approved batch merely to reduce CI runs.
- When multiple issues share a PR, state each issue's acceptance and completion boundary, and verify platform auto-completion/link behavior so a partial delivery cannot close unfinished work. Preserve required gates; fewer PRs must not mean weaker validation. Without measured run durations and queue data, describe CI savings as an expectation rather than a measured result.
- Record the parent, agreed owner, scope/files, real dependency IDs, accessible design/requirements revision, verifiable acceptance, and continuation owner. Store machine-readable dependencies alongside the human description and read them back; metadata values may themselves be JSON strings.
- For tasks involving debugging servers or product LLM calls, read `docs/slide/development/debug-task-defaults.md` and `resource-governance.md` (both under `docs/slide/development/`). Put the applicable VM/SSH details and user-authorized credential, or configured model source and shared batch budget/ledger, in the parent description; children inherit by reference. The default server is the VMware Fusion VM at `root@192.168.49.130`; the model is the existing `deepseek-flash` configuration in `mysql-3306`, with unlimited call count within 10,000,000 debugging tokens shared by the parent and all children. This is not a coding-agent budget. Resolve the specifically authorized VM password from its documented Keychain item without echoing it or storing it in repository drafts; inject it only into the intended parent task. Provider API keys stay in platform configuration. Do not probe the VM or call the model merely to create a task.

## Update and handoff

Use `multica issue update <id> --no-start ...` for metadata or body corrections. Preserve useful existing content unless replacement was requested. After every mutation, read the issue back and report the identifier, title, project, status, assignee/run state, and link when available.

`--no-start` during a body correction prevents accidental dispatch by that single write; it must not become a persistent execution prohibition. Continue the already authorized scheduling separately, checking family-wide active/queued runs and dependencies to avoid duplicate dispatch.

Before an explicit `rerun`, re-read `issue runs --active` after posting the handoff comment: comment delivery may itself enqueue the owner. Treat every returned run as in flight, including `queued`, `dispatched`, `running`, and `waiting_local_directory`; do not enqueue a second run because the first has not reached `running` yet.

Keep the description current: put run/queue snapshots, CI progress, and dated execution logs in comments or versioned delivery records. When an execution rule changes, reconcile the effective description, metadata, and enabled wakeup instructions, not just a new comment. Retain historical evidence with its date and a clear current-rule reference; respect a user's decision to keep an existing historical body.

If a create-only request accidentally starts work, list active runs, cancel each active run by its run ID, unassign the issue, and restore `todo` with `issue status <id> todo --no-start`. Read the issue and active runs again; cancellation alone does not clear the assignee or status.

## Scheduling and PR/CI continuation

- Schedule from actual dependencies, file ownership, and the authorized family-wide concurrency limit. Include existing implementation, recovery, queued, and dispatched runs; reserve any agreed coordination slot. A reporting stage is not an extra execution dependency. Start dependent work from the reviewed integrated commit and required evidence, not the status label alone.
- Define how child delivery reaches the parent reviewer and how a freed slot reaches the next ready task. Use platform event/condition wakeups and bounded active-work fallbacks; queued tasks must not all auto-start when a common timeout passes. Check enabled state, owner, delivery thread, expiry/timeout action, errors, and pause reason after configuring continuation.
- For this project's repair PRs, each creation/push must leave a checks continuation on the child issue that actually links the PR: `--until-pr checks --expires-in 30m --on-timeout wake`, targeting its implementation owner and actual delivery thread (`--parent` when available). A parent issue's child-status condition does not substitute for that PR listener. Do not invent a checks listener before a real PR exists.
- Read the current PR head and completed results proactively: a new checks rule does not replay old finished results. On failure, classify and fix in-scope blockers, validate, push, and renew the continuation; at timeout, inspect and renew if needed without duplicate dispatch. Reuse an existing parent review route rather than adding another owner mention or run.
- Parent review starts when a child delivers, without waiting for unrelated children. Review the current head and required functional, visual, and real-service evidence; track complete CI and the actual merge SHA through integration. PR creation, green CI, merged code, and running-service acceptance are distinct facts. Reuse unchanged valid evidence, and run the affected checks and required final gates after relevant changes.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| `multica` is not in `PATH` | Check the Desktop bundle through the helper script |
| Use GitHub Issue because PRs contain MAX numbers | Multica issues and GitHub PRs are different records |
| Create before searching | Search active issue title, description, and comments first |
| Put “do not start” in the task body | Leave it unassigned; report the one-time constraint outside the task |
| Type multiline Markdown into `--description` | Use a repository-local UTF-8 file with `--description-file` |
| Trust create output alone | Run `issue get` and verify persisted fields and run state |
| Cancel an accidental run and stop there | Unassign and restore `todo --no-start`, then verify active runs are empty |
