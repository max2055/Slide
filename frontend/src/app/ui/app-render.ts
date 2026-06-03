import { html, nothing } from "lit";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "./routing/session-key.ts";
import { t } from "../i18n/index.ts";
import { getSafeLocalStorage } from "./local-storage.ts";
import { refreshChatAvatar } from "./app-chat.ts";

function runUpdate(_state: unknown) { /* noop */ }
import { renderChatControls, renderChatMobileToggle, renderChatSessionSelect } from "./app-render.helpers.ts";
import {
  hasSlidePermission,
} from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { loadAgents, saveAgentsConfig } from "./controllers/agents.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import "./components/dashboard-header.ts";
import "./components/app-toggle.ts";
import "./components/app-select-field.ts";
import "./components/app-option-group.ts";
import "./components/status-badge.ts";
import "./views/dashboard.ts";
import "./views/instances-db.ts";
import "./views/instance-detail.ts";
import "./views/llm-config.ts";
import "./views/ai-settings.ts";
import "./views/scoring-settings.ts";
import "./views/cron-jobs-settings.ts";
import "./views/sql-console.ts";
import "./views/approval-dashboard.ts";
import "./views/alerts.ts";
import "./views/schema-management.ts";
import "./views/index-management.ts";
import "./views/reports.ts";
import "./views/metric-registry.ts";
import "./views/metric-templates.ts";
import "./views/event-management.ts";
import "./views/users-management.ts";
import "./views/rbac-page.ts";
import "./views/docs-viewer.ts";
import "./views/settings-shell.ts";
import "./views/appearance-settings.ts";
import "./views/branding-settings.ts";
import { icons } from "../../icons.js";
import { normalizeBasePath, TAB_GROUPS, TAB_REQUIRED_PERMISSIONS, subtitleForTab, titleForTab } from "./navigation.ts";
import { agentLogoUrl } from "./views/agents-utils.ts";
import { renderChat } from "./views/chat.ts";
import { renderCommandPalette } from "./views/command-palette.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderLoginGate } from "./views/login-gate.ts";
import {
  renderTab,
  resolveAssistantAttachmentAuthToken,
  renderSidebarConnectionStatus,
  switchChatSession,
} from "./app-render.helpers.ts";

// Lazy-loaded view modules – deferred so the initial bundle stays small.
// Each loader resolves once; subsequent calls return the cached module.
type LazyState<T> = { mod: T | null; promise: Promise<T> | null };

let _pendingUpdate: (() => void) | undefined;

function createLazy<T>(loader: () => Promise<T>): () => T | null {
  const s: LazyState<T> = { mod: null, promise: null };
  return () => {
    if (s.mod) {
      return s.mod;
    }
    if (!s.promise) {
      s.promise = loader().then((m) => {
        s.mod = m;
        _pendingUpdate?.();
        return m;
      });
    }
    return null;
  };
}

const lazyAgents = createLazy(() => import("./views/agents.ts"));
const lazySessions = createLazy(() => import("./views/sessions.ts"));
function lazyRender<M>(getter: () => M | null, render: (mod: M) => unknown) {
  const mod = getter();
  return mod ? render(mod) : nothing;
}

const UPDATE_BANNER_DISMISS_KEY = "slide:control-ui:update-banner-dismissed:v1";


type DismissedUpdateBanner = {
  latestVersion: string;
  channel: string | null;
  dismissedAtMs: number;
};

