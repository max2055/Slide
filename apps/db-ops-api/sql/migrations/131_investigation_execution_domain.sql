-- Independent, nonrefundable formal gate binding. Multiple NULL legacy rows
-- retain their original admission and budgets. Rollback retains this column:
-- dropping it would reopen consumed gates. No default enables task execution.
ALTER TABLE investigation_requests
  ADD COLUMN execution_domain VARBINARY(128) NULL COMMENT 'Trusted formal gate consumed by this request, independent of JSON',
  ADD UNIQUE KEY uq_investigation_execution_domain (execution_domain);
