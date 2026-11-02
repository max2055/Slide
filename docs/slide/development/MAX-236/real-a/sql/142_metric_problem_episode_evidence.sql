-- MAX-236 P0-REAL-A candidate DDL 142 (evaluation identity, watermarks, episodes and evidence).
-- Copied from docs/slide/development/MAX-236/08-d1-d8-contract-draft.md §1.4.
-- NOT an application migration: this file is never placed in apps/db-ops-api/sql/migrations
-- and is applied only inside the task-owned disposable acceptance database.
-- S8 DDL is NOT approved for production; 143 (binding columns) and 144 (physical audit table)
-- remain explicitly rejected.

-- ORDER NOTE: the draft lists metric_evaluations (FK -> metric_problem_episodes) before
-- metric_problem_episodes. MySQL 8 rejects that creation order, so the candidate keeps the
-- same DDL with watermarks -> episodes -> evaluations -> evidence. No column, key or
-- constraint is changed; the reorder is recorded in the real-a evidence.

CREATE TABLE metric_evaluation_watermarks (
  active_key          CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  active_episode_id   CHAR(36)    NULL,
  high_watermark      DATETIME(3) NULL,        -- 已处理的最大区间（乱序 fence）
  state_watermark     DATETIME(3) NULL,        -- 已贡献状态的最后一个区间（同槽纠正 fence）
  config_rule_version         INT      NULL,   -- F1：本关联键已接受的最新配置顺序，与活动性无关
  config_binding_revision     INT      NULL,
  config_effective_trigger_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision            BIGINT      NOT NULL DEFAULT 0,   -- 每次推进 +1（CAS/fence）
  updated_at          DATETIME(3) NOT NULL,
  PRIMARY KEY (active_key),
  UNIQUE KEY uk_active_episode (active_episode_id),     -- 一个关联键最多一个活动 episode
  CONSTRAINT ck_watermark_config_fence CHECK (
    (config_rule_version IS NULL AND config_binding_revision IS NULL AND config_effective_trigger_id IS NULL)
    OR (config_rule_version IS NOT NULL AND config_binding_revision IS NOT NULL
        AND config_effective_trigger_id IS NOT NULL)),
  CONSTRAINT fk_watermark_config FOREIGN KEY (config_effective_trigger_id)
    REFERENCES metric_effective_triggers(effective_trigger_id)
);

-- 评估账本：幂等与乱序判定的持久身份；不是“问题事件事实表”

CREATE TABLE metric_problem_episodes (
  episode_id        CHAR(36) NOT NULL,
  active_key        CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,   -- 活动期=关联键；关闭置 NULL
  resource_type     ENUM('instance','server','network_device') NOT NULL,
  resource_id       VARCHAR(64) NOT NULL,
  rule_id           VARCHAR(64) NOT NULL,      -- 稳定规则身份
  opened_effective_trigger_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,   -- 开启快照，永不改写
  current_effective_trigger_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,  -- 后续评估使用的当前快照
  dimensions        JSON NOT NULL,             -- 规范化维度
  status            ENUM('active','resolved','superseded') NOT NULL,
  revision          INT NOT NULL DEFAULT 0,    -- CAS：touch/close/config 都 +1
  config_change_seq INT NOT NULL DEFAULT 0,
  healthy_streak    INT NOT NULL DEFAULT 0,    -- 恢复策略计数（跨配置变更清零）
  notified          TINYINT(1) NOT NULL DEFAULT 0,   -- 开启被静默时为 0；窗口关闭后补发一次
  alert_id          BIGINT UNSIGNED NULL,      -- 权威事件事实；每个 episode 最多一条
  opened_at         DATETIME(3) NOT NULL,
  last_firing_at    DATETIME(3) NOT NULL,
  closed_at         DATETIME(3) NULL,
  close_reason      ENUM('recovered','superseded_by_config','rule_disabled','resource_removed') NULL,
  PRIMARY KEY (episode_id),
  UNIQUE KEY uk_active (active_key),           -- MySQL 唯一索引允许多个 NULL
  UNIQUE KEY uk_episode_alert (alert_id),      -- episode ↔ 权威 alert 的唯一归属
  KEY idx_resource_status (resource_type, resource_id, status),
  KEY idx_rule (rule_id, status),
  CONSTRAINT fk_episode_open FOREIGN KEY (opened_effective_trigger_id) REFERENCES metric_effective_triggers(effective_trigger_id),
  CONSTRAINT fk_episode_current FOREIGN KEY (current_effective_trigger_id) REFERENCES metric_effective_triggers(effective_trigger_id),
  CONSTRAINT fk_episode_alert FOREIGN KEY (alert_id) REFERENCES alerts(id)
);

