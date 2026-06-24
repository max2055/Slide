import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import { apiClient } from '../../../api/index.js';
import "../components/app-dialog.js";
import "../components/app-form-field.js";

/* ───────── Types ───────── */

interface Role {
  id: number;
  name: string;
  description: string | null;
  permission_count?: number;
  user_count?: number;
}

interface Permission {
  id: number;
  code: string;
  name: string;
  resource: string;
  action: string;
  description: string | null;
}

interface UserInfo {
  id: number;
  username: string;
  email: string | null;
}

type RbacSubTab = "roles" | "permissions";

/* ───────── Parent: RbacAdminPage ───────── */

@customElement("rbac-admin-page")
export class RbacAdminPage extends LitElement {
  @state() private activeSubTab: RbacSubTab = "roles";
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private hasAccess = false;

  static styles = [sharedBtnStyles, css`
    :host { display: block; animation: fade-in 0.25s var(--ease-out); }
    @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

    .loading { display: flex; align-items: center; justify-content: center; min-height: 300px; color: var(--muted); }
    .error-msg { color: var(--danger); font-size: var(--text-base); padding: var(--space-md) var(--space-lg); background: var(--danger-subtle); border-radius: var(--radius-sm); margin: 12px 16px; }
    .no-permission { display: flex; align-items: center; justify-content: center; min-height: 300px; color: var(--muted); font-size: var(--text-md); }

    .sub-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: var(--space-xl);
      background: var(--card);
      border-radius: var(--radius) var(--radius) 0 0;
      overflow: hidden;
    }

    .sub-tab {
      padding: var(--space-md) var(--space-xl);
      border: none;
      background: transparent;
      color: var(--muted);
      font-size: var(--text-base);
      font-weight: 500;
      cursor: pointer;
      position: relative;
      transition: color var(--duration-fast) var(--ease-out);
    }

    .sub-tab:hover { color: var(--text); background: var(--bg-hover); }
    .sub-tab--active {
      color: var(--accent);
      font-weight: 600;
    }
    .sub-tab--active::after {
      content: "";
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--accent);
    }

    /* Shared card/table/modal styles */
    .page { padding: 0; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
    .card-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); flex-wrap: wrap; gap: var(--space-md); }
    .card-title { font-size: var(--text-lg); font-weight: 600; letter-spacing: -0.02em; color: var(--text-strong); }

    .table-container { overflow-x: auto; }
    .table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--text-base); }
    .table th { position: sticky; top: 0; z-index: 3; padding: var(--space-md) var(--space-md); text-align: left; font-weight: 600; font-size: var(--text-xs); color: var(--muted); background: var(--bg-elevated); border-bottom: 1px solid var(--border); white-space: nowrap; text-transform: uppercase; letter-spacing: 0.04em; }
    .table td { padding: 14px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; }
    .table tbody tr { transition: background var(--duration-fast) ease; }
    .table tbody tr:hover { background: var(--bg-hover); }
    .table tbody tr:last-child td { border-bottom: none; }

    .actions { display: flex; gap: var(--space-sm); flex-wrap: wrap; }
    .action-btn { display: inline-flex; align-items: center; justify-content: center; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-xs); font-weight: 500; color: var(--text); background: var(--secondary); cursor: pointer; transition: all var(--duration-normal) var(--ease-out); }
    .action-btn:hover { background: var(--accent); color: var(--accent-foreground); border-color: var(--accent); }
    .action-btn.danger:hover { background: var(--danger); color: var(--danger-foreground); border-color: var(--danger); }

    .empty { display: flex; align-items: center; justify-content: center; min-height: 200px; color: var(--muted); font-size: var(--text-base); padding: 40px 20px; text-align: center; }

    .form-group { display: grid; gap: var(--space-sm); }
    .form-group label { font-size: var(--text-sm); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .form-group input, .form-group select, .form-group textarea { padding: var(--space-sm) var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-base); color: var(--text); background: var(--card); transition: all var(--duration-normal) var(--ease-out); }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
    .form-group textarea { min-height: 80px; resize: vertical; }
    .form-error { font-size: var(--text-sm); color: var(--danger); margin-top: var(--space-xs); }
    .save-error { color: var(--danger); font-size: var(--text-base); padding: var(--space-sm) var(--space-md); background: var(--danger-subtle); border-radius: var(--radius-sm); }

    /* Accordion for permission groups */
    .perm-group { border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: var(--space-sm); overflow: hidden; }
    .perm-group summary { padding: var(--space-md) var(--space-md); cursor: pointer; font-weight: 600; font-size: var(--text-base); color: var(--text); background: var(--bg-elevated); }
    .perm-group summary:hover { background: var(--bg-hover); }
    .perm-group-content { padding: var(--space-sm) var(--space-md) var(--space-md); }
    .perm-checkbox { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-xs) 0; font-size: var(--text-base); }
    .perm-checkbox input { accent-color: var(--accent); }
    .perm-checkbox label { cursor: pointer; flex: 1; }
    .perm-code { font-size: var(--text-xs); color: var(--muted); }

    .count-badge { font-size: var(--text-xs); font-weight: 500; color: var(--muted); margin-left: 8px; }
  `];

