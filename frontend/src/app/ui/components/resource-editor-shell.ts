import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';

/** Page layout from approved collection prototype R1. Panels stay mounted so
 * switching tabs preserves the candidate and its unsaved-change protection. */
@customElement('resource-editor-shell')
export class ResourceEditorShell extends LitElement {
  @property() heading = '';
  @property() caption = '';
  @property() activeTab = 'basic';
  @property({ type: Boolean }) busy = false;
  private select(tab: string) {
    this.dispatchEvent(new CustomEvent('editor-tab-change', { detail: tab }));
  }
  override firstUpdated() { this.renderRoot.querySelector<HTMLElement>('h1')?.focus(); }
  render() {
    return html`<style>${sharedBtnStyles}
      :host{display:block;min-width:0;max-width:1360px;margin:auto;color:var(--text)}
      [hidden]{display:none!important} h1{font-size:26px;color:var(--text-strong);margin:var(--space-lg) 0 var(--space-sm)}
      p{margin:0;color:var(--muted);font-size:var(--text-sm);overflow-wrap:anywhere}
      .head{display:flex;justify-content:space-between;gap:var(--space-lg);align-items:center;margin-bottom:var(--space-xl)}
      .tabs{display:flex;gap:28px;border-bottom:1px solid var(--border);margin-bottom:var(--space-xl)}
      .tabs button{background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);padding:0 0 13px;font:inherit;cursor:pointer}
      .tabs button[aria-selected=true]{color:var(--accent-text);border-color:var(--accent);font-weight:600}
      :focus-visible{outline:2px solid var(--accent);outline-offset:3px}
      @media(max-width:700px){.head{align-items:flex-start;flex-direction:column}}
    </style><section aria-label="资源编辑">
      <button class="btn btn-ghost" .disabled=${this.busy} @click=${() => this.dispatchEvent(new Event('editor-close'))}>返回资源列表</button>
      <div class="head"><div><h1 tabindex="-1">${this.heading}</h1><p>${this.caption}</p></div><slot name="actions"></slot></div>
      <div class="tabs" role="tablist" aria-label="资源编辑页签">
        ${['basic', 'collection'].map((tab, index) => html`<button id=${`tab-${tab}`} role="tab" aria-selected=${this.activeTab === tab} aria-controls=${`panel-${tab}`} tabindex=${this.activeTab === tab ? 0 : -1}
          @click=${() => this.select(tab)} @keydown=${(event: KeyboardEvent) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'basic' : event.key === 'End' ? 'collection' : index ? 'basic' : 'collection';
            this.select(next);
            void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(`#tab-${next}`)?.focus());
          }}>${index ? '监控与采集' : '基本信息'}</button>`)}
      </div>
      <div id="panel-basic" role="tabpanel" aria-labelledby="tab-basic" ?hidden=${this.activeTab !== 'basic'}><slot name="basic"></slot></div>
      <div id="panel-collection" role="tabpanel" aria-labelledby="tab-collection" ?hidden=${this.activeTab !== 'collection'}><slot name="collection"></slot></div>
    </section>`;
  }
}
