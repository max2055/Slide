const SETTINGS_KEY_PREFIX = "slide.control.settings.v1:";
const LEGACY_SETTINGS_KEY = "slide.control.settings.v1";
const USERNAME_KEY = "slide.control.username.v1";
const SESSION_TOKEN_KEY = "slide.control.session_token.v1";

type PersistedUiSettings = Omit<UiSettings, "username" | "sessionKey" | "lastActiveSessionKey"> & {
  username?: never;
  sessionKey?: string;
  lastActiveSessionKey?: string;
};

import { isSupportedLocale } from "../i18n/index.ts";
import { getSafeLocalStorage } from "./local-storage.ts";
import { inferBasePathFromPathname, normalizeBasePath } from "./navigation.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import { parseThemeSelection, type ThemeMode, type ThemeName } from "./theme.ts";

export const BORDER_RADIUS_STOPS = [0, 25, 50, 75, 100] as const;
export type BorderRadiusStop = (typeof BORDER_RADIUS_STOPS)[number];

function snapBorderRadius(value: number): BorderRadiusStop {
  let best: BorderRadiusStop = BORDER_RADIUS_STOPS[0];
  let bestDist = Math.abs(value - best);
  for (const stop of BORDER_RADIUS_STOPS) {
    const dist = Math.abs(value - stop);
    if (dist < bestDist) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}

function validateDensity(v: unknown): v is 'compact' | 'standard' | 'comfortable' {
  return v === 'compact' || v === 'standard' || v === 'comfortable';
}

export type UiSettings = {
  gatewayUrl: string;
  username: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  chatShowToolCalls: boolean;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navWidth: number; // Sidebar width when expanded (200–400px)
  navGroupsCollapsed: Record<string, boolean>; // Which nav groups are collapsed
  borderRadius: number; // Corner roundness (0–100, default 50)
  locale?: string;
  // Layer 1 — Visual
  fontDensity: 'compact' | 'standard' | 'comfortable';
  sidebarPosition: 'left' | 'right';
  reduceAnimations: boolean;
  accentColor: string;
  // Layer 2 — Layout
  defaultTab: string;
  visibleTabs: string[];
  // Layer 3 — Data display
  defaultPageSize: number;
  dateFormat: 'relative' | 'absolute';
  timezone: string;
  // Layer 4 — Behavior
  autoRefreshEnabled: boolean;
  autoRefreshInterval: number;
  notificationEnabled: boolean;
  notifySeverity: string[];
  defaultModel: string;
  // Button palette
  btnPalette?: Record<string, string>;
};

function isViteDevPage(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(document.querySelector('script[src*="/@vite/client"]'));
}

function formatHostWithPort(hostname: string, port: string): string {
  const normalizedHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${normalizedHost}:${port}`;
}

function deriveDefaultGatewayUrl(): { pageUrl: string; effectiveUrl: string } {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const configured =
    typeof window !== "undefined" &&
    normalizeOptionalString(window.__OPENCLAW_CONTROL_UI_BASE_PATH__);
  const basePath = configured
    ? normalizeBasePath(configured)
    : inferBasePathFromPathname(location.pathname);
  const pageUrl = `${proto}://${location.host}${basePath}`;
  if (!isViteDevPage()) {
    return { pageUrl, effectiveUrl: pageUrl };
  }
  // Slide uses port 28888
  const effectiveUrl = `${proto}://${formatHostWithPort(location.hostname, "28888")}/ws`;
  return { pageUrl, effectiveUrl };
}

function loadUsername(): string {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return "";
    }
    const username = storage.getItem(USERNAME_KEY);
    return normalizeOptionalString(username) ?? "";
  } catch {
    return "";
  }
}

function persistUsername(username: string) {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    const normalized = normalizeOptionalString(username) ?? "";
    if (normalized) {
      storage.setItem(USERNAME_KEY, normalized);
      return;
    }
    storage.removeItem(USERNAME_KEY);
  } catch {
    // best-effort
  }
}

export function loadSessionToken(): string | null {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return null;
    }
    const token = storage.getItem(SESSION_TOKEN_KEY);
    return normalizeOptionalString(token) ?? null;
  } catch {
    return null;
  }
}

