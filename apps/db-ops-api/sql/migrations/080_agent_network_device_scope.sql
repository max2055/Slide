-- Extend Agent resource policies to cover network devices introduced in v0.10.
-- Missing keys remain equivalent to an inherited (null) scope for compatibility.
UPDATE agent_security_policies
SET resource_scope = JSON_SET(COALESCE(resource_scope, JSON_OBJECT()), '$.networkDeviceIds', NULL)
WHERE JSON_CONTAINS_PATH(COALESCE(resource_scope, JSON_OBJECT()), 'one', '$.networkDeviceIds') = 0;
