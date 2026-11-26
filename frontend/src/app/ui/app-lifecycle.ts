import { getSafeLocalStorage } from "./local-storage.ts";
import { initChatClient } from "./direct-gateway.ts";
import type { DirectGatewayClient } from "./direct-gateway.ts";
import { observeTopbar, scheduleChatScroll } from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  detachThemeListener,
  inferBasePath,
  getTabSelectionRevision,
  hasSlidePermission,
  setTabFromRoute,
  syncUrlWithTab,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import { DEFAULT_TAB_OPTIONS, TAB_REQUIRED_PERMISSIONS, type Tab } from "./navigation.ts";
import type { UiSettings } from "./storage.ts";
import { readCurrentPermissions } from "./permissions.ts";

type LifecycleHost = {
  basePath: string;
  querySelector: (selector: string) => Element | null;
  client?: DirectGatewayClient | null;
  connectGeneration: number;
  connected?: boolean;
  tab: Tab;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  localMediaPreviewRoots: string[];
  embedSandboxMode: "strict" | "scripts" | "trusted";
  allowExternalEmbedUrls: boolean;
  chatHasAutoScrolled: boolean;
  chatManualRefreshInFlight: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string | null;
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
  settings: UiSettings;
};

export function handleConnected(host: LifecycleHost) {
  const connectGeneration = ++host.connectGeneration;
  host.basePath = inferBasePath();
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  // Capture the entry route before syncTabWithLocation canonicalizes the root URL.
  const url = new URL(window.location.href);
  const applyLandingDefault = (url.pathname === "/" || url.pathname === host.basePath || url.pathname === host.basePath + "/")
    && !url.searchParams.has("tab") && !url.searchParams.has("session");
  const bootstrapReady = loadControlUiBootstrapConfig(host);
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  // Only ungated cached preferences can be applied before the session is checked.
  if (applyLandingDefault) void applyDefaultTab(host, null);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  // Sync user preferences with server (login migration + cross-device sync)
  void syncUserPreferences(host, applyLandingDefault);
  // Fetch Slide version from backend
  fetch("/api/version").then(r => r.json()).then(d => {
    (host as any).slideVersion = `Slide v${d.version}`;
  }).catch(() => {});
  window.addEventListener("popstate", host.popStateHandler);
  void bootstrapReady.finally(() => {
    if (host.connectGeneration !== connectGeneration) {
      return;
    }
    // Storage denial means signed out; do not enter JWT transport initialization.
    try {
      if (!getSafeLocalStorage()?.getItem('token')) { host.connected = false; return; }
    } catch { host.connected = false; return; }
    initChatClient(host as unknown as Parameters<typeof initChatClient>[0]);
  });
}

type PreferenceHost = { settings: UiSettings; connectGeneration?: number; tab?: Tab };

async function loadLandingPermissions(): Promise<Set<string> | null> {
  try {
    const storage = getSafeLocalStorage();
    if (!storage?.getItem('token')) return null;
    const user = storage.getItem('user');
    const permissions = await readCurrentPermissions();
    return storage.getItem('token') && storage.getItem('user') === user ? new Set(permissions) : null;
  } catch {
    return null;
  }
}

function canOpenLandingTab(tab: Tab, permissions: Set<string> | null) {
  if (tab === 'investigations') {
    return hasSlidePermission(permissions, 'chat:view') || hasSlidePermission(permissions, 'operations:actions:view');
  }
  return hasSlidePermission(permissions, TAB_REQUIRED_PERMISSIONS[tab]);
}

async function applyDefaultTab(host: PreferenceHost, readPermissions: typeof loadLandingPermissions | null) {
  const initial = host.settings;
  const generation = host.connectGeneration;
  const revision = getTabSelectionRevision(host);
  const url = window.location.href;
  const preferred = initial.defaultTab as Tab;
  const canonical = preferred === 'attention' ? 'events' : preferred === 'operations-actions' ? 'investigations' : preferred;
  if (!DEFAULT_TAB_OPTIONS.includes(canonical)) return;
  let tab = preferred;
  let route = canonical;
  if (TAB_REQUIRED_PERMISSIONS[canonical] || canonical === 'investigations') {
    if (!readPermissions) return;
    const permissions = await readPermissions();
    if (host.settings !== initial || host.connectGeneration !== generation || getTabSelectionRevision(host) !== revision
        || window.location.href !== url) return;
    if (!canOpenLandingTab(canonical, permissions)) {
      if (permissions && host.tab && canOpenLandingTab(host.tab, permissions)) return;
      if (!permissions) return;
      tab = route = 'feedback';
    }
  }
  if (route === host.tab) return;
  // Automatic landing resolution replaces the startup entry, preserving Back behavior.
  const settingsHost = host as Parameters<typeof setTabFromRoute>[0];
  setTabFromRoute(settingsHost, tab);
  syncUrlWithTab(settingsHost, route, true);
}

export async function syncUserPreferences(host: PreferenceHost, applyLandingDefault = false, readPermissions = loadLandingPermissions) {
  const initial = host.settings;
  const generation = host.connectGeneration;
  const selectionRevision = getTabSelectionRevision(host);
  const initialUrl = window.location.href;
  const { syncPreferencesFromServer } = await import('./storage.ts');
  const merged = await syncPreferencesFromServer(initial);
  // Apply server-synced preferences
  const { applySettings } = await import('./app-settings.ts');
  // A late bootstrap response must not overwrite edits made while it was loading.
  if (host.settings !== initial || host.connectGeneration !== generation) return;
  const canApplyDefault = applyLandingDefault && getTabSelectionRevision(host) === selectionRevision
    && window.location.href === initialUrl;
  applySettings(host as Parameters<typeof applySettings>[0], merged);
  if (canApplyDefault) await applyDefaultTab(host, readPermissions);
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

export function handleDisconnected(host: LifecycleHost) {
  host.connectGeneration += 1;
  window.removeEventListener("popstate", host.popStateHandler);
  host.client?.disconnect();
  host.client = null;
  host.connected = false;
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  // Initial positioning must wait for real history, not the loading skeleton/login view.
  if (host.chatLoading || host.chatManualRefreshInFlight || !host.querySelector(".chat-thread")) {
    return;
  }
  if (!host.chatMessages.length && !host.chatToolMessages.length && !host.chatStream) {
    return;
  }
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    // Detect streaming start: chatStream changed from null/undefined to a string value
    const previousStream = changed.get("chatStream") as string | null | undefined;
    const streamJustStarted =
      changed.has("chatStream") &&
      (previousStream === null || previousStream === undefined) &&
      typeof host.chatStream === "string";
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByTab || forcedByLoad || streamJustStarted || !host.chatHasAutoScrolled,
    );
  }
}
