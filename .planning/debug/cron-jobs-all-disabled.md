---
status: investigating
trigger: "All 13 AI cron jobs show enabled=false, last run 2026-05-30, next_run_at null"
created: 2026-06-13T14:00:00Z
updated: 2026-06-13T14:10:00Z
---

## Current Focus

hypothesis: "All 13 cron_jobs were set to enabled=0 by a batch SQL operation at 2026-05-30 13:36:19"
test: Verified through DB queries and code analysis
expecting: Root cause confirmed
next_action: Report root cause analysis

## Symptoms

expected: Cron jobs should be enabled and running
actual: GET /api/cron/jobs returns all 13 jobs with enabled=false, next_run_at is null, last_run from 2026-05-30
errors: none
reproduction: GET /api/cron/jobs
started: 2026-05-30 13:36:19 (when all rows were batch-updated)

## Eliminated

- hypothesis: CronManager.start() is not being called
  evidence: server.ts line 4026 calls await cronManager.start() — verified in code
  timestamp: 2026-06-13

- hypothesis: ensureSeedData() overwrote enabled values
  evidence: ensureSeedData() skips if table has rows (line 170: if cnt > 0 return); created_at=2026-05-27 confirms migration data survived
  timestamp: 2026-06-13

- hypothesis: Migration 010 or 015 disabled jobs
  evidence: None of the migration files (009, 010, 015) set enabled=0 on all jobs — 009 seeds 10 true, 3 false; 010 only UPDATEs task_description; 015 only UPDATEs output_schema
  timestamp: 2026-06-13

- hypothesis: Frontend toggle API called 13 times
  evidence: Each API call would produce different updated_at timestamps; all 13 rows share the exact same updated_at
  timestamp: 2026-06-13

- hypothesis: A code commit caused the disable
  evidence: No commits exist between May 28-Jun 1; no code path in the entire codebase sets enabled=0 on all jobs
  timestamp: 2026-06-13

## Evidence

- timestamp: 2026-06-13
  checked: DB cron_jobs table via docker mysql
  found: All 13 rows have enabled=0, last_run_at from 2026-05-30, next_run_at=null
  implication: Jobs ran on May 30 but have been disabled since

- timestamp: 2026-06-13
  checked: DB cron_jobs updated_at timestamps
  found: ALL 13 rows have updated_at = 2026-05-30 13:36:19 (1 distinct value)
  implication: A single batch UPDATE statement modified all 13 rows at the exact same time

- timestamp: 2026-06-13
  checked: DB cron_job_logs execution history
  found: 540 log entries on 2026-05-30; only 1 log entry after 13:36:19 (job 10 at 13:36:35, which was an in-memory CronJob still running)
  implication: Jobs stopped executing immediately after the UPDATE at 13:36:19

- timestamp: 2026-06-13
  checked: cron_job_service.ensureSeedData() — cron-job-service.ts lines 165-198
  found: Only inserts 13 rows with enabled=true if table is empty; all run via INSERT with `true` for enabled
  implication: ensureSeedData() cannot cause mass disable on existing data

- timestamp: 2026-06-13
  checked: All migration files (009, 010, 015, 016)
  found: 009 seeds 10 enabled, 3 disabled; 010 only adds task_description; 015 only adds output_schema; 016 is unrelated
  implication: No migration disabled all jobs

- timestamp: 2026-06-13
  checked: git log for commits May 28-Jun 1
  found: No commits in the date range
  implication: No code change triggered the disable

- timestamp: 2026-06-13
  checked: cron_jobs cron_expr values vs migration seed
  found: Job 1 (TopSQL 自动分析) cron_expr changed from `*/10 * * * * *` (migration seed) to `0 */5 * * * *` — only row with a cron_expr change
  implication: The batch update also changed job 1's cron_expr

- timestamp: 2026-06-13
  checked: system_config for auto_analysis_config
  found: auto_analysis_config = {"enabled":false,"cronExpression":"* * * * *",...} updated at 2026-05-15 (before the disable)
  implication: This config is separate from cron_jobs.enabled; no code links auto_analysis_config to cron_jobs table

- timestamp: 2026-06-13
  checked: Every UPDATE against cron_jobs in entire codebase (cron-job-service.ts, server.ts, any .sql migration)
  found: Only toggleJob (single row, id=?) and updateJob (single row, id=?) touch enabled; no mass UPDATE exists
  implication: No code path can produce the observed batch update

## Resolution

root_cause: All 13 cron_jobs rows were set to enabled=0 by a batch SQL operation (e.g., `UPDATE cron_jobs SET enabled = 0`) at 2026-05-30 13:36:19. The evidence: (1) all 13 rows share the exact same updated_at timestamp (2026-05-30 13:36:19), proving a single statement updated all rows; (2) no code path in the entire codebase performs a mass UPDATE of cron_jobs.enabled; (3) no git commits exist during the relevant date range; (4) cron jobs stopped executing immediately after that timestamp (only 1 more in-memory execution at 13:36:35); (5) the same batch UPDATE also changed job 1's cron_expr from the migration seed value. The most likely cause is a manual SQL command executed directly against the database.

fix: Run SQL to re-enable the appropriate jobs (matching the original seed intent):
      UPDATE cron_jobs SET enabled = CASE
          WHEN name IN ('TopSQL 自动分析', '告警 RCA 分析', '故障自动诊断', '(预留) 通知推送检查') THEN 0
          ELSE 1
      END;
      Then restart the backend server so CronManager reloads enabled jobs.
verification: 
files_changed: []
