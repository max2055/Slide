-- MAX-236 P0-REAL-A candidate DDL 141 (stable rules and immutable resource-level trigger snapshots).
-- Copied from docs/slide/development/MAX-236/08-d1-d8-contract-draft.md §1.3.
-- NOT an application migration: this file is never placed in apps/db-ops-api/sql/migrations
-- and is applied only inside the task-owned disposable acceptance database.
-- S8 DDL is NOT approved for production; 143 (binding columns) and 144 (physical audit table)
-- remain explicitly rejected.

CREATE TABLE metric_rules (
  rule_id        VARCHAR(64) NOT NULL,
  name           VARCHAR(128) NOT NULL,
  template_item_id VARCHAR(64) NULL,           -- 仅来源，不是身份
  status         ENUM('draft','active','disabled','archived') NOT NULL DEFAULT 'draft',
  current_published_version INT NULL,
  revision       INT NOT NULL DEFAULT 0,
  created_at     DATETIME(3) NOT NULL,
  updated_at     DATETIME(3) NOT NULL,
  PRIMARY KEY (rule_id)
);

CREATE TABLE metric_trigger_versions (
  rule_id         VARCHAR(64) NOT NULL,
  version         INT NOT NULL,
  snapshot_hash   CHAR(71) NOT NULL,
  snapshot        JSON NOT NULL,               -- 不可变：canonical 指标键、维度、threshold/operator/window/severity
  canonical_keys  JSON NOT NULL,               -- ["metric.id@1.0.0", ...] 排序
  dimensions      JSON NOT NULL,               -- 规范化键序
  params          JSON NOT NULL,
  status          ENUM('published','retired') NOT NULL,
  source_chain    JSON NOT NULL,
  published_at    DATETIME(3) NOT NULL,
  retired_at      DATETIME(3) NULL,
  PRIMARY KEY (rule_id, version),
  UNIQUE KEY uk_trigger_snapshot (rule_id, snapshot_hash),
  CONSTRAINT fk_trigger_rule FOREIGN KEY (rule_id) REFERENCES metric_rules(rule_id)
);

-- 资源级生效配置的不可变快照：全局规则版本 ≠ 某资源实际生效的触发条件
CREATE TABLE metric_effective_triggers (
  effective_trigger_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,   -- 'sha256:<64 hex>'
  active_key           CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,   -- 关联键（不含 version）
  resource_type        ENUM('instance','server','network_device') NOT NULL,
  resource_id          VARCHAR(64) NOT NULL,
  rule_id              VARCHAR(64) NOT NULL,   -- 稳定规则身份
  rule_version         INT         NOT NULL,   -- 来源规则版本
  binding_revision     INT         NOT NULL,   -- 生效时的资源绑定 revision
  canonical_keys       JSON        NOT NULL,   -- 排序
  dimensions           JSON        NOT NULL,   -- 规范化
  params               JSON        NOT NULL,   -- {operator, threshold, severity, window_intervals}
  recovery             JSON        NOT NULL,   -- {consecutive_healthy, recovery_threshold?}
  suppression          JSON        NULL,       -- 抑制证据 {window_id, starts_interval, ends_interval}
  override_sources     JSON        NOT NULL,   -- 排序后的覆盖来源 ['binding:instance:7','group:g1']
  created_at           DATETIME(3) NOT NULL,
  PRIMARY KEY (effective_trigger_id),
  KEY idx_scope (resource_type, resource_id, rule_id, binding_revision),
  CONSTRAINT fk_et_rule FOREIGN KEY (rule_id, rule_version)
    REFERENCES metric_trigger_versions(rule_id, version)
);
