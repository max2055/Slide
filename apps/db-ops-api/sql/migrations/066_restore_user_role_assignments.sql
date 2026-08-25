-- Restore RBAC assignments for users created by the legacy baseline.
-- The baseline stores the former role in users.role_backup but does not
-- populate user_roles, which leaves freshly deployed accounts authenticated
-- but unable to access protected application APIs.
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
