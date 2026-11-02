-- MAX-236 / P0-REAL-A acceptance library seed (task-owned, disposable).
--
-- Run ONLY against the isolated database created by `env-start.sh`
-- (`max236_reala` on container `max236-reala-15coder1`). It expects the real
-- migration ledger plus the candidate 140-142 DDL to be present.
--
-- The objects are this task's own test fixtures: no platform credential value,
-- no business row and no production resource is copied. Secrets are placeholders
-- (`ENC[not-a-secret]`) and are never read by the executor — it only checks that
-- a non-empty credential exists.
--
-- Re-running is safe: every row this file owns is deleted first.

SET NAMES utf8mb4;

-- FK-safe removal of only this task's objects.
DELETE FROM instance_permissions WHERE instance_id = 9101;
DELETE FROM network_device_credentials WHERE device_id = 9301;
DELETE FROM network_device_observations WHERE device_id = 9301;
DELETE FROM server_metrics WHERE server_id = 9201;
DELETE FROM metric_publications WHERE series_hash = '67a4361dc5f949ca926231dc59ec4fa8cd16d2a8e18082420a834545d6593ecb';
DELETE FROM metric_observations WHERE series_hash = '67a4361dc5f949ca926231dc59ec4fa8cd16d2a8e18082420a834545d6593ecb';
DELETE FROM metric_rollout WHERE series_hash = '67a4361dc5f949ca926231dc59ec4fa8cd16d2a8e18082420a834545d6593ecb';
DELETE FROM metrics_history WHERE instance_id = 9101;
DELETE FROM alerts WHERE instance_id = 9101 AND title LIKE 'max236-reala%';
DELETE FROM audit_log_entries WHERE id LIKE 'max236-reala-%';
DELETE FROM metric_policy_audit WHERE target IN ('instance:9101','server:9201','network_device:9301');
DELETE FROM metric_schedule WHERE resource_key IN ('instance:9101','server:9201','network_device:9301');
DELETE FROM metric_policy_bindings WHERE resource_key IN ('instance:9101','server:9201','network_device:9301');
DELETE FROM network_devices WHERE id = 9301;
DELETE FROM servers WHERE id = 9201;
DELETE FROM database_instances WHERE id = 9101;
DELETE FROM metric_template_versions WHERE template_id IN ('tpl-a','tpl-foundation');
DELETE FROM metric_templates_v2 WHERE template_id IN ('tpl-a','tpl-foundation');
DELETE FROM users WHERE id = 9001;

-- Actor used by the executor's audit rows.
INSERT INTO users (id, username, password_hash, status)
VALUES (9001, 'max236-reala-actor', 'not-a-real-hash', 'active');

-- Candidate template aggregate rows (140). content_hash is the immutable version
-- identity the plan pins must match byte-for-byte.
INSERT INTO metric_templates_v2
  (template_id, name, status, current_published_version, revision, created_at, updated_at)
VALUES
  ('tpl-a', 'MAX-236 REAL-A template A', 'active', 1, 1, '2026-10-27 10:00:00.000', '2026-10-27 10:00:00.000'),
  ('tpl-foundation', 'MAX-236 REAL-A foundation', 'active', 1, 1, '2026-10-27 10:00:00.000', '2026-10-27 10:00:00.000');

INSERT INTO metric_template_versions
  (template_id, version, status, content_hash, aggregate, items, package_composition, source_chain, published_at)
VALUES
  ('tpl-a', 1, 'published', 'sha256:b7503c4f49fc34114a73ed6b579614f99b3a67c50b40bf828ea4a46db9938ee3',
   '{"template_id":"tpl-a","items":[],"triggers":[]}', '[]', '[]',
   '{"actor_id":9001,"request_id":"max236-reala-seed"}', '2026-10-27 10:00:00.000'),
  ('tpl-foundation', 1, 'published', 'sha256:3b90c3356edef738d002af9ecd52d05919780666b09a0683934295d4fad6c294',
   '{"template_id":"tpl-foundation","items":[],"triggers":[]}', '[]', '[]',
   '{"actor_id":9001,"request_id":"max236-reala-seed"}', '2026-10-27 10:00:00.000');

-- Canonical catalog rows. network_device has no catalog table in the real schema,
-- so a device identity can never be mapped (the executor reports that fact).
INSERT INTO metric_definitions
  (id, target_type, name, unit, db_types, aggregation, default_interval, is_collected, is_builtin)
VALUES
  ('cpu_usage', 'instance', 'CPU 使用率', '%', '["mysql"]', 'avg', 60, TRUE, FALSE),
  ('retired_metric', 'instance', '已停采指标', '%', '["mysql"]', 'avg', 60, FALSE, FALSE),
  ('cpu_usage', 'server', 'CPU 使用率', '%', '["mysql"]', 'avg', 60, TRUE, FALSE)
