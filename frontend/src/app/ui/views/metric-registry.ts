/**
 * Metric Registry Viewer — card-based metric definition browser + CRUD
 */
import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, state } from "lit/decorators.js";
import "../components/app-dialog.js";

const API_BASE = "/api";

interface MetricDefinition {
  id: string; name: string; description: string; unit: string;
  db_types: string[]; aggregation: string; default_interval: number;
  is_collected: boolean; is_builtin: boolean;
  collection_sqls?: Record<string, string>; compute_expr?: string;
  value_type?: string; category?: string; updated_by?: number;
}

const AGG_LABELS: Record<string, string> = { avg: "平均值", max: "最大值", min: "最小值", sum: "求和", count: "计数", last: "最新值" };
const VALUE_TYPE_LABELS: Record<string, string> = { gauge: "Gauge (瞬时值)", counter: "Counter (累计值)", histogram: "Histogram (分布)" };
const DB_TYPE_OPTIONS = ["mysql", "postgresql", "oracle", "dameng"];
const CATEGORY_ICONS: Record<string, string> = { performance: "⚡", capacity: "💾", connection: "🔗", cache: "🗄️", security: "🔒", availability: "🟢" };

@customElement("metric-registry-viewer")
export class MetricRegistryViewer extends LitElement {
  @state() private metrics: MetricDefinition[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private filterDbType = "all";
  @state() private expandedId: string | null = null;
  @state() private showModal = false;
  @state() private editing: MetricDefinition | null = null;
  @state() private form: Record<string, any> = {};
  @state() private formMsg: string | null = null;
  @state() private saving = false;
  @state() private showDeleteConfirm: MetricDefinition | null = null;
  static styles = [sharedBtnStyles, css`

    :host { display: block; }
    .page { padding: 0; }
    .toolbar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); border-radius: var(--radius-md); }
    .toolbar .spacer { flex: 1; }
    .filter-select { padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; background: var(--card); color: var(--text); }
    .count { font-size: 12px; color: var(--muted); }

    /* Table */
    .table-wrap { border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); overflow: hidden; }
    .table-wrap table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .table-wrap thead { background: var(--bg-elevated); }
    .table-wrap th { text-align: left; padding: 8px 12px; font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; border-bottom: 1px solid var(--border); }
    .table-wrap td { padding: 7px 12px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; white-space: nowrap; }
    .table-wrap td.col-name { white-space: normal; }
    .table-wrap tr:last-child td { border-bottom: none; }
    .table-wrap tr:hover td { background: var(--bg-elevated); }
    .table-wrap tr.row-expanded td { background: var(--bg-elevated); }
    .col-id { width: 140px; }
    .col-name { width: auto; }
    .col-db { width: 130px; }
    .col-unit { width: 60px; }
    .col-agg { width: 70px; }
    .col-int { width: 60px; }
    .col-status { width: 70px; }
    .col-act { width: 110px; white-space: nowrap; }
    .col-id code { font-size: 11px; }
    .col-db span { display: inline-block; padding: 1px 5px; margin: 1px 2px 1px 0; font-size: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 3px; }
    .text-muted { color: var(--muted); }
    .text-mono { font-family: var(--mono, monospace); font-size: 10px; }
    .name-cell { font-weight: 600; }
    .name-cell small { display: block; font-weight: 400; color: var(--muted); font-size: 10px; margin-top: 1px; }

    /* Inline expand */
    .expand-row td { padding: 0; }
    .expand-inner { padding: 12px 16px 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px 24px; border-top: 1px solid var(--border); }
    .expand-inner dl { margin: 0; }
    .expand-inner dt { font-size: 9px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.02em; }
    .expand-inner dd { font-size: 12px; color: var(--text); margin: 1px 0 0; }
    .expand-inner code { font-size: 10px; background: var(--bg); padding: 1px 4px; border-radius: 3px; }
    .expand-actions { grid-column: 1 / -1; display: flex; gap: 6px; margin-top: 4px; }


    .form-group { display: flex; flex-direction: column; gap: 4px; }
    .form-label { font-size: 12px; font-weight: 500; color: var(--text); }
    .form-input, .form-select { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; background: var(--card); color: var(--text); box-sizing: border-box; }
    .form-input:focus { outline: none; border-color: var(--accent); }
    .msg-err { font-size: 12px; padding: 8px 12px; border-radius: var(--radius-sm); background: var(--danger-subtle); color: var(--danger); }
    .form-section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--muted); padding-top: 8px; border-top: 1px solid var(--border); margin-top: 4px; letter-spacing: 0.5px; }
    .chk-group { display: flex; gap: 12px; flex-wrap: wrap; }
    .chk-label { display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
    .chk-label input[type="checkbox"] { accent-color: var(--accent); }
    .sql-area { width: 100%; min-height: 60px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; font-family: monospace; background: var(--bg-elevated); color: var(--text); resize: vertical; box-sizing: border-box; }
    .sql-area:focus { outline: none; border-color: var(--accent); }
    .toggle-row { display: flex; align-items: center; gap: 8px; }
  `];

  override connectedCallback() { super.connectedCallback(); this._load(); }

  private async _load() {
    this.loading = true; this.error = null;
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_BASE}/metrics/registry`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.metrics = Array.isArray(data) ? data : [];
    } catch (e: any) { this.error = e.message; }
    finally { this.loading = false; }
  }

  _allDbTypes() { return [...new Set(this.metrics.flatMap(m => m.db_types))].sort(); }
  _filtered() {
    if (this.filterDbType === "all") return this.metrics;
    return this.metrics.filter(m => m.db_types.includes(this.filterDbType));
  }

  _openCreate() {
    this.editing = null;
    this.form = {
      is_collected: true, aggregation: "avg", default_interval: 30,
      value_type: "gauge", db_types: [],
      collection_sqls: {},
    };
    this.formMsg = null; this.showModal = true;
  }
  _openEdit(m: MetricDefinition) {
    this.editing = m;
    this.form = {
      ...m,
      db_types: [...(m.db_types || [])],
      collection_sqls: m.collection_sqls ? { ...m.collection_sqls } : {},
    };
    this.formMsg = null; this.showModal = true;
  }

  private async _save() {
    this.saving = true; this.formMsg = null;
    try {
      const isEdit = !!this.editing;
      const res = await fetch(`${API_BASE}/metrics/registry${isEdit ? `/${this.editing!.id}` : ''}`, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${localStorage.getItem("token")}` },
        body: JSON.stringify(this.form),
      });
      if (!res.ok) throw new Error((await res.json().catch(()=>({}) )).error || "保存失败");
      this.showModal = false; await this._load();
    } catch (e: any) { this.formMsg = e.message; }
    finally { this.saving = false; }
  }

  private async _delete(m: MetricDefinition) {
    try {
      await fetch(`${API_BASE}/metrics/registry/${m.id}`, {
        method: "DELETE", headers: { "Authorization": `Bearer ${localStorage.getItem("token")}` },
      });
      this.showDeleteConfirm = null; await this._load();
    } catch (_) {}
  }

  override render() {
    if (this.loading) return html`<div style="padding:48px;text-align:center;color:var(--muted)">加载中...</div>`;
    if (this.error) return html`<div style="padding:48px;text-align:center;color:var(--danger)">${this.error}</div>`;

    const filtered = this._filtered();
    return html`<div class="page">
      <div class="table-wrap">
        <div class="toolbar">
          <span class="count">${filtered.length} 个指标</span>
          <select class="filter-select" @change=${(e: Event) => { this.filterDbType = (e.target as HTMLSelectElement).value; }}>
            <option value="all">全部类型</option>
            ${this._allDbTypes().map(t => html`<option value=${t}>${t.toUpperCase()}</option>`)}
          </select>
          <span class="spacer"></span>
          <button class="btn btn-primary" @click=${this._openCreate}>+ 新建指标</button>
        </div>
        <table>
          <thead>
            <tr>
              <th class="col-id">指标 ID</th>
              <th class="col-name">名称</th>
              <th class="col-db">数据库类型</th>
              <th class="col-unit">单位</th>
              <th class="col-agg">聚合</th>
              <th class="col-int">间隔</th>
              <th class="col-status">状态</th>
              <th class="col-act"></th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(m => html`
            <tr class="${this.expandedId === m.id ? 'row-expanded' : ''}" @click=${() => this.expandedId = this.expandedId === m.id ? null : m.id} style="cursor:pointer;">
              <td class="col-id"><code>${m.id}</code></td>
              <td class="col-name">
                <div class="name-cell">${CATEGORY_ICONS[m.category || ''] || ''} ${m.name}</div>
                ${m.description ? html`<small>${m.description}</small>` : ''}
              </td>
              <td class="col-db">${m.db_types.map(t => html`<span>${t}</span>`)}</td>
              <td class="col-unit"><span class="text-muted">${m.unit || '-'}</span></td>
              <td class="col-agg"><span class="text-muted">${AGG_LABELS[m.aggregation] || m.aggregation}</span></td>
              <td class="col-int"><span class="text-mono">${m.default_interval}s</span></td>
              <td class="col-status"><app-badge variant=${m.is_collected ? 'ok' : 'muted'}>${m.is_collected ? '启用' : '禁用'}</app-badge></td>
              <td class="col-act" @click=${(e: Event) => e.stopPropagation()}>
                <button class="btn-sm" @click=${() => this._openEdit(m)}>编辑</button>
                <button class="btn-sm danger" ?disabled=${m.is_builtin} @click=${() => { this.showDeleteConfirm = m; }}>删除</button>
              </td>
            </tr>
            ${this.expandedId === m.id ? html`
            <tr class="expand-row"><td colspan="8">
              <div class="expand-inner">
                <dl><dt>值类型</dt><dd>${m.value_type || 'gauge'}</dd></dl>
                <dl><dt>分类</dt><dd>${m.category || '-'}</dd></dl>
                <dl><dt>计算表达式</dt><dd><code>${m.compute_expr || '-'}</code></dd></dl>
                ${m.collection_sqls && Object.keys(m.collection_sqls).length ? html`<dl><dt>采集 SQL</dt><dd>${Object.entries(m.collection_sqls).map(([t, sql]) => html`<code>${t}: ${(sql as string).substring(0, 100)}${(sql as string).length > 100 ? '...' : ''}</code><br/>`)}</dd></dl>` : ''}
              </div>
            </td></tr>
            ` : ''}
            `)}
          </tbody>
        </table>
      </div>
      ${this.showModal ? this._renderModal() : nothing}
      ${this.showDeleteConfirm ? html`
        <app-dialog .open=${true} size="sm" title="确认删除" @app-dialog-close=${() => this.showDeleteConfirm = null}>
          <p>确定要删除指标 "${this.showDeleteConfirm.name}"？</p>
          <div slot="footer">
            <button class="btn" @click=${() => this.showDeleteConfirm = null}>取消</button>
            <button class="btn-primary" @click=${() => this._delete(this.showDeleteConfirm!)}>确认删除</button>
          </div>
        </app-dialog>` : nothing}
    </div>`;
  }

  _toggleDbType(dbType: string) {
    const dbs: string[] = this.form.db_types || [];
    if (dbs.includes(dbType)) this.form.db_types = dbs.filter(t => t !== dbType);
    else this.form.db_types = [...dbs, dbType];
    this.requestUpdate();
  }
  _updateCollectionSql(dbType: string, sql: string) {
    const sqls = this.form.collection_sqls || {};
    if (sql.trim()) sqls[dbType] = sql;
    else delete sqls[dbType];
    this.form.collection_sqls = sqls;
  }

  _renderModal() {
    const isEdit = !!this.editing;
    const dbTypes: string[] = this.form.db_types || [];
    const collectionSqls: Record<string, string> = this.form.collection_sqls || {};
    return html`<app-dialog .open=${true} size="xl" title="${isEdit ? '编辑指标' : '新建指标'}" @app-dialog-close=${() => this.showModal = false}>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 16px">
        <div class="form-group"><label class="form-label">指标 ID</label><input class="form-input" .value=${this.form.id || ''} @input=${(e: any) => this.form.id = e.target.value} placeholder="custom_metric" ?disabled=${isEdit} /></div>
        <div class="form-group"><label class="form-label">名称</label><input class="form-input" .value=${this.form.name || ''} @input=${(e: any) => this.form.name = e.target.value} placeholder="指标显示名称" /></div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">描述</label><input class="form-input" .value=${this.form.description || ''} @input=${(e: any) => this.form.description = e.target.value} /></div>
        <div class="form-group"><label class="form-label">单位</label><input class="form-input" .value=${this.form.unit || ''} @input=${(e: any) => this.form.unit = e.target.value} placeholder="%" /></div>
        <div class="form-group"><label class="form-label">聚合方式</label>
          <select class="form-select" .value=${this.form.aggregation || 'avg'} @change=${(e: any) => this.form.aggregation = e.target.value}>
            ${Object.entries(AGG_LABELS).map(([v, l]) => html`<option value=${v}>${l}</option>`)}
          </select></div>
        <div class="form-group"><label class="form-label">采集间隔 (秒)</label><input class="form-input" type="number" .value=${String(this.form.default_interval || 30)} @input=${(e: any) => this.form.default_interval = parseInt(e.target.value)} /></div>
        <div class="form-group"><label class="form-label">分类</label><input class="form-input" .value=${this.form.category || ''} @input=${(e: any) => this.form.category = e.target.value} placeholder="performance" /></div>
        <div class="form-group"><label class="form-label">值类型</label>
          <select class="form-select" .value=${this.form.value_type || 'gauge'} @change=${(e: any) => this.form.value_type = e.target.value}>
            ${Object.entries(VALUE_TYPE_LABELS).map(([v, l]) => html`<option value=${v}>${l}</option>`)}
          </select></div>
        <div class="form-group">
          <label class="form-label">是否采集</label>
          <div class="toggle-row" style="padding-top:6px">
            <input type="checkbox" ?checked=${!!this.form.is_collected} @change=${(e: any) => this.form.is_collected = e.target.checked} />
            <label class="toggle-label">${this.form.is_collected ? '启用' : '禁用'}</label>
          </div>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">适用数据库类型</label>
          <div class="chk-group">
            ${DB_TYPE_OPTIONS.map(t => html`
              <label class="chk-label"><input type="checkbox" ?checked=${dbTypes.includes(t)} @change=${() => this._toggleDbType(t)} /> ${t}</label>
            `)}
          </div>
        </div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">计算表达式</label><input class="form-input" .value=${this.form.compute_expr || ''} @input=${(e: any) => this.form.compute_expr = e.target.value} placeholder="例如: (running / max) * 60 + 20" /></div>
        <div style="grid-column:1/-1;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--muted);padding-top:8px;border-top:1px solid var(--border);margin-top:4px;letter-spacing:0.5px">采集 SQL（按数据库类型）</div>
        ${DB_TYPE_OPTIONS.map(t => html`
          <div class="form-group">
            <label class="form-label" style="text-transform:uppercase">${t}</label>
            <textarea class="sql-area" .value=${collectionSqls[t] || ''} @input=${(e: any) => this._updateCollectionSql(t, e.target.value)} placeholder="SELECT ... FROM ... WHERE ..."></textarea>
          </div>
        `)}
        ${this.formMsg ? html`<div class="msg-err" style="grid-column:1/-1">${this.formMsg}</div>` : ''}
      </div>
      <div slot="footer">
        <button class="btn" @click=${() => this.showModal = false}>取消</button>
        <button class="btn-primary" @click=${this._save} ?disabled=${this.saving}>${this.saving ? '保存中...' : '保存'}</button>
      </div>
    </app-dialog>`;
  }
}
declare global { interface HTMLElementTagNameMap { "metric-registry-viewer": MetricRegistryViewer; } }
