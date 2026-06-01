/**
 * Metric Templates Manager — Zabbix-style template CRUD + metric selection + rule creation
 */
import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";

interface MetricTemplate {
  id: number; name: string; description: string | null;
  db_type: string | null; macro_defaults: Record<string, number> | null;
  metrics: string[] | null;
  enabled: boolean; created_by: number | null;
  created_at: string; updated_at: string;
}

interface InstanceTemplateLink {
  instance_id: number; template_id: number;
  macro_overrides: Record<string, number> | null;
  disabled_metrics: string[] | null;
  template?: Partial<MetricTemplate>;
}

interface Instance {
  id: number; name: string; db_type: string; environment: string;
}

interface MetricDef {
  id: string; name: string; unit: string; db_types: string[];
  is_collected: boolean; is_builtin: boolean;
}

interface AlertRule {
  id: number; name: string; metric_name: string; operator: string;
  threshold: number; severity: string; enabled: boolean;
  threshold_template?: { warning?: number | null; error?: number | null; critical?: number | null } | null;
  threshold_type: string; duration_seconds: number; silence_minutes: number;
  template_id?: number | null;
}

const DB_TYPES = ["mysql", "postgresql", "oracle", "dameng"];
const OPERATORS = [">=", ">", "<=", "<", "=", "!="];
const SEVERITIES = ["info", "warning", "error", "critical"];

