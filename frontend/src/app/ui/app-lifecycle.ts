import { initChatClient } from "./direct-gateway.ts";
import type { DirectGatewayClient } from "./direct-gateway.ts";
import { observeTopbar, scheduleChatScroll } from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  detachThemeListener,
  inferBasePath,
  setTab,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import { DEFAULT_TAB_OPTIONS, type Tab } from "./navigation.ts";

type LifecycleHost = {
  basePath: string;
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
  settings?: { defaultTab?: string };
};

export function handleConnected(host: LifecycleHost) {
  const connectGeneration = ++host.connectGeneration;
  host.basePath = inferBasePath();
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  const bootstrapReady = loadControlUiBootstrapConfig(host);
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  // Apply user's default landing page if on root path
  applyDefaultTab(host);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  // Sync user preferences with server (login migration + cross-device sync)
  syncUserPreferences(host as unknown as { settings: import('./storage.ts').UiSettings });
  // Fetch Slide version from backend
  fetch("/api/version").then(r => r.json()).then(d => {
    (host as any).slideVersion = `Slide v${d.version}`;
  }).catch(() => {});
  window.addEventListener("popstate", host.popStateHandler);
  void bootstrapReady.finally(() => {
    if (host.connectGeneration !== connectGeneration) {
      return;
    }
    initChatClient(host as unknown as Parameters<typeof initChatClient>[0]);
  });
}

function applyDefaultTab(host: LifecycleHost) {
  const defaultTab = host.settings?.defaultTab;
  if (!defaultTab || defaultTab === "dashboard") return;
  // Only override if on root path
  if (window.location.pathname === "/" || window.location.pathname === host.basePath || window.location.pathname === host.basePath + "/") {
    if ((DEFAULT_TAB_OPTIONS as readonly string[]).includes(defaultTab)) {
      setTab(host as Parameters<typeof setTab>[0], defaultTab as Tab);
    }
  }
}

async function syncUserPreferences(host: { settings: import('./storage.ts').UiSettings }) {
  const { syncPreferencesFromServer, saveSettings } = await import('./storage.ts');
  const merged = await syncPreferencesFromServer(host.settings);
  // Apply server-synced preferences
  const { applySettings } = await import('./app-settings.ts');
  applySettings(host as Parameters<typeof applySettings>[0], merged);
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
  if (host.tab === "chat" && host.chatManualRefreshInFlight) {
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