export function persistSessionToken(token: string | null) {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    if (token) {
      storage.setItem(SESSION_TOKEN_KEY, token);
      return;
    }
    storage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // best-effort
  }
}

export function loadSettings(): UiSettings {
  const { pageUrl: pageDerivedUrl, effectiveUrl: defaultUrl } = deriveDefaultGatewayUrl();
  const storage = getSafeLocalStorage();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    username: loadUsername(),
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    chatShowToolCalls: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 220,
    navGroupsCollapsed: {},
    borderRadius: 50,
    // Layer 1 — Visual
    fontDensity: "standard",
    sidebarPosition: "left",
    reduceAnimations: false,
    accentColor: "#7c5cff",
    // Layer 2 — Layout
    defaultTab: "dashboard",
    visibleTabs: [],
    // Layer 3 — Data display
    defaultPageSize: 50,
    dateFormat: "absolute",
    timezone: "",
    // Layer 4 — Behavior
    autoRefreshEnabled: true,
    autoRefreshInterval: 30,
    notificationEnabled: true,
    notifySeverity: ["critical", "warning"],
    defaultModel: "",
  };

  try {
    const raw =
      storage?.getItem(SETTINGS_KEY_PREFIX + "default") ??
      storage?.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as PersistedUiSettings;
    const { theme, mode } = parseThemeSelection(
      (parsed as { theme?: unknown }).theme,
      (parsed as { themeMode?: unknown }).themeMode,
    );
    return {
      gatewayUrl: defaults.gatewayUrl,
      // Username is persisted in localStorage for convenience
      username: loadUsername(),
      sessionKey: parsed.sessionKey ?? defaults.sessionKey,
      lastActiveSessionKey: parsed.lastActiveSessionKey ?? defaults.lastActiveSessionKey,
      theme,
      themeMode: mode,
      chatFocusMode:
        typeof parsed.chatFocusMode === "boolean" ? parsed.chatFocusMode : defaults.chatFocusMode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      chatShowToolCalls:
        typeof parsed.chatShowToolCalls === "boolean"
          ? parsed.chatShowToolCalls
          : defaults.chatShowToolCalls,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navWidth:
        typeof parsed.navWidth === "number" && parsed.navWidth >= 200 && parsed.navWidth <= 400
          ? parsed.navWidth
          : defaults.navWidth,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" && parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
      borderRadius:
        typeof parsed.borderRadius === "number" &&
        parsed.borderRadius >= 0 &&
        parsed.borderRadius <= 100
          ? snapBorderRadius(parsed.borderRadius)
          : defaults.borderRadius,
      locale: isSupportedLocale(parsed.locale) ? parsed.locale : undefined,
      // Layer 1 — Visual
      fontDensity: validateDensity((parsed as any).fontDensity) ? (parsed as any).fontDensity : defaults.fontDensity,
      sidebarPosition: ((parsed as any).sidebarPosition === "left" || (parsed as any).sidebarPosition === "right") ? (parsed as any).sidebarPosition : defaults.sidebarPosition,
      reduceAnimations: typeof (parsed as any).reduceAnimations === "boolean" ? (parsed as any).reduceAnimations : defaults.reduceAnimations,
      accentColor: typeof (parsed as any).accentColor === "string" && (parsed as any).accentColor ? (parsed as any).accentColor : defaults.accentColor,
      // Layer 2 — Layout
      defaultTab: typeof (parsed as any).defaultTab === "string" ? (parsed as any).defaultTab : defaults.defaultTab,
      visibleTabs: Array.isArray((parsed as any).visibleTabs) ? (parsed as any).visibleTabs : defaults.visibleTabs,
      // Layer 3 — Data display
      defaultPageSize: typeof (parsed as any).defaultPageSize === "number" && (parsed as any).defaultPageSize > 0 ? (parsed as any).defaultPageSize : defaults.defaultPageSize,
      dateFormat: ((parsed as any).dateFormat === "relative" || (parsed as any).dateFormat === "absolute") ? (parsed as any).dateFormat : defaults.dateFormat,
      timezone: typeof (parsed as any).timezone === "string" ? (parsed as any).timezone : defaults.timezone,
      // Layer 4 — Behavior
      autoRefreshEnabled: typeof (parsed as any).autoRefreshEnabled === "boolean" ? (parsed as any).autoRefreshEnabled : defaults.autoRefreshEnabled,
      autoRefreshInterval: typeof (parsed as any).autoRefreshInterval === "number" && (parsed as any).autoRefreshInterval > 0 ? (parsed as any).autoRefreshInterval : defaults.autoRefreshInterval,
      notificationEnabled: typeof (parsed as any).notificationEnabled === "boolean" ? (parsed as any).notificationEnabled : defaults.notificationEnabled,
      notifySeverity: Array.isArray((parsed as any).notifySeverity) ? (parsed as any).notifySeverity : defaults.notifySeverity,
      defaultModel: typeof (parsed as any).defaultModel === "string" ? (parsed as any).defaultModel : defaults.defaultModel,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(next: UiSettings) {
  persistSettings(next);
}

function persistSettings(next: UiSettings) {
  persistUsername(next.username);
  const storage = getSafeLocalStorage();
  const persisted: PersistedUiSettings = {
    gatewayUrl: next.gatewayUrl,
    theme: next.theme,
    themeMode: next.themeMode,
    chatFocusMode: next.chatFocusMode,
    chatShowThinking: next.chatShowThinking,
    chatShowToolCalls: next.chatShowToolCalls,
    splitRatio: next.splitRatio,
    navCollapsed: next.navCollapsed,
    navWidth: next.navWidth,
    navGroupsCollapsed: next.navGroupsCollapsed,
    borderRadius: next.borderRadius,
    sessionKey: next.sessionKey,
    lastActiveSessionKey: next.lastActiveSessionKey,
    ...(next.locale ? { locale: next.locale } : {}),
    // Layer 1
    fontDensity: next.fontDensity,
    sidebarPosition: next.sidebarPosition,
    reduceAnimations: next.reduceAnimations,
    accentColor: next.accentColor,
    // Layer 2
    defaultTab: next.defaultTab,
    visibleTabs: next.visibleTabs,
    // Layer 3
    defaultPageSize: next.defaultPageSize,
    dateFormat: next.dateFormat,
    timezone: next.timezone,
    // Layer 4
    autoRefreshEnabled: next.autoRefreshEnabled,
    autoRefreshInterval: next.autoRefreshInterval,
    notificationEnabled: next.notificationEnabled,
    notifySeverity: next.notifySeverity,
    defaultModel: next.defaultModel,
  };
  const serialized = JSON.stringify(persisted);
  try {
    storage?.setItem(SETTINGS_KEY_PREFIX + "default", serialized);
    storage?.setItem(LEGACY_SETTINGS_KEY, serialized);
  } catch {
    // best-effort — quota exceeded or security restrictions should not
    // prevent in-memory settings and visual updates from being applied
  }
  // Fire-and-forget server sync
  syncPreferencesToServer(next);
}

// ——— Server sync ———

function buildServerPrefsPayload(settings: UiSettings): Record<string, unknown> {
  return {
    theme: settings.theme,
    themeMode: settings.themeMode,
    chatFocusMode: settings.chatFocusMode,
    chatShowThinking: settings.chatShowThinking,
    chatShowToolCalls: settings.chatShowToolCalls,
    borderRadius: settings.borderRadius,
    locale: settings.locale ?? "",
    fontDensity: settings.fontDensity,
    sidebarPosition: settings.sidebarPosition,
    reduceAnimations: settings.reduceAnimations,
    accentColor: settings.accentColor,
    defaultTab: settings.defaultTab,
    visibleTabs: settings.visibleTabs,
    navWidth: settings.navWidth,
    defaultPageSize: settings.defaultPageSize,
    dateFormat: settings.dateFormat,
    timezone: settings.timezone,
    autoRefreshEnabled: settings.autoRefreshEnabled,
    autoRefreshInterval: settings.autoRefreshInterval,
    notificationEnabled: settings.notificationEnabled,
    notifySeverity: settings.notifySeverity,
    defaultModel: settings.defaultModel,
  };
}

async function syncPreferencesToServer(settings: UiSettings) {
  try {
    const payload = buildServerPrefsPayload(settings);
    // Dynamic import to avoid circular dependency
    const { preferencesAPI } = await import('../../api/preferences.ts');
    await preferencesAPI.savePreferences(payload);
  } catch {
    // Silent fail — local storage is authoritative for immediate use
  }
}

export async function syncPreferencesFromServer(currentSettings: UiSettings): Promise<UiSettings> {
  try {
    const { preferencesAPI } = await import('../../api/preferences.ts');
    const data = await preferencesAPI.getPreferences();
    if (data?.preferences && typeof data.preferences === 'object') {
      const server = data.preferences as Record<string, unknown>;
      // Merge: server prefs override local defaults, but only for recognized keys
      return {
        ...currentSettings,
        theme: typeof server.theme === 'string' ? server.theme as ThemeName : currentSettings.theme,
        themeMode: typeof server.themeMode === 'string' ? server.themeMode as ThemeMode : currentSettings.themeMode,
        chatFocusMode: typeof server.chatFocusMode === 'boolean' ? server.chatFocusMode : currentSettings.chatFocusMode,
        chatShowThinking: typeof server.chatShowThinking === 'boolean' ? server.chatShowThinking : currentSettings.chatShowThinking,
        chatShowToolCalls: typeof server.chatShowToolCalls === 'boolean' ? server.chatShowToolCalls : currentSettings.chatShowToolCalls,
        borderRadius: typeof server.borderRadius === 'number' ? server.borderRadius : currentSettings.borderRadius,
        locale: typeof server.locale === 'string' && server.locale ? server.locale : currentSettings.locale,
        fontDensity: validateDensity(server.fontDensity) ? server.fontDensity : currentSettings.fontDensity,
        sidebarPosition: (server.sidebarPosition === 'left' || server.sidebarPosition === 'right') ? server.sidebarPosition : currentSettings.sidebarPosition,
        reduceAnimations: typeof server.reduceAnimations === 'boolean' ? server.reduceAnimations : currentSettings.reduceAnimations,
        accentColor: typeof server.accentColor === 'string' && server.accentColor ? server.accentColor : currentSettings.accentColor,
        defaultTab: typeof server.defaultTab === 'string' ? server.defaultTab : currentSettings.defaultTab,
        visibleTabs: Array.isArray(server.visibleTabs) ? server.visibleTabs as string[] : currentSettings.visibleTabs,
        navWidth: typeof server.navWidth === 'number' ? server.navWidth : currentSettings.navWidth,
        defaultPageSize: typeof server.defaultPageSize === 'number' && server.defaultPageSize > 0 ? server.defaultPageSize : currentSettings.defaultPageSize,
        dateFormat: (server.dateFormat === 'relative' || server.dateFormat === 'absolute') ? server.dateFormat : currentSettings.dateFormat,
        timezone: typeof server.timezone === 'string' ? server.timezone : currentSettings.timezone,
        autoRefreshEnabled: typeof server.autoRefreshEnabled === 'boolean' ? server.autoRefreshEnabled : currentSettings.autoRefreshEnabled,
        autoRefreshInterval: typeof server.autoRefreshInterval === 'number' ? server.autoRefreshInterval : currentSettings.autoRefreshInterval,
        notificationEnabled: typeof server.notificationEnabled === 'boolean' ? server.notificationEnabled : currentSettings.notificationEnabled,
        notifySeverity: Array.isArray(server.notifySeverity) ? server.notifySeverity as string[] : currentSettings.notifySeverity,
        defaultModel: typeof server.defaultModel === 'string' ? server.defaultModel : currentSettings.defaultModel,
      };
    }
    // Server has no preferences yet — upload current local settings (migration)
    syncPreferencesToServer(currentSettings);
    return currentSettings;
  } catch {
    // Silent fail — server unreachable, keep local settings
    return currentSettings;
  }
}
