import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { TemplateEventEvidence } from '../../../api/generated/public-api.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { metricError, metricRequest, MetricRequestError } from './metric-api.js';
import './app-dialog.js';

@customElement('template-event-close')
export class TemplateEventClose extends LitElement {
  @property({ type: Number }) eventId = 0;
  @property({ type: Boolean }) disabled = false;
  @state() private open = false;
  @state() private busy = false;
  @state() private error = '';

  static styles = sharedBtnStyles;

  protected willUpdate(changes: PropertyValues) {
    if (changes.has('eventId')) {
      this.open = false;
      this.busy = false;
      this.error = '';
    }
  }

  private dismiss() {
    if (this.busy) return;
    this.open = false;
    this.error = '';
  }

  private async confirm() {
    if (!this.eventId || this.disabled || this.busy || !this.open) return;
    const id = this.eventId;
    this.busy = true;
    this.error = '';
    try {
      const result = await metricRequest<TemplateEventEvidence>(`template-events/${id}/close`, {});
      if (result.event_id !== id || result.episode?.state !== 'closed') throw new Error('EVENT_CLOSE_RESPONSE_INVALID');
      if (this.isConnected && this.eventId === id) {
        this.open = false;
        this.dispatchEvent(new CustomEvent('template-event-closed', { detail: result, bubbles: true, composed: true }));
      }
    } catch (error) {
      if (this.eventId === id) this.error = error instanceof MetricRequestError && error.code === 'TRIGGER_MANUAL_CLOSE_DISABLED'
        ? '发生时的触发规则未允许手动关闭。' : metricError(error);
    } finally {
      if (this.eventId === id) this.busy = false;
    }
  }

  render() {
    return html`<button type="button" class="btn" ?disabled=${this.disabled || this.busy}
      @click=${() => { this.open = true; }}>手动关闭</button>
      ${this.open ? html`<app-dialog .open=${true} .closable=${!this.busy} size="sm" title="手动关闭模板事件"
        @app-dialog-close=${this.dismiss}>
        <p>关闭当前事件并保留原有指标判定。关闭通知沿用原告警的投递渠道。</p>
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        <div slot="footer">
          <button type="button" class="btn" ?disabled=${this.busy} @click=${this.dismiss}>取消</button>
          <button type="button" class="btn-primary" ?disabled=${this.busy} @click=${this.confirm}>确认关闭</button>
        </div>
      </app-dialog>` : nothing}`;
  }
}
