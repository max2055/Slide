ALTER TABLE metric_trend_receipts
  ADD COLUMN archive_invalid TINYINT(1) NULL COMMENT 'Whether the original observation contributed only to the invalid sample count',
  ADD COLUMN archive_estimated TINYINT(1) NULL COMMENT 'Whether the original observation contributed to the estimated sample count';
