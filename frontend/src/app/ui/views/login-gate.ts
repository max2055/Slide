import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import { icons } from "../../../icons.js";
import { normalizeBasePath } from "../navigation.ts";
import { agentLogoUrl } from "./agents-utils.ts";
import { renderConnectCommand } from "./connect-command.ts";
import { showToast } from "../components/app-toast-container.js";

export function renderLoginGate(state: AppViewState) {
  const basePath = normalizeBasePath(state.basePath ?? "");
  const faviconSrc = agentLogoUrl(basePath);

  // Shared login handler — validates credentials via REST API before connecting.
  // Used by both the Login button and the Enter key to prevent bypass.
  const doLogin = async () => {
    const u = state.settings.username?.trim();
    const p = state.password?.trim();
    if (!u || !p) {
      state.lastError = '请输入用户名和密码';
      return;
    }
    state.lastError = null;
    const { apiClient } = await import("../../../api/index.js");
    let token: string | null;
    try {
      token = await apiClient.directLogin(u, p);
    } catch (err) {
      // Network or server error — backend unreachable, not a credential issue
      state.lastError = '无法连接服务器。请确认后端服务已启动（http://localhost:3000），然后刷新页面重试。';
      showToast('Server unreachable', 'error');
      return;
    }
    if (!token) {
      state.lastError = '用户名或密码错误，请重试。';
      return;
    }
    fetch('/api/auth/permissions', {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json()).then((perms: string[]) => {
      localStorage.setItem('permissions', JSON.stringify(perms));
      window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: perms } }));
    }).catch(() => {});
    state.connect();
  };

  return html`
    <div class="login-gate">
      <div class="login-gate__card">
        <div class="login-gate__header">
          <img class="login-gate__logo" src=${faviconSrc} alt="Slide" />
          <div class="login-gate__title">Slide</div>
          <div class="login-gate__sub">${t("login.subtitle")}</div>
        </div>
        <div class="login-gate__form">
          <label class="field">
            <span>${t("overview.access.username")}</span>
            <input
              type="text"
              autocomplete="username"
              spellcheck="false"
              .value=${state.settings.username}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                state.applySettings({ ...state.settings, username: v });
              }}
              placeholder="${t("login.usernamePlaceholder")}"
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  doLogin();
                }
              }}
            />
          </label>
          <label class="field">
            <span>${t("overview.access.password")}</span>
            <div class="login-gate__secret-row">
              <input
                type=${state.loginShowGatewayPassword ? "text" : "password"}
                autocomplete="current-password"
                spellcheck="false"
                .value=${state.password}
                @input=${(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  state.setPassword?.(v);
                }}
                placeholder="${t("login.passwordPlaceholder")}"
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    doLogin();
                  }
                }}
              />
              <button
                type="button"
                class="btn btn--icon ${state.loginShowGatewayPassword ? "active" : ""}"
                title=${state.loginShowGatewayPassword ? "Hide password" : "Show password"}
                aria-label="Toggle password visibility"
                aria-pressed=${state.loginShowGatewayPassword}
                @click=${() => {
                  state.loginShowGatewayPassword = !state.loginShowGatewayPassword;
                }}
              >
                ${state.loginShowGatewayPassword ? icons['eye'] : icons['eye-off']}
              </button>
            </div>
          </label>
          <button class="btn primary login-gate__connect" @click=${doLogin}>
            ${t("common.connect")}
          </button>
        </div>
        ${state.lastError
          ? html`<div class="callout danger" style="margin-top: 14px;">
              <div>${state.lastError}</div>
            </div>`
          : ""}
      </div>
    </div>
  `;
}