ON DUPLICATE KEY UPDATE unit = VALUES(unit), is_collected = VALUES(is_collected), name = VALUES(name);

-- The task's own three acceptance resource rows (placeholder credentials only).
INSERT INTO database_instances
  (id, name, environment, db_type, host, port, username, password_encrypted, database_name, status)
VALUES (9101, 'max236-reala-instance', 'testing', 'mysql', '127.0.0.1', 1, 'reala', 'ENC[not-a-secret]', 'none', 'active');

INSERT INTO servers
  (id, host, port, os_type, credential_type, credential_encrypted, status)
VALUES (9201, '127.0.0.1', 2222, 'Other', 'password', 'ENC[not-a-secret]', 'offline');

INSERT INTO network_devices (id, name, host, vendor, status)
VALUES (9301, 'max236-reala-device', '127.0.0.1', 'huawei', 'unknown');

INSERT INTO network_device_credentials (device_id, protocol, username, community_encrypted)
VALUES (9301, 'snmpv2c', 'reala', 'ENC[not-a-secret]');

INSERT INTO instance_permissions (user_id, instance_id, access_level, grant_expiry)
VALUES (9001, 9101, 'admin', '2027-01-01 00:00:00');

-- Per-resource binding rows: revision 0, legacy single package, no compiled plan.
INSERT INTO metric_policy_bindings (resource_key, group_id, payload, capabilities)
VALUES
  ('instance:9101', NULL, JSON_OBJECT(
     'binding', JSON_OBJECT('resource', JSON_OBJECT('type','instance','id',9101),
       'package', JSON_OBJECT('id','mysql-basic','version','1.0.0','digest','sha256:b732eb17bd187adcbfc30328a86082129f84388160858df627ab4622389aa96c'),
       'group_id', NULL, 'overrides', JSON_OBJECT(), 'revision', 0),
     'resolved', NULL,
     'published_at', '2026-10-27 10:00:00.000',
     'application', JSON_OBJECT('applied_revision', NULL, 'reported_at', NULL, 'status', 'pending', 'error_code', NULL)), '[]'),
  ('server:9201', NULL, JSON_OBJECT(
     'binding', JSON_OBJECT('resource', JSON_OBJECT('type','server','id',9201),
       'package', JSON_OBJECT('id','mysql-basic','version','1.0.0','digest','sha256:b732eb17bd187adcbfc30328a86082129f84388160858df627ab4622389aa96c'),
       'group_id', NULL, 'overrides', JSON_OBJECT(), 'revision', 0),
     'resolved', NULL,
     'published_at', '2026-10-27 10:00:00.000',
     'application', JSON_OBJECT('applied_revision', NULL, 'reported_at', NULL, 'status', 'pending', 'error_code', NULL)), '[]'),
  ('network_device:9301', NULL, JSON_OBJECT(
     'binding', JSON_OBJECT('resource', JSON_OBJECT('type','network_device','id',9301),
       'package', JSON_OBJECT('id','mysql-basic','version','1.0.0','digest','sha256:b732eb17bd187adcbfc30328a86082129f84388160858df627ab4622389aa96c'),
       'group_id', NULL, 'overrides', JSON_OBJECT(), 'revision', 0),
     'resolved', NULL,
     'published_at', '2026-10-27 10:00:00.000',
     'application', JSON_OBJECT('applied_revision', NULL, 'reported_at', NULL, 'status', 'pending', 'error_code', NULL)), '[]');

-- Baseline publish audit (revision 0). This is the rollback target record.
INSERT INTO metric_policy_audit (target, payload)
VALUES
  ('instance:9101', JSON_OBJECT('actor_id', 9001, 'request_id', 'max236-baseline:seed', 'action', 'binding.publish',
     'target', 'instance:9101', 'revision', 0, 'at', '2026-10-27 10:00:00.000',
     'configuration', JSON_OBJECT('package', JSON_OBJECT('id','mysql-basic','version','1.0.0','digest','sha256:b732eb17bd187adcbfc30328a86082129f84388160858df627ab4622389aa96c'),
       'group_id', NULL, 'overrides', JSON_OBJECT(), 'template_pins', JSON_ARRAY()))),
  ('server:9201', JSON_OBJECT('actor_id', 9001, 'request_id', 'max236-baseline:seed', 'action', 'binding.publish',
     'target', 'server:9201', 'revision', 0, 'at', '2026-10-27 10:00:00.000',
     'configuration', JSON_OBJECT('package', JSON_OBJECT('id','mysql-basic','version','1.0.0','digest','sha256:b732eb17bd187adcbfc30328a86082129f84388160858df627ab4622389aa96c'),
       'group_id', NULL, 'overrides', JSON_OBJECT(), 'template_pins', JSON_ARRAY()))),
  ('network_device:9301', JSON_OBJECT('actor_id', 9001, 'request_id', 'max236-baseline:seed', 'action', 'binding.publish',
     'target', 'network_device:9301', 'revision', 0, 'at', '2026-10-27 10:00:00.000',
     'configuration', JSON_OBJECT('package', JSON_OBJECT('id','mysql-basic','version','1.0.0','digest','sha256:b732eb17bd187adcbfc30328a86082129f84388160858df627ab4622389aa96c'),
       'group_id', NULL, 'overrides', JSON_OBJECT(), 'template_pins', JSON_ARRAY())));

