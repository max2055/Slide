---
phase: 122-cron-script-agent-mode
plan: 03
subsystem: frontend
tags: [cron-jobs, script-editor, codemirror, mode-selector]
requires: [01]
provides: [SCRIPT-05]
affects: [cron-jobs-settings.ts, script-editor.ts]
tech-stack:
  added: []
  patterns:
    - "LitElement with Shadow DOM wrapping CodeMirror EditorView"
    - "Dialect switching via property change listener"
    - "Conditional form rendering based on task_type"
key-files:
  created:
    - "frontend/src/app/ui/components/script-editor.ts"
    - "frontend/src/app/ui/views/cron-jobs-settings.ts (modified)"
metrics:
  duration: 0h
  completed: "2026-06-26"
---

# Phase 122 Plan 03: Script/Agent Mode UI Summary

## Objective

Add script/agent mode selector, SQL editor, and instance selector to the cron job management UI, enabling users to create cron jobs via SQL scripts or natural language.

## Completed Tasks

### Task 1: Create `<script-editor>` Lit Component Wrapping CodeMirror

**File:** `frontend/src/app/ui/components/script-editor.ts`

Created a reusable CodeMirror 6 wrapper as a LitElement with Shadow DOM:

- **Properties:** `content` (initial SQL text), `dbType` (dialect: mysql/postgresql/oracle/dameng), `readonly`
- **Lifecycle:** `firstUpdated` creates EditorView, `disconnectedCallback` destroys it, `updated` triggers dialect switch when `dbType` changes
- **Dialects:** MySQL, PostgreSQL (from `@codemirror/lang-sql`), Oracle, Dameng (custom definitions matching those in `sql-console.ts`)
- **Events:** Emits `content-change` CustomEvent with `{ content }` detail on doc changes
- **Public API:** `setContent(newContent)` and `getContent()` methods
- **Styling:** oneDark theme, constrained to 200px height with overflow scroll
- **Verification:** `tsc --noEmit` passes (0 new errors)

### Task 2: Mode Selector, Script Editor, Instance Selector in cron-jobs-settings.ts

**File:** `frontend/src/app/ui/views/cron-jobs-settings.ts` (231 insertions, 6 deletions)

Extended the cron jobs management page:

- **Interface changes:** `CronJobConfig` extended with optional `task_type`, `script_id`, `target_instance_id`; added `CronScript` and `DatabaseInstance` interfaces
- **State fields:** `formTaskType`, `formScriptId`, `formTargetInstanceId`, `scripts`, `instances`, `scriptEditorContent`, `scriptEditorDbType`, `selectedScriptTemplate`, `testResult`, `testRunning`
- **Data loading:** `loadScriptsAndInstances()` fetches from `/api/cron/scripts` and `/api/database/instances` when opening create dialog
- **Mode selector:** Dropdown at top of form switches between Agent mode (unchanged textarea) and Script mode (template picker + SQL editor + instance selector)
- **Script mode form:**
  - Quick create: select predefined script template -> auto-fills SQL editor -> select instance
  - Custom create: write SQL in script-editor -> select instance -> script auto-created on save
  - Instance selection updates editor dialect automatically
  - Test execute button (template-based scripts only) calls POST `/api/cron/scripts/:id/test`
- **Save flow:** Agent mode sends `task_description`; Script mode sends `task_type: 'script'`, `script_id`, `target_instance_id`; custom SQL first creates script via POST `/api/cron/scripts`
- **Table:** Mode column with app-badge (Agent/Script) next to job name
- **Edit flow:** Populates all form fields from existing job configuration
- **Verification:** `tsc --noEmit` passes (0 new errors)

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new threat flags. All authFetch calls continue to use JWT via the existing interceptor; no new npm packages introduced.

## Key Decisions

- **Oracle/Dameng dialects:** Copied into `script-editor.ts` rather than importing from `sql-console.ts` (which does not export them), to avoid refactoring existing code. A future plan could extract shared dialect definitions.
- **Custom SQL save flow:** Custom SQL scripts are created via POST `/api/cron/scripts` before creating the cron job, using the script's returned `id`. This avoids needing separate frontend logic for un-saved scripts.
- **Test execution:** Only template-based scripts support test-execution (POST `/api/cron/scripts/:id/test`). Custom SQL can be created as a job and triggered via the existing "执行" button.
- **`app-badge variant="info"`** used for Agent mode instead of the non-existent `accent` variant, after checking the component's supported variants.

## Self-Check: PASSED

- [x] `frontend/src/app/ui/components/script-editor.ts` exists and compiles clean
- [x] `frontend/src/app/ui/views/cron-jobs-settings.ts` compiles clean with all modifications
- [x] SUMMARY.md exists at `.planning/phases/122-cron-script-agent-mode/122-03-SUMMARY.md`
- [x] Commit `536135d` (feat: script-editor component) present
- [x] Commit `02e1408` (feat: mode selector/editor/instance selector) present
- [x] Commit `ea99a9b` (docs: SUMMARY.md) present
- [x] Pre-existing errors in control-ui-bootstrap.ts and embed-sandbox.ts are unchanged (out of scope)

| Task | Hash | Message |
|------|------|---------|
| 1 | 536135d | feat(122-03): create script-editor Lit component wrapping CodeMirror |
| 2 | 02e1408 | feat(122-03): add mode selector, script editor, instance selector to cron-jobs-settings |
