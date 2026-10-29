-- MAX-238 / NATIVE-COLLECT-NOW: one durable manual-collection task per caller intent.
--
-- Additive only: one `CREATE TABLE IF NOT EXISTS`. No existing table, row,
-- binding/policy/audit writer or scheduler row is touched. The periodic
-- `metric_schedule` table keeps its own `job_id`; a manual task never writes it.
--
-- One row is exactly one user action: the resource, the published revision the
-- action started from, the caller's idempotency key under that signed principal
-- and the digest of the exact plan/pins/target/credential identity. A replay of
-- the same key returns this row instead of a second job; the same key with a
-- different principal, revision or intent is a conflict, never a replay.
--
-- `state` is the task lifecycle. `samples` holds the immutable sample identities
-- this task's own job committed (id/metric/unit/value/observed_at/quality) and is
-- written in the same transaction as the formal observation rows. A completed
-- task with an empty sample list therefore never claims a successful collection.
CREATE TABLE IF NOT EXISTS metric_collect_requests (
  id                  CHAR(36)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Server-issued collection task id',
  resource_key        VARCHAR(96)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Resource type and numeric ID',
  caller_key          VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Client idempotency key, byte-exact',
  actor_id            BIGINT UNSIGNED NOT NULL COMMENT 'Signed principal that requested the collection',
  session_version     BIGINT UNSIGNED NOT NULL COMMENT 'Session version at admission; a later session is not this intent',
  revision            BIGINT UNSIGNED NOT NULL COMMENT 'Published binding revision the action started from',
  resolution_identity CHAR(71)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Resolution identity of that fixed plan',
  intent_digest       CHAR(71)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'sha256 of resource, revision, plan identity, pins, target and credential identity',
  job_id              CHAR(36)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'The single workflow_jobs row for this task',
  state               ENUM('accepted','running','completed','failed','cancelled','unknown') NOT NULL DEFAULT 'accepted'
                      COMMENT 'Task lifecycle; independent of whether samples succeeded',
  outcome             ENUM('sampled','no_samples','failed','cancelled','unknown') NULL
                      COMMENT 'Collection result, written only when the task reaches a terminal state',
  error_code          VARCHAR(64)  CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'Stable diagnostic; never a driver message or secret',
  samples             JSON         NULL COMMENT 'Immutable sample identities committed by this task',
  attempts            JSON         NULL COMMENT 'Attempt identities and statuses returned by this task',
  created_at          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT 'Admission time',
  started_at          DATETIME(6)  NULL COMMENT 'First claimed execution of this task',
  finished_at         DATETIME(6)  NULL COMMENT 'Terminal transition time',
  updated_at          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT 'Last lifecycle transition',
  PRIMARY KEY (id),
  UNIQUE KEY uq_metric_collect_resource_caller (resource_key, caller_key),
  KEY idx_metric_collect_job (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Idempotent manual collection tasks and their exact samples';