  override async firstUpdated() {
    // Check admin access by attempting to load roles
    this.loading = true;
    try {
      await apiClient.get("/v1/rbac/roles");
      this.hasAccess = true;
    } catch (e: any) {
      this.hasAccess = false;
      if (e.message?.startsWith("HTTP 403")) {
        this.error = "无权限访问 RBAC 管理功能。需要 admin 角色。";
      } else {
        this.error = `网络错误: ${e.message}。请检查网络连接后重试。`;
      }
    } finally {
      this.loading = false;
    }
  }

  private _switchSubTab(tab: RbacSubTab) {
    this.activeSubTab = tab;
  }

  override render() {
    if (this.loading) {
      return html`<div class="loading">加载中...</div>`;
    }
    if (!this.hasAccess) {
      return html`<div class="no-permission">${this.error}</div>`;
    }

    const subTabs: { key: RbacSubTab; label: string }[] = [
      { key: "roles", label: "角色管理" },
      { key: "permissions", label: "权限管理" },
    ];

    return html`
      <div class="page">
        <div class="sub-tabs">
          ${subTabs.map(
            (st) => html`
              <button
                class="sub-tab ${st.key === this.activeSubTab ? "sub-tab--active" : ""}"
                @click=${() => this._switchSubTab(st.key)}
              >
                ${st.label}
              </button>
            `
          )}
        </div>

        ${this.activeSubTab === "roles"
          ? html`<role-management-tab></role-management-tab>`
          : ""}
        ${this.activeSubTab === "permissions"
          ? html`<permission-management-tab></permission-management-tab>`
          : ""}
      </div>
    `;
  }
}

/* ───────── RoleManagementTab ───────── */