@customElement("metric-templates-page")
export class MetricTemplatesPage extends LitElement {
  static styles = [sharedBtnStyles, css`

  // Template modal

  // Expanded detail

  // Rule creation modal

  // Instance linking modal

    :host { display: block; }
    .page { padding: 0 0 24px; }
    .toolbar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); }
    .spacer { flex: 1; }

    .table-wrap { border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); overflow: hidden; margin-top: 8px; }
    .table-wrap table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .table-wrap thead { background: var(--bg-elevated); }
    .table-wrap th { text-align: left; padding: 8px 12px; font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid var(--border); }
    .table-wrap td { padding: 7px 12px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; }
    .table-wrap tr:last-child td { border-bottom: none; }
    .table-wrap tr:hover td { background: var(--bg-elevated); }

    .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 500; }
    .badge-tag { background: var(--accent-subtle); color: var(--accent); }

    .expand-row td { padding: 0; background: var(--bg-accent); border-bottom: 1px solid var(--border); }
    .expand-inner { padding: 14px 18px; display: flex; flex-wrap: wrap; gap: 16px; }

    .section { flex: 1; min-width: 280px; }
    .section-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; margin-bottom: 6px; }

    .metric-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 3px; font-size: 11px; background: var(--bg-elevated); border: 1px solid var(--border); }
    .metric-chip.disabled { opacity: 0.4; text-decoration: line-through; }

    .rule-row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
    .rule-row:last-child { border-bottom: none; }
    .rule-metric { font-weight: 500; font-family: monospace; }
    .rule-thresholds { color: var(--muted); font-size: 10px; }

    .inst-row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
    .inst-row:last-child { border-bottom: none; }

    /* Dialog */
    .dialog-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100; display: flex; align-items: center; justify-content: center; }
    .dialog { background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--radius); width: 600px; max-height: 85vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.18); }
    .dialog.wide { width: 700px; }
    .dialog-header { padding: 14px 18px; border-bottom: 1px solid var(--border); font-size: 14px; font-weight: 600; color: var(--text-strong); }
    .dialog-body { padding: 16px 18px; display: flex; flex-wrap: wrap; gap: 12px; }
    .dialog-footer { padding: 12px 18px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; }

    .form-group { display: flex; flex-direction: column; gap: 3px; }
    .form-group.w50 { width: calc(50% - 6px); }
    .form-group.w100 { width: 100%; }
    .form-group.w33 { width: calc(33% - 8px); }
    .form-label { font-size: 11px; font-weight: 500; color: var(--muted); }
    .form-input, .form-select { padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; background: var(--card); color: var(--text); }
    .form-input:focus, .form-select:focus { border-color: var(--accent); outline: none; }

    .msg-err { color: var(--destructive); font-size: 11px; width: 100%; }
    .toast { font-size: 12px; padding: 8px 14px; border-radius: var(--radius-sm); margin-bottom: 8px; }
    .toast-ok { background: var(--ok-subtle); color: var(--ok); }
    .toast-err { background: var(--danger-subtle); color: var(--destructive); }

    .chk-group { display: flex; flex-wrap: wrap; gap: 8px; max-height: 200px; overflow-y: auto; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
    .chk-label { display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; min-width: 140px; }
    .chk-label input { margin: 0; }

    .loading { padding: 48px; text-align: center; color: var(--muted); font-size: 14px; }
    .empty { padding: 24px; text-align: center; color: var(--muted); font-size: 12px; }
  `];
  @state() private templates: MetricTemplate[] = [];
  @state() private instances: Instance[] = [];
  @state() private allMetrics: MetricDef[] = [];
  @state() private allRules: AlertRule[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private ok: string | null = null;

  override connectedCallback() { super.connectedCallback(); this._load(); }

  private async _load() {
    this.loading = true; this.error = null;
    try {
      const [tplRes, instRes, metRes, ruleRes] = await Promise.all([
        authFetch("/api/metric-templates"),
        authFetch("/api/database/instances"),
        authFetch("/api/metrics/registry"),
        authFetch("/api/alert-rules"),
      ]);
      if (!tplRes.ok) throw new Error("加载模板失败");
      this.templates = await tplRes.json();
      if (instRes.ok) this.instances = await instRes.json();
      if (metRes.ok) this.allMetrics = await metRes.json();
      if (ruleRes.ok) {
        const rulesData = await ruleRes.json();
        this.allRules = Array.isArray(rulesData) ? rulesData : rulesData.items || [];
      }
    } catch (e: any) { this.error = e.message; }
    finally { this.loading = false; }
  }

  // ─── Template CRUD ──────────────────────────────────

  private _openCreate() {
    this.editing = null;
    this.form = { name: "", description: "", db_type: "", metrics: [], enabled: true };
    this.formMsg = null;
    this.showModal = true;
  }

  private _openEdit(tpl: MetricTemplate) {
    this.editing = tpl;
    this.form = {
      name: tpl.name, description: tpl.description || "",
      db_type: tpl.db_type || "", metrics: tpl.metrics || [],
      enabled: tpl.enabled,
    };
    this.ruleForm = { name: "", metric_name: "", warning: "", error: "", critical: "" };
    this.ruleFormMsg = null;
    this.formMsg = null;
    this.showModal = true;
  }

  private async _save() {
    if (!this.form.name?.trim()) { this.formMsg = "模板名称不能为空"; return; }
    this.saving = true; this.formMsg = null;
    try {
      const body: any = {
        name: this.form.name.trim(),
        description: this.form.description?.trim() || undefined,
        db_type: this.form.db_type || null,
        metrics: this.form.metrics?.length ? this.form.metrics : null,
      };

      let res: Response;
      if (this.editing) {
        body.enabled = this.form.enabled;
        res = await authFetch(`/api/metric-templates/${this.editing.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      } else {
        res = await authFetch("/api/metric-templates", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "保存失败");
      this.showModal = false;
      await this._load();
      this.ok = this.editing ? "模板已更新" : "模板已创建";
      setTimeout(() => this.ok = null, 2500);
    } catch (e: any) { this.formMsg = e.message; }
    finally { this.saving = false; }
  }

  private async _delete(tpl: MetricTemplate) {
    try {
      const res = await authFetch(`/api/metric-templates/${tpl.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "删除失败");
      await this._load();
      this.ok = `模板 "${tpl.name}" 已删除`;
      setTimeout(() => this.ok = null, 2500);
    } catch (e: any) { this.error = e.message; }
  }

  // ─── Expand / Collapse ─────────────────────────────

  private async _toggleExpand(tpl: MetricTemplate) {
    if (this.expandedId === tpl.id) { this.expandedId = null; return; }
    this.expandedId = tpl.id;
    // Load instance links
    const links: InstanceTemplateLink[] = [];
    for (const inst of this.instances) {
      try {
        const res = await authFetch(`/api/instances/${inst.id}/templates`);
        if (res.ok) {
          const instLinks = await res.json();
          links.push(...instLinks.filter((l: any) => l.template_id === tpl.id));
        }
      } catch { /* skip */ }
    }
    this.instanceLinks = links;
    // Get rules for this template
    this.templateRules = this.allRules.filter(r => r.template_id === tpl.id);
  }

  // ─── Instance linking ──────────────────────────────

  private async _openLinkModal(tpl: MetricTemplate) {
    this.linkingTemplate = tpl;
    this.showLinkModal = true;
  }

  private _linkedIds(): Set<number> {
    return new Set(this.instanceLinks.map(l => l.instance_id));
  }

  private _availableInstances(): Instance[] {
    const linked = this._linkedIds();
    return this.instances.filter(i => !linked.has(i.id));
  }

  private async _linkInstance(instId: number) {
    if (!this.linkingTemplate) return;
    try {
      await authFetch(`/api/instances/${instId}/templates`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: this.linkingTemplate.id }),
      });
      await this._toggleExpand(this.linkingTemplate);
      this._openLinkModal(this.linkingTemplate);
    } catch (e: any) { this.error = e.message; }
  }