-- Single executor per resource (real metric_schedule PK).
INSERT INTO metric_schedule (resource_key, revision, next_due_ms, job_id, states)
VALUES
  ('instance:9101', 0, 0, 'job-instance-9101', '{}'),
  ('server:9201', 0, 0, 'job-server-9201', '{}'),
  ('network_device:9301', 0, 0, 'job-device-9301', '{}');

-- Instance history: legacy rows, one rollout series, observations and publications.
INSERT INTO metrics_history (instance_id, cpu_usage, memory_usage, recorded_at)
VALUES (9101, 42.50, 61.25, '2026-10-27 09:58:00'), (9101, 43.50, 62.25, '2026-10-27 09:59:00');

INSERT INTO metric_rollout
  (series_hash, source, generation, read_mode, package_pin, published_revision, resource_type, resource_id)
VALUES ('67a4361dc5f949ca926231dc59ec4fa8cd16d2a8e18082420a834545d6593ecb', 'max236-reala', 1, 'legacy',
  JSON_OBJECT('id','mysql-basic','version','1.0.0','digest','sha256:b732eb17bd187adcbfc30328a86082129f84388160858df627ab4622389aa96c'), 0, 'instance', '9101');

INSERT INTO metric_observations (id, series_hash, stage, observed_at, stored_at, valid_value, payload, payload_hash, evidence_expires_at)
VALUES
  ('sha256:e72e2581cffd8fef935b300f398a5a18bcb730d59ebd2fc267c5dfd7d5fe149e',
   '67a4361dc5f949ca926231dc59ec4fa8cd16d2a8e18082420a834545d6593ecb', 'raw',
   '2026-10-27 09:58:30.000', '2026-10-27 09:58:31.000', TRUE, NULL,
   'd832536029a582284c1ccb70b12b3e1c9662eab64a28b7dba9ec0ab75cfc0fa0', NULL),
  ('sha256:e12344b44ec407832a1f28733acb9b119b82ce7ded5be050cc003515cb9db072',
   '67a4361dc5f949ca926231dc59ec4fa8cd16d2a8e18082420a834545d6593ecb', 'normalized',
   '2026-10-27 09:58:30.000', '2026-10-27 09:58:31.000', TRUE, NULL,
   'f75cc554ec6bb300e5614fb8f148b161b5cc3ff53ecee7bbe35b47292c35808d', NULL);

INSERT INTO metric_publications (observation_id, series_hash, generation, observed_at)
VALUES ('sha256:e12344b44ec407832a1f28733acb9b119b82ce7ded5be050cc003515cb9db072',
  '67a4361dc5f949ca926231dc59ec4fa8cd16d2a8e18082420a834545d6593ecb', 1, '2026-10-27 09:58:30.000');

-- Event row (unchanged across migration), platform audit row, server/device history.
INSERT INTO alerts (instance_id, alert_type, level, title, message, status)
VALUES (9101, 'performance', 'warning', 'max236-reala seeded alert', 'not a real incident', 'unread');

INSERT INTO audit_log_entries (id, event_type, level, action, resource_type, resource_id, result, timestamp_ms)
VALUES ('max236-reala-audit-1', 'metric', 'info', 'seed', 'instance', '9101', 'success', 1761559200000);

INSERT INTO server_metrics (server_id, metric_name, dimensions, metric_value, recorded_at)
VALUES (9201, 'cpu_usage', '{}', 10.0000, '2026-10-27 09:58:30');

INSERT INTO network_device_observations (device_id, metric_id, dimensions, metric_value, observed_at, quality, source)
VALUES (9301, 'cpu', '{}', 1.00000000, '2026-10-27 09:58:30.000000', 'good', 'max236-reala');