@customElement("role-management-tab")
export class RoleManagementTab extends LitElement {
  @state() private roles: Role[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;

  // Create/Edit modal
  @state() private showFormModal = false;
  @state() private editingRole: Role | null = null;
  @state() private formName = "";
  @state() private formDescription = "";
  @state() private saving = false;
  @state() private saveError: string | null = null;

  // Permission edit modal
  @state() private showPermModal = false;
  @state() private permRoleId: number | null = null;
  @state() private permRoleName = "";
  @state() private allPermissions: Permission[] = [];
  @state() private checkedPermIds: Set<number> = new Set();
  @state() private savedPermIds: Set<number> = new Set();
  @state() private permLoading = false;
  @state() private permSaving = false;
  @state() private permError: string | null = null;

  static styles = RbacAdminPage.styles;

  override async firstUpdated() {
    await this._loadRoles();
  }

  private async _loadRoles() {
    this.loading = true;
    this.error = null;
    try {
      this.roles = await apiClient.get<Role[]>("/v1/rbac/roles");
    } catch (e: any) {
      this.error = `加载失败：${e.message}。请刷新页面重试。`;
    } finally {
      this.loading = false;
    }
  }

  /* ─── Create/Edit Role ─── */

  private _openCreateModal() {
    this.editingRole = null;
    this.formName = "";
    this.formDescription = "";
    this.saveError = null;
    this.showFormModal = true;
  }

  private _openEditModal(role: Role) {
    this.editingRole = role;
    this.formName = role.name;
    this.formDescription = role.description || "";
    this.saveError = null;
    this.showFormModal = true;
  }

  private _closeFormModal() {
    this.showFormModal = false;
    this.editingRole = null;
    this.saveError = null;
  }

  private async _saveRole() {
    if (!this.formName.trim()) {
      this.saveError = "角色名称不能为空";
      return;
    }
    this.saving = true;
    this.saveError = null;
    try {
      const isEdit = this.editingRole;
      const url = isEdit
        ? `/v1/rbac/roles/${this.editingRole!.id}`
        : "/v1/rbac/roles";
      const body = {
        name: this.formName.trim(),
        description: this.formDescription.trim() || undefined,
      };
      if (isEdit) {
        await apiClient.put(url, body);
      } else {
        await apiClient.post(url, body);
      }
      this._closeFormModal();
      await this._loadRoles();
    } catch (e: any) {
      this.saveError = e.message;
    } finally {
      this.saving = false;
    }
  }

  /* ─── Delete Role ─── */

  private async _deleteRole(role: Role) {
    if (!window.confirm(`确定删除角色「${role.name}」？删除后不可恢复。该角色的所有权限关联将被移除。`))
      return;
    try {
      await apiClient.delete(`/v1/rbac/roles/${role.id}`);
      await this._loadRoles();
    } catch (e: any) {
      this.error = `删除失败：${e.message}`;
    }
  }

  /* ─── Edit Permissions Modal ─── */

  private async _openPermModal(role: Role) {
    this.permRoleId = role.id;
    this.permRoleName = role.name;
    this.permError = null;
    this.permLoading = true;
    this.showPermModal = true;
    try {
      const [allPerms, rolePerms] = await Promise.all([
        apiClient.get<Permission[]>("/v1/rbac/permissions"),
        apiClient.get<Permission[]>(`/v1/rbac/roles/${role.id}/permissions`),
      ]);
      this.allPermissions = allPerms;
      const granted = new Set(rolePerms.map((p) => p.id));
      this.checkedPermIds = new Set(granted);
      this.savedPermIds = new Set(granted);
    } catch (e: any) {
      this.permError = `加载权限失败：${e.message}`;
    } finally {
      this.permLoading = false;
    }
  }

  private _closePermModal() {
    this.showPermModal = false;
    this.permRoleId = null;
    this.allPermissions = [];
    this.checkedPermIds = new Set();
    this.savedPermIds = new Set();
    this.permError = null;
  }

  private _togglePerm(permId: number) {
    const next = new Set(this.checkedPermIds);
    if (next.has(permId)) {
      next.delete(permId);
    } else {
      next.add(permId);
    }
    this.checkedPermIds = next;
  }

  private async _savePermissions() {
    if (this.permRoleId === null) return;
    this.permSaving = true;
    this.permError = null;
    const roleId = this.permRoleId;
    try {
      const toGrant = [...this.checkedPermIds].filter(
        (id) => !this.savedPermIds.has(id)
      );
      const toRevoke = [...this.savedPermIds].filter(
        (id) => !this.checkedPermIds.has(id)
      );
      for (const permId of toGrant) {
        await apiClient.post(`/v1/rbac/roles/${roleId}/permissions`, { permissionId: permId });
      }
      for (const permId of toRevoke) {
        await apiClient.delete(`/v1/rbac/roles/${roleId}/permissions/${permId}`);
      }
      this._closePermModal();
      await this._loadRoles();
    } catch (e: any) {
      this.permError = `保存权限失败：${e.message}`;
    } finally {
      this.permSaving = false;
    }
  }

  private _groupByResource(permissions: Permission[]): Map<string, Permission[]> {
    const grouped = new Map<string, Permission[]>();
    for (const p of permissions) {
      const list = grouped.get(p.resource) || [];
      list.push(p);
      grouped.set(p.resource, list);
    }
    return grouped;
  }

  private _permCountForResource(resource: string): number {
    const perms = this.allPermissions.filter((p) => p.resource === resource);
    const checked = perms.filter((p) => this.checkedPermIds.has(p.id));
    return checked.length;
  }

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error) return html`<div class="error-msg">${this.error}</div>`;

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">角色列表</span>
          <button class="btn primary" @click=${this._openCreateModal}>＋ 新建角色</button>
        </div>
        ${this._renderFormModal()}
        ${this._renderPermModal()}
        ${this.roles.length === 0
          ? html`<div class="empty">暂无角色数据。点击"新建角色"创建第一个角色。</div>`
          : html`
              <div class="table-container">
                <table class="table">
                  <thead>
                    <tr>
                      <th>角色名称</th>
                      <th>描述</th>
                      <th>权限数</th>
                      <th>用户数</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.roles.map(
                      (role) => html`
                        <tr>
                          <td style="font-weight:500">${role.name}</td>
                          <td style="color:var(--muted)">${role.description || "-"}</td>
                          <td>${role.permission_count ?? 0}</td>
                          <td>${role.user_count ?? 0}</td>
                          <td>
                            <div class="actions">
                              <button class="action-btn" @click=${() => this._openEditModal(role)}>编辑</button>
                              <button class="action-btn" @click=${() => this._openPermModal(role)}>编辑权限</button>
                              <button class="action-btn danger" @click=${() => this._deleteRole(role)}>删除</button>
                            </div>
                          </td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            `}
      </div>
    `;
  }

