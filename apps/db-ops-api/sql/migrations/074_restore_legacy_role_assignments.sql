-- Restore RBAC assignments for accounts created by legacy schema snapshots.
-- Keep this forward-only and idempotent so deployments that already ran 066
-- are unaffected while older baselined databases converge on user_roles.
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON r.name = u.role_backup
WHERE u.role_backup IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM user_roles existing
    WHERE existing.user_id = u.id
      AND existing.role_id = r.id
  );