-- 证据：每行指向既有权威事件（alerts.id）；多个 eval/证据合法地引用同一条事实

CREATE TABLE metric_evaluations (
  evaluation_id       CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,   -- 'sha256:<64 hex>'
  active_key          CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_type       ENUM('instance','server','network_device') NOT NULL,
  resource_id         VARCHAR(64) NOT NULL,
  rule_id             VARCHAR(64) NOT NULL,
  dimensions          JSON NOT NULL,
  interval_start      DATETIME(3) NOT NULL,
  effective_trigger_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observed_value      VARCHAR(64) NULL,
  state               ENUM('firing','hold','recovered','unknown') NOT NULL,
  outcome             ENUM('applied','pending_recovery','duplicate','corrected','superseded',
                           'stale','stale_config','no_data','dependency_blocked') NOT NULL,
  episode_id          CHAR(36) NULL,
  suppressed          TINYINT(1) NOT NULL DEFAULT 0,   -- 该次评估的通知是否被静默
  dependency_context_id VARCHAR(128) NULL,   -- F3：可信依赖上下文身份，与 revision/blocked 一起进入 identity
  dependency_revision   BIGINT       NULL,
  dependency_blocked    TINYINT(1)   NOT NULL DEFAULT 0,
  recorded_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (evaluation_id),
  KEY idx_watermark (active_key, interval_start),
  KEY idx_episode (episode_id),
  CONSTRAINT ck_evaluation_dependency CHECK (
    (dependency_context_id IS NULL AND dependency_revision IS NULL AND dependency_blocked = 0)
    OR (dependency_context_id IS NOT NULL AND dependency_revision IS NOT NULL)),
  CONSTRAINT fk_eval_trigger FOREIGN KEY (effective_trigger_id) REFERENCES metric_effective_triggers(effective_trigger_id),
  CONSTRAINT fk_eval_episode FOREIGN KEY (episode_id) REFERENCES metric_problem_episodes(episode_id)
);

CREATE TABLE metric_problem_episode_evidence (
  evidence_id        CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,  -- sha256(episode_id, evaluation_id, kind)
  episode_id         CHAR(36) NOT NULL,
  evaluation_id      CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind               ENUM('firing','hold','recovered','config_changed','superseded','correction') NOT NULL,
  interval_start     DATETIME(3) NOT NULL,
  alert_id           BIGINT UNSIGNED NULL,     -- 指向所属 episode 的同一权威事实；非唯一
  effective_trigger_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observed_value     VARCHAR(64) NULL,
  threshold_value    VARCHAR(64) NULL,
  quality            ENUM('good','partial','stale','unknown') NOT NULL,
  created_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (evidence_id),
  UNIQUE KEY uk_episode_evaluation_kind (episode_id, evaluation_id, kind),
  KEY idx_evidence_alert (alert_id),
  KEY idx_episode_interval (episode_id, interval_start, kind),
  CONSTRAINT ck_alert_required CHECK (kind IN ('config_changed','superseded','correction') OR alert_id IS NOT NULL),
  CONSTRAINT fk_evidence_episode FOREIGN KEY (episode_id) REFERENCES metric_problem_episodes(episode_id),
  CONSTRAINT fk_evidence_evaluation FOREIGN KEY (evaluation_id) REFERENCES metric_evaluations(evaluation_id),
  CONSTRAINT fk_evidence_alert FOREIGN KEY (alert_id) REFERENCES alerts(id)
);
