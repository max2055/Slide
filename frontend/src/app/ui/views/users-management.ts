import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import "../components/app-dialog.js";
import "../components/app-card.js";
import "../components/app-badge.js";
import "../components/app-empty-state.js";
import { apiClient } from '../../../api/index.js';
import { showToast } from "../components/app-toast-container.js";

interface UserInfo {
  id: number;
  username: string;
  email: string | null;
  status: string;
  last_login_at: string | null;
  created_at: string;
}

/** Role from RBAC roles table */
interface RoleInfo {
  id: number;
  name: string;
  description: string | null;
  permission_count?: number;
  user_count?: number;
}

/** User-role binding from user_roles table */
interface UserRoleBinding {
  id: number;
  role_id: number;
  role_name: string;
}

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  dba: '数据库管理员',
  developer: '开发者',
  analyst: '分析师',
  viewer: '观察者',
  auditor: '审计员',
};

const STATUS_LABELS: Record<string, string> = {
  active: '活跃',
  inactive: '停用',
  locked: '锁定',
};

@customElement("users-management")
export class UsersManagement extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host {
      display: block;
      animation: fade-in 0.25s var(--ease-out);
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page {
      padding: 0;
    }


    .table-container {
      overflow-x: auto;
    }

    .table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 13px;
    }

    .table th {
      position: sticky;
      top: 0;
      z-index: 3;
      padding: 10px 14px;
      text-align: left;
      font-weight: 600;
      font-size: 11px;
      color: var(--muted);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .table td {
      padding: 14px;
      border-bottom: 1px solid var(--border);
      color: var(--text);
      vertical-align: middle;
    }

    .table tbody tr {
      transition: background var(--duration-fast) ease;
    }

    .table tbody tr:hover {
      background: var(--bg-hover);
    }

    .table tbody tr:last-child td {
      border-bottom: none;
    }

    .role-badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
    }

    .role-badge.admin {
      background: rgba(239, 68, 68, 0.12);
      color: #ef4444;
    }

    .role-badge.dba {
      background: rgba(59, 130, 246, 0.12);
      color: #3b82f6;
    }

    .role-badge.developer {
      background: rgba(34, 197, 94, 0.12);
      color: #22c55e;
    }

    .role-badge.analyst {
      background: rgba(168, 85, 247, 0.12);
      color: #a855f7;
    }

    .role-badge.viewer {
      background: rgba(139, 139, 145, 0.12);
      color: var(--muted);
    }

    .role-badge.auditor {
      background: rgba(245, 158, 11, 0.12);
      color: #f59e0b;
    }


    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 5px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 500;
      color: var(--text);
      background: var(--secondary);
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
    }

    .action-btn:hover {
      background: var(--accent);
      color: var(--accent-foreground);
      border-color: var(--accent);
    }

    .action-btn.danger:hover {
      background: var(--danger);
      color: var(--danger-foreground);
      border-color: var(--danger);
    }

    .loading, .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: var(--muted);
    }

    .no-permission {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: var(--muted);
      font-size: 14px;
    }

    .error-msg {
      color: var(--danger);
      font-size: 13px;
      padding: 12px 16px;
      background: var(--danger-subtle);
      border-radius: var(--radius-sm);
      margin: 12px 16px;
    }


    .form-group {
      display: grid;
      gap: var(--space-xs);
    }

    .form-group label {
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .form-group input,
    .form-group select {
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-base);
      color: var(--text);
      background: var(--card);
      transition: all var(--duration-normal) var(--ease-out);
    }

    .form-group input:focus,
    .form-group select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-subtle);
    }

    .form-group input:disabled {
      background: var(--bg-muted);
      color: var(--muted);
      cursor: not-allowed;
    }

    .form-error {
      font-size: 12px;
      color: var(--danger);
      margin-top: 4px;
    }

    .save-error {
      color: var(--danger);
      font-size: 13px;
      padding: 8px 12px;
      background: var(--danger-subtle);
      border-radius: var(--radius-sm);
    }
  `];

  @state() private users: UserInfo[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private isAdmin = false;
  @state() private userRoles: Map<number, UserRoleBinding[]> = new Map();
  @state() private allRoles: RoleInfo[] = [];
  @state() private showModal = false;
  @state() private editingUser: UserInfo | null = null;
  @state() private showPasswordModal = false;
  @state() private passwordTarget: UserInfo | null = null;
  @state() private saving = false;
  @state() private saveError: string | null = null;

  // Form state
  @state() private formUsername = "";
  @state() private formEmail = "";
  @state() private formPassword = "";
  @state() private formRoleId: number | null = null;
  @state() private formStatus = "active";
  @state() private formErrors: string[] = [];

  // Password reset form state
  @state() private newPassword = "";
  @state() private confirmPassword = "";
  @state() private passwordErrors: string[] = [];

  override connectedCallback() {
    super.connectedCallback();
    this._checkAdmin();
  }

  private async _checkAdmin() {
    try {
      await apiClient.get("/v1/rbac/roles");
      this.isAdmin = true;
      this._init();
    } catch (e: any) {
      this.isAdmin = false;
      if (e.message?.startsWith("HTTP 403")) {
        // 403 means not admin, no error shown
      } else if (e.message?.startsWith("HTTP 401")) {
        this.error = "未登录";
      } else {
        this.error = `权限检查失败: ${e.message}`;
      }
    }
  }

  private async _init() {
    await Promise.all([this._loadUsers(), this._loadAllRoles()]);
  }

  private async _loadAllRoles() {
    try {
      this.allRoles = await apiClient.get<RoleInfo[]>("/v1/rbac/roles");
    } catch (_) {
      // non-critical; dropdown will fall back to hardcoded labels
    }
  }

  private async _loadUsers() {
    this.loading = true;
    this.error = null;
    try {
      const data = await apiClient.get<UserInfo[]>('/users');
      this.users = Array.isArray(data) ? data : [];
      await this._loadUserRoles();
    } catch (e: any) {
      if (e.message?.startsWith("HTTP 401")) {
        this.error = "未登录";
        this.isAdmin = false;
      } else if (e.message?.startsWith("HTTP 403")) {
        this.error = "无权限访问";
        this.isAdmin = false;
      } else {
        this.error = `加载失败: ${e.message}`;
      }
    } finally {
      this.loading = false;
    }
  }

  private async _loadUserRoles() {
    const userIds = this.users.map(u => u.id);
    if (userIds.length === 0) return;
    const results = await Promise.allSettled(
      userIds.map(id =>
        apiClient.get<UserRoleBinding[]>(`/v1/rbac/users/${id}/roles`)
      )
    );
    const newMap = new Map<number, UserRoleBinding[]>();
    for (let i = 0; i < userIds.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        const roles = Array.isArray(result.value) ? result.value : [];
        newMap.set(userIds[i], roles);
      } else {
        newMap.set(userIds[i], []);
      }
    }
    this.userRoles = newMap;
  }

  private _navigateToRbac(userId: number) {
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "rbac", id: userId },
      bubbles: true,
      composed: true,
    }));
  }

  // Modal handling
  private _openCreateModal() {
    this.editingUser = null;
    this.formUsername = "";
    this.formEmail = "";
    this.formPassword = "";
    this.formRoleId = null;
    this.formStatus = "active";
    this.formErrors = [];
    this.saveError = null;
    this.showModal = true;
  }

  private _openEditModal(user: UserInfo) {
    this.editingUser = user;
    this.formUsername = user.username;
    this.formEmail = user.email || "";
    this.formPassword = "";
    const roles = this.userRoles.get(user.id) || [];
    this.formRoleId = roles.length > 0 ? roles[0].role_id : null;
    this.formStatus = user.status;
    this.formErrors = [];
    this.saveError = null;
    this.showModal = true;
  }

  private _closeModal() {
    this.showModal = false;
    this.editingUser = null;
    this.formErrors = [];
    this.saveError = null;
  }

  private async _saveUser() {
    this.formErrors = [];
    this.saveError = null;

    // Validation
    if (this.editingUser) {
      // Edit mode
    } else {
      // Create mode: username and password required
      if (!this.formUsername.trim()) {
        this.formErrors.push("用户名不能为空");
      }
      if (this.formPassword.length < 8) {
        this.formErrors.push("密码长度至少 8 位");
      }
    }

    if (this.formErrors.length > 0) return;

    this.saving = true;

    try {
      if (this.editingUser) {
        const userId = this.editingUser.id;
        // Update user status
        const body: Record<string, string> = { status: this.formStatus };
        if (this.formEmail) body.email = this.formEmail;
        await apiClient.put(`/users/${userId}`, body);

        // Sync role via RBAC API
        await this._syncUserRole(userId, this.formRoleId);
      } else {
        // Create user
        const body: Record<string, string> = {
          username: this.formUsername.trim(),
          password: this.formPassword,
        };
        if (this.formEmail) body.email = this.formEmail;
        const result = await apiClient.post<{ success: boolean; userId?: number; error?: string }>('/users', body);

        // Assign role via RBAC API
        const userId = result?.userId;
        if (userId && this.formRoleId !== null) {
          try {
            await apiClient.post(`/v1/rbac/users/${userId}/roles`, { roleId: this.formRoleId });
          } catch (roleErr: any) {
            // User created but role assignment failed — log but don't fail the whole operation
            showToast('Role assignment failed', 'error');
          }
        }
      }

      this._closeModal();
      await this._loadUsers();
    } catch (e: any) {
      this.saveError = `操作失败: ${e.message}`;
    } finally {
      this.saving = false;
    }
  }

  /** Sync a user's role: remove existing roles not matching, add the selected one */
  private async _syncUserRole(userId: number, newRoleId: number | null) {
    const currentRoles = this.userRoles.get(userId) || [];

    // No change: current role matches new role
    if (currentRoles.length === 1 && currentRoles[0].role_id === newRoleId) {
      return;
    }
    // Both empty: nothing to do
    if (currentRoles.length === 0 && newRoleId === null) {
      return;
    }

    // Remove all current roles
    for (const r of currentRoles) {
      const res = await apiClient.delete(`/v1/rbac/users/${userId}/roles/${r.role_id}`);
      if (!res || (res as any).success === false) {
        throw new Error(`移除角色失败: ${(res as any)?.error || '未知错误'}`);
      }
    }
    // Add the new role if one is selected
    if (newRoleId !== null) {
      const res = await apiClient.post(`/v1/rbac/users/${userId}/roles`, { roleId: newRoleId });
      if (!res || (res as any).success === false) {
        throw new Error(`添加角色失败: ${(res as any)?.error || '未知错误'}`);
      }
    }
  }

  // Password reset
  private _openPasswordModal(user: UserInfo) {
    this.passwordTarget = user;
    this.newPassword = "";
    this.confirmPassword = "";
    this.passwordErrors = [];
    this.saveError = null;
    this.showPasswordModal = true;
  }

  private _closePasswordModal() {
    this.showPasswordModal = false;
    this.passwordTarget = null;
    this.passwordErrors = [];
    this.saveError = null;
  }

  private async _resetPassword() {
    this.passwordErrors = [];
    this.saveError = null;

    if (!this.passwordTarget) return;

    if (this.newPassword.length < 8) {
      this.passwordErrors.push("密码长度至少 8 位");
    }
    if (this.newPassword !== this.confirmPassword) {
      this.passwordErrors.push("两次输入的密码不一致");
    }
    if (this.passwordErrors.length > 0) return;

    this.saving = true;

    try {
      await apiClient.post(`/users/${this.passwordTarget.id}/password`, { password: this.newPassword });
      this._closePasswordModal();
    } catch (e: any) {
      this.saveError = `重置失败: ${e.message}`;
    } finally {
      this.saving = false;
    }
  }

  // Delete user
  private async _deleteUser(id: number, username: string) {
    if (!confirm(`确定删除用户 "${username}"？`)) return;

    try {
      await apiClient.delete(`/users/${id}`);
      await this._loadUsers();
    } catch (e: any) {
      this.error = `删除失败: ${e.message}`;
    }
  }

  private _renderUserRoleBadges(userId: number) {
    const roles = this.userRoles.get(userId) || [];
    if (roles.length === 0) {
      return html`<span class="role-badge" style="background:var(--bg-muted);color:var(--muted)">无角色</span>`;
    }
    return html`${roles.map(r => {
      const roleName = r.role_name;
      return html`<span class="role-badge ${roleName}">${ROLE_LABELS[roleName] || roleName}</span>`;
    })}`;
  }

  /** Get the label for a role dropdown option */
  private _roleLabel(role: RoleInfo): string {
    return ROLE_LABELS[role.name] || `${role.name}${role.description ? ` - ${role.description}` : ''}`;
  }

  private _formatDate(dateStr: string | null): string {
    if (!dateStr) return "-";
    try {
      return new Date(dateStr).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      return dateStr;
    }
  }

  override render() {
    if (!this.isAdmin) {
      return html`
        <div class="page">
          <app-card variant="default">
            <div slot="header">用户管理</div>
            <div class="no-permission">
              无权限访问此页面，需要 admin 角色
            </div>
          </app-card>
        </div>
      `;
    }

    return html`
      <div class="page">
        <app-card variant="default">
          <div slot="header">
            <span>用户管理</span>
            <button class="btn-primary" @click=${this._openCreateModal}>
              新建用户
            </button>
          </div>

          ${this.error
            ? html`<div class="error-msg">${this.error}</div>`
            : ""}

          ${this.loading
            ? html`<div class="loading" style="flex-direction:column;gap:12px;padding:var(--space-xl);">
                <div class="skeleton-line skeleton-line--long"></div>
                <div class="skeleton-line skeleton-line--long"></div>
                <div class="skeleton-line skeleton-line--long"></div>
                <div class="skeleton-line skeleton-line--long"></div>
                <div class="skeleton-line skeleton-line--long"></div>
              </div>`
            : this.users.length === 0
              ? html`<app-empty-state title="暂无用户数据"></app-empty-state>`
              : html`
                  <div class="table-container">
                    <table class="table">
                      <thead>
                        <tr>
                          <th>用户名</th>
                          <th>邮箱</th>
                          <th style="text-align:center">角色</th>
                          <th style="text-align:center">状态</th>
                          <th style="text-align:center">创建时间</th>
                          <th style="text-align:center">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${this.users.map(
                          (u) => html`
                            <tr>
                              <td><strong>${u.username}</strong></td>
                              <td>${u.email || "-"}</td>
                              <td style="text-align:center">
                                ${this._renderUserRoleBadges(u.id)}
                              </td>
                              <td style="text-align:center">
                                <app-badge variant="${u.status === 'active' ? 'ok' : u.status === 'inactive' ? 'muted' : 'warn'}">
                                  ${STATUS_LABELS[u.status] || u.status}
                                </app-badge>
                              </td>
                              <td style="text-align:center">${this._formatDate(u.created_at)}</td>
                              <td style="text-align:center">
                                <div class="actions">
                                  <button
                                    class="action-btn"
                                    @click=${() => this._openEditModal(u)}
                                  >编辑</button>
                                  <button
                                    class="action-btn"
                                    @click=${() => this._openPasswordModal(u)}
                                  >重置密码</button>
                                  <button
                                    class="action-btn danger"
                                    @click=${() =>
                                      this._deleteUser(u.id, u.username)}
                                  >删除</button>
                                </div>
                              </td>
                            </tr>
                          `
                        )}
                      </tbody>
                    </table>
                  </div>
                `}
        </app-card>

        <!-- Create/Edit Modal -->
        ${this.showModal ? html`
          <app-dialog .open=${true} size="md" title="${this.editingUser ? "编辑用户" : "新建用户"}" @app-dialog-close=${this._closeModal}>
            ${this.saveError ? html`<div class="save-error" style="margin-bottom:8px">${this.saveError}</div>` : ""}
            ${this.formErrors.length > 0 ? html`
              <div class="save-error" style="margin-bottom:8px">${this.formErrors.map((e) => html`<div>${e}</div>`)}</div>
            ` : ""}

            <div class="form-group">
              <label>用户名</label>
              <input type="text" .value=${this.formUsername} @input=${(e: Event) => { this.formUsername = (e.target as HTMLInputElement).value; }} ?disabled=${!!this.editingUser} placeholder=${this.editingUser ? "" : "请输入用户名"} />
            </div>

            <div class="form-group">
              <label>邮箱</label>
              <input type="email" .value=${this.formEmail} @input=${(e: Event) => { this.formEmail = (e.target as HTMLInputElement).value; }} placeholder="可选" />
            </div>

            ${!this.editingUser ? html`
              <div class="form-group">
                <label>密码</label>
                <input type="password" .value=${this.formPassword} @input=${(e: Event) => { this.formPassword = (e.target as HTMLInputElement).value; }} placeholder="至少 8 位" />
              </div>
            ` : ""}

            <div class="form-group">
              <label>角色</label>
              <select @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; this.formRoleId = v ? Number(v) : null; }}>
                <option value="" ?selected=${this.formRoleId === null}>不分配角色</option>
                ${this.allRoles.map((r) => html`<option value=${r.id} ?selected=${this.formRoleId === r.id}>${this._roleLabel(r)}</option>`)}
              </select>
            </div>

            ${this.editingUser ? html`
              <div class="form-group">
                <label>状态</label>
                <select .value=${this.formStatus} @change=${(e: Event) => { this.formStatus = (e.target as HTMLSelectElement).value; }}>
                  <option value="active">活跃</option>
                  <option value="inactive">停用</option>
                  <option value="locked">锁定</option>
                </select>
              </div>
            ` : ""}
            <div slot="footer">
              <button class="btn" @click=${this._closeModal}>取消</button>
              <button class="btn-primary" @click=${this._saveUser} ?disabled=${this.saving}>${this.saving ? "保存中..." : "保存"}</button>
            </div>
          </app-dialog>
        ` : ""}

        <!-- Password Reset Modal -->
        ${this.showPasswordModal ? html`
          <app-dialog .open=${true} size="sm" title="重置密码 - ${this.passwordTarget?.username}" @app-dialog-close=${this._closePasswordModal}>
            ${this.saveError ? html`<div class="save-error" style="margin-bottom:8px">${this.saveError}</div>` : ""}
            ${this.passwordErrors.length > 0 ? html`
              <div class="save-error" style="margin-bottom:8px">${this.passwordErrors.map((e) => html`<div>${e}</div>`)}</div>
            ` : ""}

            <div class="form-group">
              <label>新密码</label>
              <input type="password" .value=${this.newPassword} @input=${(e: Event) => { this.newPassword = (e.target as HTMLInputElement).value; }} placeholder="至少 8 位" />
            </div>

            <div class="form-group">
              <label>确认密码</label>
              <input type="password" .value=${this.confirmPassword} @input=${(e: Event) => { this.confirmPassword = (e.target as HTMLInputElement).value; }} placeholder="再次输入新密码" />
            </div>
            <div slot="footer">
              <button class="btn" @click=${this._closePasswordModal}>取消</button>
              <button class="btn-primary" @click=${this._resetPassword} ?disabled=${this.saving}>${this.saving ? "重置中..." : "确认重置"}</button>
            </div>
          </app-dialog>
        ` : ""}
      </div>
    `;
  }
}
