import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import "../components/app-dialog.ts";

export function renderGatewayUrlConfirmation(state: AppViewState) {
  const { pendingGatewayUrl } = state;
  if (!pendingGatewayUrl) {
    return nothing;
  }

  return html`
    <app-dialog
      .open=${true}
      .closable=${false}
      title=${t("channels.gatewayUrlConfirmation.title")}
      @keydown=${(event: KeyboardEvent) => {
        // Keep only the two decision controls; Escape uses the same cancel path.
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          state.handleGatewayUrlCancel();
        }
      }}
    >
      <div class="exec-approval-sub">${t("channels.gatewayUrlConfirmation.subtitle")}</div>
      <div class="exec-approval-command mono">${pendingGatewayUrl}</div>
      <div class="callout danger" style="margin-top: 12px;">
        ${t("channels.gatewayUrlConfirmation.warning")}
      </div>
      <div slot="footer" class="exec-approval-actions">
        <button class="btn-primary" autofocus @click=${() => state.handleGatewayUrlConfirm()}>
          ${t("common.confirm")}
        </button>
        <button class="btn" @click=${() => state.handleGatewayUrlCancel()}>
          ${t("common.cancel")}
        </button>
      </div>
    </app-dialog>
  `;
}
