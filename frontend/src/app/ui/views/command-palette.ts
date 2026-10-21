import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../i18n/index.ts";
import { hasSlidePermission } from "../app-settings.ts";
import { TAB_REQUIRED_PERMISSIONS, type Tab } from "../navigation.ts";
import { icons, type IconName } from "../../../icons.js";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

type PaletteItem = {
  id: string;
  label: string;
  icon: IconName;
  category: "search" | "navigation" | "skills";
  action: string;
  description?: string;
};

// Explicit product allowlist: upstream chat commands do not define Slide capabilities.
const PRODUCT_DESTINATIONS: Array<[Tab, string, IconName, string?]> = [
  ['dashboard', '资源总览', 'bar-chart'], ['attention', '关注事项', 'activity'],
  ['investigations', '调查工作台', 'search'], ['chat', '运维对话', 'file-text'],
  ['instances-db', '数据库实例', 'database'], ['servers', '服务器', 'monitor'],
  ['network-devices', '网络设备', 'monitor'],
  ['sql-console', 'SQL 控制台', 'terminal', '执行受实例权限、SQL 边界与审批约束'],
  ['events', '事件中心', 'activity'], ['reports', '巡检报告', 'file-text'],
  ['approval', '审批中心', 'file-text'], ['audit-center', '审计中心', 'search'],
  ['cron-jobs', '定时任务', 'scroll-text'], ['health-center', '平台健康', 'activity'],
  ['settings', '个人设置', 'settings'],
];

export function getPaletteItems(permissions: Set<string> | null = null, visibleTabs?: string[]): PaletteItem[] {
  if (!permissions) return [];
  return PRODUCT_DESTINATIONS.filter(([tab]) =>
    (!visibleTabs?.length || visibleTabs.includes(tab)) &&
    hasSlidePermission(permissions, tab === 'attention' ? 'alert:view' : tab === 'chat' ? 'chat:view' : TAB_REQUIRED_PERMISSIONS[tab])
  ).map(([tab, label, icon, description]) => ({ id: `nav-${tab}`, label, icon, category: 'navigation', action: `nav:${tab}`, description }));
}

export type CommandPaletteProps = {
  permissions?: Set<string> | null;
  visibleTabs?: string[];
  open: boolean;
  query: string;
  activeIndex: number;
  onToggle: () => void;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onNavigate: (tab: string) => void;
  onSlashCommand: (command: string) => void;
};

function filteredItems(query: string, props: CommandPaletteProps): PaletteItem[] {
  const items = getPaletteItems(props.permissions, props.visibleTabs);
  if (!query) {
    return items;
  }
  const q = normalizeLowercaseStringOrEmpty(query);
  return items.filter(
    (item) =>
      normalizeLowercaseStringOrEmpty(item.label).includes(q) ||
      normalizeLowercaseStringOrEmpty(item.description).includes(q),
  );
}

function groupItems(items: PaletteItem[]): Array<[string, PaletteItem[]]> {
  const map = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

let previouslyFocused: Element | null = null;

function saveFocus() {
  previouslyFocused = document.activeElement;
}

function restoreFocus() {
  if (previouslyFocused && previouslyFocused instanceof HTMLElement) {
    const target = previouslyFocused;
    requestAnimationFrame(() => { if (target.isConnected) target.focus(); });
  }
  previouslyFocused = null;
}

function selectItem(item: PaletteItem, props: CommandPaletteProps) {
  if (!getPaletteItems(props.permissions, props.visibleTabs).some(current => current.id === item.id)) return;
  if (item.action.startsWith("nav:")) {
    props.onNavigate(item.action.slice(4));
  } else {
    props.onSlashCommand(item.action);
  }
  props.onToggle();
  restoreFocus();
}

function scrollActiveIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".cmd-palette__item--active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function handleKeydown(e: KeyboardEvent, props: CommandPaletteProps) {
  const items = filteredItems(props.query, props);
  if (items.length === 0 && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
    return;
  }
  switch (e.key) {
    case "Tab": e.preventDefault(); break;
    case "ArrowDown":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex + 1) % items.length);
      scrollActiveIntoView();
      break;
    case "ArrowUp":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex - 1 + items.length) % items.length);
      scrollActiveIntoView();
      break;
    case "Enter":
      e.preventDefault();
      if (items[props.activeIndex]) {
        selectItem(items[props.activeIndex], props);
      }
      break;
    case "Escape":
      e.preventDefault();
      props.onToggle();
      restoreFocus();
      break;
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  navigation: "产品入口",
};

function focusInput(el: Element | undefined) {
  if (el) {
    saveFocus();
    requestAnimationFrame(() => (el as HTMLInputElement).focus());
  }
}

export function renderCommandPalette(props: CommandPaletteProps) {
  if (!props.open) {
    return nothing;
  }

  const items = filteredItems(props.query, props);
  const grouped = groupItems(items);

  return html`
    <div
      class="cmd-palette-overlay"
      @click=${() => {
        props.onToggle();
        restoreFocus();
      }}
    >
      <div
        role="dialog" aria-modal="true" aria-label="全局搜索"
        class="cmd-palette"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => handleKeydown(e, props)}
      >
        <input
          ${ref(focusInput)}
          role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="slide-palette-results"
          aria-activedescendant=${items[props.activeIndex] ? `palette-${items[props.activeIndex].id}` : nothing}
          aria-label="搜索产品入口"
          class="cmd-palette__input"
          placeholder="${t("overview.palette.placeholder")}"
          .value=${props.query}
          @input=${(e: Event) => {
            props.onQueryChange((e.target as HTMLInputElement).value);
            props.onActiveIndexChange(0);
          }}
        />
        <div id="slide-palette-results" class="cmd-palette__results" role="listbox" aria-label="产品入口">
          ${grouped.length === 0
            ? html`<div class="cmd-palette__empty">
                <span class="nav-item__icon" style="opacity:0.3;width:20px;height:20px"
                  >${icons['search']}</span
                >
                <span>${t("overview.palette.noResults")}</span>
              </div>`
            : grouped.map(
                ([category, groupedItems]) => html`
                  <div class="cmd-palette__group-label">
                    ${CATEGORY_LABELS[category] ?? category}
                  </div>
                  ${groupedItems.map((item) => {
                    const globalIndex = items.indexOf(item);
                    const isActive = globalIndex === props.activeIndex;
                    return html`
                      <div
                        id=${`palette-${item.id}`} role="option" aria-selected=${isActive}
                        class="cmd-palette__item ${isActive ? "cmd-palette__item--active" : ""}"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          selectItem(item, props);
                        }}
                        @mouseenter=${() => props.onActiveIndexChange(globalIndex)}
                      >
                        <span class="nav-item__icon">${icons[item.icon]}</span>
                        <span>${item.label}</span>
                        ${item.description
                          ? html`<span class="cmd-palette__item-desc muted"
                              >${item.description}</span
                            >`
                          : nothing}
                      </div>
                    `;
                  })}
                `,
              )}
        </div>
        <div class="cmd-palette__footer">
          <span><kbd>↑↓</kbd> 切换</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  `;
}
