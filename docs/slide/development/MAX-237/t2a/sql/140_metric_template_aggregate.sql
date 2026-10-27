-- MAX-236 P0-REAL-A candidate DDL 140 (template aggregate, drafts, immutable versions).
-- Copied from docs/slide/development/MAX-236/08-d1-d8-contract-draft.md §1.1.
-- NOT an application migration: this file is never placed in apps/db-ops-api/sql/migrations
-- and is applied only inside the task-owned disposable acceptance database.
-- S8 DDL is NOT approved for production; 143 (binding columns) and 144 (physical audit table)
-- remain explicitly rejected.

CREATE TABLE metric_templates_v2 (
  template_id            VARCHAR(64)  NOT NULL,
  name                   VARCHAR(128) NOT NULL,
  status                 ENUM('draft','active','deprecated','archived') NOT NULL DEFAULT 'draft',
  current_published_version INT       NULL,          -- 指针：当前生效版本；回退只改它
  revision               INT          NOT NULL DEFAULT 0,   -- CAS：发布/切换/退役 +1
  created_by             INT          NULL,
  created_at             DATETIME(3)  NOT NULL,
  updated_at             DATETIME(3)  NOT NULL,
  PRIMARY KEY (template_id),
  KEY idx_status (status)
);

-- 唯一的可编辑面；草稿本身不是版本，不参与 hash
CREATE TABLE metric_template_drafts (
  template_id        VARCHAR(64) NOT NULL,
  revision           INT         NOT NULL DEFAULT 0,   -- 编辑 CAS
  aggregate          JSON        NOT NULL,             -- 引用型聚合（解析前）
  published_version  INT         NULL,                 -- 最近一次发布的版本
  updated_by         INT         NULL,
  updated_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (template_id),
  CONSTRAINT fk_draft_template FOREIGN KEY (template_id) REFERENCES metric_templates_v2(template_id)
);

CREATE TABLE metric_template_versions (
  template_id        VARCHAR(64) NOT NULL,
  version            INT         NOT NULL,
  status             ENUM('published','retired') NOT NULL DEFAULT 'published',
  content_hash       CHAR(71)    NOT NULL,               -- 'sha256:<64 hex>'
  aggregate          JSON        NOT NULL,               -- 已解析的完整聚合（hash 输入）
  items              JSON        NOT NULL,               -- 不可变 item 版本快照
  package_composition JSON       NOT NULL,
  source_chain       JSON        NOT NULL,               -- {actor_id, request_id, base:{kind,id,version}|null, created_at, published_at, retired_at, migration_ref}（§7.4 唯一定义）
  published_at       DATETIME(3) NOT NULL,
  retired_at         DATETIME(3) NULL,
  PRIMARY KEY (template_id, version),
  UNIQUE KEY uk_content (template_id, content_hash),      -- 幂等发布的判定键
  CONSTRAINT fk_tv_template FOREIGN KEY (template_id) REFERENCES metric_templates_v2(template_id)
);

CREATE TABLE metric_template_items (
  template_id  VARCHAR(64) NOT NULL,
  item_id      VARCHAR(64) NOT NULL,                      -- 稳定，非 metric id
  status       ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at   DATETIME(3) NOT NULL,
  PRIMARY KEY (template_id, item_id),
  CONSTRAINT fk_ti_template FOREIGN KEY (template_id) REFERENCES metric_templates_v2(template_id)
);

CREATE TABLE metric_template_item_versions (
  template_id            VARCHAR(64)  NOT NULL,
  item_id                VARCHAR(64)  NOT NULL,
  version                INT          NOT NULL,
  display_name           VARCHAR(128) NOT NULL,
  canonical_metric_id    VARCHAR(128) NOT NULL,
  canonical_semantic_version VARCHAR(16) NOT NULL,
  unit                   VARCHAR(32)  NOT NULL,            -- 必须等于 canonical unit
  dimensions             JSON         NOT NULL,            -- 规范化键序
  collector_ref          JSON         NOT NULL,            -- {package_release, implementation_id}
  params_default         JSON         NOT NULL,
  source_chain           JSON         NOT NULL,
  PRIMARY KEY (template_id, item_id, version),
  KEY idx_canonical (canonical_metric_id, canonical_semantic_version),
  CONSTRAINT fk_tiv_item FOREIGN KEY (template_id, item_id)
    REFERENCES metric_template_items(template_id, item_id)
);