  private async _unlinkInstance(instId: number) {
    if (!this.expandedId) return;
    try {
      await authFetch(`/api/instances/${instId}/templates/${this.expandedId}`, { method: "DELETE" });
      const tpl = this.templates.find(t => t.id === this.expandedId);
      if (tpl) await this._toggleExpand(tpl);
    } catch (e: any) { this.error = e.message; }
  }

  // ─── Rule management ───────────────────────────────

  private _openRuleCreate(tpl: MetricTemplate) {
    this.ruleForm = {
      name: "", metric_name: "", operator: ">=", severity: "warning",
      warning: "", error: "", critical: "",
      duration_seconds: 60, silence_minutes: 5,
    };
    this.ruleFormMsg = null;
    this.showRuleModal = true;
  }

  private async _saveRule() {
    const rf = this.ruleForm;
    if (!rf.name?.trim()) { this.ruleFormMsg = "规则名称不能为空"; return; }
    if (!rf.metric_name) { this.ruleFormMsg = "请选择指标"; return; }
    const w = parseFloat(rf.warning), e = parseFloat(rf.error), c = parseFloat(rf.critical);
    if (isNaN(w) && isNaN(e) && isNaN(c)) { this.ruleFormMsg = "至少填写一个阈值"; return; }

    this.ruleSaving = true; this.ruleFormMsg = null;
    try {
      const threshold_template: any = {};
      if (!isNaN(w)) threshold_template.warning = w;
      if (!isNaN(e)) threshold_template.error = e;
      if (!isNaN(c)) threshold_template.critical = c;

      const metricDef = this.allMetrics.find(m => m.id === rf.metric_name);
      const res = await authFetch("/api/alert-rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: rf.name.trim(),
          metric_name: rf.metric_name,
          operator: rf.operator,
          threshold: !isNaN(w) ? w : (!isNaN(e) ? e : c),
          threshold_template,
          threshold_type: "static",
          severity: rf.severity,
          duration_seconds: rf.duration_seconds,
          silence_minutes: rf.silence_minutes,
          db_types: metricDef?.db_types || null,
          template_id: this.expandedId,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "创建规则失败");
      this.showRuleModal = false;
      await this._load();
      // Refresh template detail
      const tpl = this.templates.find(t => t.id === this.expandedId);
      if (tpl) await this._toggleExpand(tpl);
      this.ok = "规则已创建";
      setTimeout(() => this.ok = null, 2500);
    } catch (e: any) { this.ruleFormMsg = e.message; }
    finally { this.ruleSaving = false; }
  }

