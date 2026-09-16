import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';

interface Manifest {
  releaseId: string; commitSha: string; treeDigest: string; files: Array<{ path: string; digest: string; bytes: number }>; signature: string;
  completeness?: 'complete' | 'partial'; skippedFiles?: Array<{ path: string; reason: string }>;
  verification?: { status: 'repository-unbound' | 'deployment-verified'; reason?: string };
  repository?: { origin: string; ref: string };
}
const reasons: Record<string, string> = {
  SOURCE_SENSITIVE_CONTENT: '含疑似敏感信息', SOURCE_FILE_TOO_LARGE: '文件过大或非文本内容',
  SOURCE_CONFIG_UNSCANNABLE: '配置文件无法安全解析', SOURCE_PATH_INVALID: '不在可读源码范围', SOURCE_SYMLINK_SKIPPED: '符号链接',
  SOURCE_DEPLOYMENT_UNKNOWN: '未提供完整部署版本信息', SOURCE_COMMIT_MISMATCH: '仓库提交与部署提交不同',
  SOURCE_TREE_MISMATCH: '源码范围或内容与部署记录不同', SOURCE_SNAPSHOT_PARTIAL: '部分文件已跳过',
};
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
      const response = await authFetch('/api/platform/source/manifest'); const text = await response.text(); let body: any = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
      if (!response.ok && body.error === 'SOURCE_NOT_CONFIGURED') { if (version === this.requestVersion) this.error = '尚未配置源码仓库。请先填写平台地址和仓库路径。'; return; }
      if (!response.ok && body.error === 'SOURCE_NOT_SYNCED') { if (version === this.requestVersion) this.error = '当前仓库和分支尚未同步，请先同步源码。'; return; }
      if (!response.ok) throw new Error(body.error ?? `SOURCE_MANIFEST_UNAVAILABLE (${response.status})`);
      if (version === this.requestVersion) this.manifest = body;
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.loading = false; }
  }
  override render() {
    const m = this.manifest;
    return html`<h2>仓库源码快照</h2>${this.loading ? html`<div class="skeleton" aria-label="加载源码清单"></div>` : nothing}${this.error ? html`<p role="status">${this.error}</p>` : nothing}
      ${m ? html`
        <p role="status">${m.verification?.status === 'deployment-verified' ? '已验证部署一致性' : '未验证部署一致性'} · ${m.completeness === 'partial' ? '部分同步' : '同步完成'}</p>
        ${m.verification?.reason ? html`<p>${reasons[m.verification.reason] ?? m.verification.reason}。源码可用于理解实现，不能证明实际运行行为。</p>` : nothing}
        <dl><dt>快照</dt><dd>${m.releaseId}</dd><dt>Commit</dt><dd>${m.commitSha}</dd>${m.repository ? html`<dt>分支或引用</dt><dd>${m.repository.ref}</dd>` : nothing}<dt>Tree digest</dt><dd>${m.treeDigest}</dd><dt>签名</dt><dd>${m.signature}</dd></dl>
        ${m.skippedFiles?.length ? html`<details open><summary>已跳过 (${m.skippedFiles.length})</summary>${m.skippedFiles.map(file => html`<p>${file.path} · ${reasons[file.reason] ?? file.reason}</p>`)}</details>` : nothing}
        <details><summary>文件 (${m.files.length})</summary>${m.files.map(file => html`<p>${file.path} · ${file.bytes} B<br><code>${file.digest}</code></p>`)}</details>` : nothing}`;
  }
}
