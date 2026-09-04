export type SettingsView = {
  id: string;
  label: string;
  requiredPermission?: string;
};

export type SettingsItem = {
  id: SettingsPageId;
  label: string;
  path: string;
  icon: string;
  requiredPermission?: string;
  views?: readonly SettingsView[];
};

export type SettingsGroup = {
  id: string;
  label: string;
  items: readonly SettingsItem[];
};

export type SettingsPageId =
  | "branding"
  | "appearance"
  | "notifications"
  | "metrics"
  | "analysis"
  | "models"
  | "prompts"
  | "capabilities"
  | "security"
  | "users"
  | "login";

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "platform",
    label: "平台设置",
    items: [
      { id: "branding", label: "品牌", path: "/settings/platform/branding", icon: "palette" },
      { id: "appearance", label: "外观", path: "/settings/platform/appearance", icon: "spark" },
      { id: "notifications", label: "通知通道", path: "/settings/platform/notifications", icon: "message-square", requiredPermission: "admin:*" },
    ],
  },
  {
    id: "monitoring",
    label: "监控与分析",
    items: [
      { id: "metrics", label: "指标定义", path: "/settings/monitoring/metrics", icon: "puzzle", requiredPermission: "metric:view" },
      {
        id: "analysis",
        label: "分析策略",
        path: "/settings/monitoring/analysis",
        icon: "bar-chart",
        views: [
          { id: "automatic", label: "自动分析", requiredPermission: "ai:view" },
          { id: "scoring", label: "评分权重", requiredPermission: "scoring:view" },
        ],
      },
    ],
  },
  {
    id: "ai",
    label: "AI 与 Agent",
    items: [
      { id: "models", label: "模型配置", path: "/settings/ai/models", icon: "brain", requiredPermission: "llm:view" },
      { id: "prompts", label: "提示词管理", path: "/settings/ai/prompts", icon: "book" },
      {
        id: "capabilities",
        label: "Agent 能力",
        path: "/settings/ai/capabilities",
        icon: "wrench",
        views: [
          { id: "skills", label: "技能", requiredPermission: "ai:view" },
          { id: "tools", label: "工具", requiredPermission: "ai:view" },
        ],
      },
      {
        id: "security",
        label: "执行安全",
        path: "/settings/ai/security",
        icon: "shield",
        views: [
          { id: "policy", label: "Agent 策略", requiredPermission: "ai:view" },
          { id: "sandbox", label: "沙箱配置", requiredPermission: "audit:view" },
        ],
      },
    ],
  },
  {
    id: "access",
    label: "用户与权限",
    items: [
      {
        id: "users",
        label: "用户与权限",
        path: "/settings/access/users",
        icon: "scroll-text",
        views: [
          { id: "accounts", label: "用户", requiredPermission: "admin:*" },
          { id: "roles", label: "角色", requiredPermission: "admin:*" },
          { id: "permissions", label: "权限", requiredPermission: "admin:*" },
        ],
      },
      { id: "login", label: "登录安全", path: "/settings/access/login", icon: "lock", requiredPermission: "admin:*" },
    ],
  },
] as const;

export const SETTINGS_ITEMS = SETTINGS_GROUPS.flatMap((group) => group.items);

type LegacySettingsTarget = { pageId: SettingsPageId; view?: string };

export const LEGACY_SETTINGS_PATHS: Readonly<Record<string, LegacySettingsTarget>> = {
  "/system": { pageId: "branding" },
  "/appearance": { pageId: "appearance" },
  "/ai-settings": { pageId: "analysis", view: "automatic" },
  "/scoring-settings": { pageId: "analysis", view: "scoring" },
  "/llm-config": { pageId: "models" },
  "/prompt-settings": { pageId: "prompts" },
  "/agent-skills": { pageId: "capabilities", view: "skills" },
  "/agent-tools": { pageId: "capabilities", view: "tools" },
  "/agent-security-policy": { pageId: "security", view: "policy" },
  "/agent-sandbox": { pageId: "security", view: "sandbox" },
  "/metric-registry": { pageId: "metrics" },
  "/users": { pageId: "users", view: "accounts" },
  "/rbac": { pageId: "users", view: "roles" },
  "/settings/branding": { pageId: "branding" },
  "/settings/appearance": { pageId: "appearance" },
  "/settings/feishu-notification": { pageId: "notifications" },
  "/settings/scoring-settings": { pageId: "analysis", view: "scoring" },
  "/settings/ai-settings": { pageId: "analysis", view: "automatic" },
  "/settings/llm-config": { pageId: "models" },
  "/settings/prompt-settings": { pageId: "prompts" },
  "/settings/agent-skills": { pageId: "capabilities", view: "skills" },
  "/settings/agent-tools": { pageId: "capabilities", view: "tools" },
  "/settings/agent-security-policy": { pageId: "security", view: "policy" },
  "/settings/agent-sandbox": { pageId: "security", view: "sandbox" },
  "/settings/users": { pageId: "users", view: "accounts" },
  "/settings/rbac": { pageId: "users", view: "roles" },
  "/settings/session-security": { pageId: "login" },
};

export function settingsItemById(id: SettingsPageId): SettingsItem | undefined {
  return SETTINGS_ITEMS.find((item) => item.id === id);
}

export function permissionMatches(permissions: Set<string> | null, required?: string): boolean {
  if (!required) return true;
  if (!permissions) return true;
  if (permissions.has("*") || permissions.has(required)) return true;
  const separator = required.indexOf(":");
  return separator > 0 && permissions.has(`${required.slice(0, separator)}:*`);
}

export function visibleSettingsViews(item: SettingsItem, permissions: Set<string> | null): readonly SettingsView[] {
  return item.views?.filter((view) => permissionMatches(permissions, view.requiredPermission)) ?? [];
}

export function canAccessSettingsItem(item: SettingsItem, permissions: Set<string> | null): boolean {
  if (!permissionMatches(permissions, item.requiredPermission)) return false;
  return !item.views || visibleSettingsViews(item, permissions).length > 0;
}

export function findSettingsRoute(pathname: string): { item: SettingsItem; legacy: boolean; view?: string } | null {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const item = SETTINGS_ITEMS.find((candidate) => normalized.endsWith(candidate.path));
  if (item) return { item, legacy: false };

  for (const [legacyPath, target] of Object.entries(LEGACY_SETTINGS_PATHS)) {
    if (!normalized.endsWith(legacyPath)) continue;
    const targetItem = settingsItemById(target.pageId);
    if (targetItem) return { item: targetItem, legacy: true, view: target.view };
  }
  return null;
}

export function isSettingsPath(pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return normalized === "/settings"
    || SETTINGS_ITEMS.some((item) => item.path === normalized)
    || Object.hasOwn(LEGACY_SETTINGS_PATHS, normalized);
}

export function isSettingsLocation(pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return normalized.endsWith("/settings") || findSettingsRoute(normalized) !== null;
}

export function settingsBasePath(pathname: string): string {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const suffixes = [
    ...SETTINGS_ITEMS.map((item) => item.path),
    ...Object.keys(LEGACY_SETTINGS_PATHS),
    "/settings",
  ].sort((left, right) => right.length - left.length);
  const suffix = suffixes.find((candidate) => normalized.endsWith(candidate));
  return suffix ? normalized.slice(0, -suffix.length) : "";
}