  private _renderFormModal() {
    if (!this.showFormModal) return nothing;
    const isEdit = !!this.editingRole;
    return html`
      <app-dialog .open=${true} size="md" title="${isEdit ? '编辑角色' : '新建角色'}" @app-dialog-close=${this._closeFormModal}>
        ${this.saveError
          ? html`<div class="save-error">${this.saveError}</div>`
          : ""}
        <app-form-field label="角色名称" required>
          <input .value=${this.formName} @input=${(e: any) => (this.formName = e.target.value)} placeholder="如：高级 DBA" />
        </app-form-field>
        <app-form-field label="描述">
          <textarea .value=${this.formDescription} @input=${(e: any) => (this.formDescription = e.target.value)} placeholder="可选角色说明"></textarea>
        </app-form-field>
        <div slot="footer">
          <button class="btn" @click=${this._closeFormModal}>取消</button>
          <button class="btn primary" @click=${this._saveRole} ?disabled=${this.saving}>
            ${this.saving ? "保存中..." : "保存"}
          </button>
        </div>
      </app-dialog>
    `;
  }

  private _renderPermModal() {
    if (!this.showPermModal) return nothing;
    return html`
      <app-dialog .open=${true} size="lg" title="编辑权限 - ${this.permRoleName}" @app-dialog-close=${this._closePermModal}>
        ${this.permError
          ? html`<div class="save-error">${this.permError}</div>`
          : ""}
        ${this.permLoading
          ? html`<div class="empty">加载中...</div>`
          : this.allPermissions.length === 0
            ? html`<div class="empty">暂无权限数据。</div>`
            : html`
                ${[...this._groupByResource(this.allPermissions).entries()].map(
                  ([resource, perms]) => html`
                    <details class="perm-group">
                      <summary>
                        ${resource}
                        <span class="count-badge"
                          >已选 ${this._permCountForResource(resource)}/${perms.length}</span
                        >
                      </summary>
                      <div class="perm-group-content">
                        ${perms.map(
                          (p) => html`
                            <div class="perm-checkbox">
                              <input
                                type="checkbox"
                                .checked=${this.checkedPermIds.has(p.id)}
                                @change=${() => this._togglePerm(p.id)}
                                id="perm-${p.id}"
                              />
                              <label for="perm-${p.id}">
                                <div>${p.name}</div>
                                <div class="perm-code">${p.code}</div>
                              </label>
                            </div>
                          `
                        )}
                      </div>
                    </details>
                  `
                )}
              `}
        <div slot="footer">
          <button class="btn" @click=${this._closePermModal}>取消</button>
          <button
            class="btn primary"
            @click=${this._savePermissions}
            ?disabled=${this.permSaving || this.permLoading}
          >
            ${this.permSaving ? "保存中..." : "保存权限"}
          </button>
        </div>
      </app-dialog>
    `;
  }
}

/* ───────── PermissionManagementTab ───────── */