  private async _deleteRule(ruleId: number) {
    try {
      await authFetch(`/api/alert-rules/${ruleId}`, { method: "DELETE" });
      await this._load();
      const tpl = this.templates.find(t => t.id === this.expandedId);
      if (tpl) await this._toggleExpand(tpl);
      this.ok = "规则已删除";
      setTimeout(() => this.ok = null, 2500);
    } catch (e: any) { this.error = e.message; }
  }

  // ─── Helpers ────────────────────────────────────────

  private _toggleMetric(metricId: string) {
    const selected: string[] = [...(this.form.metrics || [])];
    const idx = selected.indexOf(metricId);
    if (idx >= 0) selected.splice(idx, 1);
    else selected.push(metricId);
    this.form.metrics = selected;
    this.requestUpdate();
  }

  private _filteredMetrics(): MetricDef[] {
    const dbType = this.form.db_type;
    if (!dbType) return this.allMetrics.filter(m => m.is_collected);
    return this.allMetrics.filter(m => m.is_collected && m.db_types.includes(dbType));
  }

  private _templateMetrics(tpl: MetricTemplate): MetricDef[] {
    if (!tpl.metrics?.length) return [];
    return this.allMetrics.filter(m => tpl.metrics!.includes(m.id));
  }

  private _ruleThresholdParts(r: AlertRule): string[] {
    const tt = r.threshold_template;
    if (!tt) return [String(r.threshold)];
    const parts: string[] = [];
    if (tt.warning != null) parts.push(`W:${tt.warning}`);
    if (tt.error != null) parts.push(`E:${tt.error}`);
    if (tt.critical != null) parts.push(`C:${tt.critical}`);
    return parts;
  }

  private async _quickAddRule() {
    const rf = this.ruleForm;
    if (!rf.metric_name) { this.ruleFormMsg = "请选择指标"; return; }
    if (!rf.name?.trim()) { this.ruleFormMsg = "请输入规则名称"; return; }
    const w = parseFloat(rf.warning), e = parseFloat(rf.error), c = parseFloat(rf.critical);
    if (isNaN(w) && isNaN(e) && isNaN(c)) { this.ruleFormMsg = "至少填一个阈值"; return; }

    this.ruleSaving = true; this.ruleFormMsg = null;
    try {
      const threshold_template: any = {};
      if (!isNaN(w)) threshold_template.warning = w;
      if (!isNaN(e)) threshold_template.error = e;
      if (!isNaN(c)) threshold_template.critical = c;
      const metricDef = this.allMetrics.find(m => m.id === rf.metric_name);
      const res = await authFetch("/api/alert-rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: rf.name.trim(), metric_name: rf.metric_name,
          operator: ">=", threshold: !isNaN(w) ? w : (!isNaN(e) ? e : c),
          threshold_template, threshold_type: "static",
          severity: "warning", duration_seconds: 60, silence_minutes: 5,
          db_types: metricDef?.db_types || null,
          template_id: this.editing!.id,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "创建失败");
      await this._load();
      this.ruleForm = { name: "", metric_name: "", warning: "", error: "", critical: "" };
      this.ok = "规则已添加";
      setTimeout(() => this.ok = null, 2000);
    } catch (e: any) { this.ruleFormMsg = e.message; }
    finally { this.ruleSaving = false; }
  }

  private async _deleteRuleInModal(ruleId: number) {
    try {
      await authFetch(`/api/alert-rules/${ruleId}`, { method: "DELETE" });
      await this._load();
    } catch (e: any) { this.error = e.message; }
  }

