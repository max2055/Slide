/**
 * Shared API types — single source of truth for frontend ↔ backend contracts.
 *
 * When modifying backend response shapes, update these types FIRST.
 * grep for these interface names in frontend/ to identify affected code.
 */

// ── User ──────────────────────────────────────────────

/** Returned by GET /api/users */
export interface UserInfo {
  id: number;
  username: string;
  email: string | null;
  status: 'active' | 'inactive' | 'locked';
  last_login_at: string | null;
  created_at: string;
}

// ── Roles (RBAC) ──────────────────────────────────────

/** Returned by GET /api/v1/rbac/roles */
export interface RoleInfo {
  id: number;
  name: string;
  description: string | null;
  permission_count?: number;
  user_count?: number;
}

/** Returned by GET /api/v1/rbac/users/:userId/roles */
export interface UserRoleBinding {
  id: number;       // user_roles.id (junction table row)
  role_id: number;  // roles.id (the actual role identifier)
  role_name: string;
}

/** Returned by GET /api/v1/rbac/permissions */
export interface PermissionInfo {
  id: number;
  code: string;
  name: string;
  resource: string;
  action: string;
  description: string | null;
}

// ── RBAC API Request Bodies ────────────────────────────

export interface CreateRoleBody {
  name: string;
  description?: string;
}

export interface UpdateRoleBody {
  name?: string;
  description?: string;
}

export interface CreatePermissionBody {
  code: string;
  name: string;
  resource: string;
  action: string;
  description?: string;
}

export interface AssignRoleBody {
  roleId: number;
}

export interface GrantInstanceAccessBody {
  instanceId: number;
  accessLevel?: 'read-only' | 'read-write' | 'admin';
}

// ── User Management API ────────────────────────────────

export interface CreateUserBody {
  username: string;
  password: string;
  email?: string;
}

export interface UpdateUserBody {
  status?: 'active' | 'inactive' | 'locked';
  email?: string;
}

export interface ResetPasswordBody {
  password: string;
}
