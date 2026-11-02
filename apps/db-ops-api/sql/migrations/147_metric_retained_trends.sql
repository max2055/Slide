CREATE TABLE IF NOT EXISTS metric_retained_trends (
  series_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Original formal series identity',
  bucket_ms BIGINT NOT NULL COMMENT 'UTC epoch aligned five minute bucket start',
  value_class VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Encoding class; unknown values retain their own conservative horizon',
  resource_key VARCHAR(128) NOT NULL COMMENT 'Live authorization scope',
  metadata JSON NOT NULL COMMENT 'Metric reference and dimensions; no raw values',
  statistics JSON NOT NULL COMMENT 'Exact sufficient statistics and conservative gap bound; not replay evidence',
  PRIMARY KEY(series_hash,bucket_ms,value_class),
  KEY retained_trends_resource(resource_key,bucket_ms)
) COMMENT='Formal trend statistics retained independently of source observations';
CREATE TABLE IF NOT EXISTS metric_trend_receipts (
  observation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Unique preservation receipt prevents duplicate accumulation',
  series_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Preserved trend series',
  bucket_ms BIGINT NOT NULL COMMENT 'Trend retention epoch; expires with its statistics',
  value_class VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Same retention class as the sufficient statistics',
  PRIMARY KEY(observation_id),
  KEY trend_receipts_bucket(series_hash,bucket_ms,value_class)
) COMMENT='No sample values; preservation receipts committed atomically with pruning';
