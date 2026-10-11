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
5. Do not assign an agent or squad unless requested. Creating an unassigned issue does not start implementation. Do not call `issue assign`, `rerun`, or status transitions that enqueue work.
6. Create with `--description-file`, explicit `--project`, `--status todo`, and JSON output:

```bash
"$SKILL_DIR/scripts/multica-issue.sh" create \
  --workspace-id <workspace-uuid> \
  --project-id <project-uuid> \
  --title "Task title" \
  --description-file .multica/task-draft.md
```

7. Parse the returned ID, then run `scripts/multica-issue.sh get --workspace-id <workspace-uuid> --issue-id <id>` and `scripts/multica-issue.sh runs --workspace-id <workspace-uuid> --issue-id <id> --active`. Verify title, full description, project, status, assignee, and identifier. Confirm the task is unassigned and the active-runs result is empty unless assignment was requested. If content is wrong, update it with `--no-start` and read it back again.

Creation is an external write. Treat the user's direct request to create a Multica task as authorization for this exact creation. Do not add a second confirmation step for terminal CLI use. A draft-only request stops before `create`.

## Update and handoff

Use `multica issue update <id> --no-start ...` for metadata or body corrections. Preserve useful existing content unless replacement was requested. After every mutation, read the issue back and report the identifier, title, project, status, assignee/run state, and link when available.

If a create-only request accidentally starts work, list active runs, cancel each active run by its run ID, unassign the issue, and restore `todo` with `issue status <id> todo --no-start`. Read the issue and active runs again; cancellation alone does not clear the assignee or status.

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
