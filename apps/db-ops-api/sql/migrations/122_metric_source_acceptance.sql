CREATE TABLE metric_source_acceptance (
  resource_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Resource whose formal source was validated',
  revision INT UNSIGNED NOT NULL COMMENT 'Validated immutable policy revision',
  generation INT UNSIGNED NOT NULL COMMENT 'Accepted publisher generation',
  evidence JSON NOT NULL COMMENT 'Actual sample identities, semantic validation and migration applicability; never a fabricated shadow report',
  accepted_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Server validation time',
  PRIMARY KEY (resource_key, revision)
) ENGINE=InnoDB COMMENT='Traceable formal source measurement acceptance';
