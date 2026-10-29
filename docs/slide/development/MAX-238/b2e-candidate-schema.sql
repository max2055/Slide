-- MAX-238 B2E — CANDIDATE schema for the unmounted MySQL binding host.
--
-- NOT a migration. This file is documentation only: it is not loaded by any
-- runner, not applied to any database, and no statement here has been executed.
-- A later live-storage package must review the exact column types, collation,
-- backup/rollback plan and the real `metric_policy_bindings` production DDL
-- before anything is applied.
--
-- Capability mapping of the four logical states to three physical writes:
--   * operation row                 -> metric_policy_operations
--   * receipt consumption           -> UNIQUE (receipt_id) on that same row
--   * binding payload / CAS update  -> metric_policy_bindings (existing table)
--   * audit                         -> metric_policy_audit (existing table)

-- ---------------------------------------------------------------------------
-- Existing table, unchanged: only these columns are used by the host.
--   resource_key  VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin
--   payload       JSON          -- B2E writes the templates-v1 envelope object
--   group_id      ...           -- kept in sync with payload.binding.group_id
--   capabilities  ...           -- never touched by a template staging
-- The CAS condition is:
--   JSON_EXTRACT(payload, '$.binding.revision') = ?   (affected rows must be 1)
-- ---------------------------------------------------------------------------

-- The operation journal. Global caller-key and receipt-id uniqueness are the
-- replay and single-use authorities; both are retained indefinitely (no delete,
-- cleanup, tombstone or monthly partition, which would break global uniqueness).
-- VARBINARY compares bytes: no case-insensitive or trailing-space collation.
-- The connection charset is utf8mb4 and every key parameter is sent as an
-- explicit UTF-8 Buffer, so a stored key round-trips byte for byte.
CREATE TABLE metric_policy_operations (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  caller_key          VARBINARY(255)  NOT NULL,
  receipt_id          VARBINARY(255)  NOT NULL,
  resource_type       VARBINARY(32)   NOT NULL,
  resource_id         BIGINT UNSIGNED NOT NULL,
  resource_key        VARBINARY(255)  NOT NULL,
  target_revision     BIGINT UNSIGNED NOT NULL,
  candidate_digest    VARBINARY(71)   NOT NULL,
  resolution_identity VARBINARY(71)   NOT NULL,
  dependency_digest   VARBINARY(71)   NOT NULL,
  status              VARBINARY(16)   NOT NULL,
  created_at          DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_metric_policy_operation_caller (caller_key),
  UNIQUE KEY uq_metric_policy_operation_receipt (receipt_id),
  KEY ix_metric_policy_operation_resource (resource_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The trusted v2 receipt rows. Written by the (not yet built) receipt issuer;
-- the B2E host only reads `payload` by exact receipt_id. A strict JSON object is
-- stored (candidate/resolution/dependency identities, items, expiry), never a
-- credential or a driver message.
CREATE TABLE metric_policy_trial_receipts (
  receipt_id  VARBINARY(255) NOT NULL,
  payload     JSON           NOT NULL,
  created_at  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (receipt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Representation boundaries enforced by the host before any write (UTF-8 bytes,
-- matching the columns above):
--   caller_key, receipt_id, resource_key  <= 255
--   operation key (resource_key#revision@candidate_digest) <= 1024
--   sha256 digests                        71 chars, validated as sha256:<64 hex>
--   revisions                             safe non-negative/positive integers
--   payload and audit JSON                <= 1 MiB each
-- No value is truncated or rounded; an out-of-range value rejects the staging.
