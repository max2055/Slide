CREATE TABLE metric_item_retention (
  resource_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Bound resource type and ID',
  metric_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Canonical metric ID and semantic version',
  history_ms BIGINT UNSIGNED NULL COMMENT 'Applied history duration in milliseconds, NULL follows platform policy',
  trends_ms BIGINT UNSIGNED NULL COMMENT 'Applied trend duration in milliseconds, NULL follows platform policy',
  PRIMARY KEY (resource_key, metric_key)
) ENGINE=InnoDB COMMENT='Applied monitoring item retention overrides per resource and canonical metric';

ALTER TABLE metric_retention_state
  ADD COLUMN item_policy_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Revision of effective monitoring item retention overrides',
  ADD COLUMN preview_item_policy_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Effective item policy revision last previewed';
