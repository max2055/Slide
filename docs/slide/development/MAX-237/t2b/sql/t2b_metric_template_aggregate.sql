-- MAX-237 T2B owned candidate DDL (template aggregate, drafts, immutable versions).
-- Derived from T2A DDL 140 (`../t2a/sql/140_metric_template_aggregate.sql`, byte-identical
-- copy of MAX-236 D1 candidate 140). Same five tables, same PK/FK/unique hash and business
-- semantics. Only these column representations change:
--   * created_by / updated_by            BIGINT UNSIGNED NULL (0..9007199254740991)
--   * canonical_metric_id / _semantic_version  LONGTEXT ascii (no artificial width)
--   * idx_canonical                      non-unique prefix index (128/16), query only
--   * every timestamp                    CHAR(24) ascii canonical UTC `YYYY-MM-DDTHH:mm:ss.SSSZ`
-- Version, revision and all version/pointer columns stay INT (accepted schemas cap at
-- 2147483647). JSON columns keep the original value verbatim.
--
-- NOT an application migration: never placed in apps/db-ops-api/sql/migrations and applied
-- only inside the task-owned disposable T2B fixture (`max237_t2b`). S8 DDL is not approved
-- for production; 143 (binding columns) and 144 (physical audit table) remain rejected.

CREATE TABLE metric_templates_v2 (
  template_id            VARCHAR(64)  NOT NULL,
  name                   VARCHAR(128) NOT NULL,
  status                 ENUM('draft','active','deprecated','archived') NOT NULL DEFAULT 'draft',
  current_published_version INT       NULL,
  revision               INT          NOT NULL DEFAULT 0,
  created_by             BIGINT UNSIGNED NULL,
  created_at             CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at             CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (template_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE metric_template_drafts (
  template_id        VARCHAR(64) NOT NULL,
  revision           INT         NOT NULL DEFAULT 0,
  aggregate          JSON        NOT NULL,
  published_version  INT         NULL,
  updated_by         BIGINT UNSIGNED NULL,
  updated_at         CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (template_id),
  CONSTRAINT fk_draft_template FOREIGN KEY (template_id) REFERENCES metric_templates_v2(template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE metric_template_versions (
  template_id        VARCHAR(64) NOT NULL,
  version            INT         NOT NULL,
  status             ENUM('published','retired') NOT NULL DEFAULT 'published',
  content_hash       CHAR(71)    NOT NULL,
  aggregate          JSON        NOT NULL,
  items              JSON        NOT NULL,
  package_composition JSON       NOT NULL,
  source_chain       JSON        NOT NULL,
  published_at       CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  retired_at         CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (template_id, version),
  UNIQUE KEY uk_content (template_id, content_hash),
  CONSTRAINT fk_tv_template FOREIGN KEY (template_id) REFERENCES metric_templates_v2(template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE metric_template_items (
  template_id  VARCHAR(64) NOT NULL,
  item_id      VARCHAR(64) NOT NULL,
  status       ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at   CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (template_id, item_id),
  CONSTRAINT fk_ti_template FOREIGN KEY (template_id) REFERENCES metric_templates_v2(template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE metric_template_item_versions (
  template_id            VARCHAR(64)  NOT NULL,
  item_id                VARCHAR(64)  NOT NULL,
  version                INT          NOT NULL,
  display_name           VARCHAR(128) NOT NULL,
  canonical_metric_id    LONGTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  canonical_semantic_version LONGTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  unit                   VARCHAR(32)  NOT NULL,
  dimensions             JSON         NOT NULL,
  collector_ref          JSON         NOT NULL,
  params_default         JSON         NOT NULL,
  source_chain           JSON         NOT NULL,
  PRIMARY KEY (template_id, item_id, version),
  KEY idx_canonical (canonical_metric_id(128), canonical_semantic_version(16)),
  CONSTRAINT fk_tiv_item FOREIGN KEY (template_id, item_id)
    REFERENCES metric_template_items(template_id, item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
