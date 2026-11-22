RENAME TABLE metric_templates_v2 TO monitoring_templates;

-- Audit snapshots are hash-covered. Only active binding payloads are renamed.
UPDATE metric_policy_bindings
SET payload = JSON_SET(payload, '$.envelope',
  CASE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.envelope'))
    WHEN 'templates-v1' THEN 'template-pending'
    WHEN 'templates-applied-v1' THEN 'template-applied'
    WHEN 'templates-stopped-v1' THEN 'template-stopped'
  END)
WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.envelope')) IN
  ('templates-v1', 'templates-applied-v1', 'templates-stopped-v1');
