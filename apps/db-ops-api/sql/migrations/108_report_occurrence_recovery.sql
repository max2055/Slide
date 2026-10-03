-- Additive only: legacy rows remain unbound for explicit reconciliation.
ALTER TABLE report_schedule_occurrences
  ADD COLUMN workflow_job_id CHAR(36) NULL COMMENT 'Durable occurrence job; NULL requires legacy reconciliation',
  ADD COLUMN lease_owner CHAR(36) NULL COMMENT 'Last claimant; validity is checked against workflow_jobs',
  ADD COLUMN fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Last durable job fencing token',
  ADD COLUMN staged_report_id BIGINT UNSIGNED NULL COMMENT 'Crash-safe report content before final commit',
  ADD COLUMN config_snapshot JSON NULL COMMENT 'Frozen report inputs and notification channels',
  ADD UNIQUE KEY uq_report_occurrence_job (workflow_job_id),
  ADD UNIQUE KEY uq_report_occurrence_staged (staged_report_id);
