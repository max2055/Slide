/**
 * Docs viewer page — in-app documentation browser
 * Fetches doc list and content from backend API, renders via markdown-it + DOMPurify
 */
import { LitElement, html, css } from "lit";
import { customElement, state, query } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { authFetch } from "../../../api/index.js";
import { toSanitizedMarkdownHtml } from "../markdown.ts";

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
  static styles = css`
    :host { display: flex; height: 100%; overflow: hidden; }
    .docs-sidebar {
      width: 240px; min-width: 240px; border-right: 1px solid var(--border);
      overflow-y: auto; padding: 8px 0; background: var(--bg-secondary, var(--bg));
    }
    .docs-sidebar__title {
      padding: 12px 16px 8px; font-size: 13px; font-weight: 600;
      color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;
    }
    .docs-sidebar__item {
      display: block; width: 100%; padding: 8px 16px; font-size: 13px;
      border: none; background: none; text-align: left; cursor: pointer;
      color: var(--fg); border-radius: 0;
    }
    .docs-sidebar__item:hover { background: var(--bg-hover); }
    .docs-sidebar__item--active {
      background: var(--bg-active); color: var(--fg-active); font-weight: 500;
    }
    .docs-content {
      flex: 1; overflow-y: auto; padding: 32px 48px; max-width: 900px;
      scroll-behavior: smooth;
    }
    .docs-content h1 { font-size: 28px; margin-top: 0; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .docs-content h2 { font-size: 22px; margin-top: 32px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .docs-content h3 { font-size: 18px; margin-top: 24px; }
    .docs-content table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    .docs-content table th, .docs-content table td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
    .docs-content table th { background: var(--bg-secondary); }
    .docs-content pre { background: var(--bg-code); padding: 16px; border-radius: 6px; overflow-x: auto; }
    .docs-content code { font-family: var(--font-mono); font-size: 13px; }
    .docs-content p code { background: var(--bg-code); padding: 2px 6px; border-radius: 3px; }
    .docs-content img { max-width: 100%; }
    .docs-content blockquote { border-left: 3px solid var(--border); margin: 16px 0; padding: 4px 16px; color: var(--muted); }
    .docs-loading { display: flex; align-items: center; justify-content: center; height: 200px; color: var(--muted); }
    .docs-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--muted); font-size: 14px; }
  `;

  @state() private docs: DocEntry[] = [];
  @state() private activeDoc: string | null = null;
  @state() private content: string = "";
  @state() private loading: boolean = false;
  @state() private error: string | null = null;
  @query(".docs-content") private contentEl!: HTMLElement;

  connectedCallback() {
    super.connectedCallback();
    this.loadDocList();
  }

  private async loadDocList() {
    try {
      const res = await authFetch("/api/docs/list");
      const data = await res.json();
      this.docs = data.docs || [];
      if (this.docs.length > 0 && !this.activeDoc) {
        this.selectDoc(this.docs[0].file);
      }
    } catch {
      this.error = "无法加载文档列表";
    }
  }

  private async selectDoc(file: string) {
    this.activeDoc = file;
    this.loading = true;
    this.error = null;
    try {
      const res = await authFetch(`/api/docs/content/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.content = data.content || "";
    } catch {
      this.error = "无法加载文档内容";
      this.content = "";
    } finally {
      this.loading = false;
    }
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    if (changed.has("content") && this.content) {
      this.addHeadingIds();
      this.scrollToHash();
    }
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
  private scrollToHash() {
    const hash = window.location.hash;
    if (!hash || !this.contentEl) return;
    // Decode the hash, strip leading #
    const targetId = decodeURIComponent(hash.slice(1));
    const target = this.contentEl.querySelector(`#${CSS.escape(targetId)}`);
    if (target) {
      // Small delay to ensure DOM is fully rendered
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
    if (!href || !href.startsWith("#")) return;
    // In-page anchor — scroll to target instead of navigating URL
    e.preventDefault();
    const targetId = decodeURIComponent(href.slice(1));
    const el = this.contentEl?.querySelector(`#${CSS.escape(targetId)}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  render() {
    return html`
      <div class="docs-sidebar">
        <div class="docs-sidebar__title">文档目录</div>
        ${this.docs.map(
          (doc) => html`
            <button
              class="docs-sidebar__item ${this.activeDoc === doc.file ? "docs-sidebar__item--active" : ""}"
              @click=${() => this.selectDoc(doc.file)}
            >
              ${doc.title}
            </button>
          `
        )}
      </div>
      <div class="docs-content" @click=${this.handleContentClick}>
        ${this.error
          ? html`<div class="docs-empty">${this.error}</div>`
          : this.loading
            ? html`<div class="docs-loading">加载中...</div>`
            : this.content
              ? html`${unsafeHTML(toSanitizedMarkdownHtml(this.content))}`
              : html`<div class="docs-empty">请从左侧选择文档</div>`
        }
      </div>
    `;
  }
}
