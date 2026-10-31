-- MAX-238: native template storage and the template binding journal.
--
-- Additive only: seven `CREATE TABLE IF NOT EXISTS` statements, no ALTER, DROP,
-- rename or backfill. Existing rows and the single-package binding path are not
-- touched; a deployment that never binds a template sees empty tables.
--
-- The five `metric_template_*` tables are the accepted MAX-237 T2B candidate DDL
-- (docs/slide/development/MAX-237/t2b/sql/t2b_metric_template_aggregate.sql),
-- column for column: same PK/FK/content-hash uniqueness and the same column
-- representations (BIGINT UNSIGNED nullable actor, LONGTEXT ascii canonical
-- columns, CHAR(24) ascii UTC timestamps, INT versions/revisions). Column and
-- table comments are added because every schema table here must be documented.
--
-- The two `metric_policy_*` tables are the accepted MAX-238 B2E candidate schema
-- (docs/slide/development/MAX-238/b2e-candidate-schema.sql). `caller_key` and
-- `receipt_id` are VARBINARY so global operation-key and receipt uniqueness are
-- byte-exact; the same row is both the operation journal and the receipt
-- consumption record.

CREATE TABLE IF NOT EXISTS metric_templates_v2 (
  template_id            VARCHAR(64)  NOT NULL COMMENT 'Upstream template identity (Zabbix template uuid for converted templates)',
  name                   VARCHAR(128) NOT NULL COMMENT 'Human-readable template name',
  status                 ENUM('draft','active','deprecated','archived') NOT NULL DEFAULT 'draft' COMMENT 'Template lifecycle status; only the current pointer makes a version selectable',
  current_published_version INT       NULL COMMENT 'Published version the current pointer names; NULL until the first publish',
  revision               INT          NOT NULL DEFAULT 0 COMMENT 'Template record revision used by compare-and-set updates',
  created_by             BIGINT UNSIGNED NULL COMMENT 'Creating actor; NULL for migrations with no human author',
  created_at             CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Creation time, canonical UTC YYYY-MM-DDTHH:mm:ss.SSSZ',
  updated_at             CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Last record update, same canonical UTC format',
  PRIMARY KEY (template_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Native template identity; identity is the upstream uuid';

CREATE TABLE IF NOT EXISTS metric_template_drafts (
  template_id        VARCHAR(64) NOT NULL COMMENT 'Template this draft belongs to',
  revision           INT         NOT NULL DEFAULT 0 COMMENT 'Draft revision used by compare-and-set updates',
  aggregate          JSON        NOT NULL COMMENT 'Draft aggregate: item references, trigger references, parameters and capability placeholders',
  published_version  INT         NULL COMMENT 'Last version published from this draft',
  updated_by         BIGINT UNSIGNED NULL COMMENT 'Last draft editor; NULL for migrations',
  updated_at         CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Last draft update, canonical UTC',
  PRIMARY KEY (template_id),
  CONSTRAINT fk_draft_template FOREIGN KEY (template_id) REFERENCES metric_templates_v2(template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='One mutable working aggregate per template';

CREATE TABLE IF NOT EXISTS metric_template_versions (
  template_id        VARCHAR(64) NOT NULL COMMENT 'Template this immutable version belongs to',
  version            INT         NOT NULL COMMENT 'Monotonic version number; rows are append-only',
  status             ENUM('published','retired') NOT NULL DEFAULT 'published' COMMENT 'Version status; retired versions are never bound',
  content_hash       CHAR(71)    NOT NULL COMMENT 'sha256 of the published aggregate, unique per template',
  aggregate          JSON        NOT NULL COMMENT 'Published aggregate snapshot this version hashes',
  items              JSON        NOT NULL COMMENT 'Immutable item snapshots referenced by the version',
  package_composition JSON       NOT NULL COMMENT 'Exact package releases and the item ids each covers',
  source_chain       JSON        NOT NULL COMMENT 'Provenance: actor, request, base version, timestamps, migration reference',
  published_at       CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Publish time, canonical UTC',
  retired_at         CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'Retirement time, canonical UTC',
  PRIMARY KEY (template_id, version),
  UNIQUE KEY uk_content (template_id, content_hash),
  CONSTRAINT fk_tv_template FOREIGN KEY (template_id) REFERENCES metric_templates_v2(template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Immutable template versions; published rows are never rewritten';

CREATE TABLE IF NOT EXISTS metric_template_items (
  template_id  VARCHAR(64) NOT NULL COMMENT 'Template this item identity belongs to',
  item_id      VARCHAR(64) NOT NULL COMMENT 'Stable item identity; survives renames and re-pins',
  status       ENUM('active','archived') NOT NULL DEFAULT 'active' COMMENT 'Item identity status',
  created_at   CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'First item version creation time, canonical UTC',
  PRIMARY KEY (template_id, item_id),
  CONSTRAINT fk_ti_template FOREIGN KEY (template_id) REFERENCES metric_templates_v2(template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Stable item identities inside one template';

CREATE TABLE IF NOT EXISTS metric_template_item_versions (
  template_id            VARCHAR(64)  NOT NULL COMMENT 'Template this item version belongs to',
  item_id                VARCHAR(64)  NOT NULL COMMENT 'Stable item identity',
  version                INT          NOT NULL COMMENT 'Monotonic item version; rows are append-only',
  display_name           VARCHAR(128) NOT NULL COMMENT 'Display name; a rename appends a new version',
  canonical_metric_id    LONGTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Canonical metric id this item provides',
  canonical_semantic_version LONGTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Canonical metric semantic version',
  unit                   VARCHAR(32)  NOT NULL COMMENT 'Canonical unit; must equal the metric definition unit',
  dimensions             JSON         NOT NULL COMMENT 'Canonical dimension names and meanings',
  collector_ref          JSON         NOT NULL COMMENT 'Exact package release (id@version#digest) and implementation that collect this item',
  params_default         JSON         NOT NULL COMMENT 'Declared template parameter defaults for this item',
  source_chain           JSON         NOT NULL COMMENT 'Provenance for this item version',
  PRIMARY KEY (template_id, item_id, version),
  KEY idx_canonical (canonical_metric_id(128), canonical_semantic_version(16)),
  CONSTRAINT fk_tiv_item FOREIGN KEY (template_id, item_id)
    REFERENCES metric_template_items(template_id, item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Immutable item versions; collector_ref pins one exact package release';

CREATE TABLE IF NOT EXISTS metric_policy_operations (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Surrogate id',
  caller_key          VARBINARY(255)  NOT NULL COMMENT 'Client operation key; globally unique, byte-exact',
  receipt_id          VARBINARY(255)  NOT NULL COMMENT 'Trial receipt consumed by this operation; globally unique single use',
  resource_type       VARBINARY(32)   NOT NULL COMMENT 'Resource type the operation targets',
  resource_id         BIGINT UNSIGNED NOT NULL COMMENT 'Numeric resource id',
  resource_key        VARBINARY(255)  NOT NULL COMMENT 'Resource type and id as one key',
  target_revision     BIGINT UNSIGNED NOT NULL COMMENT 'Binding revision this operation publishes',
  candidate_digest    VARBINARY(71)   NOT NULL COMMENT 'sha256 binding candidate digest including the dependency digest',
  resolution_identity VARBINARY(71)   NOT NULL COMMENT 'sha256 identity of the resolved template plan',
  dependency_digest   VARBINARY(71)   NOT NULL COMMENT 'sha256 trusted dependency identity (resource/group/capabilities/credential reference)',
  status              VARBINARY(16)   NOT NULL COMMENT 'Operation status; committed rows replay, anything else is unknown',
  created_at          DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT 'Row creation time',
  PRIMARY KEY (id),
  UNIQUE KEY uq_metric_policy_operation_caller (caller_key),
  UNIQUE KEY uq_metric_policy_operation_receipt (receipt_id),
  KEY ix_metric_policy_operation_resource (resource_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Template binding operation journal; caller key and receipt are globally unique';

CREATE TABLE IF NOT EXISTS metric_policy_trial_receipts (
  receipt_id  VARBINARY(255) NOT NULL COMMENT 'Receipt identity; exact lookup only',
  payload     JSON           NOT NULL COMMENT 'Strict v2 receipt body: identities, items, exclusions and expiry',
  created_at  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT 'Row creation time',
  PRIMARY KEY (receipt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Trusted v2 trial receipts read back by exact receipt id';
