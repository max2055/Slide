CREATE TABLE IF NOT EXISTS metric_trigger_heads (
  identity_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Snapshot and dimensional incident identity',
  resource_key VARBINARY(255) NOT NULL COMMENT 'Owning resource',
  config_revision BIGINT UNSIGNED NOT NULL COMMENT 'Applied revision',
  rule_id VARBINARY(128) NOT NULL COMMENT 'Exact fixed rule identity, including healthy heads',
  dimensions JSON NOT NULL COMMENT 'Series identity retained through unknown evidence',
  payload JSON NULL COMMENT 'Last accepted transition including watermark',
  sample_watermark CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'Newest accepted source observation time',
  PRIMARY KEY(identity_hash), KEY resource_heads(resource_key,config_revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Serialized trigger transition heads; not a second event center';

CREATE TABLE IF NOT EXISTS metric_trigger_episodes (
  episode_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Stable occurrence identity',
  identity_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Head identity',
  resource_key VARBINARY(255) NOT NULL COMMENT 'Authorization relation',
  config_revision BIGINT UNSIGNED NOT NULL COMMENT 'Applied binding revision',
  event_id BIGINT UNSIGNED NOT NULL COMMENT 'Existing alert_events primary key',
  alert_id BIGINT UNSIGNED NOT NULL COMMENT 'Existing alerts primary key',
  payload JSON NOT NULL COMMENT 'Transition evidence and immutable opening',
  snapshot JSON NOT NULL COMMENT 'Opening rule, template, configuration and sample identities',
  PRIMARY KEY(episode_id), UNIQUE KEY event_episode(event_id), UNIQUE KEY alert_episode(alert_id),
  KEY resource_episodes(resource_key,config_revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Fact evidence attached to the existing event records';

CREATE TABLE IF NOT EXISTS metric_trigger_inputs (
  identity_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'One rule/item/dimension/configuration',
  sample_id VARBINARY(255) NOT NULL COMMENT 'Normal formal writer observation id',
  observed_at DATETIME(3) NOT NULL COMMENT 'Source sample watermark',
  payload JSON NOT NULL COMMENT 'Validated scalar evaluator input and attempt identity',
  PRIMARY KEY(identity_hash,sample_id), KEY trigger_window(identity_hash,observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Bounded evaluation window over normal formal samples';
