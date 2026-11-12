-- Preserve historical second-precision timestamps; new writers allocate distinct
-- milliseconds while holding the database_instances row lock in one transaction.
ALTER TABLE schema_snapshots
  MODIFY COLUMN snapshot_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '快照时间';