function loadDismissedUpdateBanner(): DismissedUpdateBanner | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(UPDATE_BANNER_DISMISS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DismissedUpdateBanner>;
    if (!parsed || typeof parsed.latestVersion !== "string") {
      return null;
    }
    return {
      latestVersion: parsed.latestVersion,
      channel: typeof parsed.channel === "string" ? parsed.channel : null,
      dismissedAtMs: typeof parsed.dismissedAtMs === "number" ? parsed.dismissedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

function isUpdateBannerDismissed(updateAvailable: unknown): boolean {
  const dismissed = loadDismissedUpdateBanner();
  if (!dismissed) {
    return false;
  }
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  return Boolean(
    latestVersion && dismissed.latestVersion === latestVersion && dismissed.channel === channel,
  );
}

function dismissUpdateBanner(updateAvailable: unknown) {
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  if (!latestVersion) {
    return;
  }
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  const payload: DismissedUpdateBanner = {
    latestVersion,
    channel,
    dismissedAtMs: Date.now(),
  };
  try {
    getSafeLocalStorage()?.setItem(UPDATE_BANNER_DISMISS_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) {
    return undefined;
  }
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) {
    return candidate;
  }
  return identity?.avatarUrl;
}

function loadPermissionsFromStorage(): Set<string> | null {
  try {
    const stored = localStorage.getItem('permissions');
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return null;
}

export function renderApp(state: AppViewState) {
  const updatableState = state as AppViewState & { requestUpdate?: () => void };
  const requestHostUpdate =
    typeof updatableState.requestUpdate === "function"
      ? () => updatableState.requestUpdate?.()
      : undefined;
  _pendingUpdate = requestHostUpdate;

  // Gate: require successful gateway connection before showing the dashboard.
  // The gateway URL confirmation overlay is always rendered so URL-param flows still work.
  if (!state.connected) {
    return html` ${renderLoginGate(state)} ${renderGatewayUrlConfirmation(state)} `;
  }

  const chatDisabledReason = state.lastError;
  const isChat = state.tab === "chat";
  const chatFocus = isChat && (state.settings.chatFocusMode || state.onboarding);
  const navDrawerOpen = state.navDrawerOpen && !chatFocus && !state.onboarding;
  const navCollapsed = state.settings.navCollapsed && !navDrawerOpen;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAvatarUrl = state.chatAvatarUrl ?? assistantAvatarUrl ?? null;
  const basePath = normalizeBasePath(state.basePath ?? "");
  const resolveSelectedAgentId = () =>
    state.agentsSelectedId ??
    state.agentsList?.defaultId ??
    state.agentsList?.agents?.[0]?.id ??
    null;
  const resolvedAgentId = resolveSelectedAgentId();
  const activeSessionAgentId = resolveAgentIdFromSessionKey(state.sessionKey);
  const toolsPanelUsesActiveSession = Boolean(
    resolvedAgentId && activeSessionAgentId && resolvedAgentId === activeSessionAgentId,
  );
  const getCurrentConfigValue = () =>
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const resolveAgentToolsPath = (_agentId: string, _ensure: boolean) => null;
  const resolveAgentModelFormEntry = (index: number) => {
    const list = (getCurrentConfigValue() as { agents?: { list?: unknown[] } } | null)?.agents
      ?.list;
    const existing = Array.isArray(list)
      ? (list[index] as { model?: unknown } | undefined)?.model
      : undefined;
    return {
      basePath: ["agents", "list", index, "model"] as Array<string | number>,
      existing,
    };
  };
  const loadAgentPanelDataForSelectedAgent = (agentId: string | null) => {
    if (!agentId) {
      return;
    }
    switch (state.agentsPanel) {
      case "files":
        return;
      case "skills":
        return;
      case "tools":
        return;
    }
  };
  const refreshAgentsPanelSupplementalData = (panel: AppViewState["agentsPanel"]) => {
  };
  const resetAgentFilesState = (clearLoading = false) => {
    state.agentFilesList = null;
    state.agentFilesError = null;
    state.agentFileActive = null;
    state.agentFileContents = {};
    state.agentFileDrafts = {};
    if (clearLoading) {
      state.agentFilesLoading = false;
    }
  };
  const resetAgentSelectionPanelState = () => {
    resetAgentFilesState(true);
    state.agentSkillsReport = null;
    state.agentSkillsError = null;
    state.agentSkillsAgentId = null;
    state.toolsCatalogResult = null;
    state.toolsCatalogError = null;
    state.toolsCatalogLoading = false;
  };

  return html`
    ${renderCommandPalette({
      open: state.paletteOpen,
      query: state.paletteQuery,
      activeIndex: state.paletteActiveIndex,
      onToggle: () => {
        state.paletteOpen = !state.paletteOpen;
      },
      onQueryChange: (q) => {
        state.paletteQuery = q;
      },
      onActiveIndexChange: (i) => {
        state.paletteActiveIndex = i;
      },
      onNavigate: (tab) => {
        state.setTab(tab as import("./navigation.ts").Tab);
      },
      onSlashCommand: (cmd) => {
        state.setTab("chat" as import("./navigation.ts").Tab);
        state.chatMessage = cmd.endsWith(" ") ? cmd : `${cmd} `;
      },
    })}
    <div
      class="shell ${isChat ? "shell--chat" : ""} ${chatFocus
        ? "shell--chat-focus"
        : ""} ${navCollapsed ? "shell--nav-collapsed" : ""} ${navDrawerOpen
        ? "shell--nav-drawer-open"
        : ""} ${state.onboarding ? "shell--onboarding" : ""}"
    >
      <button
        type="button"
        class="shell-nav-backdrop"
        aria-label="${t("nav.collapse")}"
        @click=${() => {
          state.navDrawerOpen = false;
        }}
      ></button>
      <header class="topbar">
        <div class="topnav-shell">
          <button
            type="button"
            class="topbar-nav-toggle"
            @click=${() => {
              state.navDrawerOpen = !navDrawerOpen;
            }}
            title="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-label="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-expanded=${navDrawerOpen}
          >
            <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons['menu']}</span>
          </button>
          <div class="topnav-shell__content">
            <dashboard-header .tab=${state.tab}></dashboard-header>
          </div>
          <div class="topnav-shell__actions">
            <button
              class="topbar-search"
              @click=${() => {
                state.paletteOpen = !state.paletteOpen;
              }}
              title="Search or jump to… (⌘K)"
              aria-label="Open command palette"
            >
              <span class="topbar-search__label">${t("common.search")}</span>
              <kbd class="topbar-search__kbd">⌘K</kbd>
            </button>
            <div class="topbar-status">
              ${isChat ? renderChatMobileToggle(state) : nothing}
              <div class="topnav-shell__user">
                <span class="topnav-shell__user-badge">${(state.settings.username || 'A').charAt(0).toUpperCase()}</span>
                <span class="topnav-shell__user-name">${state.settings.username || 'Admin'}</span>
                <button
                  class="topnav-shell__logout-btn"
                  @click=${() => state.logout()}
                  title="退出登录"
                  aria-label="退出登录"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                    <polyline points="16,17 21,12 16,7"/>
                    <line x1="21" y1="12" x2="9" y2="12"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>
      <div class="shell-nav">
        <aside class="sidebar ${navCollapsed ? "sidebar--collapsed" : ""}">
          <div class="sidebar-shell">
            <div class="sidebar-shell__header">
              <div class="sidebar-brand">
                ${navCollapsed
                  ? nothing
                  : html`
                      <img
                        class="sidebar-brand__logo"
                        src="${agentLogoUrl(basePath)}"
                        alt="Slide"
                      />
                      <span class="sidebar-brand__copy">
                        <span class="sidebar-brand__eyebrow">${t("nav.control")}</span>
                        <span class="sidebar-brand__title">Slide</span>
                      </span>
                    `}
              </div>
              <button
                type="button"
                class="nav-collapse-toggle"
                @click=${() =>
                  state.applySettings({
                    ...state.settings,
                    navCollapsed: !state.settings.navCollapsed,
                  })}
                title="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
                aria-label="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
              >
                <span class="nav-collapse-toggle__icon" aria-hidden="true"
                  >${navCollapsed ? icons['panel-left-open'] : icons['panel-left-close']}</span
                >
              </button>
            </div>
            <div class="sidebar-shell__body">
              <nav class="sidebar-nav">
                ${TAB_GROUPS.map((group) => {
                  const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
                  const hasActiveTab = group.tabs.some((tab) => tab === state.tab);
                  const showItems = navCollapsed || hasActiveTab || !isGroupCollapsed;

                  return html`
                    <section class="nav-section ${!showItems ? "nav-section--collapsed" : ""}">
                      ${!navCollapsed
                        ? html`
                            <button
                              class="nav-section__label"
                              @click=${() => {
                                const next = { ...state.settings.navGroupsCollapsed };
                                next[group.label] = !isGroupCollapsed;
                                state.applySettings({
                                  ...state.settings,
                                  navGroupsCollapsed: next,
                                });
                              }}
                              aria-expanded=${showItems}
                            >
                              <span class="nav-section__label-text"
                                >${t(`nav.${group.label}`)}</span
                              >
                              <span class="nav-section__chevron"> ${icons['chevron-down']} </span>
                            </button>
                          `
                        : nothing}
                      <div class="nav-section__items">
                        ${group.tabs.filter((tab) => {
                          // User-configured tab visibility: empty = show all, non-empty = only show listed
                          const visibleTabs = state.settings.visibleTabs;
                          if (visibleTabs && visibleTabs.length > 0 && !visibleTabs.includes(tab)) {
                            return false;
                          }
                          const required = TAB_REQUIRED_PERMISSIONS[tab];
                          if (!required) return true; // No requirement = always visible
                          // Get permissions from state or localStorage
                          const perms = state.userPermissions || loadPermissionsFromStorage();
                          return hasSlidePermission(perms, required);
                        }).map((tab) =>
                          renderTab(state, tab, { collapsed: navCollapsed }),
                        )}
                      </div>
                    </section>
                  `;
                })}
              </nav>
            </div>
            <div class="sidebar-shell__footer">
              <div class="sidebar-utility-group">
                <button
                  class="nav-item sidebar-utility-link"
                  @click=${() => {
                    window.dispatchEvent(new CustomEvent("slide-navigate", {
                      detail: { tab: "docs" }
                    }));
                  }}
                  title="${t("common.docs")}"
                >
                  <span class="nav-item__icon" aria-hidden="true">${icons['book']}</span>
                  ${!navCollapsed
                    ? html`<span class="nav-item__text">${t("common.docs")}</span>`
                    : nothing}
                </button>
                ${(() => {
                  const slideVersion = state.slideVersion || "Slide";
                  return html`
                        <div class="sidebar-version" title=${slideVersion}>
                          ${!navCollapsed
                            ? html`
                                <span class="sidebar-version__label">${t("common.version")}</span>
                                <span class="sidebar-version__text">${slideVersion}</span>
                                ${renderSidebarConnectionStatus(state)}
                              `
                            : html` ${renderSidebarConnectionStatus(state)} `}
                        </div>
                      `;
                })()}
              </div>
            </div>
          </div>
        </aside>
      </div>
      <main class="content ${isChat ? "content--chat" : ""}">
        ${state.updateAvailable &&
        state.updateAvailable.latestVersion !== state.updateAvailable.currentVersion &&
        !isUpdateBannerDismissed(state.updateAvailable)
          ? html`<div class="update-banner callout danger" role="alert">
              <strong>Update available:</strong> v${state.updateAvailable.latestVersion} (running
              v${state.updateAvailable.currentVersion}).
              <button
                class="btn btn--sm update-banner__btn"
                ?disabled=${state.updateRunning || !state.connected}
                @click=${() => runUpdate(state)}
              >
                ${state.updateRunning ? "Updating…" : "Update now"}
              </button>
              <button
                class="update-banner__close"
                type="button"
                title="Dismiss"
                aria-label="Dismiss update banner"
                @click=${() => {
                  dismissUpdateBanner(state.updateAvailable);
                  state.updateAvailable = null;
                }}
              >
                ${icons['x']}
              </button>
            </div>`
          : nothing}
        ${state.tab === "config"
          ? nothing
          : html`<section class="content-header">
              <div>
                ${isChat
                  ? renderChatSessionSelect(state)
                  : html`<div class="page-title">${titleForTab(state.tab)}</div>`}
                ${isChat ? nothing : html`<div class="page-sub">${subtitleForTab(state.tab)}</div>`}
              </div>
              <div class="page-meta">
                ${state.lastError
                  ? html`<div class="pill danger">${state.lastError}</div>`
                  : nothing}
                ${isChat ? renderChatControls(state) : nothing}
              </div>
            </section>`}
        ${state.tab === "sessions"
          ? lazyRender(lazySessions, (m) =>
              m.renderSessions({
                loading: state.sessionsLoading,
                result: state.sessionsResult,
                error: state.sessionsError,
                activeMinutes: state.sessionsFilterActive,
                limit: state.sessionsFilterLimit,
                includeGlobal: state.sessionsIncludeGlobal,
                includeUnknown: state.sessionsIncludeUnknown,
                basePath: state.basePath,
                searchQuery: state.sessionsSearchQuery,
                sortColumn: state.sessionsSortColumn,
                sortDir: state.sessionsSortDir,
                page: state.sessionsPage,
                pageSize: state.sessionsPageSize,
                selectedKeys: state.sessionsSelectedKeys,
                expandedCheckpointKey: state.sessionsExpandedCheckpointKey,
                checkpointItemsByKey: state.sessionsCheckpointItemsByKey,
                checkpointLoadingKey: state.sessionsCheckpointLoadingKey,
                checkpointBusyKey: state.sessionsCheckpointBusyKey,
                checkpointErrorByKey: state.sessionsCheckpointErrorByKey,
                onFiltersChange: (next) => {
                  state.sessionsFilterActive = next.activeMinutes;
                  state.sessionsFilterLimit = next.limit;
                  state.sessionsIncludeGlobal = next.includeGlobal;
                  state.sessionsIncludeUnknown = next.includeUnknown;
                },
                onSearchChange: (q) => {
                  state.sessionsSearchQuery = q;
                  state.sessionsPage = 0;
                },
                onSortChange: (col, dir) => {
                  state.sessionsSortColumn = col;
                  state.sessionsSortDir = dir;
                  state.sessionsPage = 0;
                },
                onPageChange: (p) => {
                  state.sessionsPage = p;
                },
                onPageSizeChange: (s) => {
                  state.sessionsPageSize = s;
                  state.sessionsPage = 0;
                },
                onRefresh: () => loadSessions(state),
                onPatch: () => {},
                onToggleSelect: (key) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onSelectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const k of keys) {
                    next.add(k);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const k of keys) {
                    next.delete(k);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectAll: () => {
                  state.sessionsSelectedKeys = new Set();
                },
                onDeleteSelected: async () => {},
                onNavigateToChat: (sessionKey) => {
                  switchChatSession(state, sessionKey);
                  state.setTab("chat" as import("./navigation.ts").Tab);
                },
                onToggleCheckpointDetails: () => {},
                onBranchFromCheckpoint: async () => {},
                onRestoreCheckpoint: () => {},
              }),
            )
          : nothing}
        ${state.tab === "agents"
          ? lazyRender(lazyAgents, (m) =>
              m.renderAgents({
                basePath: state.basePath ?? "",
                loading: state.agentsLoading,
                error: state.agentsError,
                agentsList: state.agentsList,
                selectedAgentId: resolvedAgentId,
                activePanel: state.agentsPanel,
                config: {
                  form: getCurrentConfigValue(),
                  loading: state.configLoading,
                  saving: state.configSaving,
                  dirty: state.configFormDirty,
                },
                channels: {
                  snapshot: state.channelsSnapshot,
                  loading: state.channelsLoading,
                  error: state.channelsError,
                  lastSuccess: state.channelsLastSuccess,
                },
                cron: {
                  status: state.cronStatus,
                  jobs: state.cronJobs,
                  loading: state.cronLoading,
                  error: state.cronError,
                },
                agentFiles: {
                  list: state.agentFilesList,
                  loading: state.agentFilesLoading,
                  error: state.agentFilesError,
                  active: state.agentFileActive,
                  contents: state.agentFileContents,
                  drafts: state.agentFileDrafts,
                  saving: state.agentFileSaving,
                },
                agentIdentityLoading: state.agentIdentityLoading,
                agentIdentityError: state.agentIdentityError,
                agentIdentityById: state.agentIdentityById,
                agentSkills: {
                  report: state.agentSkillsReport,
                  loading: state.agentSkillsLoading,
                  error: state.agentSkillsError,
                  agentId: state.agentSkillsAgentId,
                  filter: state.skillsFilter,
                },
                toolsCatalog: {
                  loading: state.toolsCatalogLoading,
                  error: state.toolsCatalogError,
                  result: state.toolsCatalogResult,
                },
                toolsEffective: {
                  loading: state.toolsEffectiveLoading,
                  error: state.toolsEffectiveError,
                  result: state.toolsEffectiveResult,
                },
                runtimeSessionKey: state.sessionKey,
                runtimeSessionMatchesSelectedAgent: toolsPanelUsesActiveSession,
                modelCatalog: state.chatModelCatalog ?? [],
                onRefresh: async () => {
                  await loadAgents(state);
                },
                onSelectAgent: (agentId) => {
                  if (state.agentsSelectedId === agentId) {
                    return;
                  }
                  state.agentsSelectedId = agentId;
                },
                onSelectPanel: (panel) => {
                  state.agentsPanel = panel;
                },
                onLoadFiles: () => {},
                onSelectFile: (name) => {
                  state.agentFileActive = name;
                },
                onFileDraftChange: (name, content) => {
                  state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
                },
                onFileReset: (name) => {
                  const base = state.agentFileContents[name] ?? "";
                  state.agentFileDrafts = { ...state.agentFileDrafts, [name]: base };
                },
                onFileSave: () => {},
                onToolsProfileChange: () => {},
                onToolsOverridesChange: () => {},
                onConfigReload: () => {},
                onConfigSave: () => saveAgentsConfig(state),
                onChannelsRefresh: () => {},
                onCronRefresh: () => state.loadCron(),
                onCronRunNow: () => {},
                onSkillsFilterChange: (next) => (state.skillsFilter = next),
                onSkillsRefresh: () => {},
                onAgentSkillToggle: () => {},
                onAgentSkillsClear: () => {},
                onAgentSkillsDisableAll: () => {},
                onModelChange: () => {},
                onModelFallbacksChange: () => {},
                onSetDefault: () => {},
              }),
            )
          : nothing}
        ${state.tab === "dashboard"
          ? html`<dashboard-page></dashboard-page>`
          : nothing}
        ${state.tab === "instances-db"
          ? html`<instances-page></instances-page>`
          : nothing}
        ${state.tab === "instance-detail"
          ? html`<instance-detail-page></instance-detail-page>`
          : nothing}
        ${state.tab === "alerts"
          ? html`<alerts-page></alerts-page>`
          : nothing}
        ${state.tab === "schema"
          ? html`<schema-management-page></schema-management-page>`
          : nothing}
        ${state.tab === "indexes"
          ? html`<index-management-page></index-management-page>`
          : nothing}
        ${state.tab === "settings"
          ? html`<settings-shell></settings-shell>`
          : nothing}
        ${state.tab === "llm-config"
          ? html`<llm-config-page></llm-config-page>`
          : nothing}
        ${state.tab === "ai-settings"
          ? html`<ai-settings-page></ai-settings-page>`
          : nothing}
        ${state.tab === "scoring-settings"
          ? html`<scoring-settings-page></scoring-settings-page>`
          : nothing}
        ${state.tab === "cron-jobs"
          ? html`<cron-jobs-settings></cron-jobs-settings>`
          : nothing}
        ${state.tab === "sql-console"
          ? html`<sql-console-page></sql-console-page>`
          : nothing}
        ${state.tab === "approval"
          ? html`<approval-dashboard></approval-dashboard>`
          : nothing}
        ${state.tab === "reports"
          ? html`<reports-page></reports-page>`
          : nothing}
        ${state.tab === "metric-registry"
          ? html`<metric-registry-viewer></metric-registry-viewer>`
          : nothing}
        ${state.tab === "metric-templates"
          ? html`<metric-templates-page></metric-templates-page>`
          : nothing}
        ${state.tab === "events"
          ? html`<event-management-page></event-management-page>`
          : nothing}
        ${state.tab === "docs"
          ? html`<docs-viewer-page></docs-viewer-page>`
          : nothing}
        ${state.tab === "users"
          ? html`<users-management></users-management>`
          : nothing}
        ${state.tab === "rbac"
          ? html`<rbac-admin-page></rbac-admin-page>`
          : nothing}
        ${state.tab === "chat"
          ? renderChat({
              connected: state.connected,
              loading: state.chatLoading,
              sending: state.chatSending,
              draft: state.chatMessage,
              attachments: state.chatAttachments,
              messages: state.chatMessages,
              toolMessages: state.chatToolMessages,
              stream: state.chatStream,
              streamSegments: state.chatStreamSegments,
              streamStartedAt: state.chatStreamStartedAt,
              runId: state.chatRunId,
              sideResult: state.chatSideResult,
              sideResultTerminalRuns: state.chatSideResultTerminalRuns,
              compactionStatus: state.compactionStatus,
              fallbackStatus: state.fallbackStatus,
              thinkingLevel: state.chatThinkingLevel,
              modelCatalog: state.chatModelCatalog,
              modelsLoading: state.chatModelsLoading,
              modelOverrides: state.chatModelOverrides,
              queue: state.chatQueue,
              manualRefreshInFlight: state.chatManualRefreshInFlight,
              newMessagesBelow: state.chatNewMessagesBelow,
              assistantAvatarUrl: chatAvatarUrl,
              disabledReason: chatDisabledReason,
              showThinking,
              showToolCalls,
              settings: state.settings,
              sessionKey: state.sessionKey,
              hello: state.hello,
              canSend: state.connected,
              error: state.lastError,
              lastError: state.lastError,
              sessions: (state.sessionsResult as any) ?? null,
              focusMode: state.settings.chatFocusMode || false,
              sidebarOpen: state.sidebarOpen,
              sidebarContent: state.sidebarContent,
              sidebarError: state.sidebarError,
              splitRatio: state.splitRatio,
              assistantName: state.assistantName,
              assistantAvatar: state.assistantAvatar,
              agentsList: state.agentsList ?? null,
              currentAgentId: resolvedAgentId ?? state.agentsList?.defaultId ?? "",
              onSessionKeyChange: (next) => {
                state.sessionKey = next;
                state.applySettings({
                  ...state.settings,
                  sessionKey: next,
                  lastActiveSessionKey: next,
                });
              },
              onAttachmentsChange: (attachments) => {
                state.chatAttachments = attachments;
              },
              onDraftChange: (next) => {
                state.chatMessage = next;
              },
              onRequestUpdate: requestHostUpdate,
              onSend: () => state.handleSendChat(),
              onNewSession: () => state.handleSendChat("/new", { restoreDraft: true }),
              onRefresh: () => {
                if (!state.connected && state.lastError === '连接失败，请点击重试') {
                  state.client?.reconnect();
                  return;
                }
                state.chatManualRefreshInFlight = true;
                void loadChatHistory(state).finally(() => {
                  state.chatManualRefreshInFlight = false;
                });
              },
              onToggleFocusMode: () => {
                state.applySettings({
                  ...state.settings,
                  chatFocusMode: !state.settings.chatFocusMode,
                });
              },
              onQueueRemove: (id) => {
                state.chatQueue = state.chatQueue.filter((item) => item.id !== id);
              },
              onAgentChange: (agentId) => {
                state.agentsSelectedId = agentId;
              },
            })
          : nothing}
      </main>
      ${renderGatewayUrlConfirmation(state)} ${nothing}
    </div>
  `;
}
