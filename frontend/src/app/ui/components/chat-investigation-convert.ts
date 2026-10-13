import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { DirectGatewayClient } from '../direct-gateway.ts';
import { hasSlidePermission } from '../app-settings.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import './investigation-create.ts';

@customElement('chat-investigation-convert')
export class ChatInvestigationConvert extends LitElement {
  @property({ attribute: false }) client: DirectGatewayClient | null = null;
  @property() sessionId = '';
  @property({ type: Boolean }) active = false;
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @state() private open = false;
  createRenderRoot() { return this; }
  render() {
    if (!hasSlidePermission(this.permissions, 'chat:view')) return nothing;
    return html`<style>${sharedBtnStyles.cssText} chat-investigation-convert { display:inline-block; }</style>
      <button class="btn" ?disabled=${this.active || !this.sessionId} title=${this.active ? '等待当前执行结束后转换' : '保留原消息，关联调查'} @click=${() => this.open = true}>转为调查</button>
      <investigation-create .open=${this.open} .client=${this.client} .sessionId=${this.sessionId}
        @investigation-create-close=${() => this.open = false}
        @investigation-created=${(e: CustomEvent<{ id: string }>) => window.dispatchEvent(new CustomEvent('slide-navigate', { detail: { tab: 'investigations', investigationId: e.detail.id } }))}></investigation-create>`;
  }
}
