-- Frozen source ownership survives flag rollback and ambiguous acceptance.
CREATE TABLE IF NOT EXISTS investigation_alert_owners (
  alert_id INT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'Database alert source id',
  lane ENUM('legacy','investigation') NOT NULL COMMENT 'Immutable execution owner',
  command_snapshot JSON NOT NULL COMMENT 'Frozen trusted command',
  investigation_id CHAR(36) NULL COMMENT 'Accepted investigation',
  analysis_id INT UNSIGNED NULL COMMENT 'Legacy analysis',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Ownership decision'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Database alert execution ownership';

CREATE TABLE IF NOT EXISTS investigation_legacy_analysis_links (
  analysis_id INT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'Original analysis id',
  investigation_id CHAR(36) NOT NULL COMMENT 'Read-only historical view',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Explicit linking time',
  UNIQUE KEY uq_legacy_investigation (investigation_id),
  CONSTRAINT fk_legacy_link_investigation FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Lazy legacy result links without execution';
