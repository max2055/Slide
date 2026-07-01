import { t } from "../i18n/index.ts";
import type { IconName } from "../../icons.js";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

export const TAB_GROUPS = [
  {
    label: "slide",
    tabs: ["chat", "dashboard", "instances-db", "sql-console", "approval", "alerts", "metric-registry", "metric-templates", "reports", "events", "cron-jobs"],
  },
  {
    label: "settings",
    tabs: ["settings"],
  },
] as const;

export type Tab =
  | "agents"
  | "ai-settings"
  | "prompt-settings"
  | "agent-sessions"
  | "agent-skills"
  | "agent-tools"
  | "sessions"
  | "chat"
  | "config"
  | "cron-jobs"
  | "dashboard"
  | "docs"
  | "instances-db"
  | "alerts"
  | "schema"
  | "indexes"
  | "reports"
  | "metric-registry"
  | "metric-templates"
  | "events"
  | "users"
  | "llm-config"
  | "llm-usage"
  | "overview"
  | "rbac"
  | "sql-console"
  | "approval"
  | "instance-detail"
  | "scoring-settings"
  | "settings";

const TAB_PATHS: Record<Tab, string> = {
  agents: "/agents",
  "ai-settings": "/ai-settings",
  "prompt-settings": "/prompt-settings",
  "agent-sessions": "/agent-sessions",
  "agent-skills": "/agent-skills",
  "agent-tools": "/agent-tools",
  "scoring-settings": "/scoring-settings",
  sessions: "/sessions",
  chat: "/chat",
  config: "/config",
  "cron-jobs": "/cron-jobs",
  dashboard: "/dashboard",
  docs: "/docs",
  "instances-db": "/instances-db",
  alerts: "/alerts",
  schema: "/schema",
  indexes: "/indexes",
  reports: "/reports",
  "metric-registry": "/metric-registry",
  "metric-templates": "/metric-templates",
  events: "/events",
  users: "/users",
  "llm-config": "/llm-config",
  "llm-usage": "/llm-usage",
  overview: "/overview",
  "rbac": "/rbac",
  "sql-console": "/sql-console",
  "approval": "/approval",
  "instance-detail": "/instance-detail",
  settings: "/settings",
};

const PATH_TO_TAB = new Map<string, Tab>([
  ...Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab] as const),
]);

/** Slide permission codes required for each tab.
 * Tabs not listed remain always visible (controlled by Gateway scopes, not Slide permissions).
 * Tabs with a required permission are fully hidden when the permission is absent.
 */
/** Tabs suitable as a default landing page (excludes context-dependent tabs). */
export const DEFAULT_TAB_OPTIONS: Tab[] = [
  "chat", "dashboard", "instances-db", "sql-console",
  "alerts", "metric-registry", "metric-templates", "reports",
  "events", "approval", "cron-jobs", "sessions",
  "schema", "indexes", "settings", "ai-settings",
  "llm-config", "scoring-settings",
  "agent-sessions", "agent-skills", "agent-tools",
];

export const TAB_REQUIRED_PERMISSIONS: Partial<Record<Tab, string>> = {
  // Slide tabs — require specific permission codes
  'users': 'admin:*',
  'rbac': 'admin:*',
  'llm-config': 'llm:view',
  'alerts': 'alert:view',
  'reports': 'report:view',
  'metric-registry': 'metric:view',
  'metric-templates': 'metric:view',
  'events': 'alert:view',
  'ai-settings': 'ai:view',
  'agent-sessions': 'ai:view',
  'agent-skills': 'ai:view',
  'agent-tools': 'ai:view',
  'dashboard': 'instance:view',
  'instances-db': 'instance:view',
  'sql-console': 'instance:query',
  'schema': 'schema:view',
  'approval': 'approval:view',
  'cron-jobs': 'cron:view',
  'scoring-settings': 'scoring:view',
};

export function normalizeBasePath(basePath: string): string {
  if (!basePath) {
    return "";
  }
  let base = basePath.trim();
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (base === "/") {
    return "";
  }
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = TAB_PATHS[tab];
  return base ? `${base}${path}` : path;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizeLowercaseStringOrEmpty(normalizePath(path));
  if (normalized.endsWith("/index.html")) {
    normalized = "/";
  }
  if (normalized === "/") {
    return "dashboard";
  }
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  for (let i = 0; i < segments.length; i++) {
    const candidate = normalizeLowercaseStringOrEmpty(`/${segments.slice(i).join("/")}`);
    if (PATH_TO_TAB.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
  switch (tab) {
    case "agents":
      return "bot";
    case "ai-settings":
      return "sparkles";
    case "agent-sessions":
    case "agent-skills":
    case "agent-tools":
      return "settings";
    case "chat":
      return "message-square";
    case "cron-jobs":
      return "loader";
    case "dashboard":
      return "bar-chart";
    case "docs":
      return "book";
    case "instances-db":
      return "database";
    case "alerts":
      return "bell";
    case "schema":
      return "layout-grid";
    case "indexes":
      return "search";
    case "reports":
      return "file-text";
    case "metric-registry":
      return "puzzle";
    case "metric-templates":
      return "layout-grid";
    case "events":
      return "radio";
    case "sessions":
      return "clipboard";
    case "llm-config":
      return "brain";
    case "users":
      return "scroll-text";
    case "rbac":
      return "shield";
    case "sql-console":
      return "terminal";
    case "approval":
      return "check";
    case "instance-detail":
      return "database";
    case "settings":
      return "settings";
    default:
      return "folder";
  }
}

export function titleForTab(tab: Tab) {
  return t(`tabs.${tab}`);
}

export function subtitleForTab(tab: Tab) {
  return t(`subtitles.${tab}`);
}
