import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.ts";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { showToast } from "./app-toast-container.ts";

/** Shared explicit historical navigation. No automatic fetch or execution;
 * invalidation prevents a late acceptance navigating after logout/removal. */
@customElement("legacy-analysis-link")
export class LegacyAnalysisLink extends LitElement {
  @property({ type: Number }) analysisId = 0;
  @property() status = "";
  @state() private busy = false;
  private generation = 0;
  private invalidate = () => {
    this.generation++;
    this.busy = false;
  };
  static styles = [sharedBtnStyles];
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("slide-session-expired", this.invalidate);
    window.addEventListener("slide-permissions-loaded", this.invalidate);
  }
  disconnectedCallback() {
    this.invalidate();
    window.removeEventListener("slide-session-expired", this.invalidate);
    window.removeEventListener("slide-permissions-loaded", this.invalidate);
    super.disconnectedCallback();
  }
  private async open() {
    if (this.busy) return;
    const id = this.analysisId,
      generation = ++this.generation;
    this.busy = true;
    try {
      const response = await authFetch(`/api/ai/analysis/${id}/investigation`, { method: "POST" });
      if (!response.ok) throw new Error("LEGACY_LINK_UNAVAILABLE");
      const value = await response.json();
      if (generation !== this.generation || !this.isConnected || id !== this.analysisId) return;
      this.dispatchEvent(
        new CustomEvent("legacy-investigation-opened", { bubbles: true, composed: true }),
      );
      window.dispatchEvent(
        new CustomEvent("slide-navigate", {
          detail: { tab: "investigations", investigationId: value.id },
        }),
      );
    } catch {
      if (generation === this.generation && this.isConnected)
        showToast("历史结果链接不可用或已无权限", "error");
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  render() {
    return Number.isSafeInteger(this.analysisId) &&
      this.analysisId > 0 &&
      ["completed", "failed", "unknown"].includes(this.status)
      ? html`<button class="btn" ?disabled=${this.busy} @click=${() => void this.open()}>
          在工作空间查看历史结果
        </button>`
      : nothing;
  }
}
