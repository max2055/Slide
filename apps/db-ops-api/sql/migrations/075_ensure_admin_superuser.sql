-- Ensure the reserved admin identity retains the system administrator role even
-- when a legacy database was migrated without a role_backup value.
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON r.name = 'admin'
WHERE LOWER(u.username) = 'admin';

-- Keep the role's wildcard permission present on partially migrated schemas.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = '*'
WHERE r.name = 'admin';
