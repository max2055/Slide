import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { InvestigationRequest } from '../../../api/generated/public-api.ts';
import { operationsStyles } from '../views/operations-styles.ts';
import './app-card.ts';
import './app-form-field.ts';

type Supplement = NonNullable<InvestigationRequest['supplement']>;
/** Explicit admission only; changing selection/version discards the old draft. */
@customElement('investigation-supplement')
export class InvestigationSupplement extends LitElement {
  static styles = operationsStyles;
  @property() investigationId = '';
  @property() resultId = '';
  @property({ type: Number }) resultVersion = 0;
  @property({ attribute: false }) gaps: string[] = [];
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) submit?: (message: string, supplement: Supplement) => Promise<unknown>;
  @state() private gapIndex = 0;
  @state() private kind = '';
  @state() private numeric = '';
  @state() private source = '';
  @state() private observation = '';
  @state() private submitting = false;
  private clear() { this.gapIndex = 0; this.kind = ''; this.numeric = ''; this.source = ''; this.observation = ''; }
  protected willUpdate(changed: Map<string, unknown>) {
    if (['investigationId', 'resultId', 'resultVersion'].some(key => changed.has(key))) this.clear();
  }
  private answer(): Supplement['answer'] {
    if (!this.gaps[this.gapIndex]) return undefined;
    if (this.kind === 'unknown') return { gapIndex: this.gapIndex, kind: 'unknown' };
    if (this.kind === 'observed' || this.kind === 'not_observed')
      return { gapIndex: this.gapIndex, kind: 'choice', value: this.kind, source: 'user_observation' };
    if (this.kind === 'number' && this.numeric.trim() && Number.isFinite(Number(this.numeric))
      && (this.source === 'user_measurement' || this.source === 'monitoring_display'))
      return { gapIndex: this.gapIndex, kind: 'number', value: Number(this.numeric), source: this.source };
    return undefined;
  }
  private async send() {
    const answer = this.answer();
    if (this.disabled || this.submitting || !this.resultId || !answer || !this.submit) return;
    this.submitting = true;
    const key = `${this.investigationId}:${this.resultId}:${this.resultVersion}`;
    try {
      const accepted = await this.submit('核实所选缺口；不清楚的部分继续保留，不推定为事实。', {
        resultId: this.resultId, resultVersion: this.resultVersion,
        observation: this.observation.trim() || '未提供额外描述', answer,
      });
      if (accepted && key === `${this.investigationId}:${this.resultId}:${this.resultVersion}`) this.clear();
    } finally { this.submitting = false; }
  }
  render() {
    const locked = this.disabled || this.submitting;
    return html`<app-card><span slot="header">补充当前结果 V${this.resultVersion}</span>
      <p>选择当前结果中的一个证据缺口。补充是待核实的用户陈述，下一轮保留原结果与证据。</p>
      ${this.gaps.length ? html`
        <app-form-field label="待核实缺口">
          <select aria-label="待核实缺口" .value=${String(this.gapIndex)} ?disabled=${locked}
            @change=${(e: Event) => { this.gapIndex = Number((e.target as HTMLSelectElement).value); this.kind = ''; this.numeric = ''; this.source = ''; }}>
            ${this.gaps.map((gap, i) => html`<option value=${i}>${gap}</option>`)}
          </select>
        </app-form-field>
        <app-form-field label="补充方式" hint="不清楚会继续保留缺口；观察与数值仍需证据核实。">
          <select aria-label="补充方式" .value=${this.kind} ?disabled=${locked}
            @change=${(e: Event) => { this.kind = (e.target as HTMLSelectElement).value; this.numeric = ''; this.source = ''; }}>
            <option value="">请选择</option><option value="unknown">不清楚</option>
            <option value="observed">观察到相关现象</option><option value="not_observed">未观察到相关现象</option>
            <option value="number">补充数值</option>
          </select>
        </app-form-field>
        ${this.kind === 'number' ? html`
          <app-form-field label="观察数值" hint="按所选缺口的指标、单位与时间填写；未明确时请选择不清楚。">
            <input aria-label="观察数值" type="number" step="any" .value=${this.numeric} ?disabled=${locked}
              @input=${(e: Event) => this.numeric = (e.target as HTMLInputElement).value}>
          </app-form-field>
          <app-form-field label="数值来源">
            <select aria-label="数值来源" .value=${this.source} ?disabled=${locked}
              @change=${(e: Event) => this.source = (e.target as HTMLSelectElement).value}>
              <option value="">请选择</option><option value="user_measurement">我的测量记录</option>
              <option value="monitoring_display">我看到的监控展示</option>
            </select>
          </app-form-field>` : nothing}
      ` : html`<p>当前结果未列出具体缺口，可通过下方“继续调查”描述新问题；不自动生成缺口或观察。</p>`}
      <app-form-field label="额外描述（选填）">
        <textarea aria-label="额外描述（选填）" maxlength="1000" rows="3" .value=${this.observation} ?disabled=${locked}
          @input=${(event: Event) => this.observation = (event.target as HTMLTextAreaElement).value}></textarea>
      </app-form-field>
      <button class="btn-primary" ?disabled=${locked || !this.answer()} @click=${this.send}>保存补充并开始下一轮</button>
      <p class="muted">执行结果未知时先刷新核对原请求；不会重放上一轮或更改采集与事件状态。</p>
    </app-card>`;
  }
}
