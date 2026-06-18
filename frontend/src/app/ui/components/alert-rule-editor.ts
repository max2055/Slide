/**
 * Alert rule create/edit form modal.
 * Uses <app-dialog size="lg"> with <app-form-field> for structured inputs.
 *
 * Properties:
 *   .rule=${AlertRule|null} .open=${boolean} .metricRegistry=${any[]} .instances=${any[]}
 *
 * Events:
 *   save (detail: AlertRule data), close
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./app-dialog.js";
import "./app-form-field.js";

interface AlertRule {
  id: number;
  name: string;
  description?: string;
  metric_name: string;
  operator: string;
  threshold: number;
  duration_seconds: number;
  severity: string;
  threshold_type: 'static' | 'dynamic';
  threshold_template?: { warning?: number | null; error?: number | null; critical?: number | null } | null;
  dynamic_config?: any;
  silence_minutes: number;
  db_types?: string[] | null;
  instance_ids?: number[] | null;
  enabled: boolean;
}

@customElement("alert-rule-editor")
export class AlertRuleEditor extends LitElement {
  static styles = css`
    .form-input {
      width: 100%;
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-base);
      color: var(--text);
      background: var(--card);
      box-sizing: border-box;
      outline: none;
      transition: border-color var(--duration-fast) ease;
    }
    .form-input:focus {
      border-color: var(--ring);
      box-shadow: var(--focus-ring);
    }
    .active {
      background: var(--accent) !important;
      color: var(--accent-foreground) !important;
    }
  `;
  @property({ type: Object }) rule: AlertRule | null = null;
  @property({ type: Boolean }) open = false;
  @property({ type: Array }) metricRegistry: any[] = [];
  @property({ type: Array }) instances: any[] = [];
  @property() error = '';

  @state() private _form: Record<string, any> = {};
  @state() private _error = '';
  @state() private _thresholdError: string | null = null;

  private _emit(name: string, detail?: any) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('open') && this.open) {
      this._initForm();
    }
  }

  private _initForm() {
    if (this.rule) {
      this._form = { ...this.rule, threshold_template: this.rule.threshold_template || undefined };
    } else {
      this._form = {
        name: '', description: '', metric_name: '', operator: '>', threshold: 0,
        duration_seconds: 60, severity: 'warning', enabled: true,
        threshold_type: 'static' as const, silence_minutes: 5, db_types: null, instance_ids: null,
      };
    }
    this._error = '';
    this._thresholdError = null;
  }

  private _clearErrors() { this._error = ''; this._thresholdError = null; }

  private _update(field: string, value: any) {
    this._error = ''; // Clear errors on user edit
    this._form = { ...this._form, [field]: value };
    if (field === 'metric_name' && value) {
      const metric = this.metricRegistry.find((m: any) => (m.id || m.metric_name) === value);
      if (metric?.db_types?.length) {
        this._form = { ...this._form, db_types: metric.db_types };
      }
    }
  }

  private _validateThresholds(t: { warning?: number | null; error?: number | null; critical?: number | null }): boolean {
    const { warning: w, error: e, critical: c } = t;
    if (w == null && e == null && c == null) { this._thresholdError = null; return true; }
    if (w != null && e != null && w >= e) { this._thresholdError = 'Warning 必须小于 Error'; return false; }
    if (e != null && c != null && e >= c) { this._thresholdError = 'Error 必须小于 Critical'; return false; }
    if (w != null && c != null && w >= c) { this._thresholdError = 'Warning 必须小于 Critical'; return false; }
    this._thresholdError = null;
    return true;
  }

  private async _save() {
    const f = this._form;
    if (!f.name || !f.metric_name) { this._error = '名称和指标不能为空'; return; }
    if (this._thresholdError) { this._error = this._thresholdError; return; }
    try {
      const body: Record<string, any> = {
        name: f.name, description: f.description || '',
        metric_name: f.metric_name, operator: f.operator || '>',
        threshold: Number(f.threshold) || 0, duration_seconds: Number(f.duration_seconds) || 60,
        severity: f.severity || 'warning', threshold_type: f.threshold_type || 'static',
        threshold_template: f.threshold_template || null, silence_minutes: Number(f.silence_minutes) || 5,
        db_types: f.db_types || null, instance_ids: f.instance_ids || null,
      };
      if (body.threshold_template && body.threshold_type === 'static') body.threshold = 0;
      this._emit('save', { isEdit: !!this.rule, id: this.rule?.id, body });
    } catch (err: any) {
      this._error = err.message;
    }
  }

  private _close() { this._emit('close'); }

  override render() {
    if (!this.open) return nothing;
    const f = this._form;
    const dbTypes = ['mysql', 'postgresql', 'oracle', 'dameng'];
    const dayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    return html`
      <app-dialog size="lg" .open=${this.open} title="${this.rule ? '编辑规则' : '新建规则'}" @app-dialog-close=${this._close}>
        ${(this._error || this.error) ? html`<div style="color:var(--destructive);font-size:var(--text-base);margin-bottom:var(--space-md);">${this._error || this.error}</div>` : ''}

        <app-form-field label="规则名称" required>
          <input class="form-input" .value=${f.name || ''} @input=${(e: any) => this._update('name', e.target.value)} placeholder="例如：CPU 使用率过高" />
        </app-form-field>

        <app-form-field label="指标" required>
          <select class="form-input" .value=${f.metric_name || ''} @change=${(e: any) => this._update('metric_name', e.target.value)}>
            <option value="">请选择指标</option>
            ${this.metricRegistry.map((m: any) => html`<option value="${m.id || m.metric_name || m}">${m.name || m.id || m}${m.unit ? ` (${m.unit})` : ''}</option>`)}
          </select>
        </app-form-field>

        <app-form-field label="适用数据库类型" hint="留空=所有类型">
          <div style="display:flex;flex-wrap:wrap;gap:var(--space-sm);">
            ${dbTypes.map(t => html`<label style="display:flex;align-items:center;gap:4px;font-size:var(--text-sm);cursor:pointer;">
              <input type="checkbox" .checked=${f.db_types?.includes(t) ?? false}
                @change=${(e: any) => {
                  const cur = f.db_types ? [...f.db_types] : [];
                  e.target.checked ? cur.push(t) : cur.splice(cur.indexOf(t), 1);
                  this._update('db_types', cur.length > 0 ? cur : null);
                }} /> ${t}
            </label>`)}
          </div>
        </app-form-field>

        <app-form-field label="适用实例" hint="按住 Ctrl/Cmd 多选。留空=所有实例">
          <select class="form-input" multiple style="min-height:80px;" @change=${(e: any) => {
            const sel = Array.from(e.target.selectedOptions, (o: any) => Number(o.value)).filter((v: number) => v > 0);
            this._update('instance_ids', sel.length > 0 ? sel : null);
          }}>
            <option value="">所有实例</option>
            ${this.instances.map((inst: any) => html`<option value="${inst.id}" ?selected=${f.instance_ids?.includes(inst.id)}>${inst.name} (${inst.db_type || ''})</option>`)}
          </select>
        </app-form-field>

        <app-form-field label="操作符">
          <select class="form-input" .value=${f.operator || '>'} @change=${(e: any) => this._update('operator', e.target.value)}>
            <option value=">">大于 (&gt;)</option>
            <option value="<">小于 (&lt;)</option>
            <option value=">=">大于等于 (&ge;)</option>
            <option value="<=">小于等于 (&le;)</option>
          </select>
        </app-form-field>

        <app-form-field label="阈值类型">
          <div style="display:flex;gap:0;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;">
            <button class="${f.threshold_type === 'static' ? 'active' : ''}" style="flex:1;padding:var(--space-sm) var(--space-lg);border:none;background:var(--secondary);color:var(--text);font-size:var(--text-base);font-weight:500;cursor:pointer;${f.threshold_type === 'static' ? 'background:var(--accent);color:var(--accent-foreground);' : ''}" @click=${() => this._update('threshold_type', 'static')}>静态</button>
            <button class="${f.threshold_type === 'dynamic' ? 'active' : ''}" style="flex:1;padding:var(--space-sm) var(--space-lg);border:none;background:var(--secondary);color:var(--text);font-size:var(--text-base);font-weight:500;cursor:pointer;${f.threshold_type === 'dynamic' ? 'background:var(--accent);color:var(--accent-foreground);' : ''}" @click=${() => this._update('threshold_type', 'dynamic')}>动态</button>
          </div>
          ${f.threshold_type === 'dynamic' ? html`<div style="font-size:var(--text-sm);color:var(--muted);margin-top:var(--space-xs);">阈值由基线算法自动计算</div>` : ''}
        </app-form-field>

        ${f.threshold_type !== 'dynamic' ? html`
          <app-form-field label="三级阈值" hint="${this._thresholdError ? '' : '留空表示该级别不触发。有效值需满足 warning < error < critical'}">
            ${this._thresholdError ? html`<div style="color:var(--destructive);font-size:var(--text-sm);margin-bottom:var(--space-xs);">${this._thresholdError}</div>` : ''}
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--space-md);">
              ${['warning', 'error', 'critical'].map(level => html`
                <div>
                  <label style="font-size:var(--text-xs);color:var(--muted);margin-bottom:4px;display:block;text-transform:capitalize;">${level}</label>
                  <input type="number" class="form-input" .value=${f.threshold_template?.[level] ?? ''}
                    @input=${(e: any) => {
                      const t = { ...(f.threshold_template || {}), [level]: e.target.value !== '' ? Number(e.target.value) : null };
                      this._update('threshold_template', t);
                      this._validateThresholds(t);
                    }}
                    placeholder="留空不启用" />
                </div>
              `)}
            </div>
          </app-form-field>
        ` : html`
          <app-form-field label="动态阈值配置">
            <div style="padding:var(--space-md);background:var(--bg-elevated);border-radius:var(--radius-sm);">
              <div style="font-size:var(--text-sm);color:var(--muted);">默认使用 sigma=3, lookback_days=7</div>
            </div>
          </app-form-field>
        `}

        <app-form-field label="持续时间（秒）">
          <input type="number" class="form-input" .value=${f.duration_seconds ?? 60} @input=${(e: any) => this._update('duration_seconds', Number(e.target.value))} />
        </app-form-field>

        <app-form-field label="沉默期（分钟）" hint="同一规则在此时间内不重复触发告警。默认 5 分钟。">
          <input type="number" class="form-input" min="0" .value=${f.silence_minutes ?? 5} @input=${(e: any) => this._update('silence_minutes', Number(e.target.value))} />
        </app-form-field>

        <app-form-field label="告警等级">
          <select class="form-input" .value=${f.severity || 'warning'} @change=${(e: any) => this._update('severity', e.target.value)}>
            <option value="info">提示</option>
            <option value="warning">警告</option>
            <option value="error">错误</option>
            <option value="critical">严重</option>
          </select>
        </app-form-field>

        <div slot="footer" style="display:flex;gap:var(--space-sm);justify-content:flex-end;">
          <button class="btn" @click=${this._close}>取消</button>
          <button class="btn primary" @click=${this._save}>保存</button>
        </div>
      </app-dialog>
    `;
  }
}
