/**
 * Docs viewer page — in-app documentation browser
 * Fetches doc list and HTML content from backend API, sanitizes before rendering.
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, state, query } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { authFetch } from "../../../api/index.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import "../components/app-dialog.js";
import { toSanitizedDocumentHtml } from "../markdown.ts";

interface DocEntry {
  file: string;
  title: string;
}

/** Generate an id from heading text matching markdown TOC anchor format */
function slugifyHeading(text: string): string {
  return text
    .trim()
    .replace(/[#？?！!。，,、：:（）()【】\[\]]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

@customElement("docs-viewer-page")
export class DocsViewerPage extends LitElement {
  static styles = [
    sharedBtnStyles,
    css`
    :host {
      display: block; height: 100%; min-width: 0;
      overflow: hidden; container-type: inline-size; color: var(--text);
    }
    *, *::before, *::after { box-sizing: border-box; }
    .docs-layout { display: flex; height: 100%; min-height: 0; }
    .docs-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .docs-toolbar {
      display: flex; align-items: center; gap: var(--space-md);
      padding: var(--space-md) var(--space-xl); border-bottom: 1px solid var(--border);
    }
    .docs-current { min-width: 0; overflow-wrap: anywhere; font-size: 12px; color: var(--muted); }
    .docs-open { display: none; flex-shrink: 0; }
    .docs-directory { display: grid; gap: var(--space-xs); }
    button:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .docs-sidebar {
      width: 240px; flex-shrink: 0; border-right: 1px solid var(--border);
      overflow-y: auto; padding: 8px 0; background: var(--bg-accent);
    }
    .docs-sidebar__title {
      padding: 12px 16px 8px; font-size: 13px; font-weight: 600;
      color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;
    }
    .docs-sidebar__item {
      display: block; width: 100%; padding: 8px 16px;
      font-size: 13px; border: none; background: none;
      text-align: left; cursor: pointer; color: var(--text);
      border-radius: var(--radius-sm); overflow-wrap: anywhere;
    }
    .docs-sidebar__item:hover { background: var(--bg-hover); }
    .docs-sidebar__item--active { background: var(--accent-subtle); color: var(--accent-text); font-weight: 500; }
    .docs-content {
      flex: 1; min-height: 0; min-width: 0;
      overflow-y: auto; padding: var(--space-xl) 32px; overflow-wrap: anywhere;
      font-size: 14px; line-height: 1.9;
    }
    .docs-article { max-width: 820px; min-width: 0; }
    .docs-content .docs-table-scroll, .docs-content .docs-image-scroll { max-width: 100%; overflow-x: auto; margin: var(--space-lg) 0; }
    .docs-content .docs-image-scroll img { min-width: 720px; }
    .docs-content .docs-table-scroll table { margin: 0; overflow-wrap: normal; }
    .docs-content pre, .docs-content .doc-diagram { max-width: 100%; overflow-wrap: normal; }
    .docs-content svg { max-width: 100%; height: auto; }
    @media (prefers-reduced-motion: no-preference) {
      .docs-content { scroll-behavior: smooth; }
    }
    .docs-content h1 { font-size: 24px; margin-top: 0; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .docs-content h2 { font-size: 20px; margin-top: 32px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .docs-content h3 { font-size: 16px; margin-top: 24px; }
    .docs-content table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    .docs-content table th, .docs-content table td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
    .docs-content table th { background: var(--bg-accent); }
    .docs-content pre { background: var(--bg-accent); padding: 16px; border-radius: var(--radius-sm); overflow-x: auto; }
    .docs-content code { font-family: var(--font-mono); font-size: 13px; }
    .docs-content p code { background: var(--bg-accent); padding: 2px 6px; border-radius: var(--radius-sm); }
    .docs-content img { max-width: 100%; }
    .docs-content .doc-attachment {
      margin: 20px 0 28px; padding: 12px; border: 1px solid var(--border);
      background: var(--bg-accent); border-radius: var(--radius-sm);
    }
    .docs-content .doc-attachment img {
      display: block; width: 100%; max-width: 1180px; margin: 0 auto;
      border: 1px solid var(--border); background: var(--bg);
    }
    .docs-content .doc-attachment__caption {
      margin: 10px 4px 0; color: var(--muted); font-size: 13px;
    }
    .docs-content blockquote { border-left: 3px solid var(--border); margin: 16px 0; padding: 4px 16px; color: var(--muted); }
    .docs-content a { color: var(--accent-text); text-decoration: none; }
    .docs-content a:hover { text-decoration: underline; }
    .docs-content .doc-toc {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 10px;
      margin: 16px 0 24px; padding: 0; list-style: none;
    }
    .docs-content .doc-toc li {
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--bg-accent); padding: 10px 12px;
    }
    .docs-content .doc-diagram {
      border: 1px solid var(--border); border-radius: var(--radius-md);
      background: var(--bg-accent); padding: 16px; margin: 16px 0 24px;
      overflow-x: auto;
    }
    .docs-content .doc-flow {
      display: flex; align-items: stretch; gap: 10px; min-width: 720px;
    }
    .docs-content .doc-lane {
      flex: 1; min-width: 130px; border: 1px solid var(--border);
      border-radius: var(--radius-sm); background: var(--bg);
      padding: 12px; text-align: center;
    }
    .docs-content .doc-lane strong {
      display: block; color: var(--text-strong); margin-bottom: 6px;
    }
    .docs-content .doc-lane span {
      display: block; color: var(--muted); font-size: 12px; line-height: 1.5;
    }
    .docs-content .doc-arrow {
      display: flex; align-items: center; color: var(--muted); font-weight: 700;
    }
    .docs-content .doc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 10px; margin: 12px 0; }
    .docs-content .doc-node {
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--bg); padding: 12px;
    }
    .docs-content .doc-node strong {
      display: block; margin-bottom: 6px; color: var(--text-strong);
    }
    .docs-content .doc-node span {
      display: block; color: var(--muted); font-size: 12px; line-height: 1.5;
    }
    .docs-loading { display: flex; align-items: center; justify-content: center; height: 200px; color: var(--muted); }
    .docs-empty {
      display: flex; gap: var(--space-md); flex-wrap: wrap;
      align-items: center; justify-content: center; height: 100%;
      color: var(--muted); font-size: 14px;
    }
    @container (max-width: 850px) {
      .docs-sidebar { display: none; }
      .docs-open { display: inline-flex; }
      .docs-content { padding: var(--space-xl); }
    }
    @container (max-width: 600px) {
      .docs-toolbar { padding: var(--space-md) var(--space-lg); }
      .docs-content { padding: var(--space-lg); }
    }

    `,
  ];

  @state() private docs: DocEntry[] = [];
  @state() private activeDoc: string | null = null;
  @state() private content = "";
  @state() private loading = false;
  @state() private listing = true;
  @state() private directoryOpen = false;
  @state() private error: string | null = null;
  private pendingHash: string | null = null;
  private requestVersion = 0;
  private positions = new Map<string, number>();
  private readonly layoutObserver = new ResizeObserver((entries) => {
    if (entries.some((entry) => entry.contentRect.width > 850)) this.directoryOpen = false;
  });
  @query(".docs-content") private contentEl!: HTMLElement;
  private readonly onHistory = () => {
    // Capture before the application shell normalizes ?tab=docs and clears its query.
    const url = new URL(window.location.href);
    const tab = url.searchParams.get("tab");
    if (tab !== "docs" && (tab || !url.pathname.endsWith("/docs"))) return;
    const file = url.searchParams.get("doc");
    setTimeout(() => {
      if (!this.isConnected) return;
      const selected = this.docs.find(doc => doc.file === file)?.file ?? this.docs[0]?.file;
      if (selected) void this.selectDoc(selected, null, false);
    });
  };

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("popstate", this.onHistory, true);
    this.layoutObserver.observe(this);
    void this.loadDocList();
  }

  disconnectedCallback() {
    this.rememberPosition();
    this.layoutObserver.disconnect();
    this.requestVersion++;
    window.removeEventListener("popstate", this.onHistory, true);
    super.disconnectedCallback();
  }

  private rememberPosition() {
    if (this.activeDoc && !this.loading && this.contentEl) {
      this.positions.set(this.activeDoc, this.contentEl.scrollTop);
    }
  }

  private async loadDocList() {
    this.listing = true;
    this.error = null;
    try {
      const res = await authFetch("/api/docs/list");
      if (!res.ok) throw new Error(res.status === 403 ? "无权读取文档" : `HTTP ${res.status}`);
      const data = await res.json();
      if (!this.isConnected) return;
      this.docs = data.docs || [];
      let selected = new URL(window.location.href).searchParams.get("doc");
      // The shell clears query parameters at bootstrap for legacy ?tab=docs URLs.
      try { selected ??= sessionStorage.getItem("slide.docs.selected.v1"); } catch { /* Storage is optional. */ }
      const file = this.docs.find((doc) => doc.file === selected)?.file ?? this.docs[0]?.file;
      if (file) void this.selectDoc(file, null, false);
    } catch (error) {
      if (this.isConnected)
        this.error =
          error instanceof Error && error.message === "无权读取文档"
            ? error.message
            : "无法加载文档列表";
    } finally {
      this.listing = false;
    }
  }

  private async selectDoc(file: string, hash: string | null = null, navigate = true) {
    this.directoryOpen = false;
    const url = new URL(window.location.href);
    const previous = url.searchParams.get("doc");
    url.searchParams.set("doc", file);
    if (navigate && previous !== file) window.history.pushState(window.history.state, "", url);
    else if (previous !== file) window.history.replaceState(window.history.state, "", url);
    try { sessionStorage.setItem("slide.docs.selected.v1", file); } catch { /* Storage is optional. */ }
    if (file === this.activeDoc && !this.loading && !this.error && this.content) {
      if (hash) this.scrollToHash(hash);
      return;
    }
    this.rememberPosition();
    this.activeDoc = file;
    this.pendingHash = hash;
    const version = ++this.requestVersion;
    this.loading = true;
    this.error = null;
    try {
      const res = await authFetch(`/api/docs/files/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(res.status === 403 ? "无权读取文档" : `HTTP ${res.status}`);
      const data = await res.json();
      if (version !== this.requestVersion) return;
      this.content = data.content || "";
    } catch (error) {
      if (version !== this.requestVersion) return;
      this.error =
        error instanceof Error && error.message === "无权读取文档"
          ? error.message
          : "无法加载文档内容";
      this.content = "";
    } finally {
      if (version === this.requestVersion) this.loading = false;
    }
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    if (
      (changed.has("content") || changed.has("loading")) &&
      this.content &&
      !this.loading &&
      !this.error
    ) {
      this.addHeadingIds();
      this.prepareScrollRegions();
      if (this.contentEl) this.contentEl.scrollTop = this.positions.get(this.activeDoc ?? "") ?? 0;
      this.scrollToHash(this.pendingHash);
      this.pendingHash = null;
    }
  }

  /** Enhance only sanitized DOM; keep tables semantic inside named keyboard scroll regions. */
  private prepareScrollRegions() {
    this.contentEl?.querySelectorAll("table").forEach((table) => {
      if (table.parentElement?.classList.contains("docs-table-scroll")) return;
      const region = document.createElement("div");
      region.className = "docs-table-scroll";
      table.before(region);
      region.append(table);
    });
    this.contentEl?.querySelectorAll(".doc-attachment img").forEach((image) => {
      if (image.parentElement?.classList.contains("docs-image-scroll")) return;
      const region = document.createElement("div");
      region.className = "docs-image-scroll";
      image.before(region);
      region.append(image);
    });
    this.contentEl
      ?.querySelectorAll<HTMLElement>(".docs-table-scroll, .docs-image-scroll, pre, .doc-diagram")
      .forEach((region, index) => {
        region.tabIndex = 0;
        region.setAttribute("role", "region");
        region.setAttribute(
          "aria-label",
          `${region.tagName === "PRE" ? "代码" : region.classList.contains("doc-diagram") || region.classList.contains("docs-image-scroll") ? "图形" : "表格"} ${index + 1}，可横向滚动`,
        );
      });
  }

  /** Add id attributes to all headings so TOC anchor links work */
  private addHeadingIds() {
    if (!this.contentEl) return;
    const headings = this.contentEl.querySelectorAll("h1, h2, h3, h4, h5, h6");
    headings.forEach((h) => {
      if (!h.id) {
        h.id = slugifyHeading(h.textContent || "");
      }
    });
  }

  /** Scroll to the element matching the current URL hash */
  private scrollToHash(hash: string | null = null) {
    const rawHash = hash ?? window.location.hash.slice(1);
    if (!rawHash || !this.contentEl) return;
    let targetId: string;
    try {
      targetId = decodeURIComponent(rawHash);
    } catch {
      return;
    }
    this.scrollToTarget(targetId);
  }

  private scrollToTarget(targetId: string) {
    const target = this.contentEl.querySelector(`#${CSS.escape(targetId)}`);
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  /** Intercept clicks on in-page anchor links within the docs content */
  private handleContentClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const anchor = target.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      e.preventDefault();
      this.scrollToTarget(decodeURIComponent(href.slice(1)));
      return;
    }

    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }

    const file = decodeURIComponent(url.pathname.split("/").pop() || "");
    if (!file.endsWith(".html") || !this.docs.some((doc) => doc.file === file)) {
      return;
    }

    e.preventDefault();
    this.selectDoc(file, url.hash ? url.hash.slice(1) : null);
  }

  private renderDirectory() {
    return html`<nav class="docs-directory" aria-label="文档目录">
      ${this.docs.map(
        (doc) => html`<button
          type="button"
          class="docs-sidebar__item ${this.activeDoc === doc.file ? "docs-sidebar__item--active" : ""}"
          aria-current=${this.activeDoc === doc.file ? "page" : nothing}
          @click=${() => this.selectDoc(doc.file)}
        >
          ${doc.title}
        </button>`,
      )}
      ${this.listing ? html`<p role="status">加载目录中…</p>` : nothing}
      ${!this.listing && !this.docs.length ? html`<p>${this.error ?? "暂无可用文档"}</p>` : nothing}
    </nav>`;
  }

  render() {
    const title = this.docs.find((doc) => doc.file === this.activeDoc)?.title ?? "文档阅读";
    return html`
      <div class="docs-layout">
        <aside class="docs-sidebar" aria-label="文档浏览">
          <div class="docs-sidebar__title">文档目录</div>
          ${this.renderDirectory()}
        </aside>
        <div class="docs-main">
          <div class="docs-toolbar">
            <button
              type="button"
              class="btn docs-open"
              aria-haspopup="dialog"
              aria-expanded=${this.directoryOpen}
              @click=${() => {
                this.directoryOpen = true;
              }}
            >
              打开文档目录
            </button>
            <span class="docs-current">${title}</span>
          </div>
          <div
            class="docs-content"
            aria-label="文档正文"
            aria-busy=${this.loading || this.listing}
            @click=${this.handleContentClick}
          >
            ${
              this.error
                ? html`<div class="docs-empty" role="alert">
                    ${this.error}<button
                      class="btn"
                      type="button"
                      @click=${() => (this.activeDoc ? this.selectDoc(this.activeDoc) : this.loadDocList())}
                    >
                      重试
                    </button>
                  </div>`
                : this.loading || this.listing
                  ? html`<div class="docs-loading" role="status">加载中...</div>`
                  : this.content
                    ? html`<article class="docs-article">
                        ${unsafeHTML(toSanitizedDocumentHtml(this.content))}
                      </article>`
                    : html`<div class="docs-empty">
                        ${this.docs.length ? "当前文档暂无内容" : "暂无可用文档"}
                      </div>`
            }
          </div>
        </div>
      </div>
      <app-dialog
        .open=${this.directoryOpen}
        size="sm"
        title="文档目录"
        @app-dialog-close=${() => {
          this.directoryOpen = false;
        }}
        >${this.renderDirectory()}</app-dialog
      >
    `;
  }
}
