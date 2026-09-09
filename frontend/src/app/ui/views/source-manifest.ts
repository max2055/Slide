import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';

interface Manifest { releaseId: string; commitSha: string; treeDigest: string; files: Array<{ path: string; digest: string; bytes: number }>; signature: string }
@customElement('source-manifest')
export class SourceManifestView extends LitElement {
  @property({ type: Number }) revision = 0;
  @state() private manifest: Manifest | null = null;
  @state() private error = '';
  @state() private loading = true;
  private requestVersion = 0;
  static styles = css`
    :host { display: block; min-width: 0; color: var(--text); }
    h2 { font-size: 18px; color: var(--text-strong); margin: 0 0 var(--space-md); }
    :host { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-lg); box-sizing: border-box; }
    dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--space-sm); }
    dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
    p { overflow-wrap: anywhere; } details { margin-top: var(--space-md); } summary { cursor: pointer; }
    .skeleton { height: 80px; background: var(--border); opacity: .4; }
  `;
  protected override willUpdate(changed: Map<string, unknown>) { if (changed.has('revision')) void this.load(); }
  override disconnectedCallback() { this.requestVersion++; super.disconnectedCallback(); }
  private async load() {
    const version = ++this.requestVersion; this.loading = true; this.error = ''; this.manifest = null;
    try {
      const response = await authFetch('/api/platform/source/manifest'); const body = await response.json();
      if (!response.ok && body.error === 'SOURCE_NOT_CONFIGURED') { if (version === this.requestVersion) this.error = '尚未配置部署源码。请先填写 GitLab 地址、项目 ID 和源码路径。'; return; }
      if (!response.ok) throw new Error(body.error ?? `SOURCE_MANIFEST_UNAVAILABLE (${response.status})`);
      if (version === this.requestVersion) this.manifest = body;
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.loading = false; }
  }
  override render() {
    const m = this.manifest;
    return html`<h2>部署源码快照</h2>${this.loading ? html`<div class="skeleton" aria-label="加载源码清单"></div>` : nothing}${this.error ? html`<p role="status">${this.error}</p>` : nothing}
      ${m ? html`<dl><dt>发布</dt><dd>${m.releaseId}</dd><dt>Commit</dt><dd>${m.commitSha}</dd><dt>Tree digest</dt><dd>${m.treeDigest}</dd><dt>签名</dt><dd>${m.signature}</dd></dl><details><summary>文件 (${m.files.length})</summary>${m.files.map(file => html`<p>${file.path} · ${file.bytes} B<br><code>${file.digest}</code></p>`)}</details>` : nothing}`;
  }
}
