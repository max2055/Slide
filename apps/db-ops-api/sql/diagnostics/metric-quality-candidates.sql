-- MAX-111: read-only candidate export. No UPDATE and no automatic restoration.
-- Run with a SELECT-only account against a backup/read replica when possible.
-- All estimated rows are candidates: the old rolling 30-day UPDATE could have
-- touched them at any prior startup, not only during the current 30-day window.
-- TRUE may also be a legitimate collector flag; neither time nor this flag proves
-- a row was mislabeled. The legacy table has no persisted formula version.
START TRANSACTION READ ONLY;

SELECT
  'metrics_history' AS source_table,
  COUNT(*) AS candidate_count,
  MIN(recorded_at) AS earliest_recorded_at,
  MAX(recorded_at) AS latest_recorded_at,
  'source-quality-unverified' AS review_status
FROM metrics_history
WHERE is_estimated = TRUE;

SELECT
  'metrics_history' AS source_table,
  id,
  instance_id,
  recorded_at,
  is_estimated,
  qps,
  tps,
  cpu_usage,
  memory_usage,
  disk_usage,
  'legacy-formula-version-unavailable' AS provenance,
  'source-quality-unverified' AS review_status
FROM metrics_history
WHERE is_estimated = TRUE
ORDER BY id;

COMMIT;
