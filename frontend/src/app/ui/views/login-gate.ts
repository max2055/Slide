import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import { icons } from "../../../icons.js";
import { normalizeBasePath } from "../navigation.ts";
import { agentLogoUrl } from "./agents-utils.ts";
import "../components/app-notice.ts";

const pendingLogins = new WeakSet<AppViewState>();

export function renderLoginGate(state: AppViewState) {
  const basePath = normalizeBasePath(state.basePath ?? "");
  const faviconSrc = agentLogoUrl(basePath);
  const pending = pendingLogins.has(state);
  const requestUpdate = () => (state as AppViewState & { requestUpdate?: () => void }).requestUpdate?.();

  // Shared login handler — validates credentials via REST API before connecting.
  // Used by both the Login button and the Enter key to prevent bypass.
  const doLogin = async () => {
    if (pendingLogins.has(state)) return;
    const u = state.settings.username?.trim();
    const p = state.password;
    if (!u || !p) {
      state.lastError = t("login.requiredCredentials");
      return;
    }
    pendingLogins.add(state);
    state.lastError = null;
    requestUpdate();
    let token: string | null;
    try {
      const { apiClient } = await import("../../../api/index.js");
      token = await apiClient.directLogin(u, p);
    } catch {
      // Network or server error — backend unreachable, not a credential issue
      state.lastError = t("login.serverUnavailable", {
        address: new URL('/api/auth/login', window.location.origin).href,
      });
      return;
    } finally {
      pendingLogins.delete(state);
      requestUpdate();
    }
    if (!token) {
      state.lastError = t("login.invalidCredentials");
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
        <form class="login-gate__form" novalidate aria-busy=${pending}
          @submit=${(e: SubmitEvent) => { e.preventDefault(); void doLogin(); }}>
          <label class="field">
            <span>${t("login.username")}</span>
            <input
              type="text"
              autocomplete="username"
              required
              spellcheck="false"
              .value=${state.settings.username}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                state.applySettings({ ...state.settings, username: v });
              }}
              placeholder="${t("login.usernamePlaceholder")}"
            />
          </label>
          <label class="field">
            <span>${t("login.password")}</span>
            <div class="login-gate__secret-row">
              <input
                type=${state.loginShowGatewayPassword ? "text" : "password"}
                autocomplete="current-password"
                required
                spellcheck="false"
                .value=${state.password}
                @input=${(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  state.setPassword?.(v);
                }}
                placeholder="${t("login.passwordPlaceholder")}"
              />
              <button
                type="button"
                class="btn btn--icon ${state.loginShowGatewayPassword ? "active" : ""}"
                title=${t(state.loginShowGatewayPassword ? "login.hidePassword" : "login.showPassword")}
                aria-label=${t(state.loginShowGatewayPassword ? "login.hidePassword" : "login.showPassword")}
                aria-pressed=${state.loginShowGatewayPassword}
                @click=${() => {
                  state.loginShowGatewayPassword = !state.loginShowGatewayPassword;
                }}
              >
                ${state.loginShowGatewayPassword ? icons['eye'] : icons['eye-off']}
              </button>
            </div>
          </label>
          <button type="submit" class="btn-primary login-gate__connect" ?disabled=${pending}>
            ${t(pending ? "login.submitting" : "login.submit")}
          </button>
        </form>
        ${state.lastError
          ? html`<app-notice severity="error" role="alert">${state.lastError}</app-notice>`
          : ""}
      </div>
    </div>
  `;
}
