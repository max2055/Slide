import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { settingsManagementHeaderStyles } from "../../styles/shared-settings-page-styles.ts";
import { customElement, state } from "lit/decorators.js";
import "../components/app-dialog.js";
import "../components/app-card.js";
import "../components/app-badge.js";
import "../components/app-empty-state.js";
import { apiClient } from '../../../api/index.js';
import { showToast } from "../components/app-toast-container.js";
import { settingsBasePath } from "../settings-navigation.ts";

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
  static styles = [sharedFieldStyles, sharedBtnStyles, settingsManagementHeaderStyles, css`
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
      color: var(--danger);
    }

    .role-badge.dba {
      background: rgba(59, 130, 246, 0.12);
      color: var(--info);
    }

    .role-badge.developer {
      background: rgba(34, 197, 94, 0.12);
      color: var(--ok);
    }

    .role-badge.analyst {
      background: rgba(168, 85, 247, 0.12);
      color: color-mix(in srgb, #a855f7 55%, var(--text-strong));
    }

    .role-badge.viewer {
      background: rgba(139, 139, 145, 0.12);
      color: var(--muted);
    }

    .role-badge.auditor {
      background: rgba(245, 158, 11, 0.12);
      color: var(--warn);
    }


    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .loading, .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: var(--muted);
    }

    .permission-actions {
      text-align: center;
      padding: 0 var(--space-xl) var(--space-xl);
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

    .form-group input[type="checkbox"] { width: auto; }

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
  @state() private checkingAdmin = true;
  private permissionRevision = 0;
  private readonly sessionExpiredHandler = () => {
    this.permissionRevision++;
    this.isAdmin = false;
    this.checkingAdmin = false;
    this.error = '未登录';
  };
  @state() private userRoles: Map<number, UserRoleBinding[]> = new Map();
  @state() private allRoles: RoleInfo[] = [];
  @state() private showModal = false;
  @state() private editingUser: UserInfo | null = null;
  @state() private createdUserId: number | null = null;
  @state() private showPasswordModal = false;
  @state() private passwordTarget: UserInfo | null = null;
  @state() private saving = false;
  @state() private saveError: string | null = null;

  // Form state
  @state() private formUsername = "";
  @state() private formEmail = "";
  @state() private formPassword = "";
  @state() private formRoleId: number | null = null;
  @state() private formRoleIds: number[] = [];
  @state() private formStatus = "active";
  @state() private formErrors: string[] = [];

  // Password reset form state
  @state() private newPassword = "";
  @state() private confirmPassword = "";
  @state() private passwordErrors: string[] = [];

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-session-expired', this.sessionExpiredHandler);
    void this._checkAdmin();
  }

  override disconnectedCallback() {
    this.permissionRevision++;
    this.isAdmin = false;
    window.removeEventListener('slide-session-expired', this.sessionExpiredHandler);
    super.disconnectedCallback();
  }

  private async _checkAdmin() {
    const revision = ++this.permissionRevision;
    const session = apiClient.getSessionContext();
    this.isAdmin = false;
    this.checkingAdmin = true;
    this.error = null;
    const isCurrent = () => this.isConnected && revision === this.permissionRevision
      && session === apiClient.getSessionContext();
    if (!apiClient.getToken()) {
      this.error = '未登录';
      this.checkingAdmin = false;
      return;
    }
    try {
      await apiClient.get("/v1/rbac/roles");
      if (!isCurrent()) return;
      this.isAdmin = true;
      void this._init();
    } catch (e: unknown) {
      if (!isCurrent()) return;
      this.isAdmin = false;
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("HTTP 403")) {
        // A confirmed denial is distinct from an unavailable permission check.
      } else if (message.startsWith("HTTP 401")) {
        this.error = "未登录";
      } else {
        this.error = `权限检查失败: ${message}`;
      }
    } finally {
      if (revision === this.permissionRevision) {
        this.checkingAdmin = false;
        if (this.isConnected && !isCurrent()) this.error = '权限检查失败: 登录状态已变化，请重新检查权限';
      }
    }
  }

  private async _init() {
    await Promise.all([this._loadUsers(), this._loadAllRoles()]);
  }

  private accessGuard() {
    const revision = this.permissionRevision;
    const session = apiClient.getSessionContext();
    return () => this.isConnected && this.isAdmin && revision === this.permissionRevision
      && session === apiClient.getSessionContext();
  }

  private async _loadAllRoles() {
    const isCurrent = this.accessGuard();
    try {
      const roles = await apiClient.get<RoleInfo[]>("/v1/rbac/roles");
      if (isCurrent()) this.allRoles = roles;
    } catch (_) {
      // non-critical; dropdown will fall back to hardcoded labels
    }
  }

  private async _loadUsers() {
    const isCurrent = this.accessGuard();
    this.loading = true;
    this.error = null;
    try {
      const data = await apiClient.get<UserInfo[]>('/users');
      if (!isCurrent()) return;
      this.users = Array.isArray(data) ? data : [];
      await this._loadUserRoles();
    } catch (e: any) {
      if (!isCurrent()) return;
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
      if (isCurrent()) this.loading = false;
    }
  }

  private async _loadUserRoles() {
    const isCurrent = this.accessGuard();
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
    if (isCurrent()) this.userRoles = newMap;
  }

  private _navigateToRbac(userId: number) {
    const url = new URL(window.location.href);
    url.pathname = `${settingsBasePath(window.location.pathname)}/settings/access/users`;
    url.searchParams.set("view", "roles");
    url.searchParams.set("userId", String(userId));
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  // Modal handling
  private _openCreateModal() {
    this.editingUser = null;
    this.createdUserId = null;
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
    this.createdUserId = null;
    this.editingUser = user;
    this.formUsername = user.username;
    this.formEmail = user.email || "";
    this.formPassword = "";
    const roles = this.userRoles.get(user.id) || [];
    this.formRoleIds = roles.map(r => r.role_id);
    this.formStatus = user.status;
    this.formErrors = [];
    this.saveError = null;
    this.showModal = true;
  }

  private _closeModal() {
    if (this.saving) return;
    this.createdUserId = null;
    this.showModal = false;
    this.editingUser = null;
    this.formErrors = [];
    this.saveError = null;
  }

  private async _saveUser() {
    if (this.saving) return;
    this.formErrors = [];
    this.saveError = null;

    // Validation
    if (this.editingUser) {
      // Edit mode
    } else if (this.createdUserId === null) {
      // Create mode: username and password required
      if (!this.formUsername.trim()) {
        this.formErrors.push("用户名不能为空");
      }
      if (this.formPassword.length < 8) {
        this.formErrors.push("密码长度至少 8 位");
      }
    }

    if (this.createdUserId !== null && this.formRoleId === null) this.formErrors.push("用户已创建，请选择要绑定的角色");
    if (this.formErrors.length > 0) return;

    this.saving = true;

    try {
      if (this.editingUser) {
        const userId = this.editingUser.id;
        // Update user status
        const body: Record<string, string> = { status: this.formStatus, email: this.formEmail };
        await apiClient.put(`/users/${userId}`, body);

        // Sync role via RBAC API
        await this._syncUserRoles(userId, this.formRoleIds);
      } else {
        if (this.createdUserId === null) {
          const body: Record<string, string> = {
            username: this.formUsername.trim(),
            password: this.formPassword,
          };
          if (this.formEmail) body.email = this.formEmail;
          const result = await apiClient.post<{ success: boolean; userId?: number; error?: string }>('/users', body);
          if (!result?.success || !result.userId) throw new Error(result?.error || '创建用户未返回用户 ID');
          this.createdUserId = result.userId;
          this.formPassword = "";
        }
        if (this.formRoleId !== null) {
          try {
            const rolesUrl = ["/v1/rbac/users", this.createdUserId, "roles"].join("/");
            const result = await apiClient.post<{ success: boolean; error?: string }>(rolesUrl, { roleId: this.formRoleId });
            if (!result?.success) throw new Error(result?.error || '角色绑定失败');
          } catch (roleErr: any) {
            this.saveError = `用户已创建（ID：${this.createdUserId}），角色未绑定：${roleErr.message}。请重试绑定，无需重新创建用户。`;
            return;
          }
        }
      }

      this.saving = false;
      this._closeModal();
      await this._loadUsers();
    } catch (e: any) {
      this.saveError = `操作失败: ${e.message}`;
    } finally {
      this.saving = false;
    }
  }

  /** Preserve unchanged bindings, including their expiry metadata. */
  private async _syncUserRoles(userId: number, selectedRoleIds: number[]) {
    const expectedRoleIds = (this.userRoles.get(userId) || []).map(r => r.role_id);
    if (expectedRoleIds.length === selectedRoleIds.length && expectedRoleIds.every(id => selectedRoleIds.includes(id))) return;
    const res = await apiClient.put<{ success: boolean; error?: string }>(`/v1/rbac/users/${userId}/roles`, {
      roleIds: selectedRoleIds, expectedRoleIds,
    });
    if (!res?.success) throw new Error(res?.error || '角色保存失败');
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
      return html`<app-badge variant="muted">无角色</app-badge>`;
    }
    return html`${roles.map(r => {
      const roleName = r.role_name;
      return html`<app-badge variant="muted">${ROLE_LABELS[roleName] || roleName}</app-badge>`;
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
          <div class="page-header">
            <h1>用户管理</h1>
          </div>
          <app-card variant="default">
            <div role="status" aria-busy=${this.checkingAdmin}>
              <app-empty-state icon="lock"
                title=${this.checkingAdmin ? '正在检查权限' : this.error || '无权限访问此页面，需要 admin 角色'}
                description=${this.checkingAdmin ? '确认权限后加载用户数据。' : this.error === '未登录' ? '请登录后重新检查权限。' : ''}
              ></app-empty-state>
              ${this.checkingAdmin ? '' : html`<div class="permission-actions"><button class="btn" type="button" @click=${() => void this._checkAdmin()}>重新检查权限</button></div>`}
            </div>
          </app-card>
        </div>
      `;
    }

    return html`
      <div class="page">
        <div class="page-header">
          <h1>用户管理</h1>
          <button class="btn-primary" type="button" @click=${this._openCreateModal}>
            新建用户
          </button>
        </div>
        <app-card variant="default">
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
                                    class="btn-sm"
                                    @click=${() => this._openEditModal(u)}
                                  >编辑</button>
                                  <button
                                    class="btn-sm"
                                    @click=${() => this._openPasswordModal(u)}
                                  >重置密码</button>
                                  <button
                                    class="btn-sm danger"
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
          <app-dialog .open=${true} size="md" .closeOnOverlay=${false} .closable=${!this.saving} title="${this.editingUser ? "编辑用户" : "新建用户"}" @app-dialog-close=${this._closeModal}>
            ${this.saveError ? html`<div class="save-error" style="margin-bottom:8px">${this.saveError}</div>` : ""}
            ${this.formErrors.length > 0 ? html`
              <div class="save-error" style="margin-bottom:8px">${this.formErrors.map((e) => html`<div>${e}</div>`)}</div>
            ` : ""}

            <div class="form-group">
              <label>用户名</label>
              <input type="text" aria-label="用户名" autocomplete="off" .value=${this.formUsername} @input=${(e: Event) => { this.formUsername = (e.target as HTMLInputElement).value; }} ?disabled=${!!this.editingUser || this.createdUserId !== null || this.saving} placeholder=${this.editingUser ? "" : "请输入用户名"} />
            </div>

            <div class="form-group">
              <label>邮箱</label>
              <input type="email" ?disabled=${this.createdUserId !== null || this.saving} aria-label="邮箱" autocomplete="off" .value=${this.formEmail} @input=${(e: Event) => { this.formEmail = (e.target as HTMLInputElement).value; }} placeholder="可选" />
            </div>

            ${!this.editingUser && this.createdUserId === null ? html`
              <div class="form-group">
                <label>密码</label>
                <input type="password" aria-label="密码" ?disabled=${this.saving} autocomplete="new-password" .value=${this.formPassword} @input=${(e: Event) => { this.formPassword = (e.target as HTMLInputElement).value; }} placeholder="至少 8 位" />
              </div>
            ` : ""}

            ${this.editingUser ? html`
              <fieldset class="form-group" ?disabled=${this.saving}>
                <legend>角色（可多选）</legend>
                ${Array.from(new Map([
                  ...(this.userRoles.get(this.editingUser.id) || []).map(r => [r.role_id, { id: r.role_id, name: r.role_name, description: null }] as const),
                  ...this.allRoles.map(r => [r.id, r] as const),
                ]).values()).map(r => html`
                  <label>
                    <input type="checkbox" .checked=${this.formRoleIds.includes(r.id)}
                      @change=${(e: Event) => {
                        this.formRoleIds = (e.target as HTMLInputElement).checked
                          ? [...this.formRoleIds, r.id]
                          : this.formRoleIds.filter(id => id !== r.id);
                      }} />
                    ${this._roleLabel(r)}
                  </label>
                `)}
                ${this.formRoleIds.length === 0 ? html`<span>不分配角色</span>` : ""}
              </fieldset>
            ` : html`
            <div class="form-group">
              <label>角色</label>
              <select aria-label="角色" ?disabled=${this.saving} @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; this.formRoleId = v ? Number(v) : null; }}>
                <option value="" ?selected=${this.formRoleId === null}>不分配角色</option>
                ${this.allRoles.map((r) => html`<option value=${r.id} ?selected=${this.formRoleId === r.id}>${this._roleLabel(r)}</option>`)}
              </select>
            </div>
            `}

            ${this.editingUser ? html`
              <div class="form-group">
                <label for="user-status">状态</label>
                <select id="user-status" ?disabled=${this.saving} .value=${this.formStatus} @change=${(e: Event) => { this.formStatus = (e.target as HTMLSelectElement).value; }}>
                  <option value="active">活跃</option>
                  <option value="inactive">停用</option>
                  <option value="locked">锁定</option>
                </select>
              </div>
            ` : ""}
            <div slot="footer">
              <button class="btn" ?disabled=${this.saving} @click=${this._closeModal}>取消</button>
              <button class="btn-primary" @click=${this._saveUser} ?disabled=${this.saving}>${this.saving ? "保存中..." : this.createdUserId !== null ? "重试绑定" : "保存"}</button>
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