  private _ruleThresholdStr(r: AlertRule): string {
    const tt = r.threshold_template;
    if (!tt) return String(r.threshold);
    const parts: string[] = [];
    if (tt.warning != null) parts.push(`W:${tt.warning}`);
    if (tt.error != null) parts.push(`E:${tt.error}`);
    if (tt.critical != null) parts.push(`C:${tt.critical}`);
    return parts.join(" ");
  }

  // ─── Render ─────────────────────────────────────────

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    return html`
      ${this.ok ? html`<div class="toast toast-ok">${this.ok}</div>` : ""}
      ${this.error ? html`<div class="toast toast-err">${this.error}</div>` : ""}
      <div class="toolbar">
        <span style="font-weight:600;font-size:13px">指标模板 (${this.templates.length})</span>
        <span class="spacer"></span>
        <button class="btn btn-primary" @click=${this._openCreate}>+ 新建模板</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>名称</th><th>适用 DB</th><th>指标数</th><th>规则数</th><th>状态</th><th>操作</th>
          </tr></thead>
          <tbody>
            ${this.templates.length === 0 ? html`<tr><td colspan="6" class="empty">暂无模板，点击"新建模板"开始</td></tr>` : ""}
            ${this.templates.map(tpl => html`
              <tr>
                <td><span style="font-weight:500">${tpl.name}</span>${tpl.description ? html`<br/><span style="font-size:10px;color:var(--muted)">${tpl.description}</span>` : ""}</td>
                <td>${tpl.db_type ? html`<span class="badge badge-tag">${tpl.db_type}</span>` : html`<span style="color:var(--muted);font-size:11px">全部</span>`}</td>
                <td><span style="font-size:12px;font-weight:500">${tpl.metrics?.length || 0}</span></td>
                <td><span style="font-size:12px;font-weight:500">${this.allRules.filter(r => r.template_id === tpl.id).length}</span></td>
                <td><status-badge variant=${tpl.enabled ? 'ok' : 'muted'}>${tpl.enabled ? '启用' : '禁用'}</status-badge></td>
                <td>
                  <button class="btn btn-sm" @click=${() => this._toggleExpand(tpl)}>${this.expandedId === tpl.id ? '收起' : '详情'}</button>
                  <button class="btn btn-sm" @click=${() => this._openEdit(tpl)} style="margin-left:4px">编辑</button>
                  <button class="btn btn-sm btn-danger" @click=${() => this._delete(tpl)} style="margin-left:4px">删除</button>
                </td>
              </tr>
              ${this.expandedId === tpl.id ? html`
              <tr class="expand-row"><td colspan="6">
                <div class="expand-inner">
                  <!-- Metrics -->
                  <div class="section">
                    <div class="section-title">关联指标 (${(tpl.metrics?.length || 0)})</div>
                    ${this._templateMetrics(tpl).length === 0 ? html`<span class="empty" style="display:block;padding:8px">未关联指标</span>` : ""}
                    ${this._templateMetrics(tpl).map(m => html`
                      <span class="metric-chip" style="margin:2px">${m.id}<span style="color:var(--muted);font-size:10px"> (${m.unit})</span></span>
                    `)}
                  </div>
                  <!-- Rules -->
                  <div class="section">
                    <div class="section-title">
                      告警规则 (${this.templateRules.length})
                      <button class="btn btn-xs btn-primary" @click=${() => this._openRuleCreate(tpl)} style="margin-left:8px">+ 新增</button>
                    </div>
                    ${this.templateRules.length === 0 ? html`<span class="empty" style="display:block;padding:8px">无规则</span>` : ""}
                    ${this.templateRules.map(r => html`
                      <div class="rule-row">
                        <div>
                          <span class="rule-metric">${r.name}</span>
                          <span style="color:var(--muted);margin-left:6px">${r.metric_name} ${r.operator}</span>
                          <span class="rule-thresholds" style="margin-left:4px">${this._ruleThresholdStr(r)}</span>
                          <span class="badge badge-tag" style="margin-left:6px">${r.severity}</span>
                        </div>
                        <button class="btn btn-xs btn-danger" @click=${() => this._deleteRule(r.id)}>删除</button>
                      </div>
                    `)}
                  </div>
                  <!-- Instances -->
                  <div class="section">
                    <div class="section-title">
                      关联实例 (${this.instanceLinks.length})
                      <button class="btn btn-xs btn-primary" @click=${() => this._openLinkModal(tpl)} style="margin-left:8px">+ 关联</button>
                    </div>
                    ${this.instanceLinks.length === 0 ? html`<span class="empty" style="display:block;padding:8px">未关联实例</span>` : ""}
                    ${this.instanceLinks.map(link => {
                      const inst = this.instances.find(i => i.id === link.instance_id);
                      return html`
                        <div class="inst-row">
                          <span><strong>${inst?.name || `#${link.instance_id}`}</strong> <span style="color:var(--muted)">${inst?.db_type || ''} · ${inst?.environment || ''}</span></span>
                          <button class="btn btn-xs btn-danger" @click=${() => this._unlinkInstance(link.instance_id)}>解绑</button>
                        </div>`;
                    })}
                  </div>
                </div>
              </td></tr>` : ""}
            `)}
          </tbody>
        </table>
      </div>

      ${this.showModal ? this._renderModal() : nothing}
      ${this.showRuleModal ? this._renderRuleModal() : nothing}
      ${this.showLinkModal ? this._renderLinkModal() : nothing}
    `;
  }

  _renderModal() {
    const isEdit = !!this.editing;
    const selectedMetrics: string[] = this.form.metrics || [];
    return html`<div class="dialog-overlay" @click=${() => this.showModal = false}>
      <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div class="dialog-header">${isEdit ? '编辑模板' : '新建模板'}</div>
        <div class="dialog-body">
          <div class="form-group w50"><label class="form-label">名称 *</label><input class="form-input" .value=${this.form.name || ''} @input=${(e: any) => this.form.name = e.target.value} placeholder="MySQL 生产模板" /></div>
          <div class="form-group w50"><label class="form-label">适用数据库类型</label>
            <select class="form-select" .value=${this.form.db_type || ''} @change=${(e: any) => { this.form.db_type = e.target.value; this.form.metrics = []; }}>
              <option value="">所有类型</option>
              ${DB_TYPES.map(t => html`<option value=${t}>${t}</option>`)}
            </select></div>
          <div class="form-group w100"><label class="form-label">描述</label><input class="form-input" .value=${this.form.description || ''} @input=${(e: any) => this.form.description = e.target.value} /></div>
          ${isEdit ? html`<div class="form-group w50"><label class="form-label">状态</label>
            <select class="form-select" .value=${String(this.form.enabled)} @change=${(e: any) => this.form.enabled = e.target.value === 'true'}>
              <option value="true">启用</option><option value="false">禁用</option>
            </select></div>` : ''}

          <!-- Metrics selector -->
          <div class="form-group w100">
            <label class="form-label">关联指标 (选择模板管控的指标，留空则全部采集)</label>
            <div class="chk-group">
              ${this._filteredMetrics().map(m => html`
                <label class="chk-label">
                  <input type="checkbox" ?checked=${selectedMetrics.includes(m.id)} @change=${() => this._toggleMetric(m.id)} />
                  <span>${m.id}</span><span style="color:var(--muted);font-size:10px">(${m.unit})</span>
                </label>`)}
            </div>
          </div>

          ${isEdit ? html`
          <!-- Rules (edit mode only) -->
          <div class="form-group w100" style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
            <label class="form-label" style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px">
              告警规则 (${this.allRules.filter(r => r.template_id === this.editing!.id).length})
            </label>
            ${this.allRules.filter(r => r.template_id === this.editing!.id).map(r => html`
              <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:11px">
                <span>
                  <strong>${r.name}</strong>
                  <span style="color:var(--muted);margin:0 6px">${r.metric_name} ${r.operator}</span>
                  ${this._ruleThresholdParts(r).map((p: string) => html`<span class="badge badge-tag" style="margin:0 2px">${p}</span>`)}
                  <span class="badge badge-tag" style="margin-left:4px">${r.severity}</span>
                </span>
                <button class="btn btn-xs btn-danger" @click=${() => this._deleteRuleInModal(r.id)}>×</button>
              </div>`)}
            <div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
              <select style="padding:3px 6px;border:1px solid var(--border);border-radius:3px;font-size:10px;background:var(--card);color:var(--text);width:120px"
                .value=${this.ruleForm.metric_name} @change=${(e: any) => this.ruleForm = {...this.ruleForm, metric_name: e.target.value}}>
                <option value="">选择指标</option>
                ${this._filteredMetrics().map(m => html`<option value=${m.id}>${m.id}</option>`)}
              </select>
              <input placeholder="规则名" style="padding:3px 6px;border:1px solid var(--border);border-radius:3px;font-size:10px;width:120px;background:var(--card);color:var(--text)"
                .value=${this.ruleForm.name} @input=${(e: any) => this.ruleForm = {...this.ruleForm, name: e.target.value}} />
              <input placeholder="W" type="number" style="padding:3px 6px;border:1px solid var(--border);border-radius:3px;font-size:10px;width:60px;background:var(--card);color:var(--text)"
                .value=${this.ruleForm.warning || ''} @input=${(e: any) => this.ruleForm = {...this.ruleForm, warning: e.target.value}} />
              <input placeholder="E" type="number" style="padding:3px 6px;border:1px solid var(--border);border-radius:3px;font-size:10px;width:60px;background:var(--card);color:var(--text)"
                .value=${this.ruleForm.error || ''} @input=${(e: any) => this.ruleForm = {...this.ruleForm, error: e.target.value}} />
              <input placeholder="C" type="number" style="padding:3px 6px;border:1px solid var(--border);border-radius:3px;font-size:10px;width:60px;background:var(--card);color:var(--text)"
                .value=${this.ruleForm.critical || ''} @input=${(e: any) => this.ruleForm = {...this.ruleForm, critical: e.target.value}} />
              <button class="btn btn-xs btn-primary" @click=${this._quickAddRule} ?disabled=${this.ruleSaving}>添加规则</button>
            </div>
            ${this.ruleFormMsg ? html`<div class="msg-err">${this.ruleFormMsg}</div>` : ''}
          </div>` : ''}

          ${this.formMsg ? html`<div class="msg-err">${this.formMsg}</div>` : ""}
        </div>
        <div class="dialog-footer">
          <button class="btn" @click=${() => this.showModal = false}>取消</button>
          <button class="btn btn-primary" @click=${this._save} ?disabled=${this.saving}>${this.saving ? '保存中...' : '保存'}</button>
        </div>
      </div>
    </div>`;
  }

  _renderRuleModal() {
    const rf = this.ruleForm;
    const templateMetrics = this.expandedId
      ? this._templateMetrics(this.templates.find(t => t.id === this.expandedId)!) : [];
    const availableMetrics = templateMetrics.length > 0 ? templateMetrics : this.allMetrics.filter(m => m.is_collected);
    return html`<div class="dialog-overlay" @click=${() => this.showRuleModal = false}>
      <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div class="dialog-header">新增告警规则</div>
        <div class="dialog-body">
          <div class="form-group w50"><label class="form-label">规则名称 *</label><input class="form-input" .value=${rf.name || ''} @input=${(e: any) => this.ruleForm = {...this.ruleForm, name: e.target.value}} placeholder="TPS 过高告警" /></div>
          <div class="form-group w50"><label class="form-label">指标 *</label>
            <select class="form-select" .value=${rf.metric_name} @change=${(e: any) => this.ruleForm = {...this.ruleForm, metric_name: e.target.value}}>
              <option value="">-- 选择指标 --</option>
              ${availableMetrics.map(m => html`<option value=${m.id}>${m.id} (${m.unit})</option>`)}
            </select></div>
          <div class="form-group w33"><label class="form-label">操作符</label>
            <select class="form-select" .value=${rf.operator} @change=${(e: any) => this.ruleForm = {...this.ruleForm, operator: e.target.value}}>
              ${OPERATORS.map(o => html`<option value=${o}>${o}</option>`)}
            </select></div>
          <div class="form-group w33"><label class="form-label">严重级别</label>
            <select class="form-select" .value=${rf.severity} @change=${(e: any) => this.ruleForm = {...this.ruleForm, severity: e.target.value}}>
              ${SEVERITIES.map(s => html`<option value=${s}>${s}</option>`)}
            </select></div>
          <div class="form-group w33"><label class="form-label">持续时长 (秒)</label><input class="form-input" type="number" .value=${String(rf.duration_seconds)} @input=${(e: any) => this.ruleForm = {...this.ruleForm, duration_seconds: parseInt(e.target.value)||60}} /></div>
          <div class="form-group w33"><label class="form-label">Warning 阈值</label><input class="form-input" type="number" .value=${rf.warning || ''} @input=${(e: any) => this.ruleForm = {...this.ruleForm, warning: e.target.value}} placeholder="可选" /></div>
          <div class="form-group w33"><label class="form-label">Error 阈值</label><input class="form-input" type="number" .value=${rf.error || ''} @input=${(e: any) => this.ruleForm = {...this.ruleForm, error: e.target.value}} placeholder="可选" /></div>
          <div class="form-group w33"><label class="form-label">Critical 阈值</label><input class="form-input" type="number" .value=${rf.critical || ''} @input=${(e: any) => this.ruleForm = {...this.ruleForm, critical: e.target.value}} placeholder="可选" /></div>
          <div class="form-group w50"><label class="form-label">静默期 (分钟)</label><input class="form-input" type="number" .value=${String(rf.silence_minutes)} @input=${(e: any) => this.ruleForm = {...this.ruleForm, silence_minutes: parseInt(e.target.value)||5}} /></div>
          ${this.ruleFormMsg ? html`<div class="msg-err">${this.ruleFormMsg}</div>` : ""}
        </div>
        <div class="dialog-footer">
          <button class="btn" @click=${() => this.showRuleModal = false}>取消</button>
          <button class="btn btn-primary" @click=${this._saveRule} ?disabled=${this.ruleSaving}>${this.ruleSaving ? '创建中...' : '创建规则'}</button>
        </div>
      </div>
    </div>`;
  }

  _renderLinkModal() {
    const tpl = this.linkingTemplate;
    if (!tpl) return nothing;
    const available = this._availableInstances();
    return html`<div class="dialog-overlay" @click=${() => this.showLinkModal = false}>
      <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div class="dialog-header">关联实例 — ${tpl.name}</div>
        <div class="dialog-body">
          ${available.length === 0 ? html`<span style="font-size:12px;color:var(--muted);width:100%">没有可关联的实例（所有实例已关联）</span>` : ""}
          ${available.map(inst => html`
            <div class="inst-row" style="width:100%">
              <div>
                <strong>${inst.name}</strong>
                <span style="color:var(--muted);margin-left:6px">${inst.db_type} · ${inst.environment}</span>
                ${tpl.db_type && inst.db_type !== tpl.db_type ? html`<span style="font-size:10px;color:var(--warn);margin-left:6px">⚠ 类型不匹配</span>` : ''}
              </div>
              <button class="btn btn-sm btn-primary" @click=${() => this._linkInstance(inst.id)}>关联</button>
            </div>`)}
        </div>
        <div class="dialog-footer"><button class="btn" @click=${() => this.showLinkModal = false}>关闭</button></div>
      </div>
    </div>`;
  }
}