@customElement("permission-management-tab")
export class PermissionManagementTab extends LitElement {
  @state() private permissions: Permission[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;

  // Create modal
  @state() private showModal = false;
  @state() private formCode = "";
  @state() private formName = "";
  @state() private formResource = "";
  @state() private formAction = "";
  @state() private formDescription = "";
  @state() private formCodeError = "";
  @state() private saving = false;
  @state() private saveError: string | null = null;

  static styles = RbacAdminPage.styles;

  override async firstUpdated() {
    await this._loadPermissions();
  }

  private async _loadPermissions() {
    this.loading = true;
    this.error = null;
    try {
      this.permissions = await apiClient.get<Permission[]>("/v1/rbac/permissions");
    } catch (e: any) {
      this.error = `加载失败：${e.message}。请刷新页面重试。`;
    } finally {
      this.loading = false;
    }
  }

  /* ─── Create ─── */

  private _openCreateModal() {
    this.formCode = "";
    this.formName = "";
    this.formResource = "";
    this.formAction = "";
    this.formDescription = "";
    this.formCodeError = "";
    this.saveError = null;
    this.showModal = true;
  }

  private _closeModal() {
    this.showModal = false;
    this.formCodeError = "";
    this.saveError = null;
  }

  private _validateCode(code: string): boolean {
    return /^[a-z_]+:[a-z_]+$/.test(code);
  }

  private async _savePermission() {
    // Validate
    let hasError = false;
    this.formCodeError = "";
    this.saveError = null;

    if (!this.formCode.trim()) {
      this.formCodeError = "权限码不能为空";
      hasError = true;
    } else if (!this._validateCode(this.formCode.trim())) {
      this.formCodeError =
        "权限码格式错误，需要遵循 resource:action 格式（如 instance:list）";
      hasError = true;
    }

    if (hasError) return;

    this.saving = true;
    try {
      const [resource, action] = this.formCode.trim().split(":");
      await apiClient.post("/v1/rbac/permissions", {
        code: this.formCode.trim(),
        name: this.formName.trim() || this.formCode.trim(),
        resource,
        action,
        description: this.formDescription.trim() || undefined,
      });
      this._closeModal();
      await this._loadPermissions();
    } catch (e: any) {
      this.saveError = e.message;
    } finally {
      this.saving = false;
    }
  }

  /* ─── Delete ─── */

  private async _deletePermission(perm: Permission) {
    if (
      !window.confirm(
        `确定删除权限「${perm.code}」？删除后不可恢复。已分配此权限的角色将失去该权限。`
      )
    )
      return;
    try {
      await apiClient.delete(`/v1/rbac/permissions/${perm.id}`);
      await this._loadPermissions();
    } catch (e: any) {
      this.error = `删除失败：${e.message}`;
    }
  }

  private _handleCodeInput(e: any) {
    this.formCode = e.target.value;
    if (this.formCode.trim() && !this._validateCode(this.formCode.trim())) {
      this.formCodeError =
        "权限码格式错误，需要遵循 resource:action 格式（如 instance:list）";
    } else {
      this.formCodeError = "";
    }
  }

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error) return html`<div class="error-msg">${this.error}</div>`;

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">权限列表</span>
          <button class="btn primary" @click=${this._openCreateModal}>＋ 新建权限</button>
        </div>
        ${this._renderModal()}
        ${this.permissions.length === 0
          ? html`<div class="empty">暂无权限数据。点击"新建权限"创建第一个权限。</div>`
          : html`
              <div class="table-container">
                <table class="table">
                  <thead>
                    <tr>
                      <th>权限码</th>
                      <th>名称</th>
                      <th>资源类型</th>
                      <th>操作</th>
                      <th>描述</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.permissions.map(
                      (perm) => html`
                        <tr>
                          <td><code style="font-size:12px;background:var(--bg-elevated);padding:2px 6px;border-radius:3px">${perm.code}</code></td>
                          <td>${perm.name}</td>
                          <td>${perm.resource}</td>
                          <td>${perm.action}</td>
                          <td style="color:var(--muted)">${perm.description || "-"}</td>
                          <td>
                            <div class="actions">
                              <button class="action-btn danger" @click=${() => this._deletePermission(perm)}>删除</button>
                            </div>
                          </td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            `}
      </div>
    `;
  }

