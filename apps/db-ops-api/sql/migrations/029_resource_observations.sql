CREATE TABLE IF NOT EXISTS resource_relations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_type ENUM('instance','server') NOT NULL, source_id BIGINT UNSIGNED NOT NULL,
  target_type ENUM('instance','server') NOT NULL, target_id BIGINT UNSIGNED NOT NULL,
  relation_type ENUM('runs_on','hosts','replicates_to','depends_on') NOT NULL,
  provenance VARCHAR(64) NOT NULL, valid_from DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, valid_until DATETIME NULL,
  UNIQUE KEY uq_resource_relation (source_type, source_id, target_type, target_id, relation_type, valid_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS resource_capabilities (
  resource_type ENUM('instance','server') NOT NULL, resource_id BIGINT UNSIGNED NOT NULL, capability_key VARCHAR(128) NOT NULL,
  state ENUM('declared','configured','verified','degraded','unsupported') NOT NULL, evidence JSON NULL, reason VARCHAR(512) NULL,
  checked_at DATETIME NOT NULL, valid_until DATETIME NULL, PRIMARY KEY(resource_type, resource_id, capability_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
