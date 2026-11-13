-- MAX-374: record a driver receipt that is not a successful commit.
-- unknown stays the only state for a missing commit or rollback receipt.
-- Preserve the column default and the crash-window meaning of unknown.
ALTER TABLE sql_execution_intents
  MODIFY COLUMN state ENUM(
    'unknown',
    'succeeded',
    'reconciled_applied',
    'reconciled_not_applied',
    'rolled_back',
    'not_executed'
  ) NOT NULL DEFAULT 'unknown'
  COMMENT 'Unknown includes crash before or after target dispatch; rolled_back and not_executed require a driver receipt';