  private _renderModal() {
    if (!this.showModal) return nothing;
    return html`
      <div
        class="modal-overlay"
        @click=${(e: Event) => {
          if ((e.target as HTMLElement).classList.contains("modal-overlay"))
            this._closeModal();
        }}
      >
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">新建权限</span>
            <button class="modal-close" @click=${this._closeModal}>×</button>
          </div>
          <div class="modal-body">
            ${this.saveError
              ? html`<div class="save-error">${this.saveError}</div>`
              : ""}
            <div class="form-group">
              <label>权限码</label>
              <input
                .value=${this.formCode}
                @input=${this._handleCodeInput}
                placeholder="resource:action（如 instance:list）"
              />
              ${this.formCodeError
                ? html`<div class="form-error">${this.formCodeError}</div>`
                : ""}
            </div>
            <div class="form-group">
              <label>名称</label>
              <input
                .value=${this.formName}
                @input=${(e: any) => (this.formName = e.target.value)}
                placeholder="如：查看实例列表"
              />
            </div>
            <div class="form-group">
              <label>描述</label>
              <textarea
                .value=${this.formDescription}
                @input=${(e: any) => (this.formDescription = e.target.value)}
                placeholder="可选描述"
              ></textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click=${this._closeModal}>取消</button>
            <button
              class="btn primary"
              @click=${this._savePermission}
              ?disabled=${this.saving}
            >
              ${this.saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

/* ───────── InstancePermissionsTab ───────── */

interface DbInstance {
  id: number;
  name: string;
}

@customElement("instance-permissions-tab")
export class InstancePermissionsTab extends LitElement {
  @state() private users: UserInfo[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;

  // Modal state
  @state() private showModal = false;
  @state() private modalUserId: number | null = null;
  @state() private modalUserName = "";
  @state() private allInstances: DbInstance[] = [];
  @state() private grantedInstanceIds: Set<number> = new Set();
  @state() private savedGrantedIds: Set<number> = new Set();
  @state() private instanceFilter = "";
  @state() private loadingInstances = false;
  @state() private saving = false;
  @state() private saveError: string | null = null;

  static styles = [
    RbacAdminPage.styles,
    css`
      .instance-search {
        width: 100%;
        padding: var(--space-sm) var(--space-md);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-size: var(--text-base);
        color: var(--text);
        background: var(--card);
        outline: none;
        box-sizing: border-box;
        margin-bottom: var(--space-md);
      }
      .instance-search:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-subtle);
      }
      .instance-list {
        max-height: 300px;
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-xs) 0;
      }
      .instance-check-row {
        display: flex;
        align-items: center;
        gap: var(--space-sm);
        padding: var(--space-sm) var(--space-md);
        font-size: var(--text-base);
      }
      .instance-check-row:hover {
        background: var(--bg-hover);
      }
      .instance-check-row input {
        accent-color: var(--accent);
      }
      .instance-check-row label {
        cursor: pointer;
        flex: 1;
      }
      .save-error {
        color: var(--danger);
        font-size: var(--text-base);
        padding: var(--space-sm) var(--space-md);
        background: var(--danger-subtle);
        border-radius: var(--radius-sm);
      }
    `,
  ];

  override async firstUpdated() {
    await this._loadUsers();
  }

  private async _loadUsers() {
    this.loading = true;
    this.error = null;
    try {
      const data = await apiClient.get<UserInfo[]>("/users");
      this.users = Array.isArray(data) ? data : [];
    } catch (e: any) {
      this.error = `加载用户失败：${e.message}。请刷新页面重试。`;
    } finally {
      this.loading = false;
    }
  }

  private async _openModal(user: UserInfo) {
    this.modalUserId = user.id;
    this.modalUserName = user.username;
    this.saveError = null;
    this.instanceFilter = "";
    this.loadingInstances = true;
    this.showModal = true;
    try {
      const [instances, granted] = await Promise.all([
        apiClient.get<DbInstance[]>("/database/instances"),
        apiClient.get<number[] | DbInstance[]>(
          `/v1/rbac/users/${user.id}/instances`
        ),
      ]);
      this.allInstances = Array.isArray(instances)
        ? instances
        : (instances as any).instances || [];
      // Sort instances by name
      this.allInstances.sort((a, b) => a.name.localeCompare(b.name));
      // granted can be array of IDs or array of objects with id field
      const grantedIds: number[] = Array.isArray(granted)
        ? granted.map((g: any) => (typeof g === "number" ? g : g.id))
        : [];
      this.grantedInstanceIds = new Set(grantedIds);
      this.savedGrantedIds = new Set(grantedIds);
    } catch (e: any) {
      this.saveError = `加载实例数据失败：${e.message}`;
    } finally {
      this.loadingInstances = false;
    }
  }

  private _closeModal() {
    this.showModal = false;
    this.modalUserId = null;
    this.modalUserName = "";
    this.allInstances = [];
    this.grantedInstanceIds = new Set();
    this.savedGrantedIds = new Set();
    this.saveError = null;
    this.instanceFilter = "";
  }

  private _toggleInstance(instanceId: number) {
    const next = new Set(this.grantedInstanceIds);
    if (next.has(instanceId)) {
      next.delete(instanceId);
    } else {
      next.add(instanceId);
    }
    this.grantedInstanceIds = next;
  }

  private get _filteredInstances(): DbInstance[] {
    if (!this.instanceFilter) return this.allInstances;
    const q = this.instanceFilter.toLowerCase();
    return this.allInstances.filter((i) =>
      i.name.toLowerCase().includes(q)
    );
  }

  private async _saveInstancePerms() {
    if (this.modalUserId === null) return;
    this.saving = true;
    this.saveError = null;
    const userId = this.modalUserId;
    try {
      const toGrant = [...this.grantedInstanceIds].filter(
        (id) => !this.savedGrantedIds.has(id)
      );
      const toRevoke = [...this.savedGrantedIds].filter(
        (id) => !this.grantedInstanceIds.has(id)
      );
      for (const instanceId of toGrant) {
        await apiClient.post(`/v1/rbac/users/${userId}/instances`, { instanceId });
      }
      for (const instanceId of toRevoke) {
        await apiClient.delete(`/v1/rbac/users/${userId}/instances/${instanceId}`);
      }
      this._closeModal();
      await this._loadUsers();
    } catch (e: any) {
      this.saveError = `保存失败：${e.message}`;
    } finally {
      this.saving = false;
    }
  }

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error) return html`<div class="error-msg">${this.error}</div>`;

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">用户实例权限</span>
        </div>
        ${this._renderModal()}
        ${this.users.length === 0
          ? html`<div class="empty">暂无用户数据。</div>`
          : html`
              <div class="table-container">
                <table class="table">
                  <thead>
                    <tr>
                      <th>用户名</th>
                      <th>邮箱</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.users.map(
                      (u) => html`
                        <tr>
                          <td style="font-weight:500">${u.username}</td>
                          <td style="color:var(--muted)">${u.email || "-"}</td>
                          <td>
                            <button
                              class="action-btn"
                              @click=${() => this._openModal(u)}
                            >
                              实例权限
                            </button>
                          </td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            `}
      </div>
    `;
  }

  private _renderModal() {
    if (!this.showModal) return nothing;
    return html`
      <div
        class="modal-overlay"
        @click=${(e: Event) => {
          if ((e.target as HTMLElement).classList.contains("modal-overlay"))
            this._closeModal();
        }}
      >
        <div class="modal modal-wide">
          <div class="modal-header">
            <span class="modal-title">实例权限 - ${this.modalUserName}</span>
            <button class="modal-close" @click=${this._closeModal}>×</button>
          </div>
          <div class="modal-body">
            ${this.saveError
              ? html`<div class="save-error">${this.saveError}</div>`
              : ""}
            ${this.loadingInstances
              ? html`<div class="empty">加载中...</div>`
              : this.allInstances.length === 0
                ? html`<div class="empty">
                    暂无实例数据。请先在「实例管理」中添加数据库实例。
                  </div>`
                : html`
                    <input
                      class="instance-search"
                      .value=${this.instanceFilter}
                      @input=${(e: any) =>
                        (this.instanceFilter = e.target.value)}
                      placeholder="搜索实例名称..."
                    />
                    ${this.grantedInstanceIds.size === 0
                      ? html`<div class="empty">
                          该用户暂无实例访问权限。选择实例后点击"保存权限"。
                        </div>`
                      : ""}
                    <div class="instance-list">
                      ${this._filteredInstances.length === 0
                        ? html`<div class="empty">无匹配实例。</div>`
                        : this._filteredInstances.map(
                            (inst) => html`
                              <div class="instance-check-row">
                                <input
                                  type="checkbox"
                                  .checked=${this.grantedInstanceIds.has(
                                    inst.id
                                  )}
                                  @change=${() =>
                                    this._toggleInstance(inst.id)}
                                  id="inst-${inst.id}"
                                />
                                <label for="inst-${inst.id}">${inst.name}</label>
                              </div>
                            `
                          )}
                    </div>
                  `}
          </div>
          <div class="modal-footer">
            <button class="btn" @click=${this._closeModal}>取消</button>
            <button
              class="btn primary"
              @click=${this._saveInstancePerms}
              ?disabled=${this.saving || this.loadingInstances}
            >
              ${this.saving ? "保存中..." : "保存权限"}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
